const {
  HARD_CAP_AI_CREDITS,
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  checkModelPricing,
  resetAiCreditsGuardForTests,
} = require('./ai-credits-guard');
const { PROVIDER_COPILOT, PROVIDER_OPENAI } = require('../provider-names');
const {
  parseProviderModelMetadata,
  replaceRuntimeModels,
  clearRuntimeModels,
} = require('../runtime-model-catalog');
const { resetProviderPricingOverlaysForTests } = require('../provider-pricing-overlays');
const { resetModelPricingCatalogForTests } = require('../model-pricing-catalog');

describe('AI credit tariff accounting and budget enforcement', () => {
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

  describe('reviewed Copilot tariff accounting', () => {
    let fixture;
    let guard;
    let environment;

    function loadProjection(projection) {
      jest.isolateModules(() => {
        jest.doMock('../model-information.pricing.generated.json', () => projection);
        jest.doMock('../catalogue-loader', () => ({
          getCatalogueLoader: () => ({ capture: () => null }),
        }));
        guard = require('./ai-credits-guard');
      });
    }

    beforeEach(() => {
      environment = { ...process.env };
      for (const key of ['AWF_API_PROXY_PROVIDERS', 'AWF_MODEL_PRICING_CATALOG',
        'AWF_DEFAULT_AI_CREDITS_PRICING', 'AWF_MAX_AI_CREDITS', 'AWF_AI_CREDITS_HARD_CAP',
        'COPILOT_PROVIDER_API_KEY', 'COPILOT_API_TARGET', 'GITHUB_SERVER_URL']) delete process.env[key];
      fixture = require('../test-helpers/copilot-pricing-fixture').reviewedCopilotFixture();
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.capture.retrievedAt));
      loadProjection(fixture.projection);
    });

    afterEach(() => {
      jest.dontMock('../model-information.pricing.generated.json');
      jest.dontMock('../catalogue-loader');
      jest.restoreAllMocks();
      process.env = environment;
    });

    it('uses maintained Copilot prices for charges budgets steering and reflection when live billing is absent', () => {
      for (const model of fixture.reviewed) {
        guard.resetAiCreditsGuardForTests();
        process.env.AWF_MAX_AI_CREDITS = '0.1';
        const id = model.identity.rawId;
        const rates = model.tariffs.find(tariff => tariff.tier === 'default').components;
        const expected = Number(((10000 * Number(rates.input.price) +
          1000 * Number(rates.cachedInput.price) + 10000 * Number(rates.output.price)) / 10000).toFixed(6));
        const usage = guard.applyAiCreditsUsage({
          input_tokens: 10000, cache_read_tokens: 1000, output_tokens: 10000,
        }, id, 'copilot', { catalogue: null, runtimeCatalog: {} });
        expect(usage).toMatchObject({
          pricingSource: 'curated', pricingTier: 'default', accountingPolicy: 'concrete_model',
        });
        expect(usage.aiCreditsThisResponse).toBeCloseTo(expected, 6);
        expect(guard.getAiCreditsBlockState()).toMatchObject({ maxExceeded: true, maxAiCredits: 0.1 });
        // One request used the whole budget, so the "little left" notice
        // fired after the 99% threshold and ranks just above it.
        expect(guard.getPendingAiCreditSteeringWarning()).toMatchObject({
          rank: 99.5, threshold: null, trigger: 'little_left',
        });
        const reflected = guard.getAiCreditsReflectState().by_model[id];
        expect(reflected).toMatchObject({
          total: expected, pricing_source: 'curated', pricing_tier: 'default',
          accounting_policy: 'concrete_model', fallback_pricing_used: false,
          pricing_catalog_version: expect.any(String),
        });
        expect(reflected).not.toHaveProperty('pricing_estimate');
        process.env.AWF_AI_CREDITS_HARD_CAP = '0.1';
        expect(guard.getAiCreditsBlockState()).toMatchObject({ maxExceeded: true, hardCap: true });
        delete process.env.AWF_AI_CREDITS_HARD_CAP;
      }
    });

    it.each([272000, 272001])('charges Terra at the strict maintained threshold %s', input_tokens => {
      const usage = guard.applyAiCreditsUsage({ input_tokens }, 'gpt-6.1-terra', 'copilot', {
        catalogue: null, runtimeCatalog: {},
      });
      expect(usage).toMatchObject({
        pricingSource: 'curated', pricingTier: input_tokens > 272000 ? 'long_context' : 'default',
      });
      expect(usage.aiCreditsThisResponse).toBe(input_tokens * (input_tokens > 272000 ? 2 : 1) / 10000);
    });

    it('preserves complete provider pricing priority', () => {
      for (const id of fixture.ids) {
        const usage = guard.applyAiCreditsUsage({ input_tokens: 10000 }, id, 'copilot', {
          catalogue: null,
          runtimeCatalog: { copilot: [{
            id, provider: 'copilot', observedAt: fixture.capture.retrievedAt,
            pricing: { default: { input: 9, cachedInput: 0, cacheWrite: null, output: 9 } },
          }] },
        });
        expect(usage).toMatchObject({ pricingSource: 'provider', aiCreditsThisResponse: 9 });
      }
    });

    it.each([
      { kind: 'partial', inputTokens: 11, providerThreshold: 10, tier: 'long_context', cached: 0.02 },
      { kind: 'partial', inputTokens: 272001, providerThreshold: 500000, tier: 'default', cached: 0.01 },
      { kind: 'complete', inputTokens: 11, providerThreshold: 10, tier: 'long_context', cached: 0.9 },
      { kind: 'complete', inputTokens: 272001, providerThreshold: 500000, tier: 'default', cached: 0.9 },
    ])('preserves $kind provider $tier selection with different dated maintained thresholds', ({
      kind, inputTokens, providerThreshold, tier, cached,
    }) => {
      const model = structuredClone(require('../../../shared/model-information/sources/copilot-main.json')
        .models.find(item => item.identity.rawId === 'gpt-6.1-sol'));
      for (const tariff of model.tariffs) tariff.effectiveUntil = '2027-01-01T00:00:00Z';
      loadProjection({ 'gpt-6.1-sol': { tariffs: model.tariffs } });
      const usage = guard.applyAiCreditsUsage({
        input_tokens: inputTokens, cache_read_tokens: 1000,
      }, 'gpt-6.1-sol', 'copilot', {
        catalogue: null, runtimeCatalog: { copilot: [{
          id: 'gpt-6.1-sol', provider: 'copilot', observedAt: fixture.capture.retrievedAt,
          pricing: {
            default: { input: 1, output: 3, threshold: providerThreshold,
              ...(kind === 'complete' ? { cachedInput: 9, cacheWrite: null } : {}) },
            longContext: { input: 6, output: 8, cacheWrite: 0,
              ...(kind === 'complete' ? { cachedInput: 9 } : {}) },
          },
        }] },
      });
      expect(usage).toMatchObject({
        pricingSource: 'provider', pricingTier: tier, cachedInputCreditsThisResponse: cached,
      });
    });
  });

  it('calculates and accumulates AI credits by model', () => {
    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 1000,
      cache_read_tokens: 100,
      output_tokens: 500,
    }, 'gpt-5-mini', 'copilot');

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
      max_ai_credits: null,
      effective_max_ai_credits: HARD_CAP_AI_CREDITS,
      percent_used: 0,
      thresholds_crossed: [],
      thresholds_pending: [],
      little_left_triggered: false,
      by_model: {
        'gpt-5-mini': {
          input_credits: 0.0225,
          cached_input_credits: 0.00025,
          cache_write_credits: 0,
          output_credits: 0.1,
          total: 0.12275,
          pricing_source: 'curated',
          pricing_catalog_version: expect.any(String),
          pricing_tier: 'default',
          accounting_policy: 'concrete_model',
          fallback_pricing_used: false,
          dynamic_selector: null,
        },
      },
    });
  });

  it('applies gpt-6.1-sol long-context pricing above 272,000 input tokens', () => {
    const atThreshold = applyAiCreditsUsage({
      input_tokens: 272_000,
      output_tokens: 10_000,
    }, 'gpt-6.1-sol', PROVIDER_OPENAI);

    expect(atThreshold.aiCreditsThisResponse).toBeCloseTo(64.4, 10);
    expect(getAiCreditsReflectState().by_model['gpt-6.1-sol'].pricing_tier).toBe('default');

    resetAiCreditsGuardForTests();
    const aboveThreshold = applyAiCreditsUsage({
      input_tokens: 300_000,
      output_tokens: 10_000,
    }, 'gpt-6.1-sol', PROVIDER_OPENAI);

    expect(aboveThreshold.aiCreditsThisResponse).toBeCloseTo(135, 10);
    expect(getAiCreditsReflectState().by_model['gpt-6.1-sol']).toMatchObject({
      pricing_source: 'curated',
      pricing_tier: 'long_context',
      fallback_pricing_used: false,
    });
  });

  it('uses a supplied versioned catalog for AI-credit enforcement and records provenance', () => {
    process.env.AWF_MAX_AI_CREDITS = '10';
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      schemaVersion: 1,
      unit: 'USD_PER_1M_TOKENS',
      catalogId: 'github/gh-aw/model-pricing',
      version: 'sha256:catalog-2026-10-10',
      providers: {
        'github-copilot': {
          models: {
            'gpt-6.1-sol': {
              input: 10,
              cachedInput: 1,
              cacheWrite: 2,
              output: 50,
              reasoning: 75,
            },
          },
        },
      },
    });
    resetAiCreditsGuardForTests();
    resetModelPricingCatalogForTests();

    const usage = applyAiCreditsUsage({
      input_tokens: 1000,
      cache_read_tokens: 100,
      cache_write_tokens: 20,
      output_tokens: 10,
      reasoning_tokens: 5,
    }, 'gpt-6.1-sol', PROVIDER_COPILOT);

    expect(usage).toMatchObject({
      aiCreditsThisResponse: 1.0765,
      pricingSource: 'shared_catalog',
      pricingCatalogId: 'github/gh-aw/model-pricing',
      pricingCatalogVersion: 'sha256:catalog-2026-10-10',
    });
    expect(getAiCreditsReflectState().by_model['gpt-6.1-sol']).toMatchObject({
      pricing_source: 'shared_catalog',
      pricing_catalog_id: 'github/gh-aw/model-pricing',
      pricing_catalog_version: 'sha256:catalog-2026-10-10',
    });
    expect(checkModelPricing('gpt-6.1-sol', PROVIDER_COPILOT)).toBeNull();
  });

  it('keeps explicit provider pricing ahead of the supplied catalog', () => {
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      schemaVersion: 1,
      unit: 'USD_PER_1M_TOKENS',
      catalogId: 'shared-catalog',
      version: 'v1',
      providers: {
        copilot: {
          models: {
            'catalog-only-model': {
              input: 100,
              output: 1000,
              cachedInput: 10,
              cacheWrite: null,
              reasoning: 1000,
            },
          },
        },
      },
    });
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      copilot: {
        models: {
          'catalog-only-model': {
            cost: {
              input: '0.000002',
              output: '0.000004',
              cache_read: '0.0000002',
            },
          },
        },
      },
    });
    resetModelPricingCatalogForTests();
    resetProviderPricingOverlaysForTests();

    const usage = applyAiCreditsUsage({
      input_tokens: 1000,
      cache_read_tokens: 100,
      output_tokens: 10,
    }, 'catalog-only-model', PROVIDER_COPILOT);

    expect(usage).toMatchObject({
      aiCreditsThisResponse: 0.206,
      pricingSource: 'operator',
    });
    expect(usage.pricingCatalogVersion).toBeUndefined();
  });

  it('does not double-count cached tokens when input_tokens is total-inclusive (OpenAI-style)', () => {
    // OpenAI (Chat Completions and Responses API) reports prompt_tokens/input_tokens
    // as the TOTAL input, with cached tokens being a subset. When no provider is
    // passed, the calculation defaults to this total-inclusive interpretation.
    // Simulates: 3M total input, 2.9M from cache, 0.1M new input.
    const usage = applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 3_000_000,
      cache_read_tokens: 2_900_000,
      output_tokens: 50_000,
    }, 'gpt-5.4', 'copilot');

    // nonCached = 3M - 2.9M = 100K
    // inputCredits = 100_000 × $2.50 / 10000 = 25
    // cachedInputCredits = 2_900_000 × $0.25 / 10000 = 72.5
    // outputCredits = 50_000 × $15.00 / 10000 = 75
    // total = 172.5 AIC
    expect(usage.inputCreditsThisResponse).toBeCloseTo(25, 5);
    expect(usage.cachedInputCreditsThisResponse).toBeCloseTo(72.5, 5);
    expect(usage.outputCreditsThisResponse).toBeCloseTo(75, 5);
    expect(usage.aiCreditsThisResponse).toBeCloseTo(172.5, 5);

    // BUG (before fix): would have been 25 + 72.5 + 75 + (2.9M × $2.50 / 10000) = 172.5 + 725
    // i.e., cached tokens counted at full price AND cache rate.
    expect(usage.aiCreditsThisResponse).toBeLessThan(250);
  });

  it('treats Anthropic input_tokens as non-cached (additive cache), not total-inclusive', () => {
    // Anthropic reports input_tokens as the NON-cached input only;
    // cache_read_input_tokens and cache_creation_input_tokens are reported
    // separately and are ADDITIVE. The fresh input tokens must therefore be
    // charged in full and NOT subtracted from cache totals.
    const usage = applyAiCreditsUsage({
      input_tokens: 2000,
      cache_read_tokens: 10_000,
      output_tokens: 100,
    }, 'claude-sonnet-4-6', 'anthropic');

    // nonCached = 2000 (NOT 2000 - 10000 clamped to 0)
    // inputCredits = 2000 × $3.00 / 10000 = 0.6
    // cachedInputCredits = 10_000 × $0.30 / 10000 = 0.3
    // outputCredits = 100 × $15.00 / 10000 = 0.15
    // total = 1.05 AIC
    expect(usage.inputCreditsThisResponse).toBeCloseTo(0.6, 10);
    expect(usage.cachedInputCreditsThisResponse).toBeCloseTo(0.3, 10);
    expect(usage.outputCreditsThisResponse).toBeCloseTo(0.15, 10);
    expect(usage.aiCreditsThisResponse).toBeCloseTo(1.05, 10);

    // BUG (before fix): nonCached = max(0, 2000 - 10000) = 0, undercounting the
    // 2000 fresh input tokens → total would have been 0.45 instead of 1.05.
    expect(usage.aiCreditsThisResponse).toBeGreaterThan(1.0);
  });

  it('charges Anthropic fresh input even when cache totals exceed input_tokens', () => {
    // Reproduces the observed smoke-claude record: tiny fresh input alongside
    // large cache read/write. Previously nonCached clamped to 0, dropping the
    // fresh input charge entirely.
    const usage = applyAiCreditsUsage({
      input_tokens: 5,
      cache_read_tokens: 38_673,
      cache_write_tokens: 21_060,
      output_tokens: 205,
    }, 'claude-opus-4-7', 'anthropic');

    // nonCached = 5 (Anthropic: additive, not subtracted)
    // inputCredits  = 5      × $5.00  / 10000 = 0.0025
    // cachedInput   = 38_673 × $0.50  / 10000 = 1.93365
    // cacheWrite    = 21_060 × $6.25  / 10000 = 13.1625
    // outputCredits = 205    × $25.00 / 10000 = 0.5125
    // total = 15.6111
    expect(usage.inputCreditsThisResponse).toBeCloseTo(0.0025, 10);
    expect(usage.aiCreditsThisResponse).toBeCloseTo(15.6111, 4);
  });

  it('treats Copilot input_tokens as non-cached when provider is copilot', () => {
    const usage = applyAiCreditsUsage({
      input_tokens: 100,
      cache_read_tokens: 10_000,
      output_tokens: 0,
    }, 'gpt-5.4', 'copilot');

    // inputCredits = 100 × $2.50 / 10000 = 0.025
    // cachedInputCredits = 10_000 × $0.25 / 10000 = 0.25
    // total = 0.275
    expect(usage.inputCreditsThisResponse).toBeCloseTo(0.025, 10);
    expect(usage.cachedInputCreditsThisResponse).toBeCloseTo(0.25, 10);
    expect(usage.aiCreditsThisResponse).toBeCloseTo(0.275, 10);
  });

  it('prefers runtime Copilot pricing over the curated table', () => {
    replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-5.4',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: {
              input_price: 100,
              cache_read_price: 10,
              cache_write_price: 0,
              output_price: 600,
              max_prompt_tokens: 1000,
            },
            long_context: {
              input_price: 200,
              cache_read_price: 20,
              cache_write_price: 0,
              output_price: 900,
            },
          },
        },
      }],
    }, { format: 'copilot', apiVersion: '2026-07-01', observedAt: '2026-07-28T00:00:00Z' }));

    const usage = applyAiCreditsUsage({
      input_tokens: 100,
      cache_read_tokens: 1000,
      output_tokens: 100,
    }, 'gpt-5.4', PROVIDER_COPILOT);

    expect(usage).toMatchObject({
      inputCreditsThisResponse: 0.02,
      cachedInputCreditsThisResponse: 0.02,
      outputCreditsThisResponse: 0.09,
      pricingSource: 'provider',
      pricingTier: 'long_context',
      pricingApiVersion: '2026-07-01',
    });
  });

  it('does not double-count cached Copilot input or select long context for inclusive usage', () => {
    replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-5.4',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: {
              input_price: 100,
              cache_read_price: 10,
              cache_write_price: 0,
              output_price: 600,
              max_prompt_tokens: 1000,
            },
            long_context: {
              input_price: 200,
              cache_read_price: 20,
              cache_write_price: 0,
              output_price: 900,
            },
          },
        },
      }],
    }, { format: 'copilot' }));

    const usage = applyAiCreditsUsage({
      input_tokens: 800,
      cache_read_tokens: 300,
      cache_write_tokens: 0,
      output_tokens: 100,
      input_tokens_include_cache: true,
    }, 'gpt-5.4', PROVIDER_COPILOT);

    expect(usage).toMatchObject({
      inputCreditsThisResponse: 0.05,
      cachedInputCreditsThisResponse: 0.003,
      outputCreditsThisResponse: 0.06,
      pricingTier: 'default',
    });
  });

  it('prefers an operator provider overlay over runtime and curated pricing', () => {
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      'github-copilot': {
        models: {
          'gpt-5.4': {
            cost: {
              input: '1e-06',
              output: '4e-06',
              cache_read: '1e-07',
              cache_write: '1.25e-06',
            },
          },
        },
      },
    });
    replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-5.4',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: { input_price: 900, output_price: 1800 },
          },
        },
      }],
    }, { format: 'copilot' }));

    const usage = applyAiCreditsUsage({
      input_tokens: 1000,
      cache_read_tokens: 1000,
      cache_write_tokens: 1000,
      output_tokens: 1000,
    }, 'gpt-5.4', PROVIDER_COPILOT);

    expect(usage).toMatchObject({
      inputCreditsThisResponse: 0.1,
      cachedInputCreditsThisResponse: 0.01,
      cacheWriteCreditsThisResponse: 0.125,
      outputCreditsThisResponse: 0.4,
      pricingSource: 'operator',
      pricingTier: 'default',
    });
  });

  it('reports block state when max ai credits is configured and exceeded', () => {
    process.env.AWF_MAX_AI_CREDITS = '0.1';
    applyAiCreditsUsage({ input_tokens_include_cache: true,
      input_tokens: 1000,
      output_tokens: 500,
    }, 'gpt-5-mini', 'copilot');

    expect(getAiCreditsBlockState()).toEqual({
      maxAiCredits: 0.1,
      totalAiCredits: 0.125,
      maxExceeded: true,
    });
  });

  it.each([undefined, '-1', '0'])('disables the configured budget but retains the hard cap (%s)', (max) => {
    if (max !== undefined) process.env.AWF_MAX_AI_CREDITS = max;
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 1000, output_tokens: 0 }, 'gpt-5-mini', 'copilot');
    expect(getAiCreditsReflectState()).toMatchObject({
      max_ai_credits: null,
      effective_max_ai_credits: HARD_CAP_AI_CREDITS,
    });
    expect(getAiCreditsBlockState()).toBeNull();

    resetAiCreditsGuardForTests();
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 400_000_000, output_tokens: 0 }, 'gpt-5-mini', 'copilot');
    expect(getAiCreditsBlockState()).toEqual({
      maxAiCredits: HARD_CAP_AI_CREDITS,
      totalAiCredits: HARD_CAP_AI_CREDITS,
      maxExceeded: true,
      hardCap: true,
    });
  });

  it('clamps configured max to hard cap', () => {
    process.env.AWF_MAX_AI_CREDITS = '99999';
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 100, output_tokens: 0 }, 'gpt-5-mini', 'copilot');
    const state = getAiCreditsBlockState();
    expect(state.maxAiCredits).toBe(HARD_CAP_AI_CREDITS);
  });

  it.each([undefined, '', ' ', 'invalid', '20000credits', '0', '-1', 'NaN', 'Infinity', '1e309'])(
    'retains the default hard cap for invalid operator value %s', (rawCap) => {
      if (rawCap !== undefined) process.env.AWF_AI_CREDITS_HARD_CAP = rawCap;
      expect(getAiCreditsReflectState().effective_max_ai_credits).toBe(HARD_CAP_AI_CREDITS);
      applyAiCreditsUsage({ input_tokens: 400_000_000 }, 'gpt-5-mini', 'copilot');
      expect(getAiCreditsBlockState()).toMatchObject({
        maxAiCredits: HARD_CAP_AI_CREDITS, maxExceeded: true, hardCap: true,
      });
    },
  );

  it('enforces a tiny positive hard cap instead of restoring the default', () => {
    process.env.AWF_AI_CREDITS_HARD_CAP = '1e-350';

    applyAiCreditsUsage({ input_tokens: 1 }, 'gpt-5-mini', 'copilot');

    expect(getAiCreditsBlockState()).toMatchObject({
      maxAiCredits: 0,
      maxExceeded: true,
      hardCap: true,
    });
  });

  it('preserves exact hard-cap precision when clamping budgets and rejecting usage', () => {
    process.env.AWF_AI_CREDITS_HARD_CAP = '1.0000000000000000000000000001';
    process.env.AWF_MAX_AI_CREDITS = '1.0000000000000000000000000002';

    applyAiCreditsUsage({ input_tokens: 40_000 }, 'gpt-5-mini', 'copilot');

    expect(getAiCreditsBlockState()).toMatchObject({
      maxAiCredits: 1,
      maxExceeded: false,
    });
    expect(getAiCreditsReflectState()).toMatchObject({
      max_ai_credits: 1,
      effective_max_ai_credits: 1,
    });

    applyAiCreditsUsage({ input_tokens: 1 }, 'gpt-5-mini', 'copilot');

    expect(getAiCreditsBlockState()).toMatchObject({
      maxAiCredits: 1,
      maxExceeded: true,
      hardCap: true,
    });
  });

  it.each([undefined, '0', '-1'])('enforces a raised hard cap with budget %s', (rawMax) => {
    process.env.AWF_AI_CREDITS_HARD_CAP = '20000';
    if (rawMax !== undefined) process.env.AWF_MAX_AI_CREDITS = rawMax;
    applyAiCreditsUsage({ input_tokens: 400_000_000 }, 'gpt-5-mini', 'copilot');
    expect(getAiCreditsBlockState()).toBeNull();
    expect(getAiCreditsReflectState().effective_max_ai_credits).toBe(20000);
    applyAiCreditsUsage({ input_tokens: 400_000_000 }, 'gpt-5-mini', 'copilot');
    expect(getAiCreditsBlockState()).toEqual({
      maxAiCredits: 20000, totalAiCredits: 20000, maxExceeded: true, hardCap: true,
    });
  });

  it.each([undefined, '0', '-1'])('enforces a lowered fractional hard cap with budget %s', (rawMax) => {
    process.env.AWF_AI_CREDITS_HARD_CAP = '0.1';
    if (rawMax !== undefined) process.env.AWF_MAX_AI_CREDITS = rawMax;
    applyAiCreditsUsage({ input_tokens: 4000 }, 'gpt-5-mini', 'copilot');
    expect(getAiCreditsBlockState()).toEqual({
      maxAiCredits: 0.1, totalAiCredits: 0.1, maxExceeded: true, hardCap: true,
    });
  });

  it.each([
    ['20000', '30000', 20000],
    ['20000', '15000', 15000],
    ['100', '200', 100],
    ['100', '50', 50],
  ])('clamps budget %s / %s to the operator ceiling', (rawCap, rawMax, effective) => {
    process.env.AWF_AI_CREDITS_HARD_CAP = rawCap;
    process.env.AWF_MAX_AI_CREDITS = rawMax;
    expect(getAiCreditsBlockState()).toMatchObject({ maxAiCredits: effective, maxExceeded: false });
    expect(getAiCreditsReflectState()).toMatchObject({
      max_ai_credits: effective, effective_max_ai_credits: effective,
    });
  });

  it('invalidates cached budget clamping when the hard cap changes', () => {
    process.env.AWF_MAX_AI_CREDITS = '30000';
    expect(getAiCreditsReflectState().max_ai_credits).toBe(10000);
    process.env.AWF_AI_CREDITS_HARD_CAP = '20000';
    expect(getAiCreditsReflectState().max_ai_credits).toBe(20000);
    process.env.AWF_AI_CREDITS_HARD_CAP = '100';
    expect(getAiCreditsReflectState().max_ai_credits).toBe(100);
    delete process.env.AWF_AI_CREDITS_HARD_CAP;
    expect(getAiCreditsReflectState().max_ai_credits).toBe(10000);
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
        message: 'Hard cap on AI credits reached (10000.500000 / 10000). This limit is set by the operator and cannot be raised from inside the run.',
        total_ai_credits: 10000.5,
        max_ai_credits: 10000,
        hard_cap: true,
      },
    });
  });
});
