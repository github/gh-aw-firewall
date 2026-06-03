'use strict';

const { sanitizeForLog } = require('../logging');
const { parseModelMultipliers, parsePositiveNumber } = require('./guard-utils');

const maxModelMultiplierConfigCache = {
  rawCap: undefined,
  rawMultipliers: undefined,
  rawDefaultMultiplier: undefined,
  parsed: { cap: null, multipliers: {}, defaultMultiplier: 1 },
};

function getMaxModelMultiplierConfig() {
  const rawCap = process.env.AWF_MAX_MODEL_MULTIPLIER;
  const rawMultipliers = process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
  const rawDefaultMultiplier = process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER;

  if (
    maxModelMultiplierConfigCache.rawCap === rawCap &&
    maxModelMultiplierConfigCache.rawMultipliers === rawMultipliers &&
    maxModelMultiplierConfigCache.rawDefaultMultiplier === rawDefaultMultiplier
  ) {
    return maxModelMultiplierConfigCache.parsed;
  }

  maxModelMultiplierConfigCache.rawCap = rawCap;
  maxModelMultiplierConfigCache.rawMultipliers = rawMultipliers;
  maxModelMultiplierConfigCache.rawDefaultMultiplier = rawDefaultMultiplier;

  const parsedMultipliers = Object.freeze(parseModelMultipliers(rawMultipliers));
  const configuredDefaultMultiplier = parsePositiveNumber(rawDefaultMultiplier);
  const cap = parsePositiveNumber(rawCap);

  maxModelMultiplierConfigCache.parsed = Object.freeze({
    cap,
    multipliers: parsedMultipliers,
    defaultMultiplier: configuredDefaultMultiplier ?? 1,
  });
  return maxModelMultiplierConfigCache.parsed;
}

function resolveMultiplierForModel(model, config) {
  if (Object.hasOwn(config.multipliers, model)) {
    return config.multipliers[model];
  }

  let bestMatch = null;
  for (const [configuredModel, multiplier] of Object.entries(config.multipliers)) {
    if (model.startsWith(`${configuredModel}-`)) {
      if (!bestMatch || configuredModel.length > bestMatch.key.length) {
        bestMatch = { key: configuredModel, multiplier };
      }
    }
  }

  if (bestMatch) return bestMatch.multiplier;
  return config.defaultMultiplier;
}

/**
 * Returns a block state object when the given model's resolved multiplier
 * exceeds the configured cap (AWF_MAX_MODEL_MULTIPLIER), or null when no cap
 * is configured, the model is absent, or the multiplier is within the cap.
 *
 * @param {string|null} model - The model name from the request body (may be null)
 * @returns {{ model: string, multiplier: number, maxModelMultiplier: number } | null}
 */
function getModelMultiplierCapBlockState(model) {
  const config = getMaxModelMultiplierConfig();
  if (!config.cap || !model) return null;

  const multiplier = resolveMultiplierForModel(model, config);
  if (multiplier <= config.cap) return null;

  return {
    model: sanitizeForLog(model),
    multiplier,
    maxModelMultiplier: config.cap,
  };
}

/**
 * Builds the structured error response body for a model-multiplier cap rejection.
 *
 * @param {{ model: string, multiplier: number, maxModelMultiplier: number }} state
 * @returns {{ error: object }}
 */
function buildModelMultiplierCapError(state) {
  return {
    error: {
      type: 'model_multiplier_cap_exceeded',
      message: `Model multiplier cap exceeded: model "${state.model}" has multiplier ${state.multiplier} which exceeds the configured maximum of ${state.maxModelMultiplier}.`,
      model: state.model,
      model_multiplier: state.multiplier,
      max_model_multiplier: state.maxModelMultiplier,
    },
  };
}

/** @internal Test-only: reset cached config state between test cases. */
function resetMaxModelMultiplierGuardForTests() {
  maxModelMultiplierConfigCache.rawCap = undefined;
  maxModelMultiplierConfigCache.rawMultipliers = undefined;
  maxModelMultiplierConfigCache.rawDefaultMultiplier = undefined;
  maxModelMultiplierConfigCache.parsed = { cap: null, multipliers: {}, defaultMultiplier: 1 };
}

module.exports = {
  getModelMultiplierCapBlockState,
  buildModelMultiplierCapError,
  resetMaxModelMultiplierGuardForTests,
};
