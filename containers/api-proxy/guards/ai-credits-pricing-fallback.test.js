const {
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  checkModelPricing,
  isRecognizedDynamicSelector,
  isModelPriceable,
  canonicalizeModel,
  resetAiCreditsGuardForTests,
} = require('./ai-credits-guard');
const { PROVIDER_COPILOT, PROVIDER_OPENAI } = require('../provider-names');
const { collectLogOutput } = require('../test-helpers/log-test-helpers');
const {
  parseProviderModelMetadata,
  replaceRuntimeModels,
  clearRuntimeModels,
} = require('../runtime-model-catalog');
const { resetProviderPricingOverlaysForTests } = require('../provider-pricing-overlays');
const { resetModelPricingCatalogForTests } = require('../model-pricing-catalog');

describe('AI credit pricing fallback and model resolution', () => {
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

  it('matches pricing table entries by model prefix', () => {
    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 2000,
      cache_read_tokens: 1000,
      cache_write_tokens: 500,
      output_tokens: 100,
    }, 'claude-sonnet-4-6-20260601', 'copilot');

    // nonCached = 2000 - 1000 - 500 = 500
    // inputCredits = 500 × $3.00 / 10000 = 0.15
    // cachedInputCredits = 1000 × $0.30 / 10000 = 0.03
    // cacheWriteCredits = 500 × $3.75 / 10000 = 0.1875
    // outputCredits = 100 × $15.00 / 10000 = 0.15
    expect(usage.aiCreditsThisResponse).toBeCloseTo(0.5175, 10);
    expect(getAiCreditsReflectState().by_model['claude-sonnet-4-6-20260601'].total).toBeCloseTo(0.5175, 10);
  });

  it('resolves claude-sonnet-5 from curated pricing without unknown-model rejection', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();

    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 2000,
      cache_read_tokens: 1000,
      cache_write_tokens: 500,
      output_tokens: 100,
    }, 'claude-sonnet-5', 'copilot');

    expect(usage.aiCreditsThisResponse).toBeCloseTo(0.345, 10);
    expect(checkModelPricing('claude-sonnet-5', 'copilot')).toBeNull();
  });

  it.each([
    'claude-sonnet-5.5', 'claude-opus-5.5', 'claude-fable-5.1',
  ])('does not borrow native prices for anthropic/%s on Copilot', (model) => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();

    const prefixedModel = `anthropic/${model}`;
    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 2000,
      cache_read_tokens: 1000,
      cache_write_tokens: 500,
      output_tokens: 100,
    }, prefixedModel, 'copilot');

    expect(usage).toMatchObject({ pricingSource: 'median_estimate', accountingPolicy: 'backend_median_estimate' });
    expect(getAiCreditsReflectState().total).toBeGreaterThan(0);
    expect(checkModelPricing(prefixedModel, 'copilot')).toBeNull();
  });

  it('resolves gpt-6-astra from curated pricing without unknown-model rejection', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();

    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 2000,
      cache_read_tokens: 1000,
      output_tokens: 100,
    }, 'gpt-6-astra', 'copilot');

    // $0.01 per credit: fresh input 1.0 + cached input 0.1 + output 0.5.
    expect(usage.aiCreditsThisResponse).toBeCloseTo(1.6, 10);
    expect(checkModelPricing('gpt-6-astra', 'copilot')).toBeNull();
  });

  it.each([
    ['gpt-6-luna', 0.016],
    ['gpt-6-sol', 0.32],
  ])(
    'resolves %s from curated pricing without unknown-model rejection',
    (model, expectedCredits) => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
        input_tokens: 2000,
        cache_read_tokens: 1000,
        output_tokens: 100,
      }, model, 'copilot');

      expect(usage.aiCreditsThisResponse).toBeCloseTo(expectedCredits, 10);
      expect(getAiCreditsReflectState().by_model[model]).toMatchObject({
        pricing_source: 'curated',
        pricing_tier: 'default',
        fallback_pricing_used: false,
      });
      expect(checkModelPricing(model, PROVIDER_COPILOT)).toBeNull();
    },
  );

  it('resolves gpt-6.1-sol with OpenAI pricing despite fallback-only provider overlays', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      openai: {
        models: {
          'gpt-5.4': { cost: { input: '0.0000025', output: '0.000015' } },
          'gpt-5.4-mini': { cost: { input: '0.00000075', output: '0.0000045' } },
        },
      },
    });
    resetProviderPricingOverlaysForTests();
    resetAiCreditsGuardForTests();

    const usage = applyAiCreditsUsage({
      input_tokens: 2000,
      cache_read_tokens: 1000,
      output_tokens: 100,
    }, 'gpt-6.1-sol', PROVIDER_OPENAI);

    expect(usage.aiCreditsThisResponse).toBeCloseTo(0.31, 10);
    expect(getAiCreditsReflectState().by_model['gpt-6.1-sol']).toMatchObject({
      pricing_source: 'curated',
      pricing_tier: 'default',
      fallback_pricing_used: false,
    });
    expect(checkModelPricing('gpt-6.1-sol', PROVIDER_OPENAI)).toBeNull();
  });

  it('does not apply shared catalog rates to related but unlisted model names', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      schemaVersion: 1,
      unit: 'USD_PER_1M_TOKENS',
      catalogId: 'shared-catalog',
      version: 'v1',
      providers: {
        copilot: {
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
    resetAiCreditsGuardForTests();
    resetModelPricingCatalogForTests();

    const { lines } = collectLogOutput();
    expect(checkModelPricing('catalog-only-model-preview', PROVIDER_COPILOT)).toBeNull();
    expect(lines).toEqual([
      expect.objectContaining({ event: 'estimated_model_ai_credits_pricing', basis: 'backend' }),
    ]);
  });

  it('fills missing runtime fields from lower-priority curated pricing', () => {
    replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
      data: [{
        id: 'claude-sonnet-4-6',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: { input_price: 100, output_price: 600 },
          },
        },
      }],
    }, { format: 'copilot' }));

    const usage = applyAiCreditsUsage({
      input_tokens: 1000,
      cache_read_tokens: 1000,
      cache_write_tokens: 1000,
      output_tokens: 1000,
    }, 'claude-sonnet-4-6', PROVIDER_COPILOT);

    expect(usage).toMatchObject({
      inputCreditsThisResponse: 0.1,
      cachedInputCreditsThisResponse: 0.03,
      cacheWriteCreditsThisResponse: 0.375,
      outputCreditsThisResponse: 0.6,
      pricingSource: 'provider',
    });
  });

  it('fills missing runtime rates from the runtime-selected tier', () => {
    replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
      data: [{
        id: 'claude-haiku-5-5',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: { input_price: 100, output_price: 600 },
          },
        },
      }],
    }, { format: 'copilot' }));

    const usage = applyAiCreditsUsage({
      input_tokens: 150_000,
      cache_read_tokens: 1000,
      cache_write_tokens: 1000,
      output_tokens: 1000,
    }, 'claude-haiku-5-5', PROVIDER_COPILOT);

    expect(usage).toMatchObject({
      inputCreditsThisResponse: 15,
      cachedInputCreditsThisResponse: 0.001,
      cacheWriteCreditsThisResponse: 0.0125,
      outputCreditsThisResponse: 0.6,
      pricingSource: 'provider',
      pricingTier: 'default',
    });
  });

  it('warns when a runtime pricing tier is incomplete without blocking priced tiers', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();
    replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
      data: [{
        id: 'new-runtime-model',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: {
              input_price: 100,
              output_price: 600,
              cache_read_price: 10,
              cache_write_price: 20,
              max_prompt_tokens: 1000,
            },
            long_context: { input_price: 200, output_price: 900 },
          },
        },
      }],
    }, { format: 'copilot' }));

    const { lines } = collectLogOutput();
    expect(checkModelPricing('new-runtime-model', PROVIDER_COPILOT)).toBeNull();
    expect(lines).toEqual([]);
    expect(applyAiCreditsUsage(
      { input_tokens: 100, output_tokens: 10 }, 'new-runtime-model', PROVIDER_COPILOT,
    )).toMatchObject({ pricingSource: 'provider' });
    expect(applyAiCreditsUsage(
      { input_tokens: 2000, output_tokens: 10 }, 'new-runtime-model', PROVIDER_COPILOT,
    )).toMatchObject({ pricingSource: 'provider', accountingPolicy: 'backend_median_estimate' });
    expect(lines).toHaveLength(1);
  });

  it('warns and estimates usage for concrete models without prices', () => {
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      catalogId: 'median-fixture', version: 'v1',
      schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', providers: {
        'median-test': { models: {
          donor: { input: 2, cachedInput: 0.2, cacheWrite: null, output: 11, reasoning: 11 },
        } },
      },
    });
    const { lines } = collectLogOutput();
    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 100 }, 'unknown-model', 'median-test');

    expect(usage).toMatchObject({ pricingSource: 'median_estimate', aiCreditsThisResponse: 0.02 });
    expect(getAiCreditsReflectState().total).toBe(0.02);
    expect(lines).toContainEqual(expect.objectContaining({
      event: 'estimated_model_ai_credits_pricing',
      level: 'warn',
    }));
    expect(lines[0]).not.toHaveProperty('model');
  });

  it('resolves text-embedding-3-small with input-only pricing', () => {
    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1_000_000, output_tokens: 500 }, 'text-embedding-3-small', 'copilot');
    // input: 1M × $0.02/M / 10_000 denominator = 2.0 AIC
    // output: 500 tokens × $0.00/M = 0 AIC (embedding models produce no output cost)
    expect(usage).not.toBeNull();
    expect(usage.aiCreditsThisResponse).toBeCloseTo(2.0, 5);
    expect(usage.outputCreditsThisResponse).toBe(0);
  });

  it('resolves the explicit text-embedding-3-small-inference alias', () => {
    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1_000_000, output_tokens: 0 }, 'text-embedding-3-small-inference', 'copilot');
    // The inference name is an explicit alias, not a prefix match.
    expect(usage).not.toBeNull();
    expect(usage.aiCreditsThisResponse).toBeCloseTo(2.0, 5);
  });

  it('resolves text-embedding-ada-002 with input-only pricing', () => {
    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1_000_000, output_tokens: 1000 }, 'text-embedding-ada-002', 'copilot');
    // input: 1M × $0.10/M / 10_000 denominator = 10.0 AIC
    // output: 1000 tokens × $0.00/M = 0 AIC (embedding models produce no output cost)
    expect(usage).not.toBeNull();
    expect(usage.aiCreditsThisResponse).toBeCloseTo(10.0, 5);
    expect(usage.outputCreditsThisResponse).toBe(0);
  });

  it('does not reject embedding models when maxAiCredits is active', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();

    expect(checkModelPricing('text-embedding-3-small', 'copilot')).toBeNull();
    expect(checkModelPricing('text-embedding-3-small-inference', 'copilot')).toBeNull();
    expect(checkModelPricing('text-embedding-ada-002', 'copilot')).toBeNull();
  });

  it('does not reject claude-fable-5 when maxAiCredits is active', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();

    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 1_000_000,
      output_tokens: 100_000,
    }, 'claude-fable-5', 'copilot');

    expect(usage).toMatchObject({
      aiCreditsThisResponse: 1_500,
      totalAiCredits: 1_500,
    });
    expect(checkModelPricing('claude-fable-5', 'copilot')).toBeNull();
    expect(checkModelPricing('claude-mythos-5', 'copilot')).toBeNull();
  });

  it('uses bundled models.dev pricing for known catalog models', () => {
    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 100,
      output_tokens: 10,
    }, 'perceptron/perceptron-mk1', 'openrouter');

    expect(usage).toMatchObject({
      aiCreditsThisResponse: 0.003,
      totalAiCredits: 0.003,
    });
  });

  it('labels the estimated cached-input rate when the imported model has no cached-input price', () => {
    const usage = applyAiCreditsUsage({
      input_tokens_include_cache: true,
      input_tokens: 0,
      cache_read_tokens: 1000,
      output_tokens: 0,
    }, 'deepseek/deepseek-chat-v3-0324', 'openrouter');

    expect(usage).toMatchObject({
      pricingSource: 'models.dev',
      cachedInputCreditsThisResponse: 0.0025,
      pricingEstimate: {
        basis: 'imported_component',
        component: 'cachedInput',
        method: 'ten_percent_of_input',
        sources: ['models.dev'],
      },
      accountingPolicy: 'models_dev_missing_cached_input_estimate',
      fallbackPricingUsed: true,
    });
  });

  it('treats zero-cost catalog models as free instead of unknown', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();

    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 1000,
      output_tokens: 500,
    }, 'google/gemma-4-31b-it:free', 'openrouter');

    expect(usage).toMatchObject({
      aiCreditsThisResponse: 0,
      totalAiCredits: 0,
    });
    expect(checkModelPricing('google/gemma-4-31b-it:free', 'openrouter')).toBeNull();
  });

  describe('model name canonicalization', () => {
    it('does not strip an arbitrary prefix from provider-native accounting IDs', () => {
      const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1000, output_tokens: 100 }, 'copilot/claude-sonnet-4-6', 'copilot');
      expect(usage.pricingSource).toBe('median_estimate');
    });

    it('resolves models with dot separators (claude-sonnet-4.6)', () => {
      resetAiCreditsGuardForTests();
      const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1000, output_tokens: 100 }, 'claude-sonnet-4.6', 'copilot');
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeGreaterThan(0);
    });

    it('resolves models with underscore separators (claude_sonnet_4_6)', () => {
      resetAiCreditsGuardForTests();
      const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1000, output_tokens: 100 }, 'claude_sonnet_4_6', 'copilot');
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeGreaterThan(0);
    });

    it('does not borrow a maintained price for a prefixed provider-native ID', () => {
      resetAiCreditsGuardForTests();
      const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1000, output_tokens: 100 }, 'copilot/gpt-5.4-mini', 'copilot');
      expect(usage.pricingSource).toBe('median_estimate');
    });

    it('strips alpha date suffixes before pricing lookup', () => {
      resetAiCreditsGuardForTests();
      const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1000, output_tokens: 100 }, 'gpt-5-codex-mini-alpha-2025-11-07', 'copilot');
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeGreaterThan(0);
      expect(canonicalizeModel('gpt-5-codex-mini-alpha-2025-11-07')).toBe('gpt-5-codex-mini');
    });

    it('strips compact date suffixes in canonicalized model names', () => {
      expect(canonicalizeModel('claude-sonnet-4-6-20260601')).toBe('claude-sonnet-4-6');
    });

    it('strips URL-style model parameters before pricing lookup', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      const usage = applyAiCreditsUsage({
        input_tokens: 2000,
        cache_read_tokens: 1000,
        cache_write_tokens: 500,
        output_tokens: 100,
      }, 'claude-sonnet-5?effort=high', PROVIDER_COPILOT);

      expect(usage).toMatchObject({
        aiCreditsThisResponse: 0.645,
        pricingSource: 'curated',
      });
      expect(checkModelPricing('claude-sonnet-5?effort=high', PROVIDER_COPILOT)).toBeNull();
      expect(canonicalizeModel('claude-sonnet-5?effort=high')).toBe('claude-sonnet-5');
      expect(getAiCreditsReflectState().by_model['claude-sonnet-5?effort=high'].total).toBeCloseTo(0.645, 10);
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

      const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1000, output_tokens: 500 }, 'totally-new-model', 'copilot');
      expect(usage).not.toBeNull();
      // CREDIT_DENOMINATOR = 1M * $0.01 = 10_000
      // input: 1000 * 2.0 / 10_000 = 0.2, output: 500 * 10.0 / 10_000 = 0.5
      expect(usage.aiCreditsThisResponse).toBeCloseTo(0.7, 5);
    });

    it('defaults cachedInput to input * 0.1 when not specified', () => {
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 4.0, output: 20.0 });
      resetAiCreditsGuardForTests();

      const usage = applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 0, cache_read_tokens: 1000, output_tokens: 0 }, 'new-model', 'copilot');
      // cachedInput = 4.0 * 0.1 = 0.4; credits = 1000 * 0.4 / 10_000 = 0.04
      expect(usage).not.toBeNull();
      expect(usage.aiCreditsThisResponse).toBeCloseTo(0.04, 5);
    });
  });

  describe('missing model pricing warnings', () => {
    it('warns once and charges estimated usage when maxAiCredits is active', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
        catalogId: 'median-fixture', version: 'v1',
        schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', providers: {
          'median-test': { models: {
            donor: { input: 2, cachedInput: 0.2, cacheWrite: null, output: 11, reasoning: 11 },
          } },
        },
      });
      resetAiCreditsGuardForTests();

      const { lines } = collectLogOutput();
      expect(checkModelPricing('brand-new-model-xyz', 'median-test')).toBeNull();
      expect(checkModelPricing('brand-new-model-xyz', 'median-test')).toBeNull();
      expect(applyAiCreditsUsage(
        { input_tokens_include_cache: true, input_tokens: 1000, output_tokens: 500 }, 'brand-new-model-xyz', 'median-test',
      )).toMatchObject({ pricingSource: 'median_estimate', aiCreditsThisResponse: 0.75 });
      expect(getAiCreditsReflectState().total).toBe(0.75);
      expect(getAiCreditsBlockState()).toMatchObject({ maxExceeded: false, totalAiCredits: 0.75 });
      expect(lines).toEqual([
        expect.objectContaining({
          level: 'warn',
          event: 'estimated_model_ai_credits_pricing',
          message: expect.stringContaining('not verified provider billing'),
        }),
      ]);
    });

    it('also warns when maxAiCredits is not active', () => {
      delete process.env.AWF_MAX_AI_CREDITS;
      resetAiCreditsGuardForTests();

      const { lines } = collectLogOutput();
      expect(checkModelPricing('brand-new-model-xyz', 'copilot')).toBeNull();
      expect(lines).toHaveLength(1);
    });

    it('does not reject when default pricing is configured', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 3.0, output: 15.0 });
      resetAiCreditsGuardForTests();

      const { lines } = collectLogOutput();
      const result = checkModelPricing('brand-new-model-xyz', 'copilot');
      expect(result).toBeNull();
      expect(lines).toHaveLength(0);
    });

    it('does not reject when model is null (no model in request body)', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      const result = checkModelPricing(null, 'copilot');
      expect(result).toBeNull();
    });

    it('does not reject known models', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      const result = checkModelPricing('gpt-5-mini', 'copilot');
      expect(result).toBeNull();

      const sonnet5 = checkModelPricing('claude-sonnet-5', 'copilot');
      expect(sonnet5).toBeNull();
    });

    it('resolves gpt-6-astra from curated pricing', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      expect(checkModelPricing('gpt-6-astra', PROVIDER_COPILOT)).toBeNull();
    });

    it('warns only for unpriced auto selectors without rejecting either provider', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      const { lines } = collectLogOutput();
      expect(checkModelPricing('auto', PROVIDER_COPILOT)).toBeNull();
      expect(lines).toHaveLength(0);
      expect(checkModelPricing('auto', PROVIDER_OPENAI)).toBeNull();
      expect(lines).toHaveLength(1);
    });
  });

  it('uses conservative dynamic-selector fallback pricing for Copilot auto', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    resetAiCreditsGuardForTests();

    const usage = applyAiCreditsUsage({
      input_tokens: 1000,
      output_tokens: 500,
    }, 'auto', PROVIDER_COPILOT);

    expect(usage).toMatchObject({
      aiCreditsThisResponse: 3.5,
      pricingSource: 'dynamic_selector_fallback',
      pricingTier: 'conservative',
      accountingPolicy: 'dynamic_selector_fallback',
      fallbackPricingUsed: true,
      dynamicSelector: 'copilot:auto',
    });
    expect(isRecognizedDynamicSelector('auto', PROVIDER_COPILOT)).toBe(true);
    expect(isRecognizedDynamicSelector('auto', PROVIDER_OPENAI)).toBe(false);
    expect(getAiCreditsReflectState()).toEqual({
      total: 3.5,
      max_ai_credits: 10,
      effective_max_ai_credits: 10,
      percent_used: 35,
      thresholds_crossed: [],
      thresholds_pending: [],
      little_left_triggered: false,
      by_model: {
        auto: {
          input_credits: 1,
          cached_input_credits: 0,
          cache_write_credits: 0,
          output_credits: 2.5,
          total: 3.5,
          pricing_source: 'dynamic_selector_fallback',
          pricing_tier: 'conservative',
          accounting_policy: 'dynamic_selector_fallback',
          fallback_pricing_used: true,
          dynamic_selector: 'copilot:auto',
        },
      },
    });
  });

  describe('isModelPriceable (side-effect-free)', () => {
    it('reports priced and unpriced models correctly', () => {
      expect(isModelPriceable('openai/gpt-4-turbo:batch', 'openrouter')).toBe(true);
      expect(isModelPriceable('openai/gpt-4-turbo', 'openrouter')).toBe(true);
      expect(isModelPriceable('gpt-4-turbo', PROVIDER_OPENAI)).toBe(true);
      expect(isModelPriceable('gpt-5-mini')).toBe(false);
      expect(isModelPriceable('crest-alpha-0418-block-cy4.5', PROVIDER_OPENAI)).toBe(true);
    });

    it('emits no warning when probing unpriceable models', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      const { lines, spy } = collectLogOutput();
      for (let i = 0; i < 25; i++) {
        isModelPriceable(`crest-alpha-probe-${i}`, PROVIDER_OPENAI);
      }
      spy.mockRestore();

      expect(lines.filter(l => l.event === 'unknown_model_ai_credits_pricing')).toHaveLength(0);
    });

    it('does not suppress the warning if a probed model is later requested', () => {
      process.env.AWF_MAX_AI_CREDITS = '10';
      resetAiCreditsGuardForTests();

      isModelPriceable('crest-alpha-probe-7', PROVIDER_OPENAI);

      const { lines, spy } = collectLogOutput();
      checkModelPricing('crest-alpha-probe-7', PROVIDER_OPENAI);
      spy.mockRestore();

      expect(lines.some(l => l.event === 'estimated_model_ai_credits_pricing')).toBe(true);
    });
  });
});
