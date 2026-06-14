const {
  HARD_CAP_AI_CREDITS,
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  checkUnknownModelRejection,
  canonicalizeModel,
  resetAiCreditsGuardForTests,
} = require('./ai-credits-guard');
const { collectLogOutput } = require('../test-helpers/log-test-helpers');

describe('ai-credits-guard', () => {
  let originalMaxAiCredits;
  let originalDefaultPricing;

  beforeEach(() => {
    originalMaxAiCredits = process.env.AWF_MAX_AI_CREDITS;
    originalDefaultPricing = process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    resetAiCreditsGuardForTests();
  });

  afterEach(() => {
    resetAiCreditsGuardForTests();
    if (originalMaxAiCredits === undefined) {
      delete process.env.AWF_MAX_AI_CREDITS;
    } else {
      process.env.AWF_MAX_AI_CREDITS = originalMaxAiCredits;
    }
    if (originalDefaultPricing === undefined) {
      delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    } else {
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = originalDefaultPricing;
    }
    jest.restoreAllMocks();
  });

  it('calculates and accumulates AI credits by model', () => {
    const usage = applyAiCreditsUsage({
      input_tokens: 1000,
      cache_read_tokens: 100,
      output_tokens: 500,
    }, 'gpt-5-mini');

    // input_tokens includes cache_read_tokens, so non-cached = 900
    // inputCredits = 900 × $0.25/Mtok / 10000 = 0.0225
    // cachedInputCredits = 100 × $0.025/Mtok / 10000 = 0.00025
    // outputCredits = 500 × $2.00/Mtok / 10000 = 0.1
    expect(usage).toMatchObject({
      aiCreditsThisResponse: 0.12275,
      totalAiCredits: 0.12275,
    });
    expect(process.env.AWF_AI_CREDITS_USED).toBe('0.12275');
    expect(getAiCreditsReflectState()).toEqual({
      total: 0.12275,
      by_model: {
        'gpt-5-mini': {
          input_credits: 0.0225,
          cached_input_credits: 0.00025,
          cache_write_credits: 0,
          output_credits: 0.1,
          total: 0.12275,
        },
      },
    });
  });

  it('matches pricing table entries by model prefix', () => {
    const usage = applyAiCreditsUsage({
      input_tokens: 2000,
      cache_read_tokens: 1000,
      cache_write_tokens: 500,
      output_tokens: 100,
    }, 'claude-sonnet-4-6-20260601');

    // nonCached = 2000 - 1000 - 500 = 500
    // inputCredits = 500 × $3.00 / 10000 = 0.15
    // cachedInputCredits = 1000 × $0.30 / 10000 = 0.03
    // cacheWriteCredits = 500 × $3.75 / 10000 = 0.1875
    // outputCredits = 100 × $15.00 / 10000 = 0.15
    expect(usage.aiCreditsThisResponse).toBeCloseTo(0.5175, 10);
    expect(getAiCreditsReflectState().by_model['claude-sonnet-4-6-20260601'].total).toBeCloseTo(0.5175, 10);
  });

  it('does not double-count cached tokens (cache_read included in input_tokens)', () => {
    // Simulates: 3M total input, 2.9M from cache, 0.1M new input
    // This is how Anthropic reports: input_tokens is the total (includes cache hits)
    const usage = applyAiCreditsUsage({
      input_tokens: 3_000_000,
      cache_read_tokens: 2_900_000,
      output_tokens: 50_000,
    }, 'claude-sonnet-4-6');

    // nonCached = 3M - 2.9M = 100K
    // inputCredits = 100_000 × $3.00 / 10000 = 30
    // cachedInputCredits = 2_900_000 × $0.30 / 10000 = 87
    // outputCredits = 50_000 × $15.00 / 10000 = 75
    // total = 192 AIC
    expect(usage.inputCreditsThisResponse).toBeCloseTo(30, 5);
    expect(usage.cachedInputCreditsThisResponse).toBeCloseTo(87, 5);
    expect(usage.outputCreditsThisResponse).toBeCloseTo(75, 5);
    expect(usage.aiCreditsThisResponse).toBeCloseTo(192, 5);

    // BUG (before fix): would have been 30 + 87 + 75 + (2.9M × $3 / 10000) = 192 + 870 = 1062
    // i.e., cached tokens counted at full price AND cache rate
    expect(usage.aiCreditsThisResponse).toBeLessThan(250);
  });

  it('warns and skips usage for unknown models', () => {
    const { lines } = collectLogOutput();
    const usage = applyAiCreditsUsage({ input_tokens: 100 }, 'unknown-model');

    expect(usage).toBeNull();
    expect(getAiCreditsReflectState()).toEqual({ total: 0, by_model: {} });
    expect(lines).toContainEqual(expect.objectContaining({
      event: 'unknown_model_ai_credits_pricing',
      level: 'warn',
      model: 'unknown-model',
    }));
  });

  it('resolves text-embedding-3-small with input-only pricing', () => {
    const usage = applyAiCreditsUsage({ input_tokens: 1_000_000, output_tokens: 500 }, 'text-embedding-3-small');
    // input: 1M × $0.02/M / 10_000 denominator = 2.0 AIC
    // output: 500 tokens × $0.00/M = 0 AIC (embedding models produce no output cost)
    expect(usage).not.toBeNull();
    expect(usage.aiCreditsThisResponse).toBeCloseTo(2.0, 5);
    expect(usage.outputCreditsThisResponse).toBe(0);
  });

  it('resolves text-embedding-3-small-inference via prefix match', () => {
    const usage = applyAiCreditsUsage({ input_tokens: 1_000_000, output_tokens: 0 }, 'text-embedding-3-small-inference');
    // Same pricing as text-embedding-3-small via prefix match
    expect(usage).not.toBeNull();
    expect(usage.aiCreditsThisResponse).toBeCloseTo(2.0, 5);
  });

  it('resolves text-embedding-ada-002 with input-only pricing', () => {
    const usage = applyAiCreditsUsage({ input_tokens: 1_000_000, output_tokens: 1000 }, 'text-embedding-ada-002');
    // input: 1M × $0.10/M / 10_000 denominator = 10.0 AIC
    // output: 1000 tokens × $0.00/M = 0 AIC (embedding models produce no output cost)
    expect(usage).not.toBeNull();
    expect(usage.aiCreditsThisResponse).toBeCloseTo(10.0, 5);
    expect(usage.outputCreditsThisResponse).toBe(0);
  });

  it('does not reject embedding models when maxAiCredits is active', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();

    expect(checkUnknownModelRejection('text-embedding-3-small')).toBeNull();
    expect(checkUnknownModelRejection('text-embedding-3-small-inference')).toBeNull();
    expect(checkUnknownModelRejection('text-embedding-ada-002')).toBeNull();
  });

  it('uses bundled models.dev pricing for known catalog models', () => {
    const usage = applyAiCreditsUsage({
      input_tokens: 100,
      output_tokens: 10,
    }, 'perceptron/perceptron-mk1');

    expect(usage).toMatchObject({
      aiCreditsThisResponse: 0.003,
      totalAiCredits: 0.003,
    });
  });

  it('treats zero-cost catalog models as free instead of unknown', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();

    const usage = applyAiCreditsUsage({
      input_tokens: 1000,
      output_tokens: 500,
    }, 'google/gemma-4-31b-it:free');

    expect(usage).toMatchObject({
      aiCreditsThisResponse: 0,
      totalAiCredits: 0,
    });
    expect(checkUnknownModelRejection('google/gemma-4-31b-it:free')).toBeNull();
  });

  it('reports block state when max ai credits is configured and exceeded', () => {
    process.env.AWF_MAX_AI_CREDITS = '0.1';
    applyAiCreditsUsage({
      input_tokens: 1000,
      output_tokens: 500,
    }, 'gpt-5-mini');

    expect(getAiCreditsBlockState()).toEqual({
      maxAiCredits: 0.1,
      totalAiCredits: 0.125,
      maxExceeded: true,
    });
  });

  it('enforces hard cap even when no max is configured', () => {
    expect(process.env.AWF_MAX_AI_CREDITS).toBeUndefined();
    applyAiCreditsUsage({ input_tokens: 400_000_000, output_tokens: 0 }, 'gpt-5-mini');
    expect(getAiCreditsBlockState()).toEqual({
      maxAiCredits: HARD_CAP_AI_CREDITS,
      totalAiCredits: HARD_CAP_AI_CREDITS,
      maxExceeded: true,
      hardCap: true,
    });
  });

  it('clamps configured max to hard cap', () => {
    process.env.AWF_MAX_AI_CREDITS = '99999';
    applyAiCreditsUsage({ input_tokens: 100, output_tokens: 0 }, 'gpt-5-mini');
    const state = getAiCreditsBlockState();
    expect(state.maxAiCredits).toBe(HARD_CAP_AI_CREDITS);
  });

  it('builds a structured max ai credits limit error payload', () => {
    expect(buildAiCreditsLimitError({
      totalAiCredits: 0.125,
      maxAiCredits: 0.1,
    })).toEqual({
      error: {
        type: 'ai_credits_limit_exceeded',
        message: 'Maximum AI credits exceeded (0.125000 / 0.1).',
        total_ai_credits: 0.125,
        max_ai_credits: 0.1,
        hard_cap: false,
      },
    });
  });

  it('builds a hard cap error payload when hardCap is true', () => {
    expect(buildAiCreditsLimitError({
      totalAiCredits: 10000.5,
      maxAiCredits: 10000,
      hardCap: true,
    })).toEqual({
      error: {
        type: 'ai_credits_limit_exceeded',
        message: 'Hard cap on AI credits reached (10000.500000 / 10000). This limit cannot be overridden.',
        total_ai_credits: 10000.5,
        max_ai_credits: 10000,
        hard_cap: true,
      },
    });
  });

  describe('model name canonicalization', () => {
    it('resolves models with provider prefix (copilot/claude-sonnet-4-6)', () => {
      const usage = applyAiCreditsUsage({ input_tokens: 1000, output_tokens: 100 }, 'copilot/claude-sonnet-4-6');
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeGreaterThan(0);
    });

    it('resolves models with dot separators (claude-sonnet-4.6)', () => {
      resetAiCreditsGuardForTests();
      const usage = applyAiCreditsUsage({ input_tokens: 1000, output_tokens: 100 }, 'claude-sonnet-4.6');
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeGreaterThan(0);
    });

    it('resolves models with underscore separators (claude_sonnet_4_6)', () => {
      resetAiCreditsGuardForTests();
      const usage = applyAiCreditsUsage({ input_tokens: 1000, output_tokens: 100 }, 'claude_sonnet_4_6');
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeGreaterThan(0);
    });

    it('resolves models with combined prefix and dots (copilot/gpt-5.4-mini)', () => {
      resetAiCreditsGuardForTests();
      const usage = applyAiCreditsUsage({ input_tokens: 1000, output_tokens: 100 }, 'copilot/gpt-5.4-mini');
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeGreaterThan(0);
    });

    it('strips alpha date suffixes before pricing lookup', () => {
      resetAiCreditsGuardForTests();
      const usage = applyAiCreditsUsage({ input_tokens: 1000, output_tokens: 100 }, 'gpt-5-codex-mini-alpha-2025-11-07');
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeGreaterThan(0);
      expect(canonicalizeModel('gpt-5-codex-mini-alpha-2025-11-07')).toBe('gpt-5-codex-mini');
    });

    it('strips compact date suffixes in canonicalized model names', () => {
      expect(canonicalizeModel('claude-sonnet-4-6-20260601')).toBe('claude-sonnet-4-6');
    });
  });

  describe('default pricing fallback', () => {
    let originalDefault;

    beforeEach(() => {
      originalDefault = process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    });

    afterEach(() => {
      if (originalDefault === undefined) {
        delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
      } else {
        process.env.AWF_DEFAULT_AI_CREDITS_PRICING = originalDefault;
      }
    });

    it('uses default pricing for unknown models when configured', () => {
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 2.0, output: 10.0 });
      resetAiCreditsGuardForTests();

      const usage = applyAiCreditsUsage({ input_tokens: 1000, output_tokens: 500 }, 'totally-new-model');
      expect(usage).not.toBeNull();
      // CREDIT_DENOMINATOR = 1M * $0.01 = 10_000
      // input: 1000 * 2.0 / 10_000 = 0.2, output: 500 * 10.0 / 10_000 = 0.5
      expect(usage.aiCreditsThisResponse).toBeCloseTo(0.7, 5);
    });

    it('defaults cachedInput to input * 0.1 when not specified', () => {
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 4.0, output: 20.0 });
      resetAiCreditsGuardForTests();

      const usage = applyAiCreditsUsage({ input_tokens: 0, cache_read_tokens: 1000, output_tokens: 0 }, 'new-model');
      // cachedInput = 4.0 * 0.1 = 0.4; credits = 1000 * 0.4 / 10_000 = 0.04
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeCloseTo(0.04, 5);
    });
  });

  describe('unknown model rejection', () => {
    it('rejects unknown models when maxAiCredits is active and no default pricing', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      const result = checkUnknownModelRejection('brand-new-model-xyz');
      expect(result).not.toBeNull();
      expect(result.rejected).toBe(true);
      expect(result.model).toBe('brand-new-model-xyz');
      expect(result.error.type).toBe('unknown_model_ai_credits');
      expect(result.error.message).toContain('defaultAiCreditsPricing');
    });

    it('does not reject when maxAiCredits is not active', () => {
      delete process.env.AWF_MAX_AI_CREDITS;
      resetAiCreditsGuardForTests();

      const result = checkUnknownModelRejection('brand-new-model-xyz');
      expect(result).toBeNull();
    });

    it('does not reject when default pricing is configured', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 3.0, output: 15.0 });
      resetAiCreditsGuardForTests();

      const result = checkUnknownModelRejection('brand-new-model-xyz');
      expect(result).toBeNull();
    });

    it('does not reject when model is null (no model in request body)', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      const result = checkUnknownModelRejection(null);
      expect(result).toBeNull();
    });

    it('does not reject known models', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      const result = checkUnknownModelRejection('gpt-5-mini');
      expect(result).toBeNull();
    });
  });
});
