'use strict';

const { resolveModelPricingCatalog, resetModelPricingCatalogForTests } = require('./model-pricing-catalog');
const { projectConfiguredCatalogResolution, validate } = require('../../shared/model-information/contracts');
const { identity, matchModel } = require('../../shared/model-information/identity');
const fixtures = require('../../shared/model-information/fixtures.v1.json');

const original = process.env.AWF_MODEL_PRICING_CATALOG;
afterEach(() => {
  if (original === undefined) delete process.env.AWF_MODEL_PRICING_CATALOG;
  else process.env.AWF_MODEL_PRICING_CATALOG = original;
  resetModelPricingCatalogForTests();
});

it('accepts version-one configured catalogue via its legacy parser and projects both tier boundaries', () => {
  process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
    schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', catalogId: 'operator-prices', version: '2026-10',
    providers: { 'github-copilot': { models: { 'gpt-5.5-pro': {
      input: 2.125, output: 0, cachedInput: 0.25, cacheWrite: null, reasoning: 1.75,
      longContext: {
        threshold: 128000, input: 4.25, output: 0, cachedInput: 0.5,
        cacheWrite: null, reasoning: 3.5,
      },
    } } } },
  });
  const scope = { provider: 'copilot', channel: 'copilot-api', reviewedAt: '2026-10-01T00:00:00Z' };
  const atBoundary = resolveModelPricingCatalog('copilot', 'copilot/GPT_5_5_PRO-20261015', 128000);
  const aboveBoundary = resolveModelPricingCatalog('copilot', 'gpt-5.5-pro', 128001);
  expect(atBoundary).toMatchObject({
    source: 'shared_catalog', tier: 'default', pricingCatalogId: 'operator-prices',
    pricingCatalogVersion: '2026-10', pricing: { input: 2.125, reasoning: 1.75 },
  });
  expect(aboveBoundary).toMatchObject({ tier: 'long_context', pricing: { input: 4.25, threshold: 128000 } });
  const standard = projectConfiguredCatalogResolution(atBoundary, scope);
  const long = projectConfiguredCatalogResolution(aboveBoundary, scope);
  expect(validate('model', { ...fixtures.model, tariffs: [standard, long] })).toEqual([]);
  expect(standard).toMatchObject({
    provenance: { authority: 'configured_catalog', source: 'shared_catalog', revision: 'operator-prices/2026-10' },
    components: {
      input: { price: '2.125' },
      output: { price: '0' },
      cacheWrite: { price: { unavailable: true } },
      reasoning: { price: '1.75' },
    },
  });
  expect(long.promptTokensAbove).toBe(128000);
});

it('distinguishes downloaded feed authority from configured catalogue despite shared tariff shape', () => {
  const feed = structuredClone(fixtures.centralFeed);
  feed.models = [structuredClone(fixtures.model)];
  expect(validate('centralFeed', feed).join(' ')).toContain('cannot establish availability');
  delete feed.models[0].availability;
  feed.models[0].lifecycle.status = 'active';
  feed.models[0].tariffs[0].provenance = {
    authority: 'central_feed', source: 'mirror', revision: 'feed-1', at: '2026-10-01T00:00:00Z',
  };
  expect(validate('centralFeed', feed)).toEqual([]);
  expect(feed.models[0].tariffs[0].provenance.authority).not.toBe('configured_catalog');
});

it('exports the same identity functions to CommonJS and preserves provider separation', () => {
  expect(identity('copilot', 'gpt-5.5-pro').key).not.toBe(identity('openai', 'gpt-5.5-pro').key);
  expect(matchModel(fixtures.model, 'gpt-5.5-pro', {
    provider: 'openai', channel: 'native-api',
  })).toMatchObject({ kind: 'exact' });
});
