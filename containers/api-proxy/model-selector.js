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

/**
 * Resolve an already-selected scalar against the active provider catalogue.
 * Unknown API/deployment IDs remain provider-local; UI selectors never use
 * family-version or middle-power fallback and are never synthesized.
 */
function resolveModelSelector(selector, provider, modelIds, records, aliases = {}) {
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
  if (direct) return direct + suffix;

  const qualified = base.match(/^(.+) \(([^()]+)\)$/);
  const name = qualified ? qualified[1] : base;
  if (qualified && qualified[2].toLowerCase() !== provider.toLowerCase()) {
    throw selectorError(selector, provider, `vendor ${JSON.stringify(qualified[2])} does not match the active provider`);
  }
  const qualifiedId = qualified && ids.find(id => id.toLowerCase() === name.toLowerCase());
  if (qualifiedId) return qualifiedId + suffix;

  const aliasKey = Object.keys(aliases).find(key => key.toLowerCase() === base.toLowerCase()) ||
    (qualified && Object.keys(aliases).find(key => key.toLowerCase() === name.toLowerCase()));
  if (aliasKey) {
    // Ordinary aliases retain their existing resolution, policy and logging path.
    if (!qualified && !/\s/.test(base)) return null;
    const resolution = resolveModel(aliasKey, aliases, { [provider]: ids }, provider, [], { enabled: false });
    if (resolution && ids.includes(resolution.resolvedModel)) return resolution.resolvedModel + suffix;
    throw selectorError(selector, provider, 'the configured alias has no available catalog model');
  }

  const available = new Set(ids);
  const matches = [...new Set((records || [])
    .filter(record => available.has(record.id) &&
      typeof record.displayName === 'string' &&
      record.displayName.toLowerCase() === name.toLowerCase())
    .map(record => record.id))];
  if (matches.length > 1) {
    throw selectorError(selector, provider, 'the advertised display name is ambiguous; use a canonical ID');
  }
  if (matches.length === 1) return matches[0] + suffix;
  if (qualified || /\s/.test(base)) {
    throw selectorError(selector, provider, Array.isArray(modelIds)
      ? 'no advertised display name matches'
      : 'the active provider catalog is unavailable');
  }
  return null;
}

module.exports = { resolveModelSelector };
