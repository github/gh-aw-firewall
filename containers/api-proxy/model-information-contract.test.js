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
    schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', catalogId: 'operator/prices', version: '2026/10',
    providers: { 'github-copilot': { models: { 'gpt-5.5-pro': {
      input: 2.125, output: 0, cachedInput: 0.25, cacheWrite: null, reasoning: 1.75,
      longContext: {
        threshold: 128000, input: 4.25, output: 0, cachedInput: 0.5,
        cacheWrite: null, reasoning: 3.5,
      },
    } } } },
  });
  const scope = { provider: 'copilot', channel: 'copilot-api' };
  const atBoundary = resolveModelPricingCatalog('copilot', 'copilot/GPT_5_5_PRO-20261015', 128000);
  const aboveBoundary = resolveModelPricingCatalog('copilot', 'gpt-5.5-pro', 128001);
  expect(atBoundary).toMatchObject({
    source: 'shared_catalog', tier: 'default', pricingCatalogId: 'operator/prices',
    pricingCatalogVersion: '2026/10', pricing: { input: 2.125, reasoning: 1.75 },
  });
  expect(aboveBoundary).toMatchObject({ tier: 'long_context', pricing: { input: 4.25, threshold: 128000 } });
  const standard = projectConfiguredCatalogResolution(atBoundary, scope);
  const long = projectConfiguredCatalogResolution(aboveBoundary, scope);
  expect(validate('model', { ...fixtures.model, tariffs: [standard, long] })).toEqual([]);
  expect(standard).toMatchObject({
    provenance: {
      authority: 'configured_catalog', source: 'shared_catalog',
      catalogId: 'operator/prices', catalogVersion: '2026/10', freshness: 'unknown',
    },
    components: {
      input: { price: '2.125' },
      output: { price: '0' },
      cacheWrite: { price: '0' },
      reasoning: { price: '1.75' },
    },
  });
  expect(long.promptTokensAbove).toBe(128000);
});

it('projects exponent prices and fractional legacy thresholds without rounding', () => {
  process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
    schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', catalogId: 'precision', version: '1',
    providers: { openai: { models: { 'tiny-model': {
      input: 1e-7, output: 1e-7, cachedInput: 0, cacheWrite: null, reasoning: 0,
      longContext: {
        threshold: 128000.5, input: 1e-7, output: 1e-7, cachedInput: 0,
        cacheWrite: null, reasoning: 0,
      },
    } } } },
  });
  const resolution = resolveModelPricingCatalog('openai', 'tiny-model', 128001);
  const tariff = projectConfiguredCatalogResolution(resolution, { provider: 'openai', channel: 'native-api' });
  expect(validate('model', { ...fixtures.model, tariffs: [tariff] })).toEqual([]);
  expect(tariff.promptTokensAbove).toBe(128000);
  expect(tariff.components.input.price).toBe('0.0000001');
  expect(tariff.components.cacheWrite.price).toBe('0');
});

it('rejects central feed records that claim unsupported facts or elevated authority', () => {
  const feed = structuredClone(fixtures.centralFeed);
  const model = structuredClone(fixtures.model);
  for (const field of ['availability', 'limits', 'modalities', 'reasoning', 'protocols', 'translations']) {
    delete model[field];
  }
  delete model.identity.aliases;
  delete model.identity.family;
  model.lifecycle = { status: 'active' };
  const setAuthorities = value => {
    if (Array.isArray(value)) value.forEach(setAuthorities);
    else if (value && typeof value === 'object') {
      if (Object.hasOwn(value, 'authority')) value.authority = 'central_feed';
      Object.values(value).forEach(setAuthorities);
    }
  };
  setAuthorities(model);
  feed.models = [model];
  expect(validate('centralFeed', feed)).toEqual([]);

  for (const mutate of [
    value => { value.lifecycle.replacement = 'openai/replacement'; },
    value => { value.reasoning = structuredClone(fixtures.model.reasoning); },
    value => { value.protocols = structuredClone(fixtures.model.protocols); },
    value => { value.provenance.authority = 'operator'; },
    value => { value.tariffs[0].provenance.authority = 'configured_catalog'; },
    value => { value.tariffs[0].components.input.provenance.authority = 'configured_catalog'; },
  ]) {
    const candidate = structuredClone(feed);
    mutate(candidate.models[0]);
    expect(validate('centralFeed', candidate)).not.toEqual([]);
  }
});

it('exports the same identity functions to CommonJS and preserves provider separation', () => {
  expect(identity('copilot', 'gpt-5.5-pro').key).not.toBe(identity('openai', 'gpt-5.5-pro').key);
  expect(matchModel(fixtures.model, 'gpt-5.5-pro', {
    provider: 'openai', channel: 'native-api',
  })).toMatchObject({ kind: 'exact' });
});
