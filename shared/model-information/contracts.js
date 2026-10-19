'use strict';

const Ajv2020 = require('ajv/dist/2020');
const schema = require('./schema.v1.json');
const { identity, normalizeId } = require('./identity');

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addFormat('date-time', {
  type: 'string',
  validate: value => {
    const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(value);
    if (!parts) return false;
    const [, year, month, day, hour, minute, second, zone] = parts;
    const calendar = new Date(Date.UTC(+year, +month - 1, +day));
    return calendar.getUTCFullYear() === +year && calendar.getUTCMonth() === +month - 1 &&
      calendar.getUTCDate() === +day && +hour < 24 && +minute < 60 && +second < 60 &&
      (zone === 'Z' || (+zone.slice(1, 3) <= 23 && +zone.slice(4) < 60)) &&
      !Number.isNaN(Date.parse(value));
  },
});
ajv.addSchema(schema);
const kinds = ['model', 'overlay', 'importedSnapshot', 'centralFeed', 'resolvedExport', 'rule'];
const validators = Object.fromEntries(kinds.map(kind => [
  kind, ajv.compile({ $ref: `${schema.$id}#/$defs/${kind}` }),
]));

function stableStringify(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(stableStringify));
  if (value && typeof value === 'object') {
    return JSON.stringify(Object.keys(value).sort().map(key => [key, stableStringify(value[key])]));
  }
  return JSON.stringify(value);
}

function validate(kind, value) {
  if (!Object.hasOwn(validators, kind)) throw new Error(`Unknown contract: ${kind}`);
  const valid = validators[kind](value);
  if (!valid) return validators[kind].errors.map(error =>
    `${error.instancePath || '/'} ${error.message}`);
  if (['overlay', 'importedSnapshot', 'centralFeed', 'resolvedExport'].includes(kind)) {
    const errors = validateRecords(value.models, value.rules || []);
    if (kind === 'centralFeed') {
      for (const model of value.models) {
        if (model.availability?.length || model.lifecycle.status !== 'active') {
          errors.push(`Central feed cannot establish availability or lifecycle: ${model.identity.key}`);
        }
      }
    }
    if (kind === 'importedSnapshot' && value.accepted !== value.models.length) {
      errors.push('Imported snapshot accepted count does not match models');
    }
    return errors;
  }
  return [];
}

function validateRecords(models, rules = []) {
  const errors = [];
  const keys = new Set();
  const lookups = new Set();
  const aliases = [];
  for (const model of models) {
    const validation = validate('model', model);
    errors.push(...validation);
    if (validation.length) continue;
    const id = model.identity;
    const expected = identity(id.provider, id.rawId);
    if (id.key !== expected.key || id.lookupId !== expected.lookupId) {
      errors.push(`Invalid identity projection: ${id.key}`);
    }
    if (keys.has(id.key)) errors.push(`Duplicate exact key: ${id.key}`);
    keys.add(id.key);
    const lookupKey = `${id.provider}/${id.lookupId}`;
    if (lookups.has(lookupKey)) errors.push(`Duplicate normalized exact key: ${lookupKey}`);
    lookups.add(lookupKey);
    if (model.lifecycle.replacement && model.lifecycle.replacement === id.key) {
      errors.push(`Self replacement: ${id.key}`);
    }
    for (const alias of id.aliases || []) {
      if (alias.scope.provider !== id.provider) {
        errors.push(`Cross-provider alias: ${alias.id}`);
      }
      const ambiguous = aliases.some(({ alias: prior, key }) => key !== id.key &&
        prior.scope.provider === alias.scope.provider &&
        prior.scope.channel === alias.scope.channel &&
        prior.scope.deployment === alias.scope.deployment &&
        [alias.match, prior.match].some(match => {
          const options = { caseInsensitive: match === 'case-insensitive', separators: match === 'separators' };
          return normalizeId(alias.id, options) === normalizeId(prior.id, options);
        }));
      if (ambiguous) {
        errors.push(`Ambiguous scoped alias: ${alias.id}`);
      }
      aliases.push({ alias, key: id.key });
    }
    for (const tariff of model.tariffs || []) {
      if (tariff.scope.provider !== id.provider) errors.push(`Cross-provider tariff: ${id.key}`);
      if (tariff.effectiveFrom && tariff.effectiveUntil &&
          Date.parse(tariff.effectiveFrom) >= Date.parse(tariff.effectiveUntil)) {
        errors.push(`Invalid tariff interval: ${id.key}`);
      }
    }
  }
  for (const model of models) {
    if (model.lifecycle?.replacement && !keys.has(model.lifecycle.replacement)) {
      errors.push(`Unresolved replacement: ${model.lifecycle.replacement}`);
    }
  }
  for (const { alias, key } of aliases) {
    const lookup = `${alias.scope.provider}/${normalizeId(alias.id, {
      caseInsensitive: true, separators: true,
    })}`;
    if (lookups.has(lookup) && !models.some(model =>
      model.identity.key === key && `${model.identity.provider}/${model.identity.lookupId}` === lookup)) {
      errors.push(`Alias collides with exact key: ${alias.id}`);
    }
  }
  const seenRules = new Map();
  for (const rule of rules) {
    const validation = validate('rule', rule);
    errors.push(...validation);
    if (validation.length) continue;
    if (rule.provider !== rule.scope.provider) errors.push(`Rule provider/scope mismatch: ${rule.family}`);
    const token = JSON.stringify([
      rule.provider, normalizeId(rule.family, { caseInsensitive: true, separators: true }),
      rule.scope.channel, rule.scope.deployment || '', rule.field,
    ]);
    if (seenRules.has(token) && seenRules.get(token) !== stableStringify(rule.value)) {
      errors.push(`Conflicting equal-specificity rules: ${token}`);
    }
    seenRules.set(token, stableStringify(rule.value));
    for (const model of models) {
      if (model.identity?.provider !== rule.provider) continue;
      const id = model.identity.lookupId;
      const family = normalizeId(rule.family, { caseInsensitive: true, separators: true });
      if (id.startsWith(`${family}-`) && !rule.excludes.includes(model.identity.key)) {
        errors.push(`Family captures declared exception: ${model.identity.key}`);
      }
    }
  }
  return errors;
}

function projectConfiguredCatalogResolution(resolution, scope) {
  if (!resolution || resolution.source !== 'shared_catalog') {
    throw new Error('Expected a resolved configured shared catalogue tariff');
  }
  const provenance = {
    authority: 'configured_catalog',
    source: 'shared_catalog',
    revision: `${resolution.pricingCatalogId}/${resolution.pricingCatalogVersion}`,
    ...(scope.reviewedAt ? { at: scope.reviewedAt, freshness: 'fresh' } : { freshness: 'unknown' }),
  };
  const components = Object.fromEntries(
    Object.entries(resolution.pricing).filter(([name]) => name !== 'threshold').map(([name, price]) =>
      [name, { price: price === null ? { unavailable: true } : String(price), provenance }]),
  );
  return {
    scope: { provider: scope.provider, channel: scope.channel, ...(scope.deployment ? { deployment: scope.deployment } : {}) },
    currency: 'USD', unit: 'USD_PER_1M_TOKENS', tier: resolution.tier,
    ...(resolution.tier === 'long_context' ? { promptTokensAbove: resolution.pricing.threshold } : {}),
    components, provenance,
  };
}

module.exports = { validate, validateRecords, projectConfiguredCatalogResolution };
