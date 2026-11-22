'use strict';

const { logRequest } = require('../logging');
const {
  createSteeringDeliveryState,
  resetSteeringConversationSecretForTests,
} = require('./steering-thresholds');
const exact = require('../catalogue-contract/exact-pricing');
const { HARD_CAP_AI_CREDITS, parseAiCreditsConfig } = require('./ai-credits/config');
const { createAiCreditsPricing } = require('./ai-credits/pricing');
const { createAiCreditsAccounting } = require('./ai-credits/accounting');
const { createAiCreditsSteering } = require('./ai-credits/steering');

function createAiCreditsState() {
  return {
    totalAiCredits: exact.ZERO,
    byModel: {},
    warnedUnknownModels: new Set(),
    pricingFailure: false,
    steeringConfigKey: null,
    emittedThresholds: new Set(),
    littleLeftRank: null,
    recentRequestCosts: [],
    steeringDelivery: createSteeringDeliveryState(),
  };
}

let aiCreditsState = createAiCreditsState();

const aiCreditsConfigCache = {
  initialized: false,
  rawMax: undefined,
  rawDefault: undefined,
  rawHardCap: undefined,
  parsed: { max: null, defaultPricing: null },
};

const getState = () => aiCreditsState;
const {
  resolveModelPricing,
  checkModelPricing,
  isModelPriceable,
  isRecognizedDynamicSelector,
  canonicalizeModel,
  getDynamicSelectorDescriptor,
} = createAiCreditsPricing({ getState, getAiCreditsConfig });
const {
  updateAiCreditSteeringThresholds,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  getPendingAiCreditSteeringWarning,
  hasCrossedAiCreditSteeringThreshold,
  acknowledgeAiCreditSteeringWarning,
  claimAiCreditSteeringWarning,
} = createAiCreditsSteering({ getState, getAiCreditsConfig, throwAccountingFailure });
const { applyAiCreditsUsage } = createAiCreditsAccounting({
  getState, getAiCreditsConfig, resolveModelPricing, getDynamicSelectorDescriptor,
  throwAccountingFailure, updateAiCreditSteeringThresholds,
});

function getAiCreditsConfig() {
  try {
    return parseAiCreditsConfig(aiCreditsConfigCache);
  } catch (error) {
    throwAccountingFailure(error);
  }
}

function throwAccountingFailure(error) {
  aiCreditsState.pricingFailure = true;
  if (error.code === 'pricing_resolution_error') throw error;
  logRequest('error', 'pricing_resolution_error', {
    reason: 'exact_accounting_failed', message: 'AI-credit accounting failed; no approximate price was applied.',
  });
  const sanitized = new Error('AI-credit pricing resolution failed');
  sanitized.code = 'pricing_resolution_error';
  sanitized.statusCode = 500;
  throw sanitized;
}

function resetAiCreditsGuardForTests() {
  resetSteeringConversationSecretForTests();
  aiCreditsState = createAiCreditsState();
  aiCreditsConfigCache.initialized = false;
  aiCreditsConfigCache.rawMax = undefined;
  aiCreditsConfigCache.rawDefault = undefined;
  aiCreditsConfigCache.rawHardCap = undefined;
  aiCreditsConfigCache.parsed = { max: null, defaultPricing: null };
  delete process.env.AWF_AI_CREDITS_USED;
}

module.exports = {
  HARD_CAP_AI_CREDITS,
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  getPendingAiCreditSteeringWarning,
  hasCrossedAiCreditSteeringThreshold,
  acknowledgeAiCreditSteeringWarning,
  claimAiCreditSteeringWarning,
  checkModelPricing,
  isRecognizedDynamicSelector,
  isModelPriceable,
  canonicalizeModel,
  resetAiCreditsGuardForTests,
};
