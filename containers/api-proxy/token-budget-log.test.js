'use strict';

const { computeTokenBudgetUsage } = require('./token-budget-log');
const { resetEffectiveTokenGuardForTests } = require('./guards/effective-token-guard');
const { resetAiCreditsGuardForTests } = require('./guards/ai-credits-guard');
const { resetModelPricingCatalogForTests } = require('./model-pricing-catalog');
const { resetProviderPricingOverlaysForTests } = require('./provider-pricing-overlays');

describe('computeTokenBudgetUsage', () => {
  let logRequest;

  beforeEach(() => {
    logRequest = jest.fn();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_EFFECTIVE_TOKENS;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_MODEL_PRICING_CATALOG;
    resetEffectiveTokenGuardForTests();
    resetAiCreditsGuardForTests();
    resetModelPricingCatalogForTests();
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
      ai_credits_pricing_source: 'curated',
      ai_credits_pricing_tier: 'default',
    });
    expect(logRequest).toHaveBeenCalledWith('info', 'token_budget_usage', expect.objectContaining({
      request_id: 'req-2',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      ai_credits_this_response: expect.any(Number),
      ai_credits_total: expect.any(Number),
    }));
  });

  it('persists shared catalog provenance with AI-credit usage', () => {
    process.env.AWF_MAX_AI_CREDITS = '100';
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      schemaVersion: 1,
      unit: 'USD_PER_1M_TOKENS',
      catalogId: 'shared-catalog',
      version: 'v1',
      providers: {
        openai: {
          models: {
            'catalog-only-model': {
              input: 1,
              output: 2,
              cachedInput: 0.1,
              cacheWrite: null,
              reasoning: 2,
            },
          },
        },
      },
    });
    resetModelPricingCatalogForTests();

    const result = computeTokenBudgetUsage(
      { logRequest, requestId: 'req-catalog', provider: 'openai' },
      { input_tokens: 1000, output_tokens: 500 },
      'catalog-only-model',
    );

    expect(result).toMatchObject({
      ai_credits_pricing_source: 'shared_catalog',
      ai_credits_pricing_catalog_id: 'shared-catalog',
      ai_credits_pricing_catalog_version: 'v1',
    });
    expect(logRequest).toHaveBeenCalledWith('info', 'token_budget_usage', expect.objectContaining({
      pricing_catalog_id: 'shared-catalog',
      pricing_catalog_version: 'v1',
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

  it('reports dynamic selector accounting policy in token diagnostics', () => {
    process.env.AWF_MAX_AI_CREDITS = '100';
    const result = computeTokenBudgetUsage(
      { logRequest, requestId: 'req-dynamic', provider: 'copilot' },
      { input_tokens: 1000, output_tokens: 500 },
      'auto',
    );

    expect(result).toMatchObject({
      ai_credits_pricing_source: 'dynamic_selector_fallback',
      ai_credits_pricing_tier: 'conservative',
      ai_credits_accounting_policy: 'dynamic_selector_fallback',
      ai_credits_fallback_pricing_used: true,
      ai_credits_dynamic_selector: 'copilot:auto',
    });
    expect(logRequest).toHaveBeenCalledWith('info', 'token_budget_usage', expect.objectContaining({
      request_id: 'req-dynamic',
      provider: 'copilot',
      model: 'auto',
      pricing_source: 'dynamic_selector_fallback',
      accounting_policy: 'dynamic_selector_fallback',
      fallback_pricing_used: true,
      dynamic_selector: 'copilot:auto',
    }));
  });
});

describe('curated prices for default-model traffic', () => {
  const originalEnvironment = {};
  let logRequest;

  beforeEach(() => {
    for (const name of [
      'AWF_MAX_AI_CREDITS',
      'AWF_DEFAULT_AI_CREDITS_PRICING',
      'AWF_API_PROXY_PROVIDERS',
      'AWF_MODEL_PRICING_CATALOG',
    ]) {
      originalEnvironment[name] = process.env[name];
    }
    process.env.AWF_MAX_AI_CREDITS = '1000';
    delete process.env.AWF_API_PROXY_PROVIDERS;
    delete process.env.AWF_MODEL_PRICING_CATALOG;
    resetAiCreditsGuardForTests();
    resetModelPricingCatalogForTests();
    resetProviderPricingOverlaysForTests();
    logRequest = jest.fn();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetAiCreditsGuardForTests();
    resetModelPricingCatalogForTests();
    resetProviderPricingOverlaysForTests();
  });

  const recordA = {
    provider: 'anthropic',
    path: '/v1/messages?beta=true',
    model: 'claude-sonnet-5',
    input_tokens: 2,
    output_tokens: 1307,
    cache_read_tokens: 189407,
    cache_write_tokens: 59949,
  };
  const recordB = {
    provider: 'openai',
    path: '/responses',
    model: 'gpt-6-luna',
    input_tokens: 57001,
    output_tokens: 2857,
    cache_read_tokens: 56398,
    cache_write_tokens: 0,
  };
  const haikuBaseUsage = {
    provider: 'anthropic',
    path: '/v1/messages',
    model: 'claude-haiku-5-5',
    input_tokens: 10000,
    output_tokens: 2000,
    cache_read_tokens: 30000,
    cache_write_tokens: 10000,
  };
  const haikuLongUsage = {
    ...haikuBaseUsage,
    input_tokens: 30000,
    cache_read_tokens: 100000,
    cache_write_tokens: 20000,
  };
  const haikuThresholdUsage = {
    ...haikuBaseUsage,
    input_tokens: 20000,
    cache_read_tokens: 70000,
  };

  function computeForRecord(record) {
    return computeTokenBudgetUsage({
      logRequest,
      requestId: 'request-1',
      provider: record.provider,
    }, record, record.model);
  }

  it('prices record A (anthropic claude-sonnet-5) at the published Sonnet 5 price', () => {
    expect(computeForRecord(recordA)).toMatchObject({
      ai_credits_this_response: 20.08279,
      ai_credits_pricing_source: 'curated',
    });
  });

  it('prices record B (openai gpt-6-luna /responses) at the published GPT-6 Luna price', () => {
    expect(computeForRecord(recordB)).toMatchObject({
      ai_credits_this_response: 0.205278,
      ai_credits_pricing_source: 'curated',
    });
  });

  it('prices gpt-6-sol at $2 / $0.20 / $10 per million tokens', () => {
    expect(computeForRecord({ ...recordB, model: 'gpt-6-sol' })).toMatchObject({
      ai_credits_this_response: 4.10556,
      ai_credits_pricing_source: 'curated',
    });
  });

  it('prices claude-haiku-5-5 at base rates up to 100k prompt tokens and long-prompt rates above, recording the tier', () => {
    expect(computeForRecord(haikuBaseUsage)).toMatchObject({
      ai_credits_this_response: 0.355,
      ai_credits_pricing_source: 'curated',
      ai_credits_pricing_tier: 'default',
    });
    expect(computeForRecord(haikuLongUsage)).toMatchObject({
      ai_credits_this_response: 3.75,
      ai_credits_pricing_source: 'curated',
      ai_credits_pricing_tier: 'long_context',
    });
    expect(computeForRecord(haikuThresholdUsage)).toMatchObject({
      ai_credits_this_response: 0.495,
      ai_credits_pricing_source: 'curated',
      ai_credits_pricing_tier: 'default',
    });
  });

  it('operator price takes precedence over the curated price for claude-sonnet-5, gpt-6-luna and gpt-6-sol', () => {
    const operatorModelPrice = {
      cost: {
        input: '0.000001',
        cache_read: '0.0000001',
        cache_write: '0.00000125',
        output: '0.000005',
      },
    };
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      anthropic: { models: { 'claude-sonnet-5': operatorModelPrice } },
      openai: {
        models: {
          'gpt-6-luna': operatorModelPrice,
          'gpt-6-sol': operatorModelPrice,
        },
      },
    });
    resetProviderPricingOverlaysForTests();

    const sonnet5Usage = computeForRecord(recordA);
    const lunaUsage = computeForRecord(recordB);
    const solUsage = computeForRecord({ ...recordB, model: 'gpt-6-sol' });

    expect(sonnet5Usage.ai_credits_this_response).toBeCloseTo(10.04, 2);
    expect(sonnet5Usage.ai_credits_pricing_source).toBe('operator');
    expect(lunaUsage.ai_credits_this_response).toBeCloseTo(2.05, 2);
    expect(lunaUsage.ai_credits_pricing_source).toBe('operator');
    expect(solUsage.ai_credits_this_response).toBeCloseTo(2.05, 2);
    expect(solUsage.ai_credits_pricing_source).toBe('operator');
  });

  it('applies an operator overlay long-prompt tier above its threshold and keeps untiered entries on the default tier', () => {
    const modelPrice = {
      cost: {
        input: '0.0000001',
        cache_read: '0.00000001',
        cache_write: '0.000000125',
        output: '0.0000005',
        long_context: {
          max_prompt_tokens: 100000,
          input: '0.0000005',
          cache_read: '0.00000005',
          cache_write: '0.000000625',
          output: '0.0000025',
        },
      },
    };
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      anthropic: { models: { 'claude-haiku-5-5': modelPrice } },
    });
    resetProviderPricingOverlaysForTests();

    expect(computeForRecord(haikuLongUsage)).toMatchObject({
      ai_credits_this_response: 3.75,
      ai_credits_pricing_source: 'operator',
      ai_credits_pricing_tier: 'long_context',
    });

    const untieredPrice = {
      ...modelPrice,
      cost: {
        input: modelPrice.cost.input,
        cache_read: modelPrice.cost.cache_read,
        cache_write: modelPrice.cost.cache_write,
        output: modelPrice.cost.output,
      },
    };
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      anthropic: { models: { 'claude-haiku-5-5': untieredPrice } },
    });
    resetProviderPricingOverlaysForTests();

    expect(computeForRecord(haikuLongUsage)).toMatchObject({
      ai_credits_this_response: 0.75,
      ai_credits_pricing_source: 'operator',
      ai_credits_pricing_tier: 'default',
    });
  });

  it('applies a shared-catalog long-prompt tier and records catalog provenance', () => {
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      schemaVersion: 1,
      unit: 'USD_PER_1M_TOKENS',
      catalogId: 'shared-haiku-prices',
      version: 'v2',
      providers: {
        anthropic: {
          models: {
            'claude-haiku-5-5': {
              input: 0.1,
              cachedInput: 0.01,
              cacheWrite: 0.125,
              output: 0.5,
              reasoning: 0.5,
              longContext: {
                threshold: 100000,
                input: 0.5,
                cachedInput: 0.05,
                cacheWrite: 0.625,
                output: 2.5,
                reasoning: 2.5,
              },
            },
          },
        },
      },
    });
    resetModelPricingCatalogForTests();

    expect(computeForRecord(haikuLongUsage)).toMatchObject({
      ai_credits_this_response: 3.75,
      ai_credits_pricing_source: 'shared_catalog',
      ai_credits_pricing_tier: 'long_context',
      ai_credits_pricing_catalog_id: 'shared-haiku-prices',
      ai_credits_pricing_catalog_version: 'v2',
    });
  });

  it('rejects malformed long-context tiers instead of silently using their base rates', () => {
    const { resolveProviderPricingOverlay } = require('./provider-pricing-overlays');
    const { resolveModelPricingCatalog } = require('./model-pricing-catalog');
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      anthropic: {
        models: {
          'overlay-invalid-tier': {
            cost: {
              input: '0.0000001',
              output: '0.0000005',
              long_context: {
                max_prompt_tokens: 100000,
                input: 'invalid',
                output: '0.0000025',
              },
            },
          },
        },
      },
    });
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      schemaVersion: 1,
      unit: 'USD_PER_1M_TOKENS',
      catalogId: 'invalid-tier-catalog',
      version: 'v1',
      providers: {
        anthropic: {
          models: {
            'catalog-invalid-tier': {
              input: 0.1,
              cachedInput: 0.01,
              cacheWrite: 0.125,
              output: 0.5,
              reasoning: 0.5,
              longContext: {
                threshold: 100000,
                input: 0.5,
                cachedInput: 0.05,
                cacheWrite: 0.625,
                output: 2.5,
              },
            },
          },
        },
      },
    });
    resetProviderPricingOverlaysForTests();
    resetModelPricingCatalogForTests();

    expect(resolveProviderPricingOverlay('anthropic', 'overlay-invalid-tier')).toBeNull();
    expect(resolveModelPricingCatalog('anthropic', 'catalog-invalid-tier')).toBeNull();
  });
});
