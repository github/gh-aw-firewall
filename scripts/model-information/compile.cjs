#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { identity } = require('../../shared/model-information/identity');
const { validate, validateRecords } = require('../../shared/model-information/contracts');
const { importLegacySnapshot } = require('../../shared/model-information/import-legacy-snapshot');
const schema = require('../../shared/model-information/schema.v1.json');
const exact = require('../../shared/model-information/exact-pricing');
const pricingConsumer = require('../../shared/model-information/pricing-consumer');
const { json: consumerJson, digest } = require('../../shared/model-information/publication-contract.cjs');

const rootArgument = process.argv.find(arg => arg.startsWith('--root='));
if (rootArgument && !process.argv.includes('--check')) {
  throw new Error('--root is only available in check mode');
}
const root = rootArgument ? path.resolve(rootArgument.slice('--root='.length)) : path.resolve(__dirname, '../..');
const legacyPricing = require(path.join(root, 'containers/api-proxy/ai-credits-pricing.js'));
const sourceArgument = process.argv.find(arg => arg.startsWith('--source-dir='));
if (sourceArgument && !process.argv.includes('--check')) {
  throw new Error('--source-dir is only available in check mode');
}
const sources = sourceArgument
  ? path.resolve(sourceArgument.slice('--source-dir='.length))
  : path.join(root, 'shared/model-information/sources');
const compilerVersion = 8;
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
const latestTimestamp = provenances => provenances
  .map(item => new Date(item.at).toISOString()).sort().at(-1);

function compile() {
  if (process.argv.includes('--contracts-only') || process.argv.includes('--reasoning-types-only')) {
    const typesOnly = process.argv.includes('--reasoning-types-only');
    const directories = typesOnly ? ['dist/model-information-contract']
      : ['containers/api-proxy/catalogue-contract', 'src/model-information-contract'];
    const files = typesOnly ? ['identity.d.ts', 'resolution.d.ts', 'reasoning.d.ts']
      : ['reasoning.js', 'reasoning.d.ts'];
    for (const directory of directories) {
      for (const file of files) {
        const content = fs.readFileSync(path.join(root, 'shared/model-information', file), 'utf8');
        const filename = path.join(root, directory, file);
        if (process.argv.includes('--check')) {
          if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== content) {
            throw new Error(`${directory}/${file}: stale reasoning contract`);
          }
        } else fs.writeFileSync(filename, content);
      }
    }
    return;
  }
  const files = fs.readdirSync(sources).filter(file => file.endsWith('.json')).sort();
  const importedFile = 'shared/model-information/imported/legacy-models-dev.snapshot.v1.json';
  const expectedImport = importLegacySnapshot(
    fs.readFileSync(path.join(root, 'containers/api-proxy/models.dev.catalog.json')),
    read('shared/model-information/imported/legacy-models-dev.metadata.json'),
  );
  if (process.argv.includes('--check') && json(read(importedFile)) !== json(expectedImport)) {
    throw new Error(`${importedFile}: pinned bytes, hash, counts, collisions or provenance changed; refresh explicitly`);
  }
  const imported = expectedImport;
  const importErrors = validate('importedSnapshot', imported);
  if (importErrors.length) throw new Error(`${importedFile}: ${importErrors.join('; ')}`);
  const records = files.filter(file => !['mapping.json', 'target.json', 'pricing-reference.json',
    'lifecycle-compatibility.json'].includes(file))
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
  errors.push(...validateRecords(models, rules).map(message => `maintained sources: ${message}`));
  if (errors.length) throw new Error(errors.join('\n'));
  // Imported lifecycle/type are schema placeholders, not provider facts.
  // Join only governed pricing; never overlay one maintained record on another.
  const assembled = new Map(imported.models.map(model => [model.identity.key, model]));
  for (const model of models) {
    const existing = assembled.get(model.identity.key);
    assembled.set(model.identity.key, {
      ...model,
      ...(existing?.importedPricing ? { importedPricing: existing.importedPricing } : {}),
    });
  }
  errors.push(...validateRecords([...assembled.values()], rules)
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
    if (data.modelProtocols !== undefined) {
      errors.push(`mapping.json: ${provider}: modelProtocols is generated from canonical model records`);
    }
    const patterns = new Map();
    const routingPatterns = new Map();
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
            entry.routing.reasoningEfforts.some(effort => typeof effort !== 'string' || !effort) ||
            !Number.isSafeInteger(entry.routing.contextWindowTokens) ||
            entry.routing.contextWindowTokens < 1 ||
            (entry.routing.reasoningMode !== undefined &&
              !['optional', 'required', 'forbidden', 'unknown'].includes(entry.routing.reasoningMode)) ||
            (entry.routing.reasoningMode === 'forbidden' && entry.routing.reasoningEfforts.length > 0) ||
            (entry.routing.reasoningMode === 'required' && entry.routing.reasoningEfforts.length === 0) ||
            (entry.routing.defaultEffort !== undefined &&
              (!entry.routing.reasoningEfforts.includes(entry.routing.defaultEffort) ||
                entry.routing.reasoningMode === 'forbidden'))))) {
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
      for (const pattern of entry.routingPatterns || []) {
        const routing = JSON.stringify(entry.routing || null);
        if (routingPatterns.has(pattern) && routingPatterns.get(pattern) !== routing) {
          errors.push(`mapping.json: ${provider}: conflicting routing pattern ${pattern}`);
        }
        routingPatterns.set(pattern, routing);
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
  const sortedModels = [...assembled.values()].sort((a, b) =>
    a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0);
  const target = JSON.parse(fs.readFileSync(path.join(sources, 'target.json'), 'utf8'));
  const compatibility = JSON.parse(fs.readFileSync(path.join(sources, 'lifecycle-compatibility.json'), 'utf8'));
  if (compatibility?.schemaVersion !== 1 || compatibility.provenance?.authority !== 'maintained' ||
      !compatibility.provenance.source || !compatibility.provenance.revision ||
      typeof compatibility.provenance.at !== 'string' ||
      Number.isNaN(Date.parse(compatibility.provenance.at)) ||
      !compatibility.provenance.confidence) {
    throw new Error('lifecycle-compatibility.json: expected reviewed provenance with a valid at timestamp');
  }
  if (target.schemaVersion !== 1 || target.provenance?.authority !== 'maintained' ||
      !target.provenance.at || !Array.isArray(target.availability) ||
      !Array.isArray(target.routing)) {
    throw new Error('target.json: invalid target metadata or corrections');
  }
  const generatedAt = latestTimestamp([{ at: imported.retrievedAt }, mapping.provenance,
    reference.provenance, ...records.map(([, data]) => data.provenance), target.provenance,
    compatibility.provenance]);
  const targetModels = new Map(sortedModels
    .map(model => [model.identity.key, structuredClone(model)]));
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
  const projectMapping = records => {
    const projected = structuredClone(mapping.mapping);
    for (const model of records) {
      if (!model.protocols?.length || model.provenance.authority !== 'maintained') continue;
      const provider = projected.providers[model.identity.provider];
      if (!provider) throw new Error(`mapping.json: missing protocol provider ${model.identity.provider}`);
      if (model.protocols.some(item => !provider.endpoints[item.protocol])) {
        throw new Error(`mapping.json: undefined protocol for ${model.identity.key}`);
      }
      provider.modelProtocols ||= Object.create(null);
      provider.modelProtocols[model.identity.rawId] = model.protocols;
    }
    return projected;
  };
  const baselineMapping = projectMapping(sortedModels);
  const targetMapping = projectMapping(resolvedTarget);
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
            endpoints: parent.endpoints,
            routing: { ...parent.routing, reasoningEfforts: entry.efforts },
            notes: 'Preview excludes xhigh; #10030.',
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
  const baselineByKey = new Map(sortedModels.map(model => [model.identity.key, model]));
  const targetByKey = new Map(resolvedTarget.map(model => [model.identity.key, model]));
  const differences = [...new Set([...baselineByKey.keys(), ...targetByKey.keys()])]
    .sort().flatMap(key => {
      const baseline = baselineByKey.get(key) || null;
      const target = targetByKey.get(key) || null;
      return JSON.stringify(baseline) === JSON.stringify(target)
        ? [] : [{ key, baseline, target }];
    });
  const supported = sortedModels.filter(model => model.identity.provider === 'copilot' &&
    !['retired', 'removed'].includes(model.lifecycle.status) && model.availability?.some(item =>
      item.scope.provider === 'copilot' && item.scope.channel === 'copilot-cli' &&
      item.scope.deployment === undefined && item.fact.state === 'supported'))
    .map(model => model.identity.rawId);
  const allowedSuggestions = new Set(['auto', ...supported]);
  const suggestionOrder = compatibility.suggestionOrder;
  if (!Array.isArray(suggestionOrder) ||
      suggestionOrder.length !== supported.length + 1 ||
      new Set(suggestionOrder).size !== suggestionOrder.length ||
      suggestionOrder.some(id => typeof id !== 'string' || !allowedSuggestions.has(id))) {
    throw new Error('lifecycle-compatibility.json: expected a permutation of canonical CLI IDs plus auto; ordering cannot author availability');
  }
  const pricing = Object.fromEntries(sortedModels.flatMap(model => {
    if (model.identity.provider !== 'copilot') return [];
    const tariffs = model.tariffs || [];
    if (!tariffs.length) return [];
    if (tariffs.some(tariff => tariff.scope.provider !== 'copilot' ||
        tariff.scope.channel !== 'copilot-api' || tariff.scope.deployment !== undefined ||
        tariff.currency !== 'USD' || tariff.unit !== 'USD_PER_1M_TOKENS' ||
        !['default', 'long_context', 'post_promotion'].includes(tariff.tier) ||
        (tariff.tier === 'post_promotion' && !tariff.effectiveFrom) ||
        (tariff.tier === 'long_context'
          ? !Number.isSafeInteger(tariff.promptTokensAbove) || tariff.promptTokensAbove <= 0
          : tariff.promptTokensAbove !== undefined) ||
        ['input', 'cachedInput', 'cacheWrite', 'output'].some(field => !tariff.components[field]) ||
        Object.entries(tariff.components).some(([field, item]) => {
          if (!['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'].includes(field)) return true;
          if (typeof item.price === 'object') return field !== 'cacheWrite';
          exact.decimal(item.price);
          return false;
        })) ||
        !tariffs.some(tariff => tariff.tier === 'default') ||
        tariffs.some((tariff, index) => tariffs.slice(index + 1).some(other =>
          (tariff.tier === 'long_context') === (other.tier === 'long_context') &&
          Math.max(tariff.effectiveFrom ? Date.parse(tariff.effectiveFrom) : -Infinity,
            other.effectiveFrom ? Date.parse(other.effectiveFrom) : -Infinity) <
          Math.min(tariff.effectiveUntil ? Date.parse(tariff.effectiveUntil) : Infinity,
            other.effectiveUntil ? Date.parse(other.effectiveUntil) : Infinity)))) {
      throw new Error(`Unsupported maintained fallback tariff: ${model.identity.key}`);
    }
    const name = model.identity.rawId.startsWith('claude-')
      ? model.identity.lookupId : model.identity.rawId;
    if (tariffs.some(tariff => tariff.effectiveFrom || tariff.effectiveUntil ||
        tariff.tier === 'post_promotion')) {
      return [[name, { tariffs }]];
    }
    const convert = tariff => ({
      ...Object.fromEntries(Object.entries(tariff.components).map(([key, item]) =>
        [key, typeof item.price === 'object' ? null : item.price])),
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
        const legacyPrice = legacyPricing[name];
        if (referenceNames.has(name) || !legacyPrice) {
          throw new Error(`pricing-reference.json: duplicate or unresolved curated model ${name}`);
        }
        referenceNames.add(name);
        const project = values => ({
          ...(values.threshold !== undefined ? { threshold: values.threshold } : {}),
          input: Number(values.input), cachedInput: Number(values.cachedInput),
          cacheWrite: values.cacheWrite === null ? null : Number(values.cacheWrite),
          output: Number(values.output), reasoning: Number(values.reasoning ?? values.output),
        });
        return [name, {
          ...project(legacyPrice),
          ...(legacyPrice.longContext ? { longContext: project(legacyPrice.longContext) } : {}),
        }];
      })),
    };
  }
  const retired = Object.fromEntries(sortedModels.filter(model => model.identity.provider === 'copilot' &&
    model.lifecycle.status === 'retired' &&
    model.lifecycle.replacement).map(model => [
    model.identity.rawId, model.lifecycle.replacement.split('/').slice(1).join('/'),
  ]));
  const naming = json({
    models: [...models].sort((a, b) =>
      a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0)
      .map(model => ({ identity: model.identity })),
    rules: [...rules].sort((a, b) =>
      JSON.stringify(sorted(a)) < JSON.stringify(sorted(b)) ? -1 :
        JSON.stringify(sorted(a)) > JSON.stringify(sorted(b)) ? 1 : 0),
  });
  const eligibility = json({
    models: sortedModels.filter(model => model.harnesses && model.harnesses.length).map(model => ({
      identity: model.identity, harnesses: model.harnesses,
    })),
  });
  // OpenRouter namespaces identify the model publisher, not a native billing
  // backend. Only OpenRouter's full wire ID is associated with these imports.
  const nativeCompatibility = reference.nativeCompatibility;
  if (nativeCompatibility?.policy !== 'legacy_native_compatibility' ||
      nativeCompatibility.channel !== 'native-api' ||
      !nativeCompatibility.note || !nativeCompatibility.evidence ||
      !nativeCompatibility.additionalModels) {
    throw new Error('pricing-reference.json: expected explicit legacy native compatibility policy');
  }
  const projectCompatibility = (values, includeReasoning = true) => ({
    input: String(values.input), cachedInput: String(values.cachedInput),
    cacheWrite: values.cacheWrite === null ? null : String(values.cacheWrite),
    output: String(values.output),
    ...(values.reasoning !== undefined || includeReasoning
      ? { reasoning: String(values.reasoning ?? values.output) } : {}),
    ...(values.threshold !== undefined ? { threshold: values.threshold } : {}),
  });
  const compatibilityProviders = Object.fromEntries(Object.entries(referenceProviders).map(([provider, data]) =>
    [provider, Object.fromEntries(Object.keys(data.models).map(name => {
      const rate = legacyPricing[name];
      return [name, {
        ...projectCompatibility(rate),
        ...(rate.longContext ? { longContext: projectCompatibility(rate.longContext) } : {}),
      }];
    }))]));
  for (const [provider, names] of Object.entries(nativeCompatibility.additionalModels)) {
    if (!compatibilityProviders[provider] || !Array.isArray(names) ||
        new Set(names).size !== names.length ||
        names.some(name => !legacyPricing[name] ||
          Object.hasOwn(compatibilityProviders[provider], name))) {
      throw new Error(`pricing-reference.json: invalid native compatibility associations for ${provider}`);
    }
    for (const name of names) {
      const rate = legacyPricing[name];
      compatibilityProviders[provider][name] = {
        ...projectCompatibility(rate, false),
        ...(rate.longContext ? { longContext: projectCompatibility(rate.longContext, false) } : {}),
      };
    }
  }
  const fallbackPricing = {
    catalogRevision: revision,
    compatibility: {
      policy: nativeCompatibility.policy, channel: nativeCompatibility.channel,
      authority: 'policy', confidence: 'policy_fallback',
      sourceProvenance: reference.provenance, providers: compatibilityProviders,
    },
    imported: {
      openrouter: Object.fromEntries(imported.models.map(model =>
        [model.identity.key, model.importedPricing])),
    },
  };
  const pricingSnapshot = {
    kind: 'awf-pricing-consumer', schemaVersion: 1, schemaHash: pricingConsumer.schemaHash,
    catalogRevision: revision, generatedAt,
    maintained: sortedModels.filter(model =>
      model.provenance.authority === 'maintained' && model.tariffs?.length).map(model => ({
      identity: Object.fromEntries(['key', 'provider', 'rawId', 'lookupId']
        .map(key => [key, model.identity[key]])),
      provenance: model.provenance, tariffs: model.tariffs,
    })),
    compatibility: fallbackPricing.compatibility,
    imported: Object.entries(fallbackPricing.imported).map(([provider, prices]) => ({
      scope: { provider, channel: 'native-api' }, prices,
    })),
  };
  const pricingSnapshotBytes = consumerJson({
    ...pricingSnapshot, revision: digest(consumerJson(pricingSnapshot)),
  });
  pricingConsumer.readPricingSnapshot(pricingSnapshotBytes);
  const output = {
    'shared/model-information/pricing-consumer.v1.generated.json': pricingSnapshotBytes,
    [importedFile]: json(imported),
    'shared/model-information/naming.generated.json': naming,
    'containers/api-proxy/model-information.naming.generated.json': naming,
    'src/model-information.naming.generated.json': naming,
    'src/model-information.compat.generated.json': json({ supported: ['auto', ...supported], retired, suggestionOrder }),
    'src/model-information.eligibility.generated.json': eligibility,
    'containers/api-proxy/model-information.eligibility.generated.json': eligibility,
    'containers/api-proxy/model-information.pricing.generated.json': json(pricing),
    'containers/api-proxy/model-information.fallback-pricing.generated.json': json(fallbackPricing),
    'containers/api-proxy/model-information.retired.generated.json': json(retired),
    'containers/api-proxy/ai-credits-pricing-reference.json': json({
      schemaVersion: 1, unit: 'USD_PER_1M_TOKENS',
      catalogId: reference.catalogId, version: reference.version, providers: referenceProviders,
    }),
    'docs/model-api-mapping.json': json(baselineMapping),
    'containers/api-proxy/model-api-mapping.json': json(baselineMapping),
    'shared/model-information/catalog.generated.json': json({
      schemaVersion: 1, catalogRevision: revision, generatedAt, models: sortedModels,
    }),
    'shared/model-information/manifest.generated.json': json({
      schemaVersion: 1, compilerVersion, schemaHash, catalogRevision: revision,
      generatedAt, sourceFiles: [...files.map(file => `shared/model-information/sources/${file}`),
        'containers/api-proxy/models.dev.catalog.json',
        'shared/model-information/imported/legacy-models-dev.metadata.json'],
      import: {
        importerVersion: imported.importerVersion, sha256: imported.sha256,
        accepted: imported.accepted, rejected: imported.rejected, collisions: imported.collisions,
      },
    }),
    'shared/model-information/target.generated.json': json({
      schemaVersion: 1, catalogRevision: revision, generatedAt,
      models: resolvedTarget.sort((a, b) =>
        a.identity.key < b.identity.key ? -1 : a.identity.key > b.identity.key ? 1 : 0),
    }),
    'shared/model-information/baseline-to-target.generated.json': json({
      schemaVersion: 1, catalogRevision: revision, activation: 'staged: phases 4, 5 and 6',
      differences, mapping: { baseline: baselineMapping, target: targetMapping },
    }),
  };
  errors.push(...validate('resolvedExport', JSON.parse(output['shared/model-information/catalog.generated.json'])));
  errors.push(...validate('resolvedExport', JSON.parse(output['shared/model-information/target.generated.json'])));
  for (const file of ['contracts.js', 'contracts.d.ts', 'identity.js', 'identity.d.ts', 'resolution.js', 'resolution.d.ts',
    'reasoning.js', 'reasoning.d.ts',
    'eligibility.js', 'eligibility.d.ts', 'harness-observation.js', 'harness-observation.d.ts',
    'pricing-resolution.js', 'pricing-resolution.d.ts', 'exact-pricing.js', 'schema.v1.json',
    'publication.v1.schema.json', 'publication-contract.cjs', 'publication.cjs',
    'publication.v2.schema.json', 'publication.v2.cjs']) {
    output[`containers/api-proxy/catalogue-contract/${file}`] =
      fs.readFileSync(path.join(root, 'shared/model-information', file), 'utf8');
  }
  for (const file of ['identity.js', 'identity.d.ts', 'resolution.js', 'resolution.d.ts', 'eligibility.js', 'eligibility.d.ts',
    'reasoning.js', 'reasoning.d.ts',
    'harness-observation.js', 'harness-observation.d.ts', 'pricing-resolution.js', 'pricing-resolution.d.ts',
    'exact-pricing.js']) {
    output[`src/model-information-contract/${file}`] =
      fs.readFileSync(path.join(root, 'shared/model-information', file), 'utf8');
  }
  if (errors.length) throw new Error(errors.join('\n'));
  for (const [file, content] of Object.entries(output)) {
    const filename = path.join(root, file);
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== content) {
        errors.push(`${file}: stale; run npm run models:generate`);
      }
    } else {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`${process.argv.includes('--check') ? 'Checked' : 'Generated'} model catalogue ${revision}`);
}

if (require.main === module) compile();

module.exports = { latestTimestamp };
