const {
  applyEffectiveTokenUsage,
  getEffectiveTokenBlockState,
  getEffectiveTokenReflectState,
  resetEffectiveTokenGuardForTests,
} = require('./effective-token-guard');
const { collectLogOutput } = require('../test-helpers/log-test-helpers');

describe('effective-token-guard reflect state', () => {
  beforeEach(() => {
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER;
    resetEffectiveTokenGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER;
    jest.restoreAllMocks();
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

  it('uses multiplier 1 for unknown models when explicit default is unset and warns', () => {
    const { lines } = collectLogOutput();
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '1000';
    process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({
      'claude-opus-4.7': 27,
      'gpt-5-pro': 54,
    });

    const usage = applyEffectiveTokenUsage({ output_tokens: 1 }, 'unmapped-expensive-model');

    expect(usage.modelMultiplier).toBe(1);
    expect(usage.effectiveTokensThisResponse).toBe(4);
    expect(lines).toContainEqual(expect.objectContaining({
      event: 'unknown_model_multiplier',
      level: 'warn',
      model: 'unmapped-expensive-model',
      applied_multiplier: 1,
    }));
  });

  it('supports explicit default multipliers for unknown models', () => {
    const { lines } = collectLogOutput();
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '1000';
    process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({
      'gpt-4o': 2,
    });
    process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER = '27';

    const usage = applyEffectiveTokenUsage({ output_tokens: 1 }, 'unknown-model');

    expect(usage.modelMultiplier).toBe(27);
    expect(usage.effectiveTokensThisResponse).toBe(108);
    expect(lines).toContainEqual(expect.objectContaining({
      event: 'unknown_model_multiplier',
      level: 'warn',
      model: 'unknown-model',
      applied_multiplier: 27,
    }));
  });

  it('warns when explicit default multiplier is used with no configured model map', () => {
    const { lines } = collectLogOutput();
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '1000';
    process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER = '27';

    const usage = applyEffectiveTokenUsage({ output_tokens: 1 }, 'unknown-model');

    expect(usage.modelMultiplier).toBe(27);
    expect(lines).toContainEqual(expect.objectContaining({
      event: 'unknown_model_multiplier',
      level: 'warn',
      model: 'unknown-model',
      applied_multiplier: 27,
      default_model_multiplier: 27,
    }));
  });

  it('matches configured multipliers by concrete model prefix', () => {
    const { lines } = collectLogOutput();
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '1000';
    process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({
      'claude-opus-4.7': 27,
    });

    const usage = applyEffectiveTokenUsage({ output_tokens: 1 }, 'claude-opus-4.7-20260501');

    expect(usage.modelMultiplier).toBe(27);
    expect(lines.find((line) => line.event === 'unknown_model_multiplier')).toBeUndefined();
  });
  it('logs unknown model multiplier once per model per config state', () => {
    const { lines } = collectLogOutput();
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '1000';
    process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER = '27';

    applyEffectiveTokenUsage({ output_tokens: 1 }, 'unknown-model');
    applyEffectiveTokenUsage({ output_tokens: 2 }, 'unknown-model');
    applyEffectiveTokenUsage({ output_tokens: 1 }, 'other-unknown-model');

    const unknownLogs = lines.filter((line) => line.event === 'unknown_model_multiplier');
    expect(unknownLogs).toHaveLength(2);
    expect(unknownLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'unknown-model' }),
      expect.objectContaining({ model: 'other-unknown-model' }),
    ]));
  });
});
