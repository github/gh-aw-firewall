'use strict';

const {
  BUDGET_WARNING_THRESHOLDS,
  STEERING_DIRECTIVE,
  LITTLE_LEFT_MIN_PERCENT,
  littleLeftSteeringRank,
  describeSteeringRank,
  steeringThresholdsOnly,
  createSteeringDeliveryState,
  selectSteeringThreshold,
  acknowledgeSteeringThreshold,
  claimSteeringThreshold,
} = require('../steering-thresholds');
const { getHardCapAiCredits } = require('./config');
const exact = require('../../catalogue-contract/exact-pricing');

// The "little left" credit notice fires once about this many requests' worth
// of credits remain.
const LITTLE_LEFT_REQUESTS = 5;

function roundCredits(value) {
  return exact.number(value);
}

/** floor(log10(value)) of a positive exact value. */
function decimalExponent(value) {
  let exponent = value.n.toString().length - value.d.toString().length;
  const atLeast = exponent >= 0
    ? value.n >= value.d * 10n ** BigInt(exponent)
    : value.n * 10n ** BigInt(-exponent) >= value.d;
  if (!atLeast) exponent -= 1;
  return exponent;
}

/** `units` at `places` decimals, without trailing zeros. */
function formatCreditUnits(units, places) {
  const scale = 10n ** BigInt(places);
  const fraction = places ? (units % scale).toString().padStart(places, '0').replace(/0+$/, '') : '';
  return fraction ? `${units / scale}.${fraction}` : `${units / scale}`;
}

/**
 * "<used> of <ceiling>", with about three significant digits of the ceiling
 * (300 -> 0 decimals, 25 -> 1, 1 -> 2, 0.0000001 -> 9). Used credits are
 * rounded up and the ceiling down, so a notice never overstates what is
 * left; while the ceiling is not exceeded, used is shown as at most the
 * ceiling.
 */
function formatCreditsUsedOf(used, ceiling) {
  const places = Math.max(0, 2 - decimalExponent(ceiling));
  const scale = 10n ** BigInt(places);
  const ceilingUnits = (ceiling.n * scale) / ceiling.d;
  let usedUnits = (used.n * scale + used.d - 1n) / used.d;
  if (usedUnits > ceilingUnits && exact.compare(used, ceiling) <= 0) usedUnits = ceilingUnits;
  return `${formatCreditUnits(usedUnits, places)} of ${formatCreditUnits(ceilingUnits, places)}`;
}

function buildAiCreditsLimitError(aiCreditsBlockState) {
  const isHardCap = aiCreditsBlockState.hardCap === true;
  return {
    error: {
      type: 'ai_credits_limit_exceeded',
      message: isHardCap
        ? `Hard cap on AI credits reached (${aiCreditsBlockState.totalAiCredits.toFixed(6)} / ${aiCreditsBlockState.maxAiCredits}). This limit is set by the operator and cannot be raised from inside the run.`
        : `Maximum AI credits exceeded (${aiCreditsBlockState.totalAiCredits.toFixed(6)} / ${aiCreditsBlockState.maxAiCredits}).`,
      total_ai_credits: aiCreditsBlockState.totalAiCredits,
      max_ai_credits: aiCreditsBlockState.maxAiCredits,
      hard_cap: isHardCap,
    },
  };
}

function createAiCreditsSteering({ getState, getAiCreditsConfig, throwAccountingFailure }) {
  function getEffectiveAiCreditsCeiling(config = getAiCreditsConfig()) {
    return config.exactMax ?? config.preciseHardCap;
  }

  function updateAiCreditSteeringThresholds() {
    const config = getAiCreditsConfig();
    const ceiling = getEffectiveAiCreditsCeiling(config);
    const configKey = `${ceiling.n}/${ceiling.d}`;
    const aiCreditsState = getState();
    if (aiCreditsState.steeringConfigKey !== configKey) {
      aiCreditsState.steeringConfigKey = configKey;
      aiCreditsState.emittedThresholds = new Set();
      aiCreditsState.littleLeftRank = null;
      aiCreditsState.steeringDelivery = createSteeringDeliveryState();
    }

    const used = percent => exact.compare(exact.multiply(aiCreditsState.totalAiCredits, exact.decimal(100)),
      exact.multiply(ceiling, exact.decimal(percent))) >= 0;
    for (const threshold of BUDGET_WARNING_THRESHOLDS) {
      if (used(threshold) && !aiCreditsState.emittedThresholds.has(threshold)) {
        aiCreditsState.emittedThresholds.add(threshold);
        aiCreditsState.steeringDelivery.pending.add(threshold);
      }
    }

    // "Little left": about five requests' worth of credits remain, once at least
    // half the budget is used; at most once per run. Without a recent cost
    // there is no estimate, so it does not fire.
    const average = averageRecentRequestCost();
    if (aiCreditsState.littleLeftRank === null && average && used(LITTLE_LEFT_MIN_PERCENT) &&
      exact.compare(remainingAiCredits(ceiling),
        exact.multiply(average, exact.decimal(LITTLE_LEFT_REQUESTS))) <= 0) {
      aiCreditsState.littleLeftRank = littleLeftSteeringRank(aiCreditsState.emittedThresholds);
      aiCreditsState.emittedThresholds.add(aiCreditsState.littleLeftRank);
      aiCreditsState.steeringDelivery.pending.add(aiCreditsState.littleLeftRank);
    }
  }

  /** Credits left under `ceiling` (zero once it is reached). */
  function remainingAiCredits(ceiling) {
    const total = getState().totalAiCredits;
    if (exact.compare(total, ceiling) >= 0) return exact.ZERO;
    return exact.divide(
      { n: ceiling.n * total.d - total.n * ceiling.d, d: 1n },
      { n: ceiling.d * total.d, d: 1n },
    );
  }

  /** Average cost of the run's recent priced model requests, or null if none cost anything. */
  function averageRecentRequestCost() {
    const costs = getState().recentRequestCosts;
    if (costs.length === 0) return null;
    const average = exact.divide(costs.reduce(exact.add, exact.ZERO), exact.decimal(costs.length));
    return exact.compare(average, exact.ZERO) > 0 ? average : null;
  }

  function getAiCreditsReflectState() {
    try {
      return buildAiCreditsReflectState();
    } catch (error) {
      throwAccountingFailure(error);
    }
  }

  function buildAiCreditsReflectState() {
    const config = getAiCreditsConfig();
    const effectiveCeiling = getEffectiveAiCreditsCeiling(config);
    const aiCreditsState = getState();
    const reflectedTotal = exact.compare(aiCreditsState.totalAiCredits, effectiveCeiling) < 0
      ? aiCreditsState.totalAiCredits : effectiveCeiling;
    const byModel = {};
    for (const [model, usage] of Object.entries(aiCreditsState.byModel)) {
      byModel[model] = {
        input_credits: roundCredits(usage.inputCredits),
        cached_input_credits: roundCredits(usage.cachedInputCredits),
        cache_write_credits: roundCredits(usage.cacheWriteCredits),
        output_credits: roundCredits(usage.outputCredits),
        total: roundCredits(usage.totalCredits),
        pricing_source: usage.pricingSource,
        pricing_tier: usage.pricingTier,
        ...(usage.pricingCatalogId ? { pricing_catalog_id: usage.pricingCatalogId } : {}),
        ...(usage.pricingCatalogVersion ? { pricing_catalog_version: usage.pricingCatalogVersion } : {}),
        ...(usage.pricingEstimate ? { pricing_estimate: usage.pricingEstimate } : {}),
        ...(usage.pricingPromotion ? { pricing_promotion: usage.pricingPromotion } : {}),
        accounting_policy: usage.accountingPolicy || null,
        fallback_pricing_used: usage.fallbackPricingUsed === true,
        dynamic_selector: usage.dynamicSelector || null,
      };
    }
    return {
      total: roundCredits(aiCreditsState.totalAiCredits),
      ...(aiCreditsState.pricingFailure ? { pricing_error: 'pricing_resolution_error' } : {}),
      max_ai_credits: config.max,
      effective_max_ai_credits: Number(config.max ?? config.hardCap),
      percent_used: exact.number(exact.multiply(exact.divide(reflectedTotal, effectiveCeiling), exact.decimal(100)), 2),
      thresholds_crossed: steeringThresholdsOnly(aiCreditsState.emittedThresholds),
      thresholds_pending: steeringThresholdsOnly(aiCreditsState.steeringDelivery.pending),
      little_left_triggered: aiCreditsState.littleLeftRank !== null,
      by_model: byModel,
    };
  }

  /**
   * Facts of an AI-credit notice, from the current totals: "247 of 300 AI
   * credits are used; at the current rate about 12 more model requests fit."
   * The estimate is the remaining credits divided by the average cost of the
   * run's recent priced model requests, rounded down, and is left out when no
   * recent request cost anything.
   */
  function buildAiCreditSteeringMessage() {
    const ceiling = getEffectiveAiCreditsCeiling();
    let facts = `${formatCreditsUsedOf(getState().totalAiCredits, ceiling)} AI credits are used`;
    const average = averageRecentRequestCost();
    if (average) {
      const quotient = exact.divide(remainingAiCredits(ceiling), average);
      const requests = Number(quotient.n / quotient.d);
      facts += requests === 0
        ? '; at the current rate less than one more model request fits'
        : `; at the current rate about ${requests} more model ${requests === 1 ? 'request fits' : 'requests fit'}`;
    }
    return `[AWF AI CREDIT WARNING] ${facts}. ${STEERING_DIRECTIVE}`;
  }

  /**
   * @param {string|null} [conversation] - Conversation key; omit for the
   *   run-level notice (each notice once per run).
   */
  function getPendingAiCreditSteeringWarning(conversation = null) {
    try {
      updateAiCreditSteeringThresholds();
    } catch (error) {
      throwAccountingFailure(error);
    }
    const aiCreditsState = getState();
    const rank = selectSteeringThreshold(
      aiCreditsState.steeringDelivery, aiCreditsState.emittedThresholds, conversation);
    if (rank === null) return null;
    let message;
    try {
      message = buildAiCreditSteeringMessage();
    } catch (error) {
      throwAccountingFailure(error);
    }
    return { ...describeSteeringRank(rank), message };
  }

  /**
   * Whether any AI-credit threshold has been crossed in this run, updating the
   * crossed thresholds first. Unlike the run-level pending notices, this stays
   * true after a notice is delivered, since other conversations may still need it.
   */
  function hasCrossedAiCreditSteeringThreshold() {
    try {
      updateAiCreditSteeringThresholds();
    } catch (error) {
      throwAccountingFailure(error);
    }
    return getState().emittedThresholds.size > 0;
  }

  /** @param {number} rank - Notice rank (warning.rank) */
  function acknowledgeAiCreditSteeringWarning(rank) {
    acknowledgeSteeringThreshold(getState().steeringDelivery.pending, rank);
  }

  /** @param {number} rank - Notice rank (warning.rank) */
  function claimAiCreditSteeringWarning(rank, conversation = null) {
    return claimSteeringThreshold(getState().steeringDelivery, rank, conversation);
  }

  function getAiCreditsBlockState() {
    const aiCreditsState = getState();
    const roundedTotalAiCredits = roundCredits(aiCreditsState.totalAiCredits);
    const hardCap = getHardCapAiCredits();

    // Hard cap always applies, regardless of config
    if (exact.compare(aiCreditsState.totalAiCredits, hardCap.preciseValue) >= 0) {
      return {
        maxAiCredits: hardCap.value,
        totalAiCredits: roundedTotalAiCredits,
        maxExceeded: true,
        hardCap: true,
      };
    }

    let config;
    try {
      config = getAiCreditsConfig();
    } catch (error) {
      if (error.code !== 'pricing_resolution_error') throw error;
      // The shared pricing-error descriptor blocks dispatch for invalid limits.
      return null;
    }
    if (!config.exactMax) return null;
    return {
      maxAiCredits: config.max,
      totalAiCredits: roundedTotalAiCredits,
      maxExceeded: exact.compare(aiCreditsState.totalAiCredits, config.exactMax) >= 0,
    };
  }

  return {
    updateAiCreditSteeringThresholds,
    getAiCreditsReflectState,
    getAiCreditsBlockState,
    buildAiCreditsLimitError,
    getPendingAiCreditSteeringWarning,
    hasCrossedAiCreditSteeringThreshold,
    acknowledgeAiCreditSteeringWarning,
    claimAiCreditSteeringWarning,
  };
}

module.exports = { createAiCreditsSteering };
