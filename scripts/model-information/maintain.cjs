#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { importLegacySnapshot } = require('../../shared/model-information/import-legacy-snapshot');
const approvedSources = require('./maintenance-sources.json');

const root = path.resolve(__dirname, '../..');
const reportFile = 'shared/model-information/maintenance-report.json';
const rawImport = 'containers/api-proxy/models.dev.catalog.json';
const metadataFile = 'shared/model-information/imported/legacy-models-dev.metadata.json';
const snapshotFile = 'shared/model-information/imported/legacy-models-dev.snapshot.v1.json';
const projections = [
  snapshotFile, 'shared/model-information/catalog.generated.json',
  'shared/model-information/manifest.generated.json', 'shared/model-information/target.generated.json',
  'shared/model-information/baseline-to-target.generated.json',
  'src/model-information.compat.generated.json',
  'containers/api-proxy/model-information.pricing.generated.json',
  'containers/api-proxy/model-information.retired.generated.json',
  'containers/api-proxy/ai-credits-pricing-reference.json',
  'docs/model-api-mapping.json', 'containers/api-proxy/model-api-mapping.json',
];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const canonical = file => /^shared\/model-information\/sources\/[a-z-]+\.json$/.test(file) ||
  [rawImport, metadataFile].includes(file);
const allowed = file => canonical(file) || projections.includes(file) || file === reportFile;
const metadataKeys = new Set(['retrievedAt', 'checkedAt', 'lastUpdated', 'revision', 'sha256']);

function facts(value, field) {
  if (field === 'price' && typeof value === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  }
  if (Array.isArray(value)) return value.map(item => facts(item));
  if (!value || typeof value !== 'object') return value;
  if (field === 'provenance') {
    return Object.fromEntries(['authority', 'confidence', 'freshness'].filter(key => value[key] !== undefined)
      .map(key => [key, value[key]]));
  }
  return Object.fromEntries(Object.keys(value).sort().filter(key => !metadataKeys.has(key))
    .map(key => [key, facts(value[key], key)]));
}

function differences(before, after, pointer = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && /\/(data|models)$/.test(pointer)) {
    const key = item => item?.identity?.key || item?.id;
    if ([...before, ...after].every(item => typeof key(item) === 'string') &&
        new Set(before.map(key)).size === before.length && new Set(after.map(key)).size === after.length) {
      const left = new Map(before.map(item => [key(item), item]));
      const right = new Map(after.map(item => [key(item), item]));
      return [...new Set([...left.keys(), ...right.keys()])].sort().flatMap(id =>
        differences(left.get(id), right.get(id), `${pointer}/@id=${id.replace(/~/g, '~0').replace(/\//g, '~1')}`));
    }
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key =>
      differences(before[key], after[key], `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  }
  return [{ pointer, before: before ?? null, after: after ?? null }];
}

function importMetadata(bytes, capture) {
  return {
    source: capture.url, revision: capture.sha256, retrievedAt: capture.retrievedAt,
    sha256: hash(bytes),
    license: 'Model API does not declare a catalogue/model license; no license rights inferred.',
  };
}

function inspectCatalogue(bytes, capture) {
  const source = JSON.parse(bytes);
  if (source.total_count === undefined || source.links === undefined) {
    throw new Error('Incomplete catalogue coverage: fresh API captures require total_count and links');
  }
  const snapshot = importLegacySnapshot(bytes, importMetadata(bytes, capture));
  const data = source.data;
  // OpenRouter routing aliases and variable-price sentinels are not exact priced models.
  const excluded = data.filter(entry => typeof entry?.id === 'string' &&
    (entry.id.startsWith('~') || (
      entry.pricing?.prompt === '-1' && entry.pricing?.completion === '-1'))).map(entry => entry.id);
  if (!snapshot.accepted || snapshot.collisions.length || snapshot.rejected !== excluded.length) {
    throw new Error(`Invalid/ambiguous catalogue: accepted=${snapshot.accepted}, rejected=${snapshot.rejected}, collisions=${json(snapshot.collisions)}`);
  }
  return { snapshot, excluded };
}

function documentText(bytes) {
  return bytes.toString('utf8')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

async function captureSources(directory, fetcher = fetch, sources = approvedSources) {
  fs.mkdirSync(directory, { recursive: true });
  const captures = [];
  for (const source of sources) {
    const errors = [];
    let captured;
    for (const url of source.urls) {
      try {
        const response = await fetcher(url, {
          signal: AbortSignal.timeout(60000), headers: { 'Accept-Language': 'en' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > 12 * 1024 * 1024) throw new Error('Oversized response');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 12 * 1024 * 1024) throw new Error('Oversized response');
        // Retain failed validation evidence too, without labelling it a successful capture.
        fs.writeFileSync(path.join(directory, `${source.id}.attempt-${errors.length}.raw`), bytes);
        const text = source.kind === 'catalogue' ? bytes.toString('utf8') : documentText(bytes);
        if (text.length < 80 || /<title>[^<]*(access denied|just a moment|sign in)/i.test(bytes.toString('utf8'))) {
          throw new Error('Empty, incomplete or authentication/challenge page');
        }
        captured = {
          id: source.id, scope: source.scope, kind: source.kind, url,
          finalUrl: response.url || url, sha256: hash(bytes), textSha256: hash(text),
          retrievedAt: new Date().toISOString(), status: 'ok',
        };
        if (source.kind === 'catalogue') {
          const { snapshot, excluded } = inspectCatalogue(bytes, captured);
          captured.import = { accepted: snapshot.accepted, rejected: snapshot.rejected, collisions: snapshot.collisions, excluded };
        }
        fs.writeFileSync(path.join(directory, `${source.id}.raw`), bytes);
        fs.writeFileSync(path.join(directory, `${source.id}.txt`), text);
        break;
      } catch (error) {
        captured = undefined;
        errors.push(`${url}: ${error.message}`);
      }
    }
    captures.push(captured || { id: source.id, scope: source.scope, status: 'failed', errors });
  }
  fs.writeFileSync(path.join(directory, 'captures.json'), json({ schemaVersion: 1, sources: captures }));
  return captures;
}

function loadCaptures(directory) {
  const captures = read(path.join(directory, 'captures.json')).sources;
  const errors = [];
  for (const source of approvedSources) {
    const capture = captures.find(item => item.id === source.id);
    if (!capture || capture.status !== 'ok') {
      errors.push(`${source.id}: ${json(capture?.errors || ['missing capture'])}`);
      continue;
    }
    if (!source.urls.includes(capture.url) ||
        hash(fs.readFileSync(path.join(directory, `${source.id}.raw`))) !== capture.sha256 ||
        hash(fs.readFileSync(path.join(directory, `${source.id}.txt`))) !== capture.textSha256) {
      errors.push(`${source.id}: unapproved URL or evidence hash mismatch`);
    }
  }
  if (errors.length) throw new Error(`Incomplete source coverage; existing facts retained:\n${errors.join('\n')}`);
  return captures;
}

function refreshImport(cwd, directory) {
  const capture = loadCaptures(directory).find(item => item.id === 'openrouter-models');
  const bytes = fs.readFileSync(path.join(directory, 'openrouter-models.raw'));
  const { snapshot } = inspectCatalogue(bytes, capture);
  const current = read(path.join(cwd, snapshotFile));
  // Compare imported facts, not API ordering/descriptions, formatting or capture dates.
  if (json(facts(current.models)) === json(facts(snapshot.models)) &&
      json(catalogueFacts(fs.readFileSync(path.join(cwd, rawImport)))) === json(catalogueFacts(bytes))) return false;
  fs.writeFileSync(path.join(cwd, rawImport), bytes);
  fs.writeFileSync(path.join(cwd, metadataFile), json(importMetadata(bytes, capture)));
  return true;
}

function catalogueFacts(bytes) {
  const normalizePrices = value => {
    if (typeof value === 'string' && /^(0|[1-9]\d*)(\.\d+)?$/.test(value)) return facts(value, 'price');
    if (Array.isArray(value)) return value.map(normalizePrices);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, normalizePrices(value[key])]));
    return value;
  };
  return JSON.parse(bytes).data.filter(entry => !entry.id.startsWith('~') &&
    !(entry.pricing?.prompt === '-1' && entry.pricing?.completion === '-1')).map(entry => ({
    id: entry.id, pricing: normalizePrices(entry.pricing),
    context: entry.context_length ?? null,
    providerContext: entry.top_provider?.context_length ?? null,
    maxCompletion: entry.top_provider?.max_completion_tokens ?? null,
    parameters: [...(entry.supported_parameters || [])].sort(),
    expiration: entry.expiration_date ?? null,
  })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function reviewReasons(changes) {
  const reasons = new Set(['human-review-required']);
  for (const change of changes) {
    const text = change.pointer;
    if (/lifecycle|replacement/.test(text)) reasons.add('lifecycle-retirement-replacement');
    if (/price|tariff|pricing|threshold|promotion|effective/i.test(text)) reasons.add('pricing-including-decreases-and-expiry');
    if (/reasoning|effort|limit|context/i.test(text)) reasons.add('efforts-and-limits');
    if (/availability|scope|channel|deployment|protocol|feature|harness|routing|endpoint/i.test(text)) {
      reasons.add('compatibility-contraction-and-scope');
    }
    if (/confidence/.test(text)) reasons.add('confidence-including-downgrade');
    if (change.after === null) reasons.add('source-or-record-disappearance-not-proof-of-retirement');
  }
  return [...reasons].sort();
}

function modelIds(value) {
  return [...new Set([
    ...(value.models || []).map(model => model.identity.key),
    ...(value.data || []).map(model => model.id),
    ...(Array.isArray(value.availability) ? value.availability.map(id => `copilot/${id}`) : []),
    ...(value.routing || []).map(model => `${model.provider}/${model.id}`),
  ])].sort();
}

function buildReport(cwd, directory) {
  const captures = loadCaptures(directory);
  const baseFile = path.join(directory, 'base-revision');
  const base = fs.existsSync(baseFile) ? fs.readFileSync(baseFile, 'utf8').trim() : 'HEAD';
  if (base !== 'HEAD' && !/^[0-9a-f]{40}$/.test(base)) throw new Error('Invalid maintenance base revision');
  const changed = [...new Set([
    ...git(cwd, 'diff', '--name-only', base).trim().split('\n'),
    ...git(cwd, 'ls-files', '--others', '--exclude-standard').trim().split('\n'),
  ])].filter(Boolean).sort();
  for (const file of changed) if (!allowed(file)) throw new Error(`Out-of-scope change: ${file}`);
  const claimsPath = path.join(directory, 'proposal.json');
  const claims = fs.existsSync(claimsPath) ? read(claimsPath).changes : [];
  const changes = [];
  for (const file of changed.filter(canonical)) {
    // Canonical inputs must already exist: adding a new source format needs a separate review.
    const beforeBytes = Buffer.from(git(cwd, 'show', `${base}:${file}`));
    const afterBytes = fs.readFileSync(path.join(cwd, file));
    const before = JSON.parse(beforeBytes);
    const after = JSON.parse(afterBytes);
    if (file === rawImport && json(catalogueFacts(beforeBytes)) === json(catalogueFacts(afterBytes))) {
      throw new Error('Import contains no material model facts; capture/formatting/description-only churn is forbidden');
    }
    if (file !== metadataFile && json(facts(before)) === json(facts(after))) {
      throw new Error(`${file}: metadata/timestamp-only churn is not a source update`);
    }
    if ([rawImport, metadataFile].includes(file)) {
      const capture = captures.find(item => item.id === 'openrouter-models');
      const raw = fs.readFileSync(path.join(cwd, rawImport));
      if (hash(raw) !== capture.sha256 ||
          json(read(path.join(cwd, metadataFile))) !== json(importMetadata(raw, capture))) {
        throw new Error('Import bytes/metadata must match the captured API response exactly');
      }
      inspectCatalogue(raw, capture);
      if (!changed.includes(rawImport) || !changed.includes(metadataFile)) throw new Error('Import requires raw bytes and metadata together');
    } else {
      const claim = claims.find(item => item.file === file);
      if (!claim || claim.beforeSha256 !== hash(beforeBytes) || claim.afterSha256 !== hash(afterBytes) ||
          !claim.summary || !claim.scope || !Array.isArray(claim.evidence) || !claim.evidence.length) {
        throw new Error(`${file}: missing source-aware proposal with exact before/after hashes, scope and summary`);
      }
      for (const evidence of claim.evidence) {
        const capture = captures.find(item => item.id === evidence.source);
        if (!capture || typeof evidence.quote !== 'string' || evidence.quote.trim().length < 20 ||
            !fs.readFileSync(path.join(directory, `${capture.id}.txt`), 'utf8').includes(evidence.quote)) {
          throw new Error(`${file}: unsupported evidence quote from ${evidence.source}`);
        }
      }
    }
    const delta = file === rawImport
      ? differences({ data: catalogueFacts(beforeBytes) }, { data: catalogueFacts(afterBytes) })
      : differences(before, after);
    const beforeIds = modelIds(before);
    const afterIds = modelIds(after);
    const removedModels = beforeIds.filter(id => !afterIds.includes(id));
    const reviewRequired = reviewReasons(delta);
    if (removedModels.length) reviewRequired.push('source-or-record-disappearance-not-proof-of-retirement');
    changes.push({ file, changes: delta, reviewRequired: [...new Set(reviewRequired)].sort(),
      addedModels: afterIds.filter(id => !beforeIds.includes(id)), removedModels,
      previousProvenance: before.provenance || (file === metadataFile ? before : null),
      proposal: claims.find(item => item.file === file) || { scope: 'OpenRouter observation only; no native-provider deployability or billing inference' } });
  }
  if (!changes.length) {
    if (changed.length) throw new Error('Generated/report changes without a canonical source change');
    return null;
  }
  const reviewBaseFile = path.join(directory, 'review-base-revision');
  const reviewBase = fs.existsSync(reviewBaseFile) ? fs.readFileSync(reviewBaseFile, 'utf8').trim() : base;
  if (reviewBase !== 'HEAD' && !/^[0-9a-f]{40}$/.test(reviewBase)) throw new Error('Invalid maintenance review base');
  const pendingSourceChanges = reviewBase === base ? undefined : git(cwd, 'diff', '--name-only', reviewBase).trim().split('\n')
    .filter(canonical).sort().map(file => ({
      file, changes: differences(
        file === rawImport ? { data: catalogueFacts(Buffer.from(git(cwd, 'show', `${reviewBase}:${file}`))) }
          : JSON.parse(git(cwd, 'show', `${reviewBase}:${file}`)),
        file === rawImport ? { data: catalogueFacts(fs.readFileSync(path.join(cwd, file))) } : read(path.join(cwd, file))),
    }));
  return {
    schemaVersion: 1, status: 'proposed-not-activated', baseRevision: git(cwd, 'rev-parse', base).trim(),
    reviewBaseRevision: git(cwd, 'rev-parse', reviewBase).trim(),
    ...(pendingSourceChanges ? { pendingSourceChanges } : {}),
    pathFormat: 'JSON Pointer fields; data/models arrays use @id=<escaped exact ID> selectors, not positional indices. Raw import diffs cover governed observations only; exact bytes are pinned separately.',
    roundingTolerance: 'Zero unless a separately reviewed provider-specific tolerance is documented; no guessed tolerance.',
    sources: captures, changes,
    generatedFiles: projections,
    reviewRequired: ['All model-fact changes require human review; no auto-merge or publication.'],
  };
}

function selectPullRequest(pulls) {
  if (pulls.length >= 1000) throw new Error('Incomplete PR coverage: selection reached the 1000-PR retrieval limit');
  const matches = pulls.filter(pr => pr.headRefName.startsWith('automation/model-source-maintenance-') &&
    !pr.isCrossRepository);
  if (matches.length > 1) throw new Error('Multiple maintenance PRs found; reconcile before updating');
  if (matches.some(pr => pr.title !== '[models] Refresh canonical model sources' || pr.baseRefName !== 'main')) {
    throw new Error('Maintenance PR identity changed; preserve human edits and reconcile before updating');
  }
  return matches[0] || null;
}

async function main() {
  const [command, directory = '/tmp/gh-aw/model-maintenance'] = process.argv.slice(2);
  if (command === 'capture') {
    const captures = await captureSources(directory);
    console.log(json(captures));
    if (captures.some(item => item.status !== 'ok')) throw new Error('Source retrieval failed; see captures.json for affected sources');
  } else if (command === 'refresh-import') {
    console.log(refreshImport(root, directory) ? 'Import source changed; regenerate before review' : 'Import facts unchanged');
  } else if (command === 'report') {
    const report = buildReport(root, directory);
    if (report) fs.writeFileSync(path.join(root, reportFile), json(report));
    console.log(report ? `Review required: ${reportFile}` : 'No material source changes');
  } else if (command === 'verify') {
    const report = buildReport(root, directory);
    if (report && json(read(path.join(root, reportFile))) !== json(report)) throw new Error('Missing or stale maintenance impact report');
    execFileSync(process.execPath, [path.join(root, 'scripts/model-information/compile.cjs'), '--check'], { cwd: root, stdio: 'inherit' });
  } else if (command === 'select-pr') {
    console.log(json(selectPullRequest(read(directory))));
  } else {
    throw new Error('Expected capture, refresh-import, report, verify or select-pr');
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {
  captureSources, loadCaptures, refreshImport, buildReport, selectPullRequest,
  facts, differences, reviewReasons, inspectCatalogue, hash, json, allowed, projections,
};
