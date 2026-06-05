const {
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  resetAiCreditsGuardForTests,
} = require('./ai-credits-guard');
const { collectLogOutput } = require('../test-helpers/log-test-helpers');

describe('ai-credits-guard', () => {
  let originalMaxAiCredits;

  beforeEach(() => {
    originalMaxAiCredits = process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_MAX_AI_CREDITS;
    resetAiCreditsGuardForTests();
  });

  afterEach(() => {
    resetAiCreditsGuardForTests();
    if (originalMaxAiCredits === undefined) {
      delete process.env.AWF_MAX_AI_CREDITS;
    } else {
      process.env.AWF_MAX_AI_CREDITS = originalMaxAiCredits;
    }
    jest.restoreAllMocks();
  });

  it('calculates and accumulates AI credits by model', () => {
    const usage = applyAiCreditsUsage({
      input_tokens: 1000,
      cache_read_tokens: 100,
      output_tokens: 500,
    }, 'gpt-5-mini');

    expect(usage).toMatchObject({
      aiCreditsThisResponse: 0.12525,
      totalAiCredits: 0.12525,
    });
    expect(process.env.AWF_AI_CREDITS_USED).toBe('0.12525');
    expect(getAiCreditsReflectState()).toEqual({
      total: 0.12525,
      by_model: {
        'gpt-5-mini': {
          input_credits: 0.025,
          cached_input_credits: 0.00025,
          cache_write_credits: 0,
          output_credits: 0.1,
          total: 0.12525,
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

    expect(usage.aiCreditsThisResponse).toBeCloseTo(0.9675, 10);
    expect(getAiCreditsReflectState().by_model['claude-sonnet-4-6-20260601'].total).toBeCloseTo(0.9675, 10);
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
      },
    });
  });
});
