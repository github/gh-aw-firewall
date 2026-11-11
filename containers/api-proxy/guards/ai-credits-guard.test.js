const {
  HARD_CAP_AI_CREDITS,
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  buildAiCreditsLimitError,
  getPendingAiCreditSteeringWarning,
  acknowledgeAiCreditSteeringWarning,
  claimAiCreditSteeringWarning,
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

describe('ai-credits-guard', () => {
  let originalMaxAiCredits;
  let originalHardCap;
  let originalDefaultPricing;
  let originalModelPricingCatalog;

  beforeEach(() => {
    originalMaxAiCredits = process.env.AWF_MAX_AI_CREDITS;
    originalHardCap = process.env.AWF_AI_CREDITS_HARD_CAP;
    originalDefaultPricing = process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    originalModelPricingCatalog = process.env.AWF_MODEL_PRICING_CATALOG;
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_AI_CREDITS_HARD_CAP;
    delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    delete process.env.AWF_MODEL_PRICING_CATALOG;
    resetAiCreditsGuardForTests();
    clearRuntimeModels();
    resetProviderPricingOverlaysForTests();
    resetModelPricingCatalogForTests();
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
        expect(guard.getPendingAiCreditSteeringWarning().threshold).toBe(99);
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

    it('does not reuse an expired Copilot promo without a verified successor', () => {
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 9, output: 9 });
      for (const id of ['gemini-3.8-flash', 'gemini-4-argon']) {
        const end = Date.parse(fixture.projection[id].tariffs[0].effectiveUntil);
        for (const time of [end - 1, end, end + 1]) {
          Date.now.mockReturnValue(time);
          guard.resetAiCreditsGuardForTests();
          const usage = guard.applyAiCreditsUsage({ input_tokens: 10000 }, id, 'copilot', {
            catalogue: null, runtimeCatalog: {},
          });
          expect(usage.pricingSource).toBe(time < end ? 'curated' : 'configured_default');
          expect(guard.checkModelPricing(id, 'copilot')).toBeNull();
          expect(guard.getAiCreditsReflectState().by_model[id].pricing_source)
            .toBe(time < end ? 'curated' : 'configured_default');
        }
      }
    });

    it('selects a reviewed successor only within its effective interval', () => {
      // Immutable estimated contract fixture, not a successor claimed by the captured page.
      const staged = require('../test-helpers/copilot-pricing-fixture').copilotPromotionContractFixture();
      const successor = staged.tariffs.find(tariff => tariff.tier === 'post_promotion');
      const provenance = require('../../../shared/model-information/fixtures.v1.json').model.provenance;
      successor.provenance = provenance;
      successor.effectiveUntil = '2027-02-01T00:00:00Z';
      for (const component of Object.values(successor.components)) component.provenance = provenance;
      loadProjection({ 'gemini-3.8-flash': { tariffs: staged.tariffs } });
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 9, output: 9 });
      const start = Date.parse(successor.effectiveFrom);
      for (const time of [start - 1, start, start + 1, Date.parse(successor.effectiveUntil)]) {
        Date.now.mockReturnValue(time);
        guard.resetAiCreditsGuardForTests();
        const usage = guard.applyAiCreditsUsage({ input_tokens: 10000 }, 'gemini-3.8-flash', 'copilot', {
          catalogue: null, runtimeCatalog: {},
        });
        expect(usage.pricingSource).toBe(time < Date.parse(successor.effectiveUntil)
          ? 'curated' : 'configured_default');
        if (time >= start && time < Date.parse(successor.effectiveUntil)) {
          expect(usage).toMatchObject({
            pricingTier: 'post_promotion', pricingObservedAt: provenance.at,
            pricingCatalogId: provenance.source, aiCreditsThisResponse: Number(successor.components.input.price),
          });
        }
      }
    });
  });

  afterEach(() => {
    resetAiCreditsGuardForTests();
    clearRuntimeModels();
    resetProviderPricingOverlaysForTests();
    resetModelPricingCatalogForTests();
    delete process.env.AWF_API_PROXY_PROVIDERS;
    if (originalMaxAiCredits === undefined) {
      delete process.env.AWF_MAX_AI_CREDITS;
    } else {
      process.env.AWF_MAX_AI_CREDITS = originalMaxAiCredits;
    }
    if (originalHardCap === undefined) {
      delete process.env.AWF_AI_CREDITS_HARD_CAP;
    } else {
      process.env.AWF_AI_CREDITS_HARD_CAP = originalHardCap;
    }
    if (originalDefaultPricing === undefined) {
      delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
    } else {
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = originalDefaultPricing;
    }
    if (originalModelPricingCatalog === undefined) {
      delete process.env.AWF_MODEL_PRICING_CATALOG;
    } else {
      process.env.AWF_MODEL_PRICING_CATALOG = originalModelPricingCatalog;
    }
    jest.restoreAllMocks();
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

  it('steers fractional AI-credit budgets independently', () => {
    process.env.AWF_MAX_AI_CREDITS = '0.001';
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 32 }, 'gpt-5-mini', 'copilot');

    expect(getPendingAiCreditSteeringWarning()).toEqual({
      threshold: 80,
      message: '[AWF AI CREDIT WARNING] You have used 80% of your AI-credit budget. Begin planning to wrap up your current work.',
    });
    expect(getAiCreditsReflectState()).toMatchObject({
      max_ai_credits: 0.001,
      effective_max_ai_credits: 0.001,
      percent_used: 80,
      thresholds_crossed: [80],
      thresholds_pending: [80],
    });
  });

  it('uses the 10,000-credit hard cap as the steering ceiling', () => {
    process.env.AWF_MAX_AI_CREDITS = '20000';
    applyAiCreditsUsage({ input_tokens_include_cache: true, input_tokens: 320_000_000 }, 'gpt-5-mini', 'copilot');

    expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);
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

  it('invalidates cached steering limits when the raw hard cap changes without changing its number projection', () => {
    process.env.AWF_AI_CREDITS_HARD_CAP = '1.0000000000000000000000000001';
    applyAiCreditsUsage({ input_tokens: 32_000 }, 'gpt-5-mini', 'copilot');

    expect(getPendingAiCreditSteeringWarning()).toBeNull();

    process.env.AWF_AI_CREDITS_HARD_CAP = '1';

    expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);
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

  it.each([
    ['20000', 640_000_000],
    ['100', 3_200_000],
  ])('uses operator hard cap %s for reflection and steering', (rawCap, inputTokens) => {
    process.env.AWF_AI_CREDITS_HARD_CAP = rawCap;
    applyAiCreditsUsage({ input_tokens: inputTokens }, 'gpt-5-mini', 'copilot');
    expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);
    expect(getAiCreditsReflectState()).toMatchObject({
      effective_max_ai_credits: Number(rawCap),
      percent_used: 80,
      thresholds_crossed: [80],
    });
    expect(getAiCreditsBlockState()).toBeNull();
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
