'use strict';

const { createRoutingError } = require('./routing-errors');
const { lookupModelEndpoints, lookupModelRoutingMetadata } = require('./model-api-mapping');
const { resolveModelReasoning, pinModelReasoning, NATIVE_PROVIDER_HOSTS } = require('./model-reasoning');

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

function normalizeModel(id, metadata, provider, scope, records) {
  const mapped = lookupModelRoutingMetadata(id, provider);
  const endpointMapping = lookupModelEndpoints(id, provider);
  const limits = metadata?.capabilities?.limits;
  const reasoning = resolveModelReasoning(id, provider, {
    records: records || (metadata ? [{ ...metadata, id: metadata.id || id }] : []), scope,
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
      if (typeof endpoint !== 'string') return [];
      if (endpoint === 'responses' || /\/responses$/.test(endpoint)) return ['responses'];
      if (endpoint === 'chat_completions' || /\/chat\/completions$/.test(endpoint)) return ['chat-completions'];
      if (endpoint === 'messages' || /\/messages$/.test(endpoint)) return ['messages'];
      if (['decisions', '/decisions', '/v1/decisions'].includes(endpoint)) return ['decisions'];
      return [];
    })
    : undefined;
  const providerProtocols = provider === 'anthropic'
    ? new Set(['messages'])
    : provider === 'copilot'
      ? new Set(['responses', 'chat-completions', 'messages', 'decisions'])
      : new Set(['responses', 'chat-completions', 'decisions']);

  return pinModelReasoning(freezeModel({
    id,
    ...(efforts === undefined ? {} : { efforts }),
    ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(Array.isArray(protocols) ? { protocols: [...new Set(protocols.filter(protocol => providerProtocols.has(protocol)))] } : {}),
    ...(typeof metadata?.modelPickerEnabled === 'boolean'
      ? { modelPickerEnabled: metadata.modelPickerEnabled }
      : {}),
  }), reasoning);
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
  createRoutingCatalogue,
  isNativeAdapter,
  normalizeModel,
};
