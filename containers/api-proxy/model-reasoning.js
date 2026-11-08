'use strict';

const { resolveReasoning, assessReasoningEffort } = require('./catalogue-contract/reasoning');
const { resolveModelIdentity } = require('./model-identity');
const { resolveIdentity } = require('./catalogue-contract/resolution');
const { getModelEligibilityScope } = require('./model-eligibility');
const { lookupModelRoutingMetadata, getModelApiMapping } = require('./model-api-mapping');
const { getRuntimeModels } = require('./runtime-model-catalog');
const { isGithubCopilotCatalogTarget } = require('./providers/copilot-auth');

const modelPins = new WeakMap();
const requestPins = new WeakMap();
const NATIVE_PROVIDER_HOSTS = Object.freeze({
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
});

function runtimeFact(record, identity, scope) {
  const supports = record.capabilities?.supports;
  let rawEfforts;
  let field;
  let support = 'unknown';
  let mode;
  if (Array.isArray(record.supportedReasoningEfforts)) {
    rawEfforts = record.supportedReasoningEfforts;
    field = 'supportedReasoningEfforts';
  } else if (Array.isArray(supports?.reasoning_effort)) {
    rawEfforts = supports.reasoning_effort;
    field = 'capabilities.supports.reasoning_effort';
  } else if (supports?.reasoningEffort === false) {
    rawEfforts = [];
    field = 'capabilities.supports.reasoningEffort';
  } else if (Object.hasOwn(record, 'supportedReasoningEfforts')) {
    rawEfforts = record.supportedReasoningEfforts;
    field = 'supportedReasoningEfforts';
  } else if (supports && Object.hasOwn(supports, 'reasoning_effort')) {
    rawEfforts = supports.reasoning_effort;
    field = 'capabilities.supports.reasoning_effort';
  } else if (supports && Object.hasOwn(supports, 'reasoningEffort')) {
    field = 'capabilities.supports.reasoningEffort';
  } else if (scope.provider === 'copilot' && supports &&
      typeof supports === 'object' && !Array.isArray(supports)) {
    rawEfforts = [];
    field = 'capabilities.supports';
  }
  if (!field) return null;
  if (Array.isArray(rawEfforts)) {
    support = rawEfforts.length ? 'supported' : 'unsupported';
    if (!rawEfforts.length) mode = 'forbidden';
  }
  return {
    identity, scope: record.scope || getModelEligibilityScope(identity.provider), active: true, authority: 'provider',
    support, rawEfforts, mode,
    provenance: { authority: 'provider', source: 'provider-model-list', field,
      at: record.observedAt, apiVersion: record.apiVersion },
  };
}

function capturedIdentity(model, provider, scope, identities) {
  const resolved = resolveModelIdentity(model, provider, { scope, policy: { providerPrefix: false } });
  return resolved.matchKind === 'unmatched'
    ? resolveIdentity(model, scope, { models: identities.map(identity => ({ identity })) },
      { caseInsensitive: true, providerPrefix: false })
    : resolved;
}

function resolveModelReasoning(model, provider, { records = getRuntimeModels(provider) || [], scope, maintained = true } = {}) {
  scope = { ...getModelEligibilityScope(provider), ...scope, provider };
  const captured = records.filter(record => !record.provider || record.provider === provider).map(record => ({
    record,
    identity: resolveModelIdentity(record.id, provider, { scope, policy: { providerPrefix: false } }).identity,
  }));
  const resolution = capturedIdentity(model, provider, scope, captured.map(entry => entry.identity).filter(Boolean));
  const facts = [];
  for (const { record, identity: exact } of captured) {
    if (!exact || !resolution.identity || exact.key !== resolution.identity.key) continue;
    const fact = runtimeFact(record, exact, scope);
    if (fact) facts.push(fact);
  }
  // Only active maintained native-API mappings apply. Staged canonical targets,
  // imported metadata, accounting families and custom deployments are not evidence.
  if (maintained && scope.channel === 'native-api' && scope.deployment === undefined) {
    const mapped = lookupModelRoutingMetadata(resolution.wireId, provider);
    if (mapped) facts.push({
      identity: resolution.identity, scope, active: true, authority: 'maintained',
      support: mapped.reasoningEfforts.length ? 'supported' : 'unsupported',
      rawEfforts: mapped.reasoningEfforts,
      provenance: { authority: 'maintained', source: 'model-api-mapping',
        at: getModelApiMapping()?.lastUpdated, field: 'routing.reasoningEfforts' },
    });
  }
  return resolveReasoning({ identity: resolution.identity, scope, facts });
}

function pinModelReasoning(model, decision) {
  modelPins.set(model, decision);
  return model;
}

function getModelReasoning(model, provider) {
  return modelPins.get(model) || resolveModelReasoning(model.id, provider, {
    records: [{ id: model.id, ...(model.efforts === undefined ? {} : { supportedReasoningEfforts: model.efforts }) }],
    maintained: false,
  });
}

function getRequestReasoning(model, provider, runtimeCatalog, req = {}, options = {}) {
  const scope = getModelEligibilityScope(provider, req);
  const nativeTarget = options.targetHost === undefined || (
    (provider === 'copilot' ? isGithubCopilotCatalogTarget(options.targetHost)
      : options.targetHost.toLowerCase() === NATIVE_PROVIDER_HOSTS[provider]) &&
    (options.targetScheme === undefined || options.targetScheme === 'https'));
  const key = JSON.stringify([provider, model, scope, nativeTarget]);
  let pins = requestPins.get(req);
  if (!pins) requestPins.set(req, pins = new Map());
  if (!pins.has(key)) {
    const selected = req.awfReasoning;
    const resolved = capturedIdentity(model, provider, scope, selected?.identity ? [selected.identity] : []);
    const matches = nativeTarget && selected?.identity && resolved.identity &&
      selected.identity.key === resolved.identity.key &&
      selected.scope.provider === scope.provider && selected.scope.channel === scope.channel &&
      selected.scope.deployment === scope.deployment;
    pins.set(key, matches ? selected : resolveModelReasoning(model, provider, {
      scope, records: runtimeCatalog ? runtimeCatalog[provider] || [] : getRuntimeModels(provider) || [],
      maintained: nativeTarget,
    }));
  }
  return pins.get(key);
}

module.exports = {
  resolveModelReasoning, pinModelReasoning, getModelReasoning, getRequestReasoning, assessReasoningEffort,
  NATIVE_PROVIDER_HOSTS,
};
