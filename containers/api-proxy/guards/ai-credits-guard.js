'use strict';

const { logRequest, sanitizeForLog } = require('../logging');
const pricingByModel = require('../ai-credits-pricing');
const { parsePositiveNumber } = require('./guard-utils');

const TOKENS_PER_MILLION = 1_000_000;
const DOLLARS_PER_CREDIT = 0.01;
const CREDIT_DENOMINATOR = TOKENS_PER_MILLION * DOLLARS_PER_CREDIT;

// Absolute hard cap on AI credits that cannot be overridden by configuration.
// This is a safety limit to prevent runaway spending regardless of what
// maxAiCredits is set to via CLI flags or config files.
const HARD_CAP_AI_CREDITS = 10_000;

function roundCredits(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function createAiCreditsState() {
  return {
    totalAiCredits: 0,
    byModel: {},
    warnedUnknownModels: new Set(),
  };
}

let aiCreditsState = createAiCreditsState();

const aiCreditsConfigCache = {
  rawMax: undefined,
  rawDefault: undefined,
  parsed: { max: null, defaultPricing: null },
};

function getAiCreditsConfig() {
  const rawMax = process.env.AWF_MAX_AI_CREDITS;
  const rawDefault = process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
  if (aiCreditsConfigCache.rawMax === rawMax && aiCreditsConfigCache.rawDefault === rawDefault) {
    return aiCreditsConfigCache.parsed;
  }
  aiCreditsConfigCache.rawMax = rawMax;
  aiCreditsConfigCache.rawDefault = rawDefault;

  let defaultPricing = null;
  if (rawDefault) {
    try {
      const parsed = JSON.parse(rawDefault);
      if (parsed && typeof parsed.input === 'number' && typeof parsed.output === 'number') {
        defaultPricing = {
          input: parsed.input,
          cachedInput: parsed.cachedInput ?? parsed.input * 0.1,
          cacheWrite: parsed.cacheWrite ?? null,
          output: parsed.output,
        };
      }
    } catch { /* invalid JSON — leave null */ }
  }

  const parsedMax = parsePositiveNumber(rawMax);
  aiCreditsConfigCache.parsed = {
    max: parsedMax ? Math.min(parsedMax, HARD_CAP_AI_CREDITS) : null,
    defaultPricing,
  };
  return aiCreditsConfigCache.parsed;
}

/**
 * Canonicalize a model name by stripping provider prefix and normalizing
 * common deployment suffixes and separators (dash, dot, underscore are all
 * treated as equivalent).
 * E.g. "copilot/claude-sonnet-4.6" → "claude-sonnet-4-6"
 *      "claude_sonnet_4_6"          → "claude-sonnet-4-6"
 *      "gpt-5-codex-mini-alpha-2025-11-07" → "gpt-5-codex-mini"
 */
function canonicalizeModel(model) {
  const bare = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  const withoutDateSuffix = bare.replace(/(-alpha)?-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  return withoutDateSuffix.replace(/[._]/g, '-');
}

function resolveModelPricing(model, state = aiCreditsState) {
  if (Object.hasOwn(pricingByModel, model)) return pricingByModel[model];

  const canonical = canonicalizeModel(model);

  // Try canonical form against canonicalized pricing keys
  for (const [configuredModel, pricing] of Object.entries(pricingByModel)) {
    const canonicalKey = canonicalizeModel(configuredModel);
    if (canonical === canonicalKey) return pricing;
  }

  // Prefix match: canonical model starts with a canonical pricing key
  let prefixMatch = null;
  for (const [configuredModel, pricing] of Object.entries(pricingByModel)) {
    const canonicalKey = canonicalizeModel(configuredModel);
    if (canonical.startsWith(`${canonicalKey}-`)) {
      if (!prefixMatch || canonicalKey.length > prefixMatch.key.length) {
        prefixMatch = { key: canonicalKey, pricing };
      }
    }
  }
  if (prefixMatch) return prefixMatch.pricing;

  if (!state.warnedUnknownModels.has(model)) {
    logRequest('warn', 'unknown_model_ai_credits_pricing', {
      model: sanitizeForLog(model),
    });
    state.warnedUnknownModels.add(model);
  }

  // Fall back to configured default pricing if available
  const config = getAiCreditsConfig();
  if (config.defaultPricing) return config.defaultPricing;

  return null;
}

/**
 * Check if a model is unresolvable and should be rejected.
 * Only rejects when maxAiCredits is active and no default pricing is configured.
 *
 * @param {string} model
 * @returns {{ rejected: boolean, model: string, error: object } | null}
 */
function checkUnknownModelRejection(model) {
  const config = getAiCreditsConfig();
  if (!config.max) return null; // guard not active, don't reject
  if (!model) return null; // no model in request body, can't check
  if (config.defaultPricing) return null; // has fallback, don't reject

  const pricing = resolveModelPricing(model);
  if (pricing) return null; // model resolved, don't reject

  return {
    rejected: true,
    model,
    error: {
      type: 'unknown_model_ai_credits',
      message: `Model "${model}" has no AI credits pricing and no default pricing is configured. ` +
        'Set apiProxy.defaultAiCreditsPricing in the AWF config (e.g. {"input": 3.0, "output": 15.0}) ' +
        'to provide a fallback rate, or add the model to the pricing table.',
      model,
    },
  };
}

function calculateAiCredits(normalizedUsage, model, state = aiCreditsState) {
  const pricing = resolveModelPricing(model, state);
  if (!pricing) return null;

  const inputCredits = ((normalizedUsage.input_tokens || 0) * pricing.input) / CREDIT_DENOMINATOR;
  const cachedInputCredits = ((normalizedUsage.cache_read_tokens || 0) * pricing.cachedInput) / CREDIT_DENOMINATOR;
  const cacheWriteCredits = pricing.cacheWrite
    ? ((normalizedUsage.cache_write_tokens || 0) * pricing.cacheWrite) / CREDIT_DENOMINATOR
    : 0;
  const outputCredits = ((normalizedUsage.output_tokens || 0) * pricing.output) / CREDIT_DENOMINATOR;
  const totalCredits = inputCredits + cachedInputCredits + cacheWriteCredits + outputCredits;

  return {
    inputCredits,
    cachedInputCredits,
    cacheWriteCredits,
    outputCredits,
    totalCredits,
  };
}

function applyAiCreditsUsage(normalizedUsage, model) {
  if (!normalizedUsage) return null;
  const safeModel = model || 'unknown';
  const calc = calculateAiCredits(normalizedUsage, safeModel);
  if (!calc) return null;

  if (!Object.hasOwn(aiCreditsState.byModel, safeModel)) {
    aiCreditsState.byModel[safeModel] = {
      inputCredits: 0,
      cachedInputCredits: 0,
      cacheWriteCredits: 0,
      outputCredits: 0,
      totalCredits: 0,
    };
  }

  const modelBucket = aiCreditsState.byModel[safeModel];
  modelBucket.inputCredits += calc.inputCredits;
  modelBucket.cachedInputCredits += calc.cachedInputCredits;
  modelBucket.cacheWriteCredits += calc.cacheWriteCredits;
  modelBucket.outputCredits += calc.outputCredits;
  modelBucket.totalCredits += calc.totalCredits;
  aiCreditsState.totalAiCredits += calc.totalCredits;

  process.env.AWF_AI_CREDITS_USED = String(roundCredits(aiCreditsState.totalAiCredits));

  return {
    aiCreditsThisResponse: roundCredits(calc.totalCredits),
    inputCreditsThisResponse: roundCredits(calc.inputCredits),
    cachedInputCreditsThisResponse: roundCredits(calc.cachedInputCredits),
    cacheWriteCreditsThisResponse: roundCredits(calc.cacheWriteCredits),
    outputCreditsThisResponse: roundCredits(calc.outputCredits),
    totalAiCredits: roundCredits(aiCreditsState.totalAiCredits),
  };
}

function getAiCreditsReflectState() {
  const byModel = {};
  for (const [model, usage] of Object.entries(aiCreditsState.byModel)) {
    byModel[model] = {
      input_credits: roundCredits(usage.inputCredits),
      cached_input_credits: roundCredits(usage.cachedInputCredits),
      cache_write_credits: roundCredits(usage.cacheWriteCredits),
      output_credits: roundCredits(usage.outputCredits),
      total: roundCredits(usage.totalCredits),
    };
  }
  return {
    total: roundCredits(aiCreditsState.totalAiCredits),
    by_model: byModel,
  };
}

function getAiCreditsBlockState() {
  const config = getAiCreditsConfig();
  const roundedTotalAiCredits = roundCredits(aiCreditsState.totalAiCredits);

  // Hard cap always applies, regardless of config
  if (roundedTotalAiCredits >= HARD_CAP_AI_CREDITS) {
    return {
      maxAiCredits: HARD_CAP_AI_CREDITS,
      totalAiCredits: roundedTotalAiCredits,
      maxExceeded: true,
      hardCap: true,
    };
  }

  if (!config.max) return null;
  return {
    maxAiCredits: config.max,
    totalAiCredits: roundedTotalAiCredits,
    maxExceeded: roundedTotalAiCredits >= config.max,
  };
}

function buildAiCreditsLimitError(aiCreditsBlockState) {
  const isHardCap = aiCreditsBlockState.hardCap === true;
  return {
    error: {
      type: 'ai_credits_limit_exceeded',
      message: isHardCap
        ? `Hard cap on AI credits reached (${aiCreditsBlockState.totalAiCredits.toFixed(6)} / ${aiCreditsBlockState.maxAiCredits}). This limit cannot be overridden.`
        : `Maximum AI credits exceeded (${aiCreditsBlockState.totalAiCredits.toFixed(6)} / ${aiCreditsBlockState.maxAiCredits}).`,
      total_ai_credits: aiCreditsBlockState.totalAiCredits,
      max_ai_credits: aiCreditsBlockState.maxAiCredits,
      hard_cap: isHardCap,
    },
  };
}

function resetAiCreditsGuardForTests() {
  aiCreditsState = createAiCreditsState();
  aiCreditsConfigCache.rawMax = undefined;
  aiCreditsConfigCache.rawDefault = undefined;
  aiCreditsConfigCache.parsed = { max: null, defaultPricing: null };
  delete process.env.AWF_AI_CREDITS_USED;
}

module.exports = {
  HARD_CAP_AI_CREDITS,
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  checkUnknownModelRejection,
  canonicalizeModel,
  resetAiCreditsGuardForTests,
};
