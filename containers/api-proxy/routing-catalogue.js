'use strict';

const { createRoutingError } = require('./routing-errors');
const { lookupModelEndpoints, lookupModelRoutingMetadata } = require('./model-api-mapping');
const { resolveModelReasoning, pinModelReasoning, NATIVE_PROVIDER_HOSTS } = require('./model-reasoning');
const { isAutomaticModelEligible } = require('./automatic-model-eligibility');

function isNativeAdapter(adapter, provider) {
  if (
    !adapter ||
    adapter.name !== provider ||
    typeof adapter.isEnabled !== 'function' ||
    adapter.isEnabled() !== true
  ) return false;
  if (provider === 'copilot') {
    return adapter.getRoutingProviderIdentity?.() === 'github-copilot';
  }
  if (!Object.hasOwn(NATIVE_PROVIDER_HOSTS, provider)) return false;
  if (typeof adapter.getTargetHost !== 'function') return false;
  const targetHost = adapter.getTargetHost();
  const targetScheme = adapter.getTargetScheme?.();
  return typeof targetHost === 'string' &&
    targetHost.toLowerCase() === NATIVE_PROVIDER_HOSTS[provider] &&
    (targetScheme === undefined || targetScheme === 'https');
}

const LIVE_ENDPOINT_MODELS = new WeakSet();

const PROTOCOL_TO_CANONICAL_ENDPOINT = Object.freeze({
  responses: '/responses',
  'chat-completions': '/chat/completions',
  messages: '/v1/messages',
});

function recognizeAgentEndpointProtocol(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.includes(':')) return null;
  if (endpoint === 'responses' || /\/responses$/.test(endpoint)) return 'responses';
  if (endpoint === 'chat_completions' || /\/chat\/completions$/.test(endpoint)) return 'chat-completions';
  if (endpoint === 'messages' || /\/messages$/.test(endpoint)) return 'messages';
  return null;
}

function canonicalizeAgentEndpoint(endpoint) {
  const protocol = recognizeAgentEndpointProtocol(endpoint);
  return protocol ? PROTOCOL_TO_CANONICAL_ENDPOINT[protocol] : endpoint;
}

function hasLiveEndpointMetadata(model) {
  return !!model && typeof model === 'object' && LIVE_ENDPOINT_MODELS.has(model);
}

function freezeModel(model) {
  if (model.efforts) Object.freeze(model.efforts);
  if (model.protocols) Object.freeze(model.protocols);
  return Object.freeze(model);
}

function normalizeModel(id, metadata, provider, scope, records, reasoningOptions) {
  const mapped = scope?.deployment === undefined &&
    (scope?.channel === undefined || scope.channel === 'native-api')
    ? lookupModelRoutingMetadata(id, provider) : null;
  const endpointMapping = lookupModelEndpoints(id, provider);
  const limits = metadata?.capabilities?.limits;
  const { scope: reasoningScope = scope, maintained } = reasoningOptions || {};
  const reasoning = resolveModelReasoning(id, provider, {
    records: records || (metadata ? [{ ...metadata, id: metadata.id || id }] : []),
    scope: reasoningScope,
    ...(maintained === undefined ? {} : { maintained }),
  });
  const efforts = ['absent', 'unknown'].includes(reasoning.support) ? undefined : reasoning.supportedEfforts;
  const runtimeContextWindow = limits?.max_context_window_tokens;
  const contextWindow = Number.isInteger(runtimeContextWindow) && runtimeContextWindow > 0
    ? runtimeContextWindow
    : mapped?.contextWindowTokens;
  const supportedEndpoints = Array.isArray(metadata?.supportedEndpoints)
    ? metadata.supportedEndpoints
    : endpointMapping?.endpoints.map(endpoint => endpointMapping.endpointPaths?.[endpoint] || endpoint);
  const protocols = Array.isArray(supportedEndpoints)
    ? supportedEndpoints.flatMap(endpoint => {
      const agentProtocol = recognizeAgentEndpointProtocol(endpoint);
      if (agentProtocol) return [agentProtocol];
      // Catalogue visibility only: Decisions has no automatic routing/translation choice.
      if (['decisions', '/decisions', '/v1/decisions'].includes(endpoint)) return ['decisions'];
      return [];
    })
    : undefined;
  const providerProtocols = provider === 'anthropic'
    ? new Set(['messages'])
    : provider === 'copilot'
      ? new Set(['responses', 'chat-completions', 'messages', 'decisions'])
      : new Set(['responses', 'chat-completions', 'decisions']);

  const normalized = pinModelReasoning(freezeModel({
    id,
    ...(efforts === undefined ? {} : { efforts }),
    ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(Array.isArray(protocols) ? { protocols: [...new Set(protocols.filter(protocol => providerProtocols.has(protocol)))] } : {}),
    ...(!isAutomaticModelEligible(metadata) ? { automaticSelectionEligible: false } : {}),
    ...(typeof metadata?.modelPickerEnabled === 'boolean'
      ? { modelPickerEnabled: metadata.modelPickerEnabled }
      : {}),
  }), reasoning);
  if (Array.isArray(metadata?.supportedEndpoints)) {
    LIVE_ENDPOINT_MODELS.add(normalized);
  }
  return normalized;
}

function createRoutingCatalogue({ getAdapter, getCopilotAdapter, getDiscoveredModels, getRuntimeModels }) {
  if (typeof getAdapter !== 'function' && typeof getCopilotAdapter !== 'function') {
    throw createRoutingError('routing_configuration_error', 'The routing catalogue dependencies are incomplete');
  }
  const resolveAdapter = getAdapter || (provider => provider === 'copilot' ? getCopilotAdapter?.() : null);
  if (
    typeof resolveAdapter !== 'function' ||
    typeof getDiscoveredModels !== 'function' ||
    typeof getRuntimeModels !== 'function'
  ) {
    throw createRoutingError('routing_configuration_error', 'The routing catalogue dependencies are incomplete');
  }

  return Object.freeze({
    async getSnapshot({ signal, provider = 'copilot', scope } = {}) {
      if (signal?.aborted) {
        throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
      }

      const adapter = resolveAdapter(provider);
      const configured = isNativeAdapter(adapter, provider);
      const discovered = getDiscoveredModels(provider);
      if (!configured || !Array.isArray(discovered) || discovered.length === 0) {
        return Object.freeze({
          provider,
          configured,
          discovery: 'failed',
        });
      }

      const records = getRuntimeModels(provider) || [];
      const metadataById = new Map(records.map(model => [model.id.toLowerCase(), model]));
      const models = discovered.map(id => normalizeModel(id, metadataById.get(id.toLowerCase()), provider, scope, records));
      return Object.freeze({
        provider,
        configured: true,
        discovery: 'complete',
        models: Object.freeze(models),
      });
    },
  });
}

module.exports = {
  PROTOCOL_TO_CANONICAL_ENDPOINT,
  canonicalizeAgentEndpoint,
  createRoutingCatalogue,
  hasLiveEndpointMetadata,
  isNativeAdapter,
  normalizeModel,
  recognizeAgentEndpointProtocol,
};
