'use strict';

const { stripRedundantProviderPrefix } = require('./model-utils');
const { resolveModel } = require('./model-resolver');

function selectorError(selector, provider, reason) {
  const error = new Error(
    `Unsupported model selector ${JSON.stringify(selector)} on ${provider}: ${reason}. ` +
    'Use a canonical provider model ID, an unambiguous advertised display name, or ' +
    `"Model Name (${provider})". The custom-agent loader must select the first available ` +
    'entry from a prioritized frontmatter model list before sending a scalar to AWF. ' +
    'Check provider model discovery or configure an explicit apiProxy.models alias.',
  );
  error.code = 'unsupported_model_selector';
  error.statusCode = 400;
  error.type = 'invalid_request_error';
  return error;
}

function modelSelection(id, suffix) {
  const resolvedModel = id + suffix;
  return { resolvedModel, candidates: [resolvedModel], log: [] };
}

function resolveAliasSelection(selector, aliasKey, provider, ids, aliases, suffix, modelPolicy, qualified, base) {
  if (!aliasKey || (!qualified && !/\s/.test(base))) return null;
  const resolveAlias = policy => resolveModel(
    aliasKey, aliases, { [provider]: ids }, provider, [], { enabled: false }, policy,
  );
  const resolution = resolveAlias(modelPolicy) || (modelPolicy && resolveAlias(null));
  if (resolution && ids.includes(resolution.resolvedModel)) {
    return {
      ...resolution,
      resolvedModel: resolution.resolvedModel + suffix,
      candidates: (resolution.candidates || [resolution.resolvedModel]).map(id => id + suffix),
    };
  }
  throw selectorError(selector, provider, 'the configured alias has no available catalog model');
}

/**
 * Resolve an already-selected scalar against the active provider catalogue.
 * Unknown API/deployment IDs remain provider-local; UI selectors never use
 * family-version or middle-power fallback and are never synthesized.
 */
function resolveModelSelector(selector, provider, modelIds, records, aliases = {}, modelPolicy = null) {
  if (Array.isArray(selector)) {
    throw selectorError(selector, provider, 'prioritized lists belong to the consuming surface');
  }
  if (typeof selector !== 'string' || !selector) return null;
  const queryIndex = selector.indexOf('?');
  const suffix = queryIndex < 0 ? '' : selector.slice(queryIndex);
  const base = stripRedundantProviderPrefix(
    queryIndex < 0 ? selector : selector.slice(0, queryIndex), provider,
  );
  const ids = (modelIds || []).filter(id => typeof id === 'string');
  const direct = ids.find(id => id.toLowerCase() === base.toLowerCase());
  // Check IDs before interpreting punctuation: deployment names are arbitrary.
  if (direct) return modelSelection(direct, suffix);

  const exactAliasKey = Object.keys(aliases).find(key => key.toLowerCase() === base.toLowerCase());
  const exactAlias = resolveAliasSelection(
    selector, exactAliasKey, provider, ids, aliases, suffix, modelPolicy, false, base,
  );
  if (exactAlias) return exactAlias;

  const fullNameMatches = [...new Set((records || [])
    .filter(record => ids.includes(record.id) &&
      typeof record.displayName === 'string' &&
      record.displayName.toLowerCase() === base.toLowerCase())
    .map(record => record.id))];
  if (fullNameMatches.length > 1) {
    throw selectorError(selector, provider, 'the advertised display name is ambiguous; use a canonical ID');
  }
  if (fullNameMatches.length === 1) return modelSelection(fullNameMatches[0], suffix);

  const qualified = base.match(/^(.+) \(([^()]+)\)$/);
  const name = qualified ? qualified[1] : base;
  if (qualified && qualified[2].toLowerCase() !== provider.toLowerCase()) {
    const error = selectorError(selector, provider, `vendor ${JSON.stringify(qualified[2])} does not match the active provider`);
    error.catalogRefreshable = false;
    throw error;
  }
  const qualifiedId = qualified && ids.find(id => id.toLowerCase() === name.toLowerCase());
  if (qualifiedId) return modelSelection(qualifiedId, suffix);

  const aliasKey =
    (qualified && Object.keys(aliases).find(key => key.toLowerCase() === name.toLowerCase()));
  const aliasSelection = resolveAliasSelection(
    selector, aliasKey, provider, ids, aliases, suffix, modelPolicy, Boolean(qualified), base,
  );
  if (aliasSelection) return aliasSelection;

  const available = new Set(ids);
  const matches = [...new Set((records || [])
    .filter(record => available.has(record.id) &&
      typeof record.displayName === 'string' &&
      record.displayName.toLowerCase() === name.toLowerCase())
    .map(record => record.id))];
  if (matches.length > 1) {
    throw selectorError(selector, provider, 'the advertised display name is ambiguous; use a canonical ID');
  }
  if (matches.length === 1) return modelSelection(matches[0], suffix);
  if (qualified || /\s/.test(base)) {
    throw selectorError(selector, provider, Array.isArray(modelIds)
      ? 'no advertised display name matches'
      : 'the active provider catalog is unavailable');
  }
  return null;
}

module.exports = { resolveModelSelector };
