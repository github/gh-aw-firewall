'use strict';

const { identity, normalizeId, matchModel, matchFamilyRule } = require('./identity');
const { isDeepStrictEqual } = require('node:util');

function stripRedundantProviderPrefix(model, provider) {
  if (typeof model !== 'string' || typeof provider !== 'string') return model;
  const prefix = `${provider}/`;
  return model.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
    ? model.slice(prefix.length) || model : model;
}

function ambiguous(candidate, scope, matches) {
  const error = new Error(
    `Ambiguous model identity "${candidate}" for ${scope.provider}/${scope.channel}: ` +
    `${matches.join(', ')}. Use an exact model ID or disambiguate the reviewed aliases/rules.`,
  );
  error.code = 'ambiguous_model_identity';
  error.statusCode = 400;
  return error;
}

function resolveIdentity(requestedModel, scope, view, policy = {}) {
  const candidate = policy.providerPrefix === false
    ? requestedModel : stripRedundantProviderPrefix(requestedModel, scope.provider);
  const parameterIndex = typeof candidate === 'string' ? candidate.indexOf('?') : -1;
  const rawId = parameterIndex < 0 ? candidate : candidate.slice(0, parameterIndex);
  const parameterSuffix = parameterIndex < 0 ? '' : candidate.slice(parameterIndex);
  let resolvedIdentity;
  try {
    resolvedIdentity = identity(scope.provider, rawId);
  } catch {
    // Malformed or non-string request values remain opaque to request consumers.
    return {
      requestedModel, identity: null, wireId: requestedModel,
      matchKind: 'unmatched', parameterSuffix: '', model: requestedModel,
    };
  }

  const models = view.models || [];
  const scoped = models.filter(record => record.identity.provider === scope.provider);
  const select = matches => {
    const distinct = [...new Map(matches.map(record => [record.identity.key, record])).values()];
    if (distinct.length > 1) {
      throw ambiguous(rawId, scope, distinct.map(record => record.identity.key).sort());
    }
    return distinct[0];
  };
  // Raw exact IDs take precedence even when normalization or aliases would collide.
  let selected = select(scoped.filter(record =>
    record.identity.rawId === rawId && matchModel(record, rawId, scope)));
  let matchKind = selected ? 'exact' : 'unmatched';
  const matchingPolicy = { ...policy, providerPrefix: false };
  if (!selected) {
    selected = select(scoped.filter(record =>
      normalizeId(record.identity.rawId, matchingPolicy) === normalizeId(rawId, matchingPolicy) &&
      matchModel(record, rawId, scope, matchingPolicy)?.kind === 'exact'));
    if (selected) matchKind = 'exact';
  }
  if (!selected) {
    selected = select(scoped.filter(record =>
      matchModel(record, rawId, scope, matchingPolicy)?.kind === 'alias'));
    if (selected) matchKind = 'alias';
  }
  if (selected) resolvedIdentity = selected.identity;
  const wireId = selected ? selected.identity.rawId : rawId;
  const familyMatches = (view.rules || []).filter(rule =>
    matchFamilyRule(rule, wireId, scope, models));
  const families = new Set(familyMatches.map(rule =>
    normalizeId(rule.family, { caseInsensitive: true, separators: true })));
  const facts = new Map();
  const conflictingFacts = familyMatches.some(rule => {
    const key = JSON.stringify([
      normalizeId(rule.family, { caseInsensitive: true, separators: true }), rule.field,
    ]);
    if (facts.has(key) && !isDeepStrictEqual(facts.get(key), rule.value)) return true;
    facts.set(key, rule.value);
    return false;
  });
  if (families.size > 1 || conflictingFacts) {
    throw ambiguous(rawId, scope, familyMatches.map(rule =>
      `${rule.provider}/${rule.family} (${rule.field})`).sort());
  }
  const family = resolvedIdentity.family || familyMatches.map(rule => rule.family).sort()[0];
  if (!selected && familyMatches.length) matchKind = 'family';
  return {
    requestedModel, identity: resolvedIdentity, wireId, matchKind, parameterSuffix,
    model: wireId + parameterSuffix, ...(family ? { family } : {}),
  };
}

module.exports = { resolveIdentity, stripRedundantProviderPrefix };
