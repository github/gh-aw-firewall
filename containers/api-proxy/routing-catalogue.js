'use strict';

const { createRoutingError } = require('./routing-errors');
const { lookupModelEndpoints, lookupModelRoutingMetadata } = require('./model-api-mapping');

const NATIVE_PROVIDER_HOSTS = Object.freeze({
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
});

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

function freezeModel(model) {
  if (model.efforts) Object.freeze(model.efforts);
  if (model.protocols) Object.freeze(model.protocols);
  return Object.freeze(model);
}

function normalizeModel(id, metadata, provider) {
  const mapped = lookupModelRoutingMetadata(id, provider);
  const endpointMapping = lookupModelEndpoints(id, provider);
  const limits = metadata?.capabilities?.limits;
  const reasoningSupport = metadata?.capabilities?.supports?.reasoningEffort;
  const efforts = Array.isArray(metadata?.supportedReasoningEfforts)
    ? [...metadata.supportedReasoningEfforts]
    : (reasoningSupport === false ? [] : (mapped?.reasoningEfforts ?? undefined));
  const runtimeContextWindow = limits?.max_context_window_tokens;
  const contextWindow = Number.isInteger(runtimeContextWindow) && runtimeContextWindow > 0
    ? runtimeContextWindow
    : mapped?.contextWindowTokens;
  const supportedEndpoints = Array.isArray(metadata?.supportedEndpoints)
    ? metadata.supportedEndpoints
    : endpointMapping?.endpoints.map(endpoint => endpointMapping.endpointPaths?.[endpoint] || endpoint);
  const protocols = Array.isArray(supportedEndpoints)
    ? supportedEndpoints.flatMap(endpoint => {
      if (typeof endpoint !== 'string') return [];
      if (endpoint === 'responses' || /\/responses$/.test(endpoint)) return ['responses'];
      if (endpoint === 'chat_completions' || /\/chat\/completions$/.test(endpoint)) return ['chat-completions'];
      if (endpoint === 'messages' || /\/messages$/.test(endpoint)) return ['messages'];
      return [];
    })
    : undefined;
  const providerProtocols = provider === 'anthropic'
    ? new Set(['messages'])
    : new Set(['responses', 'chat-completions']);

  return freezeModel({
    id,
    ...(efforts === undefined ? {} : { efforts }),
    ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(Array.isArray(protocols) ? { protocols: [...new Set(protocols.filter(protocol => providerProtocols.has(protocol)))] } : {}),
  });
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
    async getSnapshot({ signal, provider = 'copilot' } = {}) {
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

      const metadataById = new Map(
        (getRuntimeModels(provider) || []).map(model => [model.id.toLowerCase(), model]),
      );
      const models = discovered.map(id => normalizeModel(id, metadataById.get(id.toLowerCase()), provider));
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
  createRoutingCatalogue,
  isNativeAdapter,
  normalizeModel,
};
