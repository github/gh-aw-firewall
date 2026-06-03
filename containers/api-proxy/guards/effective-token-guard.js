'use strict';

const { parsePositiveInteger, parseModelMultipliers, parsePositiveNumber } = require('./guard-utils');
const { logRequest, sanitizeForLog } = require('../logging');

const ET_WARNING_THRESHOLDS = [80, 90, 95, 99];

const ET_DEFAULT_WEIGHTS = Object.freeze({
  input: 1.0,
  cacheRead: 0.1,
  output: 4.0,
  reasoning: 4.0,
});

const ET_STEERING_MESSAGES = {
  80: 'You have used 80% of your effective token budget. Begin planning to wrap up your current work.',
  90: 'You have used 90% of your effective token budget. Complete your current task and prepare final output.',
  95: 'You have used 95% of your effective token budget. Finalize and submit your work now.',
  99: 'You have used 99% of your effective token budget. You are about to be cut off. Submit immediately.',
};

function createEffectiveTokenState(configKey = null) {
  return {
    configKey,
    totalEffectiveTokens: 0,
    emittedThresholds: new Set(),
    uninjectedThresholds: new Set(),
    warnedUnknownModels: new Set(),
  };
}

let etGuardState = createEffectiveTokenState();

const effectiveTokenConfigCache = {
  rawMax: undefined,
  rawMultipliers: undefined,
  rawDefaultMultiplier: undefined,
  parsed: { max: null, multipliers: {}, defaultMultiplier: 1 },
};

function getEffectiveTokenConfig() {
  const rawMax = process.env.AWF_MAX_EFFECTIVE_TOKENS;
  const rawMultipliers = process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
  const rawDefaultMultiplier = process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER;
  if (
    effectiveTokenConfigCache.rawMax === rawMax &&
    effectiveTokenConfigCache.rawMultipliers === rawMultipliers &&
    effectiveTokenConfigCache.rawDefaultMultiplier === rawDefaultMultiplier
  ) {
    return effectiveTokenConfigCache.parsed;
  }

  effectiveTokenConfigCache.rawMax = rawMax;
  effectiveTokenConfigCache.rawMultipliers = rawMultipliers;
  effectiveTokenConfigCache.rawDefaultMultiplier = rawDefaultMultiplier;
  const parsedMultipliers = Object.freeze(parseModelMultipliers(rawMultipliers));
  const configuredDefaultMultiplier = parsePositiveNumber(rawDefaultMultiplier);
  effectiveTokenConfigCache.parsed = {
    max: parsePositiveInteger(rawMax),
    multipliers: parsedMultipliers,
    defaultMultiplier: configuredDefaultMultiplier ?? 1,
  };
  return effectiveTokenConfigCache.parsed;
}

function getEffectiveTokenState(config) {
  if (!config.max) return null;
  const configKey = `${config.max}|${JSON.stringify(config.multipliers)}|${config.defaultMultiplier}`;
  if (etGuardState.configKey !== configKey) {
    etGuardState = createEffectiveTokenState(configKey);
  }
  return etGuardState;
}

function resolveModelMultiplier(model, config, state = null) {
  if (Object.hasOwn(config.multipliers, model)) {
    return { multiplier: config.multipliers[model], source: 'exact' };
  }

  let prefixMatch = null;
  for (const [configuredModel, multiplier] of Object.entries(config.multipliers)) {
    if (model.startsWith(`${configuredModel}-`)) {
      if (!prefixMatch || configuredModel.length > prefixMatch.matchedModel.length) {
        prefixMatch = { multiplier, source: 'prefix', matchedModel: configuredModel };
      }
    }
  }

  if (prefixMatch) return prefixMatch;

  const shouldLog = !state || !state.warnedUnknownModels.has(model);
  if (shouldLog) {
    logRequest('warn', 'unknown_model_multiplier', {
      model: sanitizeForLog(model),
      applied_multiplier: config.defaultMultiplier,
      default_model_multiplier: config.defaultMultiplier,
    });
    state?.warnedUnknownModels.add(model);
  }

  return { multiplier: config.defaultMultiplier, source: 'default' };
}

function calculateEffectiveTokens(normalizedUsage, model, config, state = null) {
  const multiplierResolution = resolveModelMultiplier(model, config, state);
  const multiplier = multiplierResolution.multiplier;
  const baseWeightedTokens =
    (ET_DEFAULT_WEIGHTS.input * (normalizedUsage.input_tokens || 0)) +
    (ET_DEFAULT_WEIGHTS.cacheRead * (normalizedUsage.cache_read_tokens || 0)) +
    (ET_DEFAULT_WEIGHTS.output * (normalizedUsage.output_tokens || 0)) +
    (ET_DEFAULT_WEIGHTS.reasoning * (normalizedUsage.reasoning_tokens || 0));
  return {
    multiplier,
    baseWeightedTokens,
    effectiveTokens: multiplier * baseWeightedTokens,
  };
}

function applyEffectiveTokenUsage(normalizedUsage, model) {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state || !normalizedUsage) return null;

  const previousTotal = state.totalEffectiveTokens;
  const calc = calculateEffectiveTokens(normalizedUsage, model || 'unknown', config, state);
  state.totalEffectiveTokens += calc.effectiveTokens;
  const percentUsed = (state.totalEffectiveTokens / config.max) * 100;

  const crossedThresholds = [];
  for (const threshold of ET_WARNING_THRESHOLDS) {
    if (percentUsed >= threshold && !state.emittedThresholds.has(threshold)) {
      state.emittedThresholds.add(threshold);
      state.uninjectedThresholds.add(threshold);
      crossedThresholds.push(threshold);
    }
  }

  return {
    maxEffectiveTokens: config.max,
    previousTotalEffectiveTokens: previousTotal,
    totalEffectiveTokens: state.totalEffectiveTokens,
    effectiveTokensThisResponse: calc.effectiveTokens,
    modelMultiplier: calc.multiplier,
    crossedThresholds,
    maxExceeded: state.totalEffectiveTokens >= config.max,
  };
}

function getEffectiveTokenBlockState() {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state) return null;
  return {
    maxEffectiveTokens: config.max,
    totalEffectiveTokens: state.totalEffectiveTokens,
    maxExceeded: state.totalEffectiveTokens >= config.max,
  };
}

function getEffectiveTokenReflectState() {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state) {
    return {
      enabled: false,
      max_effective_tokens: null,
      total_effective_tokens: 0,
      remaining_effective_tokens: null,
      percent_used: 0,
      thresholds_crossed: [],
    };
  }
  const reflectedTotal = Math.min(state.totalEffectiveTokens, config.max);
  return {
    enabled: true,
    max_effective_tokens: config.max,
    total_effective_tokens: reflectedTotal,
    remaining_effective_tokens: Math.max(0, config.max - reflectedTotal),
    percent_used: Math.round((reflectedTotal / config.max) * 10000) / 100,
    thresholds_crossed: [...state.emittedThresholds].sort((a, b) => a - b),
  };
}

function resetEffectiveTokenGuardForTests() {
  etGuardState = createEffectiveTokenState();
  effectiveTokenConfigCache.rawMax = undefined;
  effectiveTokenConfigCache.rawMultipliers = undefined;
  effectiveTokenConfigCache.rawDefaultMultiplier = undefined;
  effectiveTokenConfigCache.parsed = { max: null, multipliers: {}, defaultMultiplier: 1 };
}

function buildEffectiveTokenLimitError(etState) {
  return {
    error: {
      type: 'effective_tokens_limit_exceeded',
      message: `Maximum effective tokens exceeded (${etState.totalEffectiveTokens.toFixed(2)} / ${etState.maxEffectiveTokens}).`,
      total_effective_tokens: etState.totalEffectiveTokens,
      max_effective_tokens: etState.maxEffectiveTokens,
    },
  };
}

function getAndClearPendingSteeringMessage() {
  const config = getEffectiveTokenConfig();
  const state = getEffectiveTokenState(config);
  if (!state || state.uninjectedThresholds.size === 0) return null;

  const maxThreshold = Math.max(...state.uninjectedThresholds);
  state.uninjectedThresholds.delete(maxThreshold);
  const text = ET_STEERING_MESSAGES[maxThreshold] ||
    `You have used ${maxThreshold}% of your effective token budget.`;
  return `[AWF TOKEN WARNING] ${text}`;
}

module.exports = {
  applyEffectiveTokenUsage,
  getEffectiveTokenBlockState,
  getEffectiveTokenReflectState,
  resetEffectiveTokenGuardForTests,
  buildEffectiveTokenLimitError,
  getAndClearPendingSteeringMessage,
  ET_WARNING_THRESHOLDS,
};
