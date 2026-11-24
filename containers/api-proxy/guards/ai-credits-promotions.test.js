const {
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  getAiCreditsBlockState,
  resetAiCreditsGuardForTests,
} = require('./ai-credits-guard');
const { PROVIDER_COPILOT } = require('../provider-names');
const {
  parseProviderModelMetadata,
  replaceRuntimeModels,
  clearRuntimeModels,
  captureRuntimePricing,
} = require('../runtime-model-catalog');
const { resetProviderPricingOverlaysForTests } = require('../provider-pricing-overlays');
const { resetModelPricingCatalogForTests } = require('../model-pricing-catalog');

describe('AI credit time-bound promotions', () => {
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

    it('switches bundled promotional models to their published post_promotion rates at expiry', () => {
      const bundled = jest.requireActual('../model-information.pricing.generated.json');
      loadProjection(bundled);
      for (const [id, boundary, promoRate, successorRate] of [
        ['gemini-4-carbon', '2026-12-01T00:00:00.000Z', 2, 4],
        ['mai-code-2', '2027-05-17T00:00:00.000Z', 0.5, 1],
        ['mai-code-2-flash', '2027-05-17T00:00:00.000Z', 0.05, 0.1],
      ]) {
        const end = Date.parse(boundary);
        for (const [time, tier, expectedCredits] of [
          [end - 1, 'default', promoRate],
          [end, 'post_promotion', successorRate],
          [end + 1, 'post_promotion', successorRate],
        ]) {
          Date.now.mockReturnValue(time);
          guard.resetAiCreditsGuardForTests();
          const usage = guard.applyAiCreditsUsage({ input_tokens: 10000 }, id, 'copilot', {
            catalogue: null, runtimeCatalog: {},
          });
          expect(usage).toMatchObject({
            pricingSource: 'curated', pricingTier: tier, aiCreditsThisResponse: expectedCredits,
          });
        }
      }
    });
  });

  describe('time-bound provider promotions', () => {
    const startsAt = '2027-05-01T00:00:00Z';
    const endsAt = '2027-05-18T00:00:00Z';
    const activeTime = Date.parse(startsAt);
    const tokens = {
      input_tokens: 1000, cache_read_tokens: 1000, cache_write_tokens: 1000,
      output_tokens: 1000, reasoning_tokens: 100,
    };

    function installPromotion({ percent = 50, threshold = 3000, partial = false,
      promo = { id: 'mai-promo', discount_percent: percent, starts_at: startsAt, ends_at: endsAt },
      model = 'promotion-model' } = {}) {
      const prices = {
        input_price: 200, output_price: 800,
        ...(partial ? {} : { cache_read_price: 20, cache_write_price: 250 }),
      };
      replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
        data: [{ id: model, billing: { promo, token_prices: {
          batch_size: 1_000_000,
          default: { ...prices, max_prompt_tokens: threshold },
          long_context: {
            input_price: 400, output_price: 1600, cache_read_price: 40, cache_write_price: 500,
          },
        } } }],
      }));
    }

    function chargePromotion(time = activeTime, usage = tokens, model = 'promotion-model') {
      return applyAiCreditsUsage(usage, model, PROVIDER_COPILOT, { catalogue: null, now: () => time });
    }

    it.each([
      ['default', 3000, 1],
      ['long_context', 2999, 2],
    ])('discounts all components after selecting the %s tier', (tier, threshold, multiplier) => {
      installPromotion({ threshold });
      const usage = chargePromotion();
      expect(usage).toMatchObject({
        inputCreditsThisResponse: 0.1 * multiplier,
        cachedInputCreditsThisResponse: 0.01 * multiplier,
        cacheWriteCreditsThisResponse: 0.125 * multiplier,
        outputCreditsThisResponse: 0.4 * multiplier,
        aiCreditsThisResponse: 0.635 * multiplier,
        pricingSource: 'provider', pricingTier: tier, pricingDiscountPercent: 50,
        pricingPromotion: {
          id: 'mai-promo', endsAt, active: true, applied: true,
          discountedComponents: ['input', 'output', 'cachedInput', 'cacheWrite'],
          listPriceSource: 'provider', listPriceTier: tier,
          effectivePriceSource: 'provider_promotion', effectivePriceTier: tier,
        },
      });
      expect(getAiCreditsReflectState().by_model['promotion-model']).toMatchObject({
        total: 0.635 * multiplier, pricing_promotion: usage.pricingPromotion,
      });
    });

    it.each([
      [activeTime - 1, 1.27, false],
      [activeTime, 0.635, true],
      [Date.parse(endsAt) - 1, 0.635, true],
      [Date.parse(endsAt), 1.27, false],
      [Date.parse(endsAt) + 1, 1.27, false],
    ])('uses inclusive start and exclusive expiry at %s', (time, total, applied) => {
      installPromotion();
      expect(chargePromotion(time)).toMatchObject({
        aiCreditsThisResponse: total, pricingPromotion: { active: applied, applied },
      });
    });

    it.each([[0, 1.27, false], [100, 0, true], [12.5, 1.11125, true]])(
      'accounts exactly for a %s percent discount', (percent, total, applied) => {
        installPromotion({ percent });
        const usage = chargePromotion();
        expect(usage.aiCreditsThisResponse).toBe(total);
        expect(usage.pricingPromotion.applied).toBe(applied);
        expect(Number.isFinite(getAiCreditsReflectState().total)).toBe(true);
      },
    );

    it.each([
      { discount_percent: 101, ends_at: endsAt },
      { discount_percent: null, ends_at: endsAt },
      { discount_percent: 50, ends_at: '2027-02-30T00:00:00Z' },
      { discount_percent: 50, ends_at: endsAt, starts_at: endsAt },
      { discount_percent: 50 },
    ])('ignores malformed promotion %j', promo => {
      installPromotion({ promo });
      expect(chargePromotion()).toMatchObject({ aiCreditsThisResponse: 1.27 });
      expect(chargePromotion()).not.toHaveProperty('pricingPromotion');
    });

    it('does not preserve removed promotions while retaining canonical rates', () => {
      installPromotion();
      expect(chargePromotion().aiCreditsThisResponse).toBe(0.635);
      replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
        data: [{ id: 'promotion-model' }],
      }));
      const usage = chargePromotion();
      expect(usage.aiCreditsThisResponse).toBe(1.27);
      expect(usage).not.toHaveProperty('pricingPromotion');
      expect(getAiCreditsReflectState().by_model['promotion-model'])
        .not.toHaveProperty('pricing_promotion');
    });

    it('stops applying withdrawn promotions to requests with pinned tariffs', () => {
      installPromotion({ percent: 100 });
      const pinnedTariffs = captureRuntimePricing();
      replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
        data: [{ id: 'promotion-model' }],
      }));

      const usage = applyAiCreditsUsage(tokens, 'promotion-model', PROVIDER_COPILOT, {
        catalogue: null, runtimeCatalog: pinnedTariffs, now: () => activeTime,
      });

      expect(usage.aiCreditsThisResponse).toBe(1.27);
      expect(usage.pricingSource).toBe('provider');
      expect(usage).not.toHaveProperty('pricingPromotion');
    });

    it('never discounts fallback cache components of a partial provider tariff', () => {
      installPromotion({ partial: true, model: 'claude-sonnet-4-6' });
      const usage = chargePromotion(activeTime, tokens, 'claude-sonnet-4-6');
      expect(usage).toMatchObject({
        inputCreditsThisResponse: 0.1, outputCreditsThisResponse: 0.4,
        cachedInputCreditsThisResponse: 0.03, cacheWriteCreditsThisResponse: 0.375,
        pricingPromotion: { applied: true, discountedComponents: ['input', 'output'] },
      });
    });

    it('does not discount operator pricing ahead of an active provider promotion', () => {
      installPromotion();
      process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({ copilot: { models: {
        'promotion-model': { cost: {
          input: 0.000002, output: 0.000008, cache_read: 0.0000002, cache_write: 0.0000025,
        } },
      } } });
      expect(chargePromotion()).toMatchObject({
        aiCreditsThisResponse: 1.27, pricingSource: 'operator',
      });
      expect(chargePromotion()).not.toHaveProperty('pricingPromotion');
    });

    it('does not discount configured model prices', () => {
      installPromotion();
      process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
        schemaVersion: 1, catalogId: 'promotion-override', version: 'v1',
        unit: 'USD_PER_1M_TOKENS', providers: { copilot: { models: {
          'promotion-model': { input: 2, output: 8, cachedInput: 0.2, cacheWrite: 2.5, reasoning: 8 },
        } } },
      });
      expect(chargePromotion()).toMatchObject({
        aiCreditsThisResponse: 1.27, pricingSource: 'shared_catalog',
      });
    });

    it.each(['promotion-model', 'auto'])('does not discount fallback-only prices for %s', model => {
      replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
        data: [{ id: model, billing: {
          promo: { discount_percent: 100, ends_at: endsAt },
        } }],
      }));
      process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({
        input: 2, output: 8, cachedInput: 0.2, cacheWrite: 2.5,
      });
      const usage = chargePromotion(activeTime, tokens, model);
      expect(usage.aiCreditsThisResponse).toBeGreaterThan(0);
      expect(usage.pricingSource).toBe(model === 'auto' ? 'dynamic_selector_fallback' : 'configured_default');
    });

    it('enforces the budget against discounted totals and resumes list prices at expiry', () => {
      installPromotion();
      process.env.AWF_MAX_AI_CREDITS = '1.27';
      expect(chargePromotion().totalAiCredits).toBe(0.635);
      expect(getAiCreditsBlockState().maxExceeded).toBe(false);
      expect(chargePromotion().totalAiCredits).toBe(1.27);
      expect(getAiCreditsBlockState().maxExceeded).toBe(true);
      resetAiCreditsGuardForTests();
      expect(chargePromotion(Date.parse(endsAt)).totalAiCredits).toBe(1.27);
      expect(getAiCreditsBlockState().maxExceeded).toBe(true);
    });
  });
});
