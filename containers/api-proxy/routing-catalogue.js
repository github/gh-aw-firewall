'use strict';

const { createRoutingError } = require('./routing-errors');

function freezeModel(model) {
  if (model.efforts) Object.freeze(model.efforts);
  if (model.protocols) Object.freeze(model.protocols);
  return Object.freeze(model);
}

function normalizeModel(id, metadata) {
  const limits = metadata?.capabilities?.limits;
  const reasoningSupport = metadata?.capabilities?.supports?.reasoningEffort;
  const efforts = Array.isArray(metadata?.supportedReasoningEfforts)
    ? [...metadata.supportedReasoningEfforts]
    : (reasoningSupport === false ? [] : undefined);
  const contextWindow = limits?.max_context_window_tokens;
  const protocols = Array.isArray(metadata?.supportedEndpoints)
    ? metadata.supportedEndpoints.flatMap(endpoint => {
      if (endpoint === '/responses') return ['responses'];
      if (endpoint === '/chat/completions') return ['chat-completions'];
      return [];
    })
    : undefined;

  return freezeModel({
    id,
    ...(efforts === undefined ? {} : { efforts }),
    ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(protocols === undefined ? {} : { protocols: [...new Set(protocols)] }),
  });
}

function createRoutingCatalogue({ getCopilotAdapter, getDiscoveredModels, getRuntimeModels }) {
  if (
    typeof getCopilotAdapter !== 'function' ||
    typeof getDiscoveredModels !== 'function' ||
    typeof getRuntimeModels !== 'function'
  ) {
    throw createRoutingError('routing_configuration_error', 'The routing catalogue dependencies are incomplete');
  }

  return Object.freeze({
    async getSnapshot({ signal } = {}) {
      if (signal?.aborted) {
        throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
      }

      const adapter = getCopilotAdapter();
      const configured = adapter?.name === 'copilot' &&
        adapter.isEnabled() === true &&
        adapter.getRoutingProviderIdentity?.() === 'github-copilot';
      const discovered = getDiscoveredModels('copilot');
      if (!configured || !Array.isArray(discovered) || discovered.length === 0) {
        return Object.freeze({
          provider: 'copilot',
          configured,
          discovery: 'failed',
        });
      }

      const metadataById = new Map(
        (getRuntimeModels('copilot') || []).map(model => [model.id.toLowerCase(), model]),
      );
      const models = discovered.map(id => normalizeModel(id, metadataById.get(id.toLowerCase())));
      return Object.freeze({
        provider: 'copilot',
        configured: true,
        discovery: 'complete',
        models: Object.freeze(models),
      });
    },
  });
}

module.exports = {
  createRoutingCatalogue,
};
