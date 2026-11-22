'use strict';

const guard = require('./ai-credits-guard');
const { clearRuntimeModels } = require('../runtime-model-catalog');
const { resetProviderPricingOverlaysForTests } = require('../provider-pricing-overlays');
const { resetModelPricingCatalogForTests } = require('../model-pricing-catalog');
const { collectLogOutput } = require('../test-helpers/log-test-helpers');

describe('AI credits facade state ownership', () => {
  let environment;
  let logs;
  const model = 'facade-fixture';
  const charge = (tokens = 10000, options = {}) => guard.applyAiCreditsUsage(
    { input_tokens: tokens }, model, 'openai', { catalogue: null, ...options });

  beforeEach(() => {
    environment = { ...process.env };
    for (const key of ['AWF_MAX_AI_CREDITS', 'AWF_AI_CREDITS_HARD_CAP',
      'AWF_DEFAULT_AI_CREDITS_PRICING', 'AWF_MODEL_PRICING_CATALOG',
      'AWF_API_PROXY_PROVIDERS']) delete process.env[key];
    guard.resetAiCreditsGuardForTests();
    clearRuntimeModels();
    resetProviderPricingOverlaysForTests();
    resetModelPricingCatalogForTests();
    logs = collectLogOutput().lines;
    process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: '1', output: '0' });
    process.env.AWF_MAX_AI_CREDITS = '1';
  });

  afterEach(() => {
    guard.resetAiCreditsGuardForTests();
    clearRuntimeModels();
    resetProviderPricingOverlaysForTests();
    resetModelPricingCatalogForTests();
    jest.restoreAllMocks();
    process.env = environment;
  });

  it('preserves the public exports', () => {
    const functions = [
      'applyAiCreditsUsage', 'getAiCreditsReflectState', 'getAiCreditsBlockState',
      'buildAiCreditsLimitError', 'getPendingAiCreditSteeringWarning',
      'hasCrossedAiCreditSteeringThreshold', 'acknowledgeAiCreditSteeringWarning',
      'claimAiCreditSteeringWarning', 'checkModelPricing', 'isRecognizedDynamicSelector',
      'isModelPriceable', 'canonicalizeModel', 'resetAiCreditsGuardForTests',
    ];
    expect(Object.keys(guard).sort()).toEqual(['HARD_CAP_AI_CREDITS', ...functions].sort());
    expect(guard.HARD_CAP_AI_CREDITS).toBe(10000);
    for (const name of functions) expect(typeof guard[name]).toBe('function');
  });

  it('shares exact totals across accounting, reflection, steering, and both limits', () => {
    charge(8000, { purpose: 'routing_classification' });
    expect(process.env.AWF_AI_CREDITS_USED).toBe('0.8');
    expect(guard.getAiCreditsReflectState()).toMatchObject({
      total: 0.8, thresholds_crossed: [80], by_model: { [model]: { total: 0.8 } },
    });
    expect(guard.getAiCreditsBlockState()).toMatchObject({ totalAiCredits: 0.8, maxExceeded: false });
    expect(guard.hasCrossedAiCreditSteeringThreshold()).toBe(true);
    const warning = guard.getPendingAiCreditSteeringWarning();
    expect(warning).toMatchObject({ rank: 80 });
    guard.claimAiCreditSteeringWarning(warning.rank).acknowledge();
    expect(guard.getPendingAiCreditSteeringWarning()).toBeNull();

    charge(2000, { purpose: 'routing_classification' });
    const block = guard.getAiCreditsBlockState();
    expect(block).toEqual({ maxAiCredits: 1, totalAiCredits: 1, maxExceeded: true });
    expect(guard.buildAiCreditsLimitError(block).error).toMatchObject({
      total_ai_credits: 1, max_ai_credits: 1, hard_cap: false,
    });
    delete process.env.AWF_MAX_AI_CREDITS;
    process.env.AWF_AI_CREDITS_HARD_CAP = '1';
    expect(guard.getAiCreditsBlockState()).toEqual({ ...block, hardCap: true });
  });

  it('resets every module without reloading the facade or retaining old notice claims', () => {
    charge();
    const oldClaim = guard.claimAiCreditSteeringWarning(
      guard.getPendingAiCreditSteeringWarning('conversation').rank, 'conversation');
    expect(() => charge(-1)).toThrow(expect.objectContaining({ code: 'pricing_resolution_error' }));
    expect(guard.checkModelPricing(model, 'openai').error.type).toBe('pricing_resolution_error');

    guard.resetAiCreditsGuardForTests();
    oldClaim.acknowledge();
    oldClaim.release();
    expect(process.env.AWF_AI_CREDITS_USED).toBeUndefined();
    expect(guard.getAiCreditsReflectState()).toMatchObject({
      total: 0, thresholds_crossed: [], thresholds_pending: [],
      little_left_triggered: false, by_model: {},
    });
    expect(guard.getAiCreditsReflectState()).not.toHaveProperty('pricing_error');
    expect(guard.checkModelPricing(model, 'openai')).toBeNull();
    expect(guard.hasCrossedAiCreditSteeringThreshold()).toBe(false);
    expect(guard.getPendingAiCreditSteeringWarning('conversation')).toBeNull();
    expect(guard.getAiCreditsBlockState().maxExceeded).toBe(false);

    charge(8000, { purpose: 'routing_classification' });
    expect(guard.getPendingAiCreditSteeringWarning('conversation')).toMatchObject({
      rank: 80, message: expect.stringContaining('0.8 of 1 AI credits are used.'),
    });
    expect(guard.getAiCreditsReflectState().little_left_triggered).toBe(false);
  });

  it('shares configuration refreshes without discarding accumulated usage', () => {
    charge(5000);
    process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: '2', output: '0' });
    expect(charge(2500)).toMatchObject({ aiCreditsThisResponse: 0.5, totalAiCredits: 1 });
    expect(guard.getAiCreditsBlockState().maxExceeded).toBe(true);

    process.env.AWF_MAX_AI_CREDITS = '2';
    expect(guard.getAiCreditsBlockState()).toMatchObject({ maxAiCredits: 2, maxExceeded: false });
    expect(guard.getAiCreditsReflectState().effective_max_ai_credits).toBe(2);
    process.env.AWF_AI_CREDITS_HARD_CAP = '0.75';
    expect(guard.getAiCreditsReflectState()).toMatchObject({
      total: 1, max_ai_credits: 0.75, effective_max_ai_credits: 0.75, percent_used: 100,
    });
    expect(guard.getAiCreditsBlockState()).toMatchObject({
      maxAiCredits: 0.75, totalAiCredits: 1, maxExceeded: true, hardCap: true,
    });
  });

  it('resets pricing warning deduplication along with accounting state', () => {
    delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    const options = { catalogue: null, runtimeCatalog: {}, allowMedianEstimate: false };
    expect(guard.isModelPriceable(model, 'openai', options)).toBe(false);
    expect(logs).toEqual([]);
    expect(guard.checkModelPricing(model, 'openai', options)).toBeNull();
    expect(guard.checkModelPricing(model, 'openai', options)).toBeNull();
    expect(logs.filter(log => log.event === 'unknown_model_ai_credits_pricing')).toHaveLength(1);

    guard.resetAiCreditsGuardForTests();
    expect(guard.checkModelPricing(model, 'openai', options)).toBeNull();
    expect(logs.filter(log => log.event === 'unknown_model_ai_credits_pricing')).toHaveLength(2);
  });
});
