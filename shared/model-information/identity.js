'use strict';

function normalizeId(id, { caseInsensitive = false, separators = false, stripDate = false } = {}) {
  let result = id;
  if (stripDate) result = result.replace(/(-alpha)?-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  if (separators) result = result.replace(/[._]/g, '-');
  if (caseInsensitive) result = result.toLowerCase();
  return result;
}

function identity(provider, rawId) {
  if (typeof provider !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(provider) ||
      typeof rawId !== 'string' || !rawId || /[/?#]/.test(rawId)) {
    throw new Error('Invalid provider-qualified model identity');
  }
  return {
    key: `${provider}/${rawId}`, provider, rawId,
    lookupId: normalizeId(rawId, { caseInsensitive: true, separators: true }),
  };
}

function matchModel(record, candidate, scope, policy = {}) {
  if (record.identity.provider !== scope.provider || typeof candidate !== 'string') return null;
  const { rawId, aliases = [] } = record.identity;
  const requested = policy.providerPrefix && candidate.startsWith(`${scope.provider}/`)
    ? candidate.slice(scope.provider.length + 1) : candidate;
  const normalized = normalizeId(requested, policy);
  const exact = normalizeId(rawId, policy);
  if (normalized === exact) return { key: record.identity.key, kind: 'exact' };
  for (const alias of aliases) {
    if (alias.scope.provider !== scope.provider || alias.scope.channel !== scope.channel ||
        alias.scope.deployment !== scope.deployment) continue;
    const aliasPolicy = alias.match === 'exact' ? {} : {
      separators: alias.match === 'separators',
      caseInsensitive: alias.match === 'case-insensitive',
    };
    if (normalizeId(requested, aliasPolicy) === normalizeId(alias.id, aliasPolicy)) {
      return { key: record.identity.key, kind: 'alias' };
    }
  }
  return null;
}

function matchFamilyRule(rule, candidate, scope, declaredModels = []) {
  if (scope.provider !== rule.provider || scope.channel !== rule.scope.channel ||
      scope.deployment !== rule.scope.deployment || typeof candidate !== 'string') return null;
  const family = normalizeId(rule.family, { caseInsensitive: true, separators: true });
  const id = normalizeId(candidate, { caseInsensitive: true, separators: true });
  if (id !== family && !id.startsWith(`${family}-`)) return null;
  if (rule.excludes.includes(`${rule.provider}/${candidate}`) ||
      declaredModels.some(model => model.identity.provider === rule.provider &&
        model.identity.lookupId === id && model.identity.family !== rule.family)) return null;
  return { kind: 'family', rule };
}

module.exports = { identity, normalizeId, matchModel, matchFamilyRule };
