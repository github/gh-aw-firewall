'use strict';

const { parsePositiveNumber } = require('../guard-utils');
const exact = require('../../catalogue-contract/exact-pricing');

// Default operator-controlled safety limit, enforced regardless of maxAiCredits.
const HARD_CAP_AI_CREDITS = 10_000;

function getHardCapAiCredits(rawCap = process.env.AWF_AI_CREDITS_HARD_CAP) {
  const value = Number(rawCap);
  try {
    const preciseValue = exact.decimal(rawCap);
    if (Number.isFinite(value) && exact.compare(preciseValue, exact.ZERO) > 0) {
      return { value, preciseValue };
    }
  } catch {
    // Invalid operator values retain the mandatory default.
  }
  return { value: HARD_CAP_AI_CREDITS, preciseValue: exact.decimal(HARD_CAP_AI_CREDITS) };
}

function parseDefaultPricing(rawDefault) {
  let defaultPricing = null;
  if (rawDefault) {
    try {
      const parsed = JSON.parse(rawDefault);
      if (parsed && parsed.input !== undefined && parsed.output !== undefined) {
        defaultPricing = exact.fromExact({
          input: exact.decimal(parsed.input),
          cachedInput: parsed.cachedInput === undefined
            ? exact.multiply(exact.decimal(parsed.input), exact.decimal('0.1')) : exact.decimal(parsed.cachedInput),
          cacheWrite: parsed.cacheWrite == null ? null : exact.decimal(parsed.cacheWrite),
          output: exact.decimal(parsed.output),
          ...(parsed.reasoning !== undefined ? { reasoning: exact.decimal(parsed.reasoning) } : {}),
        });
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  return defaultPricing;
}

function parseAiCreditsConfig(aiCreditsConfigCache) {
  const rawMax = process.env.AWF_MAX_AI_CREDITS;
  const rawDefault = process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
  const rawHardCap = process.env.AWF_AI_CREDITS_HARD_CAP;
  if (aiCreditsConfigCache.initialized && aiCreditsConfigCache.rawMax === rawMax &&
      aiCreditsConfigCache.rawDefault === rawDefault && aiCreditsConfigCache.rawHardCap === rawHardCap) {
    return aiCreditsConfigCache.parsed;
  }
  const hardCap = getHardCapAiCredits(rawHardCap);
  const parsedMax = parsePositiveNumber(rawMax);
  let exactMax = null;
  // Invalid/nonpositive legacy limits retain their opt-out semantics.
  if (parsedMax || (typeof rawMax === 'string' &&
      /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawMax.trim()))) {
    exactMax = exact.decimal(rawMax);
    if (exact.compare(exactMax, exact.ZERO) === 0) exactMax = null;
  }
  if (exactMax) {
    if (exact.compare(exactMax, hardCap.preciseValue) > 0) {
      exactMax = hardCap.preciseValue;
    }
  }
  aiCreditsConfigCache.initialized = true;
  aiCreditsConfigCache.rawMax = rawMax;
  aiCreditsConfigCache.rawDefault = rawDefault;
  aiCreditsConfigCache.rawHardCap = rawHardCap;
  aiCreditsConfigCache.parsed = {
    max: exactMax ? Math.min(Number(rawMax), hardCap.value) : null,
    exactMax,
    hardCap: hardCap.value,
    preciseHardCap: hardCap.preciseValue,
    get defaultPricing() { return parseDefaultPricing(rawDefault); },
  };
  return aiCreditsConfigCache.parsed;
}

module.exports = { HARD_CAP_AI_CREDITS, getHardCapAiCredits, parseAiCreditsConfig };
