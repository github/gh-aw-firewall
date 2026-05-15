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
});
