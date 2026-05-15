const {
  applyEffectiveTokenUsage,
  getEffectiveTokenBlockState,
  getEffectiveTokenReflectState,
  resetEffectiveTokenGuardForTests,
} = require('./effective-token-guard');

describe('effective-token-guard reflect state', () => {
  beforeEach(() => {
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    resetEffectiveTokenGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    resetEffectiveTokenGuardForTests();
  });

  it('caps reflected total at max after the running total exceeds the budget', () => {
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '100';

    // output_tokens are weighted at 4x by default (30 * 4 = 120 effective tokens).
    applyEffectiveTokenUsage({ output_tokens: 30 }, 'gpt-4o');

    const blockState = getEffectiveTokenBlockState();
    const reflectState = getEffectiveTokenReflectState();

    expect(blockState.totalEffectiveTokens).toBe(120);
    expect(blockState.maxExceeded).toBe(true);
    expect(reflectState.total_effective_tokens).toBe(100);
    expect(reflectState.remaining_effective_tokens).toBe(0);
    expect(reflectState.percent_used).toBe(100);
    expect(reflectState.max_effective_tokens).toBe(100);
  });

  it('does not cap reflected usage while total remains below max', () => {
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '100';

    applyEffectiveTokenUsage({ output_tokens: 20 }, 'gpt-4o');

    expect(getEffectiveTokenReflectState()).toMatchObject({
      max_effective_tokens: 100,
      total_effective_tokens: 80,
      remaining_effective_tokens: 20,
      percent_used: 80,
    });
  });

  it('reports 100% usage when total lands exactly on max', () => {
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '100';

    applyEffectiveTokenUsage({ output_tokens: 25 }, 'gpt-4o');

    expect(getEffectiveTokenReflectState()).toMatchObject({
      max_effective_tokens: 100,
      total_effective_tokens: 100,
      remaining_effective_tokens: 0,
      percent_used: 100,
    });
  });
});
