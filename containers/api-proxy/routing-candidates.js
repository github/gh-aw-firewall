'use strict';

const { isModelPermittedByPolicy } = require('./guards/model-policy-guard');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const { stripRedundantProviderPrefix } = require('./model-utils');
const { createRoutingError } = require('./routing-errors');
const { isModelEligible } = require('./model-eligibility');
const { getModelReasoning, pinModelReasoning, assessReasoningEffort } = require('./model-reasoning');
const { isAutomaticModelEligible } = require('./automatic-model-eligibility');

const PROVIDERS = Object.freeze({
  copilot: Object.freeze({ canonical: 'github-copilot', alias: 'copilot' }),
  openai: Object.freeze({ canonical: 'openai', alias: 'openai' }),
  anthropic: Object.freeze({ canonical: 'anthropic', alias: 'anthropic' }),
});

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

function protocolFor(provider, effort, protocols) {
  if (provider === 'anthropic') return 'messages';
  if (effort === undefined) return protocols.includes('chat-completions') ? 'chat-completions' : null;
  if (protocols.includes('responses')) return 'responses';
  if (protocols.includes('chat-completions')) return 'chat-completions';
  if (protocols.includes('messages')) return 'messages';
  return null;
}

function getModelRoutingChoices(providerModel, provider) {
  if (providerModel.automaticSelectionEligible === false || !isAutomaticModelEligible(providerModel)) return [];
  if (!Array.isArray(providerModel.protocols)) return [];
  const decision = getModelReasoning(providerModel, provider);
  const efforts = decision.support === 'unsupported' ? [undefined] : decision.selectableEfforts;
  return efforts.flatMap(effort => {
    if (!assessReasoningEffort(decision, effort, { automatic: true }).admitted) return [];
    const protocol = protocolFor(provider, effort, providerModel.protocols);
    return protocol && providerModel.protocols.includes(protocol) ? [{ effort, protocol }] : [];
  });
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

// Shortlist only: costs, incumbents and probes still refer to exact choices in eligibleRank.
function shortlistPrimaryOptions(eligibleRank, suspendedBases = []) {
  const skipBases = new Set(Array.from(suspendedBases, model => model.toLowerCase()));
  const options = [];
  for (const choice of eligibleRank) {
    const base = choice.model.toLowerCase();
    if (skipBases.has(base)) continue;
    options.push(choice);
    if (options.length === 3) break;
    skipBases.add(base);
  }
  return Object.freeze(options);
}

// Only consume the rank accepted by validateRouteResponse, never the (potentially
// larger) catalogue or offered pool. Resolve IDs to the immutable offered choices.
function buildPrimaryRouteOptions(rankedChoices, pool, excludedModels = []) {
  const seen = new Set();
  const fullRank = rankedChoices.map(({ id }) => {
    const choice = pool.byId[id].choice;
    const key = makePairKey(choice.model, choice.effort);
    if (seen.has(key)) {
      throw createRoutingError('routing_contract_error', 'The router route response returned a duplicate model and effort');
    }
    seen.add(key);
    return choice;
  });
  const excluded = new Set(excludedModels.map(model => model.toLowerCase()));
  const eligibleRank = excluded.size ? fullRank.filter(choice => !excluded.has(choice.model.toLowerCase())) : fullRank;
  return Object.freeze({
    fullRank: Object.freeze(fullRank),
    ordinaryPick: fullRank[0],
    eligibleRank: Object.freeze(eligibleRank),
    options: shortlistPrimaryOptions(eligibleRank),
    excludedFallback: eligibleRank.length === 0,
  });
}

function buildRoutingCandidates({ catalogue, policy = {}, candidateModels, eligibilityRequest = {} }) {
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
  const routingCandidates = normalizePolicyList(candidateModels, 'routing.candidateModels');
  const providerModels = indexModels(catalogue.models, 'catalogue.models', model => model.id);
  const policyModels = new Map(
    [...providerModels].filter(([, model]) =>
      (provider !== 'copilot' || !getRetiredModelBlockState(
        stripRedundantProviderPrefix(model.id, providerInfo.canonical),
        provider,
        { inputMode: 'native' },
      )) &&
      isModelPermittedByPolicy(model.id, allowedModels, disallowedModels, providerInfo.alias)),
  );
  if (policyModels.size === 0) {
    throw createRoutingError('model_policy_violation', 'The model policy excludes every available model');
  }
  const permittedModels = routingCandidates
    ? new Map([...policyModels].filter(([, model]) =>
      isModelPermittedByPolicy(model.id, routingCandidates, null, providerInfo.alias)))
    : policyModels;
  if (permittedModels.size === 0) {
    throw createRoutingError('no_route', 'No available model matches routing.candidateModels');
  }

  const pairs = [];
  for (const providerModel of permittedModels.values()) {
    const nativeName = stripRedundantProviderPrefix(providerModel.id, providerInfo.canonical);
    if (!isModelEligible(nativeName, provider, eligibilityRequest, { inputMode: 'native' })) continue;
    for (const { effort, protocol } of getModelRoutingChoices(providerModel, provider)) {
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
    byId[id] = pinModelReasoning(Object.freeze({
      choice,
      provider: pair.provider,
      wireModel: pair.providerModel.id,
      ...(pair.effort === undefined ? {} : { effort: pair.effort }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      protocol: pair.protocol,
    }), getModelReasoning(pair.providerModel, pair.provider));
    return choice;
  });

  return Object.freeze({
    choices: Object.freeze(choices),
    byId: Object.freeze(byId),
  });
}

module.exports = {
  buildPrimaryRouteOptions,
  shortlistPrimaryOptions,
  buildRoutingCandidates,
  getModelRoutingChoices,
  normalizePolicyList,
};
