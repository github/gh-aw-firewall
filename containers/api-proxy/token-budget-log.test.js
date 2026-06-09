'use strict';

const { computeTokenBudgetUsage } = require('./token-budget-log');
const { resetEffectiveTokenGuardForTests } = require('./guards/effective-token-guard');
const { resetAiCreditsGuardForTests } = require('./guards/ai-credits-guard');

describe('computeTokenBudgetUsage', () => {
  let logRequest;

  beforeEach(() => {
    logRequest = jest.fn();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_MAX_AI_CREDITS;
    resetEffectiveTokenGuardForTests();
    resetAiCreditsGuardForTests();
  });

  it('returns undefined when neither guard is active', () => {
    const result = computeTokenBudgetUsage(
      { logRequest, requestId: 'req-1', provider: 'openai' },
      { input_tokens: 10, output_tokens: 5 },
      'brand-new-model-xyz',
    );
    expect(result).toBeUndefined();
    expect(logRequest).not.toHaveBeenCalled();
  });

  it('returns effective token fields when effective token guard is active', () => {
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '1000';
    const result = computeTokenBudgetUsage(
      { logRequest, requestId: 'req-1', provider: 'openai' },
      { input_tokens: 10, output_tokens: 5 },
      'brand-new-model-xyz',
    );
    expect(result).toMatchObject({
      effective_tokens_this_response: expect.any(Number),
      effective_tokens_total: expect.any(Number),
      model_multiplier: expect.any(Number),
    });
    // No AI credits → no token_budget_usage log
    expect(logRequest).not.toHaveBeenCalled();
  });

  it('returns AI credits fields and emits token_budget_usage log when AI credits guard is active', () => {
    process.env.AWF_MAX_AI_CREDITS = '100';
    const result = computeTokenBudgetUsage(
      { logRequest, requestId: 'req-2', provider: 'anthropic' },
      { input_tokens: 1000, output_tokens: 500 },
      'claude-sonnet-4-6',
    );
    expect(result).toMatchObject({
      ai_credits_this_response: expect.any(Number),
      ai_credits_total: expect.any(Number),
    });
    expect(logRequest).toHaveBeenCalledWith('info', 'token_budget_usage', expect.objectContaining({
      request_id: 'req-2',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      ai_credits_this_response: expect.any(Number),
      ai_credits_total: expect.any(Number),
    }));
  });

  it('uses "unknown" as model name when model is falsy', () => {
    // ai-credits-guard may emit unknown-model warnings to stdout; silence for this test.
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    process.env.AWF_MAX_AI_CREDITS = '100';
    process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 2.0, output: 10.0 });

    try {
      const result = computeTokenBudgetUsage(
        { logRequest, requestId: 'req-4', provider: 'openai' },
        { input_tokens: 1000, output_tokens: 500 },
        undefined,
      );
      expect(result).toMatchObject({
        ai_credits_this_response: expect.any(Number),
        ai_credits_total: expect.any(Number),
      });
      expect(logRequest).toHaveBeenCalledWith('info', 'token_budget_usage', expect.objectContaining({
        request_id: 'req-4',
        provider: 'openai',
        model: 'unknown',
      }));
    } finally {
      delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
      stdoutSpy.mockRestore();
    }
  });

  it('returns both effective token and AI credits fields when both guards are active', () => {
    process.env.AWF_MAX_EFFECTIVE_TOKENS = '100000';
    process.env.AWF_MAX_AI_CREDITS = '100';
    const result = computeTokenBudgetUsage(
      { logRequest, requestId: 'req-5', provider: 'openai' },
      { input_tokens: 1000, output_tokens: 500 },
      'gpt-5-mini',
    );
    expect(result).toMatchObject({
      effective_tokens_this_response: expect.any(Number),
      effective_tokens_total: expect.any(Number),
      model_multiplier: expect.any(Number),
      ai_credits_this_response: expect.any(Number),
      ai_credits_total: expect.any(Number),
    });
    expect(logRequest).toHaveBeenCalledTimes(1);
  });
});
