'use strict';

const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');
const { stripRedundantProviderPrefix } = require('./model-utils');
const { createRoutingError } = require('./routing-errors');

const PROVIDERS = Object.freeze({
  copilot: Object.freeze({ canonical: 'github-copilot', alias: 'copilot' }),
  openai: Object.freeze({ canonical: 'openai', alias: 'openai' }),
  anthropic: Object.freeze({ canonical: 'anthropic', alias: 'anthropic' }),
});
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function normalizePolicyList(value, name) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw createRoutingError('routing_configuration_error', `${name} must be an array or null`);
  }
  if (value.length === 0) return null;
  return value.map((pattern, index) => {
    if (typeof pattern !== 'string' || !pattern.trim()) {
      throw createRoutingError('routing_configuration_error', `${name}[${index}] must be a nonblank string`);
    }
    if (pattern.includes('${{')) {
      throw createRoutingError('routing_configuration_error', `${name}[${index}] must be a literal model pattern`);
    }
    return pattern.trim();
  });
}

// Unknown live efforts cannot be represented by this version of the contract.
function normalizeEfforts(value) {
  const efforts = [];
  for (const effort of value) {
    if (EFFORTS.has(effort) && !efforts.includes(effort)) efforts.push(effort);
  }
  return efforts;
}

function protocolFor(provider, effort, protocols) {
  if (provider === 'anthropic') return 'messages';
  if (effort === undefined) return protocols.includes('chat-completions') ? 'chat-completions' : null;
  if (protocols.includes('responses')) return 'responses';
  if (protocols.includes('messages')) return 'messages';
  if (protocols.includes('chat-completions')) return 'chat-completions';
  return null;
}

function indexModels(models, path, getIdentity) {
  if (!Array.isArray(models)) {
    throw createRoutingError('routing_configuration_error', `${path} must be an array`);
  }
  const indexed = new Map();
  for (const [index, model] of models.entries()) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) {
      throw createRoutingError('routing_configuration_error', `${path}[${index}] must be an object`);
    }
    const identity = getIdentity(model);
    if (typeof identity !== 'string' || !identity.trim()) {
      throw createRoutingError('routing_configuration_error', `${path}[${index}] has no model identity`);
    }
    const key = identity.toLowerCase();
    if (!indexed.has(key)) indexed.set(key, model);
  }
  return indexed;
}

function makePairKey(model, effort) {
  return `${model.toLowerCase()}\u0000${effort === undefined ? '' : effort}`;
}

function buildRoutingCandidates({ catalogue, policy = {} }) {
  const provider = catalogue?.provider;
  const providerInfo = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : null;
  if (!catalogue || !providerInfo || catalogue.configured !== true) {
    throw createRoutingError('provider_unavailable', 'The selected provider is not configured');
  }
  if (catalogue.discovery !== 'complete' || !Array.isArray(catalogue.models) || catalogue.models.length === 0) {
    throw createRoutingError('provider_unavailable', 'The selected provider model catalogue is unavailable');
  }

  const allowedModels = normalizePolicyList(policy.allowedModels, 'allowedModels');
  const disallowedModels = normalizePolicyList(policy.disallowedModels, 'disallowedModels');
  const providerModels = indexModels(catalogue.models, 'catalogue.models', model => model.id);
  const permittedModels = new Map(
    [...providerModels].filter(([, model]) => isModelPermittedByPolicy(model.id, allowedModels, disallowedModels, providerInfo.alias)),
  );
  if (permittedModels.size === 0) {
    throw createRoutingError('model_policy_violation', 'The model policy excludes every available model');
  }

  const pairs = [];
  for (const providerModel of permittedModels.values()) {
    if (!Array.isArray(providerModel.efforts) || !Array.isArray(providerModel.protocols)) continue;
    const efforts = normalizeEfforts(providerModel.efforts);
    if (providerModel.efforts.length > 0 && efforts.length === 0) continue;

    const nativeName = stripRedundantProviderPrefix(providerModel.id, providerInfo.canonical);
    for (const effort of (efforts.length === 0 ? [undefined] : efforts)) {
      const protocol = protocolFor(provider, effort, providerModel.protocols);
      if (!protocol || !providerModel.protocols.includes(protocol)) continue;
      pairs.push({
        model: `${providerInfo.canonical}/${nativeName}`,
        effort,
        providerModel,
        protocol,
        provider,
      });
    }
  }

  pairs.sort((left, right) => {
    const leftKey = makePairKey(left.model, left.effort);
    const rightKey = makePairKey(right.model, right.effort);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  if (pairs.length === 0) {
    throw createRoutingError('no_route', 'No available model and effort is supported for the selected provider');
  }

  const byId = Object.create(null);
  const choices = pairs.map((pair, index) => {
    const id = `choice-${String(index + 1).padStart(4, '0')}`;
    const choice = Object.freeze({
      id,
      model: pair.model,
      ...(pair.effort === undefined ? {} : { effort: pair.effort }),
    });
    const contextWindow = Number.isInteger(pair.providerModel.contextWindow) && pair.providerModel.contextWindow > 0
      ? pair.providerModel.contextWindow
      : undefined;
    byId[id] = Object.freeze({
      choice,
      provider: pair.provider,
      wireModel: pair.providerModel.id,
      ...(pair.effort === undefined ? {} : { effort: pair.effort }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      protocol: pair.protocol,
    });
    return choice;
  });

  return Object.freeze({
    choices: Object.freeze(choices),
    byId: Object.freeze(byId),
  });
}

module.exports = {
  buildRoutingCandidates,
  normalizePolicyList,
};
