const {
  HARD_CAP_AI_CREDITS,
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  getPendingAiCreditSteeringWarning,
  acknowledgeAiCreditSteeringWarning,
  claimAiCreditSteeringWarning,
  resetAiCreditsGuardForTests,
} = require('./ai-credits-guard');
const { clearRuntimeModels } = require('../runtime-model-catalog');
const { resetProviderPricingOverlaysForTests } = require('../provider-pricing-overlays');
const { resetModelPricingCatalogForTests } = require('../model-pricing-catalog');

describe('AI credit steering notices', () => {
  let originalEnvironment;

  beforeEach(() => {
    originalEnvironment = { ...process.env };
    for (const key of ['AWF_MAX_AI_CREDITS', 'AWF_AI_CREDITS_HARD_CAP',
      'AWF_DEFAULT_AI_CREDITS_PRICING', 'AWF_MODEL_PRICING_CATALOG',
      'AWF_API_PROXY_PROVIDERS']) delete process.env[key];
    resetAiCreditsGuardForTests();
    clearRuntimeModels();
    resetProviderPricingOverlaysForTests();
    resetModelPricingCatalogForTests();
  });

  afterEach(() => {
    resetAiCreditsGuardForTests();
    clearRuntimeModels();
    resetProviderPricingOverlaysForTests();
    resetModelPricingCatalogForTests();
    jest.restoreAllMocks();
    process.env = originalEnvironment;
  });

  it('steers fractional AI-credit budgets independently', () => {
    process.env.AWF_MAX_AI_CREDITS = '0.001';
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 32 }, 'gpt-5-mini', 'copilot');

    // The only request so far cost 80% of the budget: less than one more fits.
    expect(getPendingAiCreditSteeringWarning()).toEqual({
      rank: 80.5,
      threshold: null,
      trigger: 'little_left',
      message: '[AWF AI CREDIT WARNING] 0.0008 of 0.001 AI credits are used; at the current rate less than ' +
        "one more model request fits. If you are responsible for this workflow's final output, stop the " +
        'remaining work and submit it now with what you have. Otherwise, finish your current step and ' +
        'return what you have to the agent that started you.',
    });
    expect(getAiCreditsReflectState()).toMatchObject({
      max_ai_credits: 0.001,
      effective_max_ai_credits: 0.001,
      percent_used: 80,
      thresholds_crossed: [80],
      thresholds_pending: [80],
      little_left_triggered: true,
    });
  });

  it('uses the 10,000-credit hard cap as the steering ceiling', () => {
    process.env.AWF_MAX_AI_CREDITS = '20000';
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 320_000_000 }, 'gpt-5-mini', 'copilot');

    expect(getPendingAiCreditSteeringWarning()).toMatchObject({ rank: 80.5, trigger: 'little_left' });
    expect(getPendingAiCreditSteeringWarning().message).toContain('8000 of 10000 AI credits are used');
    expect(getAiCreditsReflectState()).toMatchObject({
      max_ai_credits: HARD_CAP_AI_CREDITS,
      effective_max_ai_credits: HARD_CAP_AI_CREDITS,
      percent_used: 80,
      thresholds_crossed: [80],
    });
  });

  it('drops superseded credit thresholds once the newest one is delivered without weakening terminal enforcement', () => {
    process.env.AWF_MAX_AI_CREDITS = '0.001';
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 32 }, 'gpt-5-mini', 'copilot');
    acknowledgeAiCreditSteeringWarning(80);
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 8 }, 'gpt-5-mini', 'copilot');
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 4 }, 'gpt-5-mini', 'copilot');
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 4 }, 'gpt-5-mini', 'copilot');

    expect(getPendingAiCreditSteeringWarning().threshold).toBe(99);
    acknowledgeAiCreditSteeringWarning(99);
    expect(getPendingAiCreditSteeringWarning()).toBeNull();
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([]);
    expect(getAiCreditsBlockState()).toMatchObject({
      maxAiCredits: 0.001,
      maxExceeded: true,
    });
  });

  it('keeps a claimed credit notice pending until its request succeeds', () => {
    process.env.AWF_MAX_AI_CREDITS = '1';
    applyAiCreditsUsage({ input_tokens: 32_000 }, 'gpt-5-mini', 'copilot');
    applyAiCreditsUsage({ input_tokens: 4_000 }, 'gpt-5-mini', 'copilot');
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([80, 90]);

    const failed = claimAiCreditSteeringWarning(getPendingAiCreditSteeringWarning().threshold);
    // While the 90% notice is in flight, neither it nor the older 80% notice is offered again.
    expect(getPendingAiCreditSteeringWarning()).toBeNull();
    failed.release();
    expect(getPendingAiCreditSteeringWarning().threshold).toBe(90);
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([80, 90]);

    const delivered = claimAiCreditSteeringWarning(90);
    delivered.acknowledge();
    delivered.release();
    expect(getPendingAiCreditSteeringWarning()).toBeNull();
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([]);
  });

  it('offers a newer credit notice while an older one is in flight', () => {
    process.env.AWF_MAX_AI_CREDITS = '1';
    applyAiCreditsUsage({ input_tokens: 32_000 }, 'gpt-5-mini', 'copilot');
    const older = claimAiCreditSteeringWarning(getPendingAiCreditSteeringWarning().threshold);
    applyAiCreditsUsage({ input_tokens: 4_000 }, 'gpt-5-mini', 'copilot');

    expect(getPendingAiCreditSteeringWarning().threshold).toBe(90);
    claimAiCreditSteeringWarning(90).acknowledge();
    older.release();
    expect(getPendingAiCreditSteeringWarning()).toBeNull();
    expect(getAiCreditsReflectState().thresholds_pending).toEqual([]);
  });

  describe('notice wording and the "little left" notice', () => {
    const DIRECTIVE = "If you are responsible for this workflow's final output, stop the remaining work and " +
      'submit it now with what you have. Otherwise, finish your current step and return what you have to ' +
      'the agent that started you.';
    // 400,000 gpt-5-mini input tokens cost 10 credits.
    const spend = (credits, options) => applyAiCreditsUsage(
      { input_tokens: credits * 40_000 }, 'gpt-5-mini', 'copilot', options);

    it('states the credits used and the requests that still fit, then the fixed directive', () => {
      process.env.AWF_MAX_AI_CREDITS = '300';
      for (let i = 0; i < 24; i++) spend(10);

      expect(getPendingAiCreditSteeringWarning()).toEqual({
        rank: 80, threshold: 80, trigger: 'threshold',
        message: '[AWF AI CREDIT WARNING] 240 of 300 AI credits are used; at the current rate about 6 more ' +
          `model requests fit. ${DIRECTIVE}`,
      });
      acknowledgeAiCreditSteeringWarning(80);

      // About five requests' worth left: the "little left" notice fires
      // between the 80% and 90% thresholds and ranks between them.
      spend(10);
      expect(getPendingAiCreditSteeringWarning()).toEqual({
        rank: 80.5, threshold: null, trigger: 'little_left',
        message: '[AWF AI CREDIT WARNING] 250 of 300 AI credits are used; at the current rate about 5 more ' +
          `model requests fit. ${DIRECTIVE}`,
      });
      expect(getAiCreditsReflectState()).toMatchObject({
        thresholds_crossed: [80], thresholds_pending: [], little_left_triggered: true,
      });

      spend(20);
      expect(getPendingAiCreditSteeringWarning()).toMatchObject({ rank: 90, threshold: 90, trigger: 'threshold' });
      expect(getPendingAiCreditSteeringWarning().message).toContain('270 of 300 AI credits are used; at the ' +
        'current rate about 2 more model requests fit.');
    });

    it('rounds used credits up and the ceiling down, so a notice never overstates what is left', () => {
      process.env.AWF_MAX_AI_CREDITS = '300';
      spend(247.3);
      expect(getPendingAiCreditSteeringWarning().message).toBe('[AWF AI CREDIT WARNING] 248 of 300 AI credits ' +
        `are used; at the current rate less than one more model request fits. ${DIRECTIVE}`);
      // 299.7 used: 0.3 left, so it never reads "299 of 300".
      spend(52.4);
      expect(getPendingAiCreditSteeringWarning().message).toContain('300 of 300 AI credits are used;');

      resetAiCreditsGuardForTests();
      process.env.AWF_MAX_AI_CREDITS = '25.38';
      spend(20.02);
      expect(getPendingAiCreditSteeringWarning().message).toContain('20.1 of 25.3 AI credits are used;');
    });

    it.each([
      ['0.0000001', 1, '0.00000008 of 0.0000001'],
      ['0.000001', 10, '0.0000008 of 0.000001'],
    ])('keeps both values meaningful for a %s-credit ceiling', (ceiling, tokens, facts) => {
      process.env.AWF_MAX_AI_CREDITS = ceiling;
      // 1 input token costs 0.00000008 credits at this price.
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 0.0008, output: 0 });
      applyAiCreditsUsage({ input_tokens: tokens }, 'unlisted-test-model', 'openai');
      expect(getPendingAiCreditSteeringWarning().message).toContain(`] ${facts} AI credits are used;`);
    });

    it('fires the "little left" notice only once at least half the budget is used, and once per run', () => {
      process.env.AWF_MAX_AI_CREDITS = '100';
      spend(40);
      expect(getPendingAiCreditSteeringWarning()).toBeNull();
      expect(getAiCreditsReflectState().little_left_triggered).toBe(false);

      spend(15);
      expect(getPendingAiCreditSteeringWarning()).toEqual({
        rank: 0.5, threshold: null, trigger: 'little_left',
        message: '[AWF AI CREDIT WARNING] 55 of 100 AI credits are used; at the current rate about 1 more ' +
          `model request fits. ${DIRECTIVE}`,
      });
      claimAiCreditSteeringWarning(0.5).acknowledge();
      expect(getPendingAiCreditSteeringWarning()).toBeNull();

      spend(1);
      expect(getPendingAiCreditSteeringWarning()).toBeNull();
      spend(24);
      expect(getPendingAiCreditSteeringWarning()).toMatchObject({ rank: 80, trigger: 'threshold' });
    });

    it('never offers the "little left" notice after a more urgent threshold in the same conversation', () => {
      process.env.AWF_MAX_AI_CREDITS = '100';
      for (let i = 0; i < 9; i++) spend(5);
      spend(35);
      // 80 credits used at 8 credits a request: 80% and "little left" fire
      // together, and "little left" is the current notice.
      expect(getPendingAiCreditSteeringWarning('conversation-a')).toMatchObject({ rank: 80.5 });
      claimAiCreditSteeringWarning(80.5, 'conversation-a').acknowledge();
      spend(10);
      expect(getPendingAiCreditSteeringWarning('conversation-a')).toMatchObject({ rank: 90 });
      claimAiCreditSteeringWarning(90, 'conversation-a').acknowledge();
      expect(getPendingAiCreditSteeringWarning('conversation-a')).toBeNull();
      // A conversation that has heard nothing gets only the current notice.
      expect(getPendingAiCreditSteeringWarning('conversation-b')).toMatchObject({ rank: 90 });
    });

    it('leaves out the estimate when no recent request cost counts, excluding routing classifiers', () => {
      process.env.AWF_MAX_AI_CREDITS = '1';
      applyAiCreditsUsage({ input_tokens: 32_000 }, 'gpt-5-mini', 'copilot', { purpose: 'routing_classification' });

      expect(getPendingAiCreditSteeringWarning()).toEqual({
        rank: 80, threshold: 80, trigger: 'threshold',
        message: `[AWF AI CREDIT WARNING] 0.8 of 1 AI credits are used. ${DIRECTIVE}`,
      });
      expect(getAiCreditsReflectState().little_left_triggered).toBe(false);
    });
  });

  it('invalidates cached steering limits when the raw hard cap changes without changing its number projection', () => {
    process.env.AWF_AI_CREDITS_HARD_CAP = '1.0000000000000000000000000001';
    applyAiCreditsUsage({ input_tokens: 32_000 }, 'gpt-5-mini', 'copilot');

    expect(getAiCreditsReflectState().thresholds_crossed).toEqual([]);
    expect(getPendingAiCreditSteeringWarning()).toMatchObject({ rank: 0.5, trigger: 'little_left' });

    process.env.AWF_AI_CREDITS_HARD_CAP = '1';

    expect(getPendingAiCreditSteeringWarning()).toMatchObject({ rank: 80.5, trigger: 'little_left' });
    expect(getAiCreditsReflectState().thresholds_crossed).toEqual([80]);
  });

  it.each([
    ['20000', 640_000_000],
    ['100', 3_200_000],
  ])('uses operator hard cap %s for reflection and steering', (rawCap, inputTokens) => {
    process.env.AWF_AI_CREDITS_HARD_CAP = rawCap;
    applyAiCreditsUsage({ input_tokens: inputTokens }, 'gpt-5-mini', 'copilot');
    expect(getPendingAiCreditSteeringWarning()).toMatchObject({ rank: 80.5, trigger: 'little_left' });
    expect(getAiCreditsReflectState()).toMatchObject({
      effective_max_ai_credits: Number(rawCap),
      percent_used: 80,
      thresholds_crossed: [80],
    });
    expect(getAiCreditsBlockState()).toBeNull();
  });
});
