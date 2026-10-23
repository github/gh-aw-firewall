'use strict';

const Ajv2020 = require('ajv/dist/2020');
const schema = require('./schema.v1.json');
const {
  identity, normalizeId, familyMatches, familyRuleExcludes, familyRuleHasException,
} = require('./identity');

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
    if (kind === 'overlay') {
      for (const model of value.models) {
        if (model.identity.provider !== value.scope.provider) {
          errors.push(`Overlay model provider is outside scope: ${model.identity.key}`);
        }
        const scopes = [
          ...(model.identity.aliases || []).map(alias => alias.scope),
          ...(model.availability || []).map(item => item.scope),
          ...(model.harnesses || []).map(harness => harness.scope),
          ...(model.tariffs || []).map(tariff => tariff.scope),
        ];
        for (const scope of scopes) {
          if (!scopeIsWithin(scope, value.scope)) {
            errors.push(`Overlay scope does not contain model fact: ${model.identity.key}`);
          }
        }
      }
      for (const rule of value.rules || []) {
        if (!scopeIsWithin(rule.scope, value.scope)) {
          errors.push(`Overlay scope does not contain rule: ${rule.family}`);
        }
      }
    }
    if (kind === 'centralFeed') {
      if (value.provenance.authority !== 'central_feed') {
        errors.push('Central feed provenance must use central_feed authority');
      }
      for (const model of value.models) {
        if (!model || typeof model !== 'object') continue;
        const label = model.identity?.key || '(invalid model)';
        if (model.availability !== undefined || model.lifecycle?.status !== 'active' ||
            model.lifecycle?.replacement) {
          errors.push(`Central feed cannot establish availability or lifecycle: ${label}`);
        }
        for (const field of ['limits', 'modalities', 'reasoning', 'protocols', 'translations']) {
          if (Object.hasOwn(model, field)) {
            errors.push(`Central feed cannot establish ${field}: ${label}`);
          }
        }
        if (model.identity?.aliases !== undefined || model.identity?.family !== undefined) {
          errors.push(`Central feed cannot establish aliases or model family: ${label}`);
        }
        validateCentralFeedAuthority(model, label, errors);
      }
    }
    if (kind === 'importedSnapshot' && value.accepted !== value.models.length) {
      errors.push('Imported snapshot accepted count does not match models');
    }
    return errors;
  }
  return [];
}

function scopeIsWithin(scope, authority) {
  return scope.provider === authority.provider && scope.channel === authority.channel &&
    (authority.deployment === undefined || scope.deployment === authority.deployment);
}

function validateCentralFeedAuthority(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateCentralFeedAuthority(item, `${path}[${index}]`, errors));
  } else if (value && typeof value === 'object') {
    if (Object.hasOwn(value, 'authority') && value.authority !== 'central_feed') {
      errors.push(`Central feed cannot assert ${value.authority} authority: ${path}`);
    }
    for (const [key, item] of Object.entries(value)) {
      validateCentralFeedAuthority(item, `${path}.${key}`, errors);
    }
  }
}

function validateRecords(models, rules = []) {
  const errors = [];
  if (!Array.isArray(models)) return ['Models must be an array'];
  if (!Array.isArray(rules)) {
    errors.push('Rules must be an array');
    rules = [];
  }
  const keys = new Set();
  const lookups = new Set();
  const aliases = [];
  const validModels = [];
  for (const model of models) {
    const validation = validate('model', model);
    errors.push(...validation);
    if (validation.length) continue;
    const id = model.identity;
    let expected;
    try {
      expected = identity(id.provider, id.rawId);
    } catch {
      errors.push(`Invalid identity construction: ${id.key}`);
      continue;
    }
    if (id.key !== expected.key || id.lookupId !== expected.lookupId) {
      errors.push(`Invalid identity projection: ${id.key}`);
      continue;
    }
    validModels.push(model);
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
        normalizeId(alias.id, {
          caseInsensitive: alias.match === 'case-insensitive' || prior.match === 'case-insensitive',
          separators: alias.match === 'separators' || prior.match === 'separators',
        }) === normalizeId(prior.id, {
          caseInsensitive: alias.match === 'case-insensitive' || prior.match === 'case-insensitive',
          separators: alias.match === 'separators' || prior.match === 'separators',
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
  for (const model of validModels) {
    if (model.lifecycle?.replacement && !keys.has(model.lifecycle.replacement)) {
      errors.push(`Unresolved replacement: ${model.lifecycle.replacement}`);
    }
  }
  for (const { alias, key } of aliases) {
    const options = {
      caseInsensitive: alias.match === 'case-insensitive',
      separators: alias.match === 'separators',
    };
    if (validModels.some(model => model.identity.key !== key &&
        model.identity.provider === alias.scope.provider &&
        normalizeId(model.identity.rawId, options) === normalizeId(alias.id, options))) {
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
    for (const model of validModels) {
      if (model.identity.provider !== rule.provider) continue;
      const id = model.identity.lookupId;
      if (familyMatches(rule.family, id) && familyRuleHasException(rule, id, [model]) &&
          !familyRuleExcludes(rule, id)) {
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
    catalogId: resolution.pricingCatalogId,
    catalogVersion: resolution.pricingCatalogVersion,
    ...(scope.reviewedAt ? { at: scope.reviewedAt, freshness: 'fresh' } : { freshness: 'unknown' }),
  };
  const components = Object.fromEntries(
    Object.entries(resolution.pricing).filter(([name]) => name !== 'threshold').map(([name, price]) =>
      [name, { price: price === null ? '0' : decimalString(price), provenance }]),
  );
  return {
    scope: { provider: scope.provider, channel: scope.channel, ...(scope.deployment ? { deployment: scope.deployment } : {}) },
    currency: 'USD', unit: 'USD_PER_1M_TOKENS', tier: resolution.tier,
    ...(resolution.tier === 'long_context' ? { promptTokensAbove: Math.floor(resolution.pricing.threshold) } : {}),
    components, provenance,
  };
}

function decimalString(value) {
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, integer, fraction = '', exponentText] = match;
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer.length + Number(exponentText);
  if (decimalPosition <= 0) return `${sign}0.${'0'.repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) return `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

module.exports = { validate, validateRecords, projectConfiguredCatalogResolution };
