#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { identity } = require('../../shared/model-information/identity');
const { validate, validateRecords } = require('../../shared/model-information/contracts');
const { importPinnedLegacySnapshot } = require('../../shared/model-information/import-legacy-snapshot');
const schema = require('../../shared/model-information/schema.v1.json');

const root = path.resolve(__dirname, '../..');
const sourceArgument = process.argv.find(arg => arg.startsWith('--source-dir='));
if (sourceArgument && !process.argv.includes('--check')) {
  throw new Error('--source-dir is only available in check mode');
}
const sources = sourceArgument
  ? path.resolve(sourceArgument.slice('--source-dir='.length))
  : path.join(root, 'shared/model-information/sources');
const compilerVersion = 1;
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const sorted = value => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sorted(value[key])]),
  );
  return value;
};

function seed() {
  if (fs.existsSync(sources)) throw new Error('Sources already exist; refusing to overwrite reviewed data');
  const host = fs.readFileSync(path.join(root, 'src/copilot-model.ts'), 'utf8');
  const names = [...host.match(/const SUPPORTED_COPILOT_MODELS = new Set\(\[([\s\S]*?)\]\)/)[1]
    .matchAll(/'([^']+)'/g)].map(match => match[1]);
  const prices = require('../../containers/api-proxy/ai-credits-pricing');
  const retired = require('../../containers/api-proxy/guards/retired-model-guard');
  const replacement = 'gpt-5.3-codex';
  if (retired.getRetiredModelBlockState('gpt-5-codex')?.suggestion !== replacement) {
    throw new Error('Legacy retirement map changed; review seed migration');
  }
  const reviewedAt = new Date(execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toISOString();
  const inputs = ['src/copilot-model.ts', 'containers/api-proxy/ai-credits-pricing.js',
    'containers/api-proxy/guards/retired-model-guard.js', 'docs/model-api-mapping.json'];
  const provenance = {
    authority: 'maintained', source: 'pinned legacy compatibility capture',
    revision: sha256(inputs.map(file => fs.readFileSync(path.join(root, file))).join('\n')),
    at: reviewedAt, confidence: 'estimated',
  };
  const byProvider = new Map();
  const normalizedName = name => name.toLowerCase().replace(/[._]/g, '-');
  const hostNames = new Map(names.filter(name => name !== 'auto').map(name => [normalizedName(name), name]));
  const priceNames = new Map(Object.keys(prices).map(name => [normalizedName(name), name]));
  for (const normalized of new Set([...hostNames.keys(), ...priceNames.keys(), 'gpt-5-codex'])) {
    const rawId = hostNames.get(normalized) || priceNames.get(normalized) || normalized;
    const provider = rawId.startsWith('claude-') ? 'anthropic' :
      rawId.startsWith('gemini-') ? 'google' : rawId.startsWith('grok-') ? 'x-ai' :
        rawId.startsWith('mai-') ? 'microsoft' : 'openai';
    const id = identity('copilot', rawId);
    const price = prices[priceNames.get(normalized)];
    const record = {
      schemaVersion: 1, identity: id,
      lifecycle: normalized === 'gpt-5-codex'
        ? { status: 'retired', replacement: 'copilot/gpt-5.3-codex' } : { status: 'active' },
      modelType: rawId.startsWith('text-embedding-') ? 'embedding' : 'completion',
      ...(hostNames.has(normalized) ? { availability: [{
        scope: { provider: 'copilot', channel: 'copilot-cli' },
        fact: { state: 'supported', provenance },
      }] } : {}),
      ...(price ? { tariffs: Object.entries({ default: price, ...(price.longContext ? { long_context: price.longContext } : {}) })
        .map(([tier, values]) => ({
          scope: { provider: 'copilot', channel: 'copilot-api' },
          currency: 'USD', unit: 'USD_PER_1M_TOKENS', tier,
          ...(tier === 'long_context' ? { promptTokensAbove: values.threshold } : {}),
          components: Object.fromEntries(Object.entries(values)
            .filter(([key]) => key !== 'longContext' && key !== 'threshold')
            .map(([key, value]) => [key, {
              price: value === null ? { unavailable: true } : String(value),
              provenance,
            }])),
          provenance,
        })) } : {}),
      provenance,
    };
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(record);
  }
  fs.mkdirSync(sources, { recursive: true });
  for (const [provider, models] of byProvider) {
    fs.writeFileSync(path.join(sources, `${provider}.json`), json({
      schemaVersion: 1, provenance, models: models.sort((a, b) =>
        a.identity.key.localeCompare(b.identity.key, 'en')), rules: [],
    }));
  }
  fs.writeFileSync(path.join(sources, 'mapping.json'), json({
    schemaVersion: 1, provenance: {
      ...provenance, source: 'docs/model-api-mapping.json',
      revision: sha256(fs.readFileSync(path.join(root, 'docs/model-api-mapping.json'))),
      at: read('docs/model-api-mapping.json').lastUpdated,
    },
    mapping: read('docs/model-api-mapping.json'),
  }));
}

function compile() {
  const files = fs.readdirSync(sources).filter(file => file.endsWith('.json')).sort();
  const importedFile = 'shared/model-information/imported/legacy-models-dev.snapshot.v1.json';
  const imported = read(importedFile);
  const expectedImport = importPinnedLegacySnapshot();
  if (json(imported) !== json(expectedImport)) {
    throw new Error(`${importedFile}: pinned bytes, hash, counts, collisions or provenance changed; refresh explicitly`);
  }
  const importErrors = validate('importedSnapshot', imported);
  if (importErrors.length) throw new Error(`${importedFile}: ${importErrors.join('; ')}`);
  const records = files.filter(file => !['mapping.json', 'target.json', 'pricing-reference.json'].includes(file))
    .map(file => [file, JSON.parse(fs.readFileSync(path.join(sources, file), 'utf8'))]);
  const errors = [];
  for (const [file, data] of records) {
    if (data?.schemaVersion !== 1 || data.provenance?.authority !== 'maintained' ||
        !data.provenance.source || !data.provenance.revision ||
        !data.provenance.at || !data.provenance.confidence || !Array.isArray(data.models)) {
      errors.push(`${file}: expected schemaVersion, reviewed provenance and models`);
      continue;
    }
    if (data.rules !== undefined && !Array.isArray(data.rules)) {
      errors.push(`${file}: rules must be an array`);
      continue;
    }
    for (const [index, model] of data.models.entries()) {
      errors.push(...validate('model', model).map(message => `${file}: models[${index}] ${message}`));
    }
    for (const [index, rule] of (data.rules || []).entries()) {
      errors.push(...validate('rule', rule).map(message => `${file}: rules[${index}] ${message}`));
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const models = records.flatMap(([, data]) => data.models);
  const rules = records.flatMap(([, data]) => data.rules || []);
  errors.push(...validateRecords([...models, ...imported.models], rules)
    .map(message => `assembled sources and import: ${message}`));
  const mapping = JSON.parse(fs.readFileSync(path.join(sources, 'mapping.json'), 'utf8'));
  if (mapping?.schemaVersion !== 1 || mapping.provenance?.authority !== 'maintained' ||
      !mapping.provenance.source || !mapping.provenance.revision ||
      !mapping.provenance.confidence ||
      !mapping.mapping?.providers || !mapping.mapping?.lastUpdated ||
      mapping.provenance.at !== mapping.mapping.lastUpdated) {
    errors.push('mapping.json: invalid pinned mapping/provenance');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  for (const [provider, data] of Object.entries(mapping.mapping.providers || {})) {
    if (!data || typeof data.endpoints !== 'object' || !Array.isArray(data.models)) {
      errors.push(`mapping.json: ${provider}: invalid endpoints/models`);
      continue;
    }
    const patterns = new Map();
    const families = new Set();
    for (const [index, entry] of (data.models || []).entries()) {
      if (!entry || typeof entry !== 'object') {
        errors.push(`mapping.json: ${provider}.models[${index}]: invalid mapping entry`);
        continue;
      }
      if (!entry.family || !Array.isArray(entry.patterns) || !entry.patterns.length ||
          entry.patterns.some(pattern => typeof pattern !== 'string' || !pattern) ||
          !Array.isArray(entry.endpoints) || entry.endpoints.some(name => !data.endpoints?.[name]) ||
          (entry.routingPatterns && (!Array.isArray(entry.routingPatterns) ||
            entry.routingPatterns.some(pattern => typeof pattern !== 'string' || !pattern))) ||
          (entry.routing && (!Array.isArray(entry.routing.reasoningEfforts) ||
            !Number.isSafeInteger(entry.routing.contextWindowTokens) ||
            entry.routing.contextWindowTokens < 1))) {
        errors.push(`mapping.json: ${provider}.models[${index}]: invalid mapping entry`);
      }
      if (families.has(entry.family)) errors.push(`mapping.json: ${provider}: duplicate family ${entry.family}`);
      families.add(entry.family);
      for (const pattern of entry.patterns || []) {
        if (patterns.has(pattern) && patterns.get(pattern) !== JSON.stringify(entry.endpoints)) {
          errors.push(`mapping.json: ${provider}: conflicting equal-specificity pattern ${pattern}`);
        }
        patterns.set(pattern, JSON.stringify(entry.endpoints));
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const schemaHash = sha256(json(sorted(schema)));
  const reference = JSON.parse(fs.readFileSync(path.join(sources, 'pricing-reference.json'), 'utf8'));
  if (reference.schemaVersion !== 1 || reference.provenance?.authority !== 'maintained' ||
      !reference.provenance.revision || !reference.provenance.at ||
      !reference.catalogId || !reference.version || !reference.providers) {
    throw new Error('pricing-reference.json: invalid review metadata');
  }
  const revision = sha256(json(sorted({
    compilerVersion, schemaHash, imported, sources: Object.fromEntries(files.map(file =>
      [file, JSON.parse(fs.readFileSync(path.join(sources, file), 'utf8'))])),
  })));
  const generatedAt = [{ at: imported.retrievedAt }, mapping.provenance, reference.provenance,
    ...records.map(([, data]) => data.provenance)]
    .map(item => new Date(item.at).toISOString()).sort().at(-1);
  const sortedModels = [...models, ...imported.models].sort((a, b) =>
    a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0);
  const target = JSON.parse(fs.readFileSync(path.join(sources, 'target.json'), 'utf8'));
  if (target.schemaVersion !== 1 || target.provenance?.authority !== 'maintained' ||
      !target.provenance.at || !Array.isArray(target.availability) ||
      !Array.isArray(target.routing)) {
    throw new Error('target.json: invalid target metadata or corrections');
  }
  const targetModels = new Map(models.map(model => [model.identity.key, structuredClone(model)]));
  const targetModel = (provider, rawId) => {
    const id = identity(provider, rawId);
    if (provider === 'copilot' && !targetModels.has(id.key)) {
      const existing = [...targetModels.values()].find(model =>
        model.identity.provider === provider && model.identity.lookupId === id.lookupId);
      if (existing) {
        targetModels.delete(existing.identity.key);
        existing.identity = id;
        targetModels.set(id.key, existing);
      }
    }
    if (!targetModels.has(id.key)) targetModels.set(id.key, {
      schemaVersion: 1, identity: id, lifecycle: { status: 'active' },
      modelType: 'completion', provenance: target.provenance,
    });
    return targetModels.get(id.key);
  };
  for (const rawId of target.availability) {
    const model = targetModel('copilot', rawId);
    if (model.availability?.some(entry => entry.scope.channel === 'copilot-cli')) {
      throw new Error(`target.json: duplicate availability correction: ${rawId}`);
    }
    model.availability = [...(model.availability || []), {
      scope: { provider: 'copilot', channel: 'copilot-cli' },
      fact: { state: 'supported', provenance: target.provenance },
    }];
  }
  for (const [rawId, rates] of Object.entries(target.tariffs || {})) {
    const model = targetModel('copilot', rawId);
    if (model.tariffs?.length) throw new Error(`target.json: duplicate curated tariff: ${rawId}`);
    const components = values => Object.fromEntries(['input', 'cachedInput', 'cacheWrite', 'output']
      .map((name, index) => [name, {
        price: values[index] === null ? { unavailable: true } : String(values[index]),
        provenance: target.provenance,
      }]));
    const base = {
      scope: { provider: 'copilot', channel: 'copilot-api' },
      currency: 'USD', unit: 'USD_PER_1M_TOKENS', tier: 'default',
      components: components(rates.default), provenance: target.provenance,
    };
    if (rates.promotionUntil) {
      base.promotion = 'promotional rate per #10029';
      base.effectiveUntil = rates.promotionUntil;
      base.successor = 'post_promotion';
    }
    model.tariffs = [base];
    if (rates.successor) model.tariffs.push({
      ...base, tier: 'post_promotion', components: components(rates.successor),
      effectiveFrom: rates.promotionUntil, promotion: undefined, successor: undefined,
      effectiveUntil: undefined,
    });
    if (rates.long) model.tariffs.push({
      ...base, tier: 'long_context', promptTokensAbove: rates.long[0],
      components: components(rates.long.slice(1)),
    });
    for (const tariff of model.tariffs) {
      for (const key of ['promotion', 'successor', 'effectiveUntil']) {
        if (tariff[key] === undefined) delete tariff[key];
      }
    }
  }
  for (const entry of target.routing) {
    const model = targetModel(entry.provider, entry.id);
    if (model.reasoning || model.limits) throw new Error(`target.json: duplicate routing: ${model.identity.key}`);
    model.identity.family = entry.family;
    model.reasoning = {
      support: 'supported', rawEfforts: entry.efforts, selectableEfforts: entry.efforts,
      mode: 'optional', provenance: target.provenance,
    };
    if (entry.context) model.limits = { contextTokens: entry.context, provenance: target.provenance };
  }
  for (const excluded of target.excludedVariants || []) {
    const [provider, ...raw] = excluded.split('/');
    const model = targetModel(provider, raw.join('/'));
    model.identity.family = model.identity.rawId;
    model.reasoning = {
      support: 'unknown', rawEfforts: [], selectableEfforts: [],
      mode: 'forbidden', provenance: target.provenance,
    };
  }
  const resolvedTarget = [...targetModels.values()].sort((a, b) =>
    a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0);
  const targetErrors = validateRecords(resolvedTarget);
  if (targetErrors.length) throw new Error(targetErrors.map(message => `target.json: ${message}`).join('\n'));
  const targetMapping = structuredClone(mapping.mapping);
  for (const entry of target.routing) {
    const family = targetMapping.providers[entry.provider]?.models.find(item => item.family === entry.family);
    if (!family) {
      if (entry.provider === 'openai' && entry.family === 'gpt-5.4-mini') {
        const family54 = targetMapping.providers.openai.models.findIndex(item => item.family === 'gpt-5.4');
        targetMapping.providers.openai.models.splice(family54, 0, {
          family: entry.family, patterns: ['gpt-5.4-mini*'],
          endpoints: ['chat_completions', 'responses'], notes: 'Exact reviewed mini routing; #10030.',
        });
      } else if (entry.provider === 'anthropic' && entry.family === 'claude-mythos-preview') {
        const parent = targetMapping.providers.anthropic.models.find(item => item.family === 'claude-mythos-5');
        parent.routingPatterns = parent.routingPatterns.filter(pattern => pattern !== 'claude-mythos-preview*');
        targetMapping.providers.anthropic.models.splice(
          targetMapping.providers.anthropic.models.indexOf(parent), 0, {
            family: 'claude-mythos-preview', patterns: ['claude-mythos-preview*'],
            endpoints: parent.endpoints, notes: 'Preview excludes xhigh; #10030.',
          });
      } else throw new Error(`target.json: unknown mapped family ${entry.provider}/${entry.family}`);
    }
  }
  for (const entry of target.routing) {
    const family = targetMapping.providers[entry.provider].models.find(item => item.family === entry.family);
    if (entry.provider === 'anthropic' && entry.id === 'claude-opus-4.6') {
      const old = family;
      old.routingPatterns = ['claude-opus-4-8', 'claude-opus-4-7'];
      targetMapping.providers.anthropic.models.splice(
        targetMapping.providers.anthropic.models.indexOf(old), 0, {
          family: 'claude-opus-4-6', patterns: ['claude-opus-4-6'],
          endpoints: old.endpoints, routingPatterns: ['claude-opus-4-6'],
          routing: { reasoningEfforts: entry.efforts, contextWindowTokens: 1000000 },
          notes: 'Opus 4.6 does not support xhigh; #10030.',
        });
      continue;
    }
    if (entry.provider === 'anthropic' && entry.family === 'claude-opus-4') {
      family.routing.reasoningEfforts = entry.efforts;
      continue;
    }
    family.routingPatterns = [...new Set([...(family.routingPatterns || []),
      entry.id.replace(/claude-(opus|sonnet|haiku)-(\d+)\.(\d+)/, 'claude-$1-$2-$3')])];
    family.routing = {
      reasoningEfforts: entry.efforts,
      ...(entry.context || family.routing?.contextWindowTokens
        ? { contextWindowTokens: entry.context || family.routing.contextWindowTokens } : {}),
    };
    if (entry.provider === 'openai') {
      family.routingPatterns = [...new Set(target.routing.filter(item =>
        item.provider === 'openai' && item.family === entry.family).map(item => item.id)
        .concat(entry.family === 'gpt-5.5' ? ['gpt-5.5-2026-04-23'] : []))];
    }
  }
  const differences = resolvedTarget.filter(model =>
    JSON.stringify(model) !== JSON.stringify(models.find(item => item.identity.key === model.identity.key)))
    .map(model => ({
      key: model.identity.key,
      baseline: models.find(item => item.identity.key === model.identity.key) || null,
      target: model,
    }));
  const supported = sortedModels.filter(model => model.availability?.some(item =>
    item.scope.channel === 'copilot-cli' && item.fact.state === 'supported')).map(model => model.identity.rawId);
  const pricing = Object.fromEntries(sortedModels.flatMap(model => {
    if (model.identity.provider !== 'copilot') return [];
    const tariffs = model.tariffs || [];
    if (!tariffs.length) return [];
    const name = model.identity.rawId.startsWith('claude-')
      ? model.identity.lookupId : model.identity.rawId;
    const convert = tariff => ({
      ...Object.fromEntries(Object.entries(tariff.components).map(([key, item]) =>
        [key, typeof item.price === 'object' ? null : Number(item.price)])),
      ...(tariff.promptTokensAbove !== undefined ? { threshold: tariff.promptTokensAbove } : {}),
    });
    const base = tariffs.find(tariff => tariff.tier === 'default');
    const long = tariffs.find(tariff => tariff.tier === 'long_context');
    return [[name, { ...convert(base), ...(long ? { longContext: convert(long) } : {}) }]];
  }));
  const referenceProviders = {};
  const referenceNames = new Set();
  for (const [provider, data] of Object.entries(reference.providers)) {
    if (!data.source || !/^\d{4}-\d\d-\d\d$/.test(data.checkedAt) ||
        data.reasoningMatchesOutput !== true ||
        !Array.isArray(data.models)) throw new Error(`pricing-reference.json: invalid ${provider} scope`);
    referenceProviders[provider] = {
      source: data.source, checkedAt: data.checkedAt,
      models: Object.fromEntries(data.models.map(name => {
        if (referenceNames.has(name) || !pricing[name]) {
          throw new Error(`pricing-reference.json: duplicate or unresolved curated model ${name}`);
        }
        referenceNames.add(name);
        const rate = pricing[name];
        const project = values => ({
          ...(values.threshold !== undefined ? { threshold: values.threshold } : {}),
          input: values.input, cachedInput: values.cachedInput,
          cacheWrite: values.cacheWrite, output: values.output,
          reasoning: values.reasoning ?? (data.reasoningMatchesOutput ? values.output : undefined),
        });
        return [name, {
          ...project(rate),
          ...(rate.longContext ? { longContext: project(rate.longContext) } : {}),
        }];
      })),
    };
  }
  const retired = Object.fromEntries(sortedModels.filter(model => model.lifecycle.status === 'retired' &&
    model.lifecycle.replacement).map(model => [
    model.identity.rawId, model.lifecycle.replacement.split('/').slice(1).join('/'),
  ]));
  const output = {
    'src/model-information.compat.generated.json': json({ supported: ['auto', ...supported], retired }),
    'containers/api-proxy/model-information.pricing.generated.json': json(pricing),
    'containers/api-proxy/model-information.retired.generated.json': json(retired),
    'containers/api-proxy/ai-credits-pricing-reference.json': json({
      schemaVersion: 1, unit: 'USD_PER_1M_TOKENS',
      catalogId: reference.catalogId, version: reference.version, providers: referenceProviders,
    }),
    'docs/model-api-mapping.json': json(mapping.mapping),
    'containers/api-proxy/model-api-mapping.json': json(mapping.mapping),
    'shared/model-information/catalog.generated.json': json({
      schemaVersion: 1, catalogRevision: revision, generatedAt, models: sortedModels,
    }),
    'shared/model-information/manifest.generated.json': json({
      schemaVersion: 1, compilerVersion, schemaHash, catalogRevision: revision,
      generatedAt, sourceFiles: [...files.map(file => `shared/model-information/sources/${file}`), importedFile],
      import: {
        importerVersion: imported.importerVersion, sha256: imported.sha256,
        accepted: imported.accepted, rejected: imported.rejected, collisions: imported.collisions,
      },
    }),
    'shared/model-information/target.generated.json': json({
      schemaVersion: 1, catalogRevision: revision, generatedAt,
      models: [...resolvedTarget, ...imported.models.filter(model => !targetModels.has(model.identity.key))]
        .sort((a, b) =>
        a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0),
    }),
    'shared/model-information/baseline-to-target.generated.json': json({
      schemaVersion: 1, catalogRevision: revision, activation: 'staged: phases 4, 5 and 6',
      differences, mapping: { baseline: mapping.mapping, target: targetMapping },
    }),
  };
  errors.push(...validate('resolvedExport', JSON.parse(output['shared/model-information/catalog.generated.json'])));
  errors.push(...validate('resolvedExport', JSON.parse(output['shared/model-information/target.generated.json'])));
  if (errors.length) throw new Error(errors.join('\n'));
  for (const [file, content] of Object.entries(output)) {
    const filename = path.join(root, file);
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== content) {
        errors.push(`${file}: stale; run npm run models:generate`);
      }
    } else {
      fs.writeFileSync(filename, content);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`${process.argv.includes('--check') ? 'Checked' : 'Generated'} model catalogue ${revision}`);
}

if (process.argv.includes('--seed')) seed();
else compile();
