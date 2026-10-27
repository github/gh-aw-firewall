#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const approvedSources = require('./maintenance-sources.json');

const root = path.resolve(__dirname, '../..');
const reportFile = 'shared/model-information/maintenance-report.json';
const rawImport = 'containers/api-proxy/models.dev.catalog.json';
const metadataFile = 'shared/model-information/imported/legacy-models-dev.metadata.json';
const snapshotFile = 'shared/model-information/imported/legacy-models-dev.snapshot.v1.json';
const maintenanceTitle = 'chore: refresh canonical model sources';
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
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
});
const hasGitObject = (cwd, object) => {
  try {
    execFileSync('git', ['cat-file', '-e', object], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const canonical = file => /^shared\/model-information\/sources\/[a-z-]+\.json$/.test(file) ||
  [rawImport, metadataFile].includes(file);
const allowed = file => canonical(file) || projections.includes(file) || file === reportFile;
const metadataKeys = new Set(['retrievedAt', 'checkedAt', 'lastUpdated', 'revision', 'sha256']);

function trustedRestoredPaths(cwd, reviewBase, candidates) {
  const paths = git(cwd, 'ls-tree', '-r', '--name-only', reviewBase, '--', '.github', '.agents', 'AGENTS.md')
    .trim().split('\n').filter(Boolean);
  const candidateSet = candidates ? new Set(candidates) : null;
  return new Set(paths.filter(file => {
    if (candidateSet && !candidateSet.has(file)) return false;
    const target = path.join(cwd, file);
    return hasGitObject(cwd, `${reviewBase}:${file}`) && fs.existsSync(target) &&
      hash(fs.readFileSync(target)) === hash(Buffer.from(git(cwd, 'show', `${reviewBase}:${file}`)));
  }));
}

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
  const { importLegacySnapshot } = require('../../shared/model-information/import-legacy-snapshot');
  const source = JSON.parse(bytes);
  if (!Number.isSafeInteger(source.total_count) || source.total_count !== source.data?.length ||
      !source.links || !Object.hasOwn(source.links, 'next') || source.links.next !== null) {
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
  const entities = {
    '&nbsp;': ' ', '&#160;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
    '&quot;': '"', '&#39;': "'",
  };
  return bytes.toString('utf8')
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot);|&#(?:160|39);/g, entity => entities[entity])
    .replace(/\s+/g, ' ').trim();
}

function writeCapture(directory, filename, content) {
  const staging = fs.mkdtempSync(path.join(directory, '.capture-'));
  try {
    const file = path.join(staging, 'evidence');
    fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(file, path.join(directory, filename));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function captureSources(directory, fetcher = fetch, sources = approvedSources) {
  if (sources.some(source => !/^[a-z][a-z0-9-]*$/.test(source.id))) {
    throw new Error('Unsafe capture source ID');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) {
    throw new Error('Evidence directory must be an owned directory, not a symlink');
  }
  fs.chmodSync(directory, 0o700);
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
        writeCapture(directory, `${source.id}.attempt-${errors.length}.raw`, bytes);
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
        writeCapture(directory, `${source.id}.raw`, bytes);
        writeCapture(directory, `${source.id}.txt`, text);
        break;
      } catch (error) {
        captured = undefined;
        errors.push(`${url}: ${error.message}`);
      }
    }
    captures.push(captured || { id: source.id, scope: source.scope, status: 'failed', errors });
  }
  writeCapture(directory, 'captures.json', json({ schemaVersion: 1, sources: captures }));
  return captures;
}

function loadCaptures(directory, trustedManifestSha256) {
  const manifest = fs.readFileSync(path.join(directory, 'captures.json'));
  if (trustedManifestSha256 !== undefined &&
      (!/^[0-9a-f]{64}$/.test(trustedManifestSha256) || hash(manifest) !== trustedManifestSha256)) {
    throw new Error(`Trusted capture manifest mismatch; rejecting evidence for ${approvedSources.map(source => source.id).join(', ')}`);
  }
  const captures = JSON.parse(manifest).sources;
  if (!Array.isArray(captures) || captures.some(item => !item || typeof item.id !== 'string') ||
      new Set(captures.map(item => item.id)).size !== captures.length) {
    throw new Error('Capture manifest contains an invalid or duplicate source record');
  }
  const errors = [];
  const expectedIds = new Set(approvedSources.map(source => source.id));
  const actualIds = new Set(captures.map(item => item.id));
  const unknown = [...actualIds].filter(id => !expectedIds.has(id));
  const missing = [...expectedIds].filter(id => !actualIds.has(id));
  if (unknown.length || missing.length) {
    throw new Error(`Capture manifest source mismatch; unknown=${unknown.join(',')}, missing=${missing.join(',')}`);
  }
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
      json(catalogueFacts(fs.readFileSync(path.join(cwd, rawImport)))) === json(catalogueFacts(bytes)) &&
      json(runtimeResolutionFacts(fs.readFileSync(path.join(cwd, rawImport)))) ===
        json(runtimeResolutionFacts(bytes))) return false;
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
    canonicalSlug: entry.canonical_slug ?? null,
    context: entry.context_length ?? null,
    providerContext: entry.top_provider?.context_length ?? null,
    maxCompletion: entry.top_provider?.max_completion_tokens ?? null,
    parameters: [...(entry.supported_parameters || [])].sort(),
    inputModalities: [...(entry.architecture?.input_modalities || [])].sort(),
    outputModalities: [...(entry.architecture?.output_modalities || [])].sort(),
    expiration: entry.expiration_date ?? null,
  })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function runtimeResolutionFacts(bytes) {
  const data = JSON.parse(bytes).data;
  const canonicalize = model => {
    if (typeof model !== 'string') return '';
    const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
    const withoutDateSuffix = bare.replace(/(-alpha)?-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
    return withoutDateSuffix.replace(/[._]/g, '-');
  };
  const normalizePricing = pricing => {
    const input = Number(pricing?.prompt) * 1_000_000;
    const output = Number(pricing?.completion) * 1_000_000;
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return null;
    const cachedInput = pricing.input_cache_read === undefined
      ? input * 0.1 : Number(pricing.input_cache_read) * 1_000_000;
    const cacheWrite = pricing.input_cache_write === undefined ? null : Number(pricing.input_cache_write) * 1_000_000;
    if (!Number.isFinite(cachedInput) || cachedInput < 0 ||
        (cacheWrite !== null && (!Number.isFinite(cacheWrite) || cacheWrite < 0))) return null;
    return {
      input, cachedInput, cacheWrite, output,
    };
  };
  const exactResolution = new Map();
  const aliasResolution = new Map();
  for (const entry of data) {
    const pricing = normalizePricing(entry.pricing);
    const exactKey = canonicalize(entry.id);
    if (exactKey && !exactResolution.has(exactKey)) {
      exactResolution.set(exactKey, {
        exists: true,
        pricing: pricing ? { modelId: entry.id, alias: entry.id, ...pricing } : null,
      });
    }

    const aliasKey = canonicalize(entry.canonical_slug);
    if (aliasKey) {
      if (!aliasResolution.has(aliasKey)) {
        aliasResolution.set(aliasKey, { exists: true, pricing: null });
      }
      const current = aliasResolution.get(aliasKey);
      if (pricing && !current.pricing) {
        current.pricing = { modelId: entry.id, alias: entry.canonical_slug, ...pricing };
      }
    }
  }
  const resolution = new Map([...aliasResolution, ...exactResolution]);
  return Object.fromEntries([...resolution.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0).map(([key, value]) =>
    [`@lookup=${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, value]));
}

function reviewReasons(changes) {
  const reasons = new Set(['human-review-required']);
  for (const change of changes) {
    const text = change.pointer.replace(/\/@(?:id|lookup)=[^/]*(?=\/|$)/g, '').toLowerCase();
    if (/lifecycle|replacement|expiration|retir/.test(text)) reasons.add('lifecycle-retirement-replacement');
    if (/price|tariff|pricing|threshold|promotion|effective/.test(text)) reasons.add('pricing-including-decreases-and-expiry');
    if (/reasoning|effort|limit|context|maxcompletion/.test(text)) reasons.add('efforts-and-limits');
    if (/availability|scope|channel|deployment|protocol|feature|harness|routing|endpoint|parameter|canonical.?slug|modalit|runtime.?resolution|lookup/.test(text)) {
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

function runtimeConsumerEffects(cwd, base) {
  const effects = [];
  for (const file of [rawImport, 'containers/api-proxy/model-information.retired.generated.json']) {
    if (!hasGitObject(cwd, `${base}:${file}`) || !fs.existsSync(path.join(cwd, file))) continue;
    const beforeBytes = Buffer.from(git(cwd, 'show', `${base}:${file}`));
    const afterBytes = fs.readFileSync(path.join(cwd, file));
    const changes = file === rawImport
      ? differences(
        { runtimeResolution: runtimeResolutionFacts(beforeBytes) },
        { runtimeResolution: runtimeResolutionFacts(afterBytes) },
      )
      : differences(JSON.parse(beforeBytes), JSON.parse(afterBytes));
    if (changes.length) effects.push({ file, changes });
  }
  return effects;
}

function buildReport(cwd, directory, trustedManifestSha256, trustedRevisions = {}) {
  const captures = loadCaptures(directory, trustedManifestSha256);
  const baseFile = path.join(directory, 'base-revision');
  const base = trustedRevisions.baseRevision || process.env.TRUSTED_MAINTENANCE_BASE ||
    (fs.existsSync(baseFile) ? fs.readFileSync(baseFile, 'utf8').trim() : 'HEAD');
  if (base !== 'HEAD' && !/^[0-9a-f]{40}$/.test(base)) throw new Error('Invalid maintenance base revision');
  const reviewBaseFile = path.join(directory, 'review-base-revision');
  const reviewBase = trustedRevisions.reviewBaseRevision || process.env.TRUSTED_REVIEW_BASE ||
    (fs.existsSync(reviewBaseFile) ? fs.readFileSync(reviewBaseFile, 'utf8').trim() : base);
  if (reviewBase !== 'HEAD' && !/^[0-9a-f]{40}$/.test(reviewBase)) throw new Error('Invalid maintenance review base');
  const mergeBase = base === 'HEAD' || reviewBase === 'HEAD'
    ? base : git(cwd, 'merge-base', base, reviewBase).trim();
  const committedChanges = new Set(git(cwd, 'diff', '--name-only', base, 'HEAD').trim().split('\n').filter(Boolean));
  const changed = [...new Set([
    ...git(cwd, 'diff', '--name-only', base).trim().split('\n'),
    ...committedChanges,
    ...git(cwd, 'ls-files', '--others', '--exclude-standard').trim().split('\n'),
  ])].filter(Boolean).sort();
  const restored = trustedRestoredPaths(cwd, reviewBase, changed);
  const matchesTrustedCommit = file => hasGitObject(cwd, `HEAD:${file}`) &&
    hash(Buffer.from(git(cwd, 'show', `HEAD:${file}`))) ===
      hash(Buffer.from(git(cwd, 'show', `${reviewBase}:${file}`)));
  const ignoredRestored = new Set([...restored].filter(file =>
    !committedChanges.has(file) || matchesTrustedCommit(file)));
  for (const file of changed) {
    if (ignoredRestored.has(file)) continue;
    if (!allowed(file)) throw new Error(`Out-of-scope change: ${file}`);
  }
  const claimsPath = path.join(directory, 'proposal.json');
  const claims = fs.existsSync(claimsPath) ? read(claimsPath).changes : [];
  const changes = [];
  for (const file of changed.filter(file => canonical(file) && !ignoredRestored.has(file))) {
    // Canonical inputs must already exist: adding a new source format needs a separate review.
    const beforeBytes = Buffer.from(git(cwd, 'show', `${base}:${file}`));
    const afterBytes = fs.readFileSync(path.join(cwd, file));
    const before = JSON.parse(beforeBytes);
    const after = JSON.parse(afterBytes);
    if (file === rawImport &&
        json(catalogueFacts(beforeBytes)) === json(catalogueFacts(afterBytes)) &&
        json(runtimeResolutionFacts(beforeBytes)) === json(runtimeResolutionFacts(afterBytes))) {
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
      ? [
        ...differences({ data: catalogueFacts(beforeBytes) }, { data: catalogueFacts(afterBytes) }),
        ...differences(
          { runtimeResolution: runtimeResolutionFacts(beforeBytes) },
          { runtimeResolution: runtimeResolutionFacts(afterBytes) },
        ),
      ]
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
    if (changed.some(file => !ignoredRestored.has(file))) {
      throw new Error('Generated/report changes without a canonical source change');
    }
    return null;
  }
  const pendingSourceChanges = mergeBase === base ? undefined :
    git(cwd, 'diff', '--name-only', mergeBase).trim().split('\n')
      .filter(file => canonical(file) && !ignoredRestored.has(file)).sort().map(file => {
        const beforeExists = hasGitObject(cwd, `${mergeBase}:${file}`);
        const beforeBytes = beforeExists ? Buffer.from(git(cwd, 'show', `${mergeBase}:${file}`)) : null;
        const afterExists = fs.existsSync(path.join(cwd, file));
        const afterBytes = afterExists ? fs.readFileSync(path.join(cwd, file)) : null;
        return {
          file,
          changes: file === rawImport
            ? differences(
              beforeBytes ? { data: catalogueFacts(beforeBytes) } : null,
              afterBytes ? { data: catalogueFacts(afterBytes) } : null,
            ).concat(beforeBytes && afterBytes ? differences(
              { runtimeResolution: runtimeResolutionFacts(beforeBytes) },
              { runtimeResolution: runtimeResolutionFacts(afterBytes) },
            ) : [])
            : differences(beforeBytes ? JSON.parse(beforeBytes) : null,
              afterBytes ? JSON.parse(afterBytes) : null),
        };
      });
  return {
    schemaVersion: 1, status: 'proposed-awaiting-human-review', baseRevision: git(cwd, 'rev-parse', base).trim(),
    reviewBaseRevision: git(cwd, 'rev-parse', reviewBase).trim(),
    ...(pendingSourceChanges ? { pendingSourceChangesBaseRevision: mergeBase } : {}),
    ...(pendingSourceChanges ? { pendingSourceChanges } : {}),
    runtimeConsumerEffects: runtimeConsumerEffects(cwd, base),
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
  if (matches.some(pr => pr.title !== maintenanceTitle || pr.baseRefName !== 'main')) {
    throw new Error('Maintenance PR identity changed; preserve human edits and reconcile before updating');
  }
  return matches[0] || null;
}

function verifyCommittedTree(cwd) {
  const status = git(cwd, 'status', '--porcelain').trim().split('\n').filter(Boolean);
  if (!status.length) return;
  const reviewBase = process.env.TRUSTED_REVIEW_BASE;
  if (!reviewBase || !/^[0-9a-f]{40}$/.test(reviewBase)) {
    throw new Error('Final verification requires a clean committed tree');
  }
  const restored = trustedRestoredPaths(cwd, reviewBase, status.map(entry => entry.slice(3)));
  for (const entry of status) {
    const file = entry.slice(3);
    if (!restored.has(file)) {
      throw new Error('Final verification requires a clean committed tree');
    }
  }
}

async function main() {
  const [command, directory = '/tmp/gh-aw/model-maintenance', targetRoot = root] = process.argv.slice(2);
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
  } else if (command === 'verify' || command === 'verify-committed') {
    const cwd = path.resolve(targetRoot);
    if (command === 'verify-committed') verifyCommittedTree(cwd);
    const report = buildReport(cwd, directory);
    if (report && json(read(path.join(cwd, reportFile))) !== json(report)) throw new Error('Missing or stale maintenance impact report');
    execFileSync(process.execPath, [
      path.join(root, 'scripts/model-information/compile.cjs'), '--check', `--root=${cwd}`,
    ], { cwd: root, stdio: 'inherit' });
  } else if (command === 'select-pr') {
    console.log(json(selectPullRequest(read(directory))));
  } else {
    throw new Error('Expected capture, refresh-import, report, verify, verify-committed or select-pr');
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {
  captureSources, loadCaptures, refreshImport, buildReport, selectPullRequest,
  facts, differences, reviewReasons, inspectCatalogue, documentText, hash, json, allowed, projections,
  catalogueFacts, runtimeResolutionFacts, runtimeConsumerEffects, verifyCommittedTree, maintenanceTitle,
};
