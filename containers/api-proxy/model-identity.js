'use strict';

const { resolveIdentity } = require('./catalogue-contract/resolution');
const naming = require('./model-information.naming.generated.json');

function resolveModelIdentity(model, provider, options = {}) {
  return resolveIdentity(model, {
    provider,
    channel: provider === 'copilot' ? 'copilot-api' : 'native-api',
    ...options.scope,
  }, naming, { caseInsensitive: true, ...options.policy });
}

// Callers supply provider-native names; discovery owns availability and wire spelling.
function findAvailableModel(model, provider, availableModels = []) {
  const base = model.split('?')[0];
  const literal = availableModels.find(id => id.toLowerCase() ===
    base.toLowerCase());
  if (literal) return literal;
  const options = { policy: { providerPrefix: false } };
  const requested = resolveModelIdentity(model, provider, options);
  const direct = availableModels.find(id => id.toLowerCase() ===
    requested.wireId.toLowerCase());
  if (direct) return direct;
  if (requested.matchKind !== 'alias') return null;
  const matches = availableModels.filter(id =>
    resolveModelIdentity(id, provider, options).identity?.key === requested.identity?.key);
  if (matches.length > 1) {
    const error = new Error('Ambiguous available model identity; use an exact provider model ID');
    error.code = 'ambiguous_model_identity';
    error.statusCode = 400;
    throw error;
  }
  return matches[0] || null;
}

module.exports = { resolveModelIdentity, findAvailableModel };
