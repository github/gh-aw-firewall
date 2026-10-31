'use strict';

const { createEligibilityStore } = require('./catalogue-contract/eligibility');
const generated = require('./model-information.eligibility.generated.json');
const { resolveModelIdentity } = require('./model-identity');
const { getProviderAliases } = require('./provider-pricing-overlays');
const { stripRedundantProviderPrefix } = require('./model-utils');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const { getModelPolicyBlockState } = require('./guards/model-policy-guard');

const EMPTY_RECORDS = Object.freeze([]);
const discoveryIdentityCache = new WeakMap();

function getDiscoveryIdentityKeys(req, provider, scope, records) {
  let scopedCache = discoveryIdentityCache.get(req);
  if (!scopedCache) {
    scopedCache = new Map();
    discoveryIdentityCache.set(req, scopedCache);
  }
  const scopeKey = JSON.stringify(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right)));
  const cacheKey = `${provider}:${scopeKey}`;
  let cached = scopedCache.get(cacheKey);
  if (!cached || cached.records !== records) {
    const keys = new Set();
    for (const record of records) {
      const { identity } = resolveModelIdentity(record.id, provider, {
        scope, policy: { providerPrefix: false },
      });
      if (identity) keys.add(identity.key);
    }
    cached = { records, keys };
    scopedCache.set(cacheKey, cached);
  }
  return cached.keys;
}

// Only the embedding process may supply evidence. Request bodies, headers,
// remote catalogues and host-side version guesses are not trusted observations.
function createProxyEligibilityStore(initial = {}) {
  const state = evidence => {
    const models = new Map();
    for (const model of [...generated.models, ...(evidence.models || [])]) {
      const previous = models.get(model.identity.key);
      models.set(model.identity.key, {
        identity: model.identity,
        harnesses: [...(previous?.harnesses || []), ...(model.harnesses || [])],
      });
    }
    return { ...evidence, models: [...models.values()] };
  };
  const store = createEligibilityStore(state(initial));
  return Object.freeze({
    pin: () => store.pin(),
    replaceTrustedEvidence: evidence => store.replace(state(evidence)),
  });
}

const proxyEligibilityStore = createProxyEligibilityStore();

function pinRequestEligibility(req) {
  if (!req.awfEligibility) req.awfEligibility = proxyEligibilityStore.pin();
  if (req.awfEligibilityScope && !Object.isFrozen(req.awfEligibilityScope)) {
    req.awfEligibilityScope = Object.freeze({ ...req.awfEligibilityScope });
  }
  return req.awfEligibility;
}

function getModelEligibilityScope(provider, req = {}) {
  return {
    channel: provider === 'copilot' ? 'copilot-api' : 'native-api',
    ...(req.awfEligibilityScope?.provider === provider ? req.awfEligibilityScope : {}),
    provider,
  };
}

function evaluateModelEligibility(model, provider, req = {}, options = {}) {
  pinRequestEligibility(req);
  const consumerScope = getModelEligibilityScope(provider, req);
  const scope = { ...consumerScope, ...options.scope, provider };
  const prefix = options.inputMode !== 'native' && typeof model === 'string' && getProviderAliases(provider)
    .find(alias => model.toLowerCase().startsWith(`${alias}/`));
  const nativeModel = prefix ? stripRedundantProviderPrefix(model, prefix) : model;
  const { identity } = resolveModelIdentity(nativeModel, provider, { scope, policy: { providerPrefix: false } });
  const retired = getRetiredModelBlockState(model, provider, { inputMode: options.inputMode });
  const blocked = getModelPolicyBlockState(model, provider);
  const records = req.awfRuntimePricing?.[provider] || EMPTY_RECORDS;
  const available = identity && getDiscoveryIdentityKeys(req, provider, consumerScope, records).has(identity.key);
  // Only the existing recovery path may assert authoritative absence. A custom
  // deployment, explicit fallback or recovery opt-out still permits opaque IDs.
  const discovery = {
    status: available ? 'available' : 'unknown',
    authoritative: available && req.awfModelCatalogAuthoritative === true,
    scope: consumerScope,
  };
  const evidence = options.evidence || {};
  return req.awfEligibility.evaluate({
    lifecycle: evidence.lifecycle ?? (retired ? { status: 'retired', scope: consumerScope } : undefined),
    policy: evidence.policy ?? { status: blocked ? 'deny' : 'allow', reason: blocked?.reason, scope: consumerScope },
    discovery: evidence.discovery ?? discovery,
    identity, scope,
  });
}

function isModelEligible(model, provider, req, options) {
  return evaluateModelEligibility(model, provider, req, options).admitted;
}

function isModelHarnessEligible(model, provider, req, options) {
  return !['incompatible', 'unverified'].includes(evaluateModelEligibility(model, provider, req, options).harness);
}

function getAliasEligibilityRejection(model, provider, req) {
  const rejection = req?.awfAliasEligibilityRejection;
  return rejection?.provider === provider && rejection.requestedModel === model ? rejection.decision : null;
}

function buildEligibilityError(decision) {
  return {
    error: {
      type: 'invalid_request_error',
      code: 'model_harness_incompatible',
      message: 'This model requires a compatible, verified harness in the actual execution environment. ' +
        'Upgrade the required harness and supply trusted execution-environment evidence before retrying.',
      model: decision.identity?.key,
      scope: decision.scope,
      reasons: decision.reasons.filter(reason =>
        reason.code.startsWith('harness_') && reason.code !== 'harness_compatible').map(reason => ({
        code: reason.code,
        detected: reason.detected ?? null,
        ...(reason.required !== undefined ? { required: reason.required } : {}),
        ...(reason.actual !== undefined ? { actual: reason.actual } : {}),
        reason: reason.reason || 'A compatible verified harness in the actual execution environment is required',
      })),
    },
  };
}

module.exports = {
  createProxyEligibilityStore, proxyEligibilityStore, pinRequestEligibility,
  getModelEligibilityScope, evaluateModelEligibility, isModelEligible, isModelHarnessEligible,
  getAliasEligibilityRejection, buildEligibilityError,
};
