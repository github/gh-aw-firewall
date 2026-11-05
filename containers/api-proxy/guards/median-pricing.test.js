'use strict';

jest.mock('../model-information.naming.generated.json', () => {
  const actual = jest.requireActual('../model-information.naming.generated.json');
  const { identity } = jest.requireActual('../catalogue-contract/identity');
  return {
    models: [...actual.models, ...['family-a', 'family-b', 'family-special'].map(id => ({
      identity: { ...identity('median-test', id), family: id === 'family-special' ? 'special' : 'family',
        ...(id === 'family-a' ? { aliases: [{
          id: 'family-alias', match: 'exact',
          scope: { provider: 'median-test', channel: 'native-api' },
        }] } : {}),
      },
    }))],
    rules: [...actual.rules, {
      provider: 'median-test', family: 'family',
      scope: { provider: 'median-test', channel: 'native-api' },
      excludes: [], field: 'reasoning', value: true,
    }],
  };
});

jest.mock('../model-information.fallback-pricing.generated.json', () => {
  const actual = jest.requireActual('../model-information.fallback-pricing.generated.json');
  const imported = (namespace, price) => ({
    currency: 'USD', unit: 'USD_PER_1M_TOKENS', sourceNamespace: namespace,
    provenance: { source: 'fixture-import', revision: 'v1' },
    components: { input: { price }, output: { price } },
  });
  return { ...actual, imported: { ...actual.imported, 'collision-backend': {
    'publisher-a/shared': imported('publisher-a', '2'),
    'publisher-b/shared': imported('publisher-b', '8'),
  } } };
});

const exact = require('../catalogue-contract/exact-pricing');
const { medianPricingFact } = require('../catalogue-contract/pricing-resolution');
const { getMedianPricingFact } = require('../catalogue-pricing');
const { applyAiCreditsUsage, resetAiCreditsGuardForTests, getAiCreditsReflectState,
  getAiCreditsBlockState, isModelPriceable, checkModelPricing } = require('./ai-credits-guard');
const { captureRuntimePricing, replaceRuntimeModels, clearRuntimeModels } = require('../runtime-model-catalog');
const { collectLogOutput } = require('../test-helpers/log-test-helpers');
const rates = (input, output = input, cachedInput = input, cacheWrite = null, reasoning) => ({
  input, output, cachedInput, cacheWrite, ...(reasoning === undefined ? {} : { reasoning }),
});
const donor = (pricing, family = 'family', source = 'curated') => ({
  family, result: { source, tier: 'default', pricing: exact.rates(pricing) },
});
const configure = (models, provider = 'median-test') => {
  process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
    schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', catalogId: 'fixture', version: 'v1',
    providers: { [provider]: { models: Object.fromEntries(Object.entries(models)
      .map(([id, pricing]) => [id, { reasoning: pricing.output, ...pricing }])) } },
  });
};
const charge = (model = 'family-new', options = {}, tokens = 10000) =>
  applyAiCreditsUsage({ input_tokens: tokens }, model, 'median-test', { catalogue: null, ...options });
let env;
beforeEach(() => {
  env = { ...process.env };
  for (const key of ['AWF_API_PROXY_PROVIDERS', 'AWF_MODEL_PRICING_CATALOG',
    'AWF_DEFAULT_AI_CREDITS_PRICING', 'AWF_MAX_AI_CREDITS']) delete process.env[key];
  resetAiCreditsGuardForTests();
  clearRuntimeModels();
});
afterEach(() => {
  process.env = env;
  clearRuntimeModels();
  jest.restoreAllMocks();
});

test.each([
  [[rates(7)], 7],
  [[rates(9), rates(1), rates(4)], 4],
  [[rates(9), rates(1), rates(4), rates(2)], 3],
])('uses independently expected singleton/odd/even medians %#', (prices, expected) => {
  expect(medianPricingFact(prices.map(price => donor(price)), 'family').default.input).toBe(expected);
});

test('sorts each component independently, keeps zero, excludes null cache writes and uses output reasoning', () => {
  const fact = medianPricingFact([
    donor(rates(1, 90, 0, null)), donor(rates(9, 10, 4, 0, 0)),
    donor(rates(3, 30, 2, 8, 6)),
  ], 'family');
  expect(fact.default).toEqual({ input: 3, output: 30, cachedInput: 2, cacheWrite: 4, reasoning: 6 });
  expect(fact.metadata.estimate.componentDonors).toEqual({
    input: 3, output: 3, cachedInput: 3, cacheWrite: 2, reasoning: 3,
  });
  expect(medianPricingFact([donor(rates(0))]).default.cacheWrite).toBeNull();
  expect(medianPricingFact([])).toBeNull();
  expect(medianPricingFact([donor(rates(5), 'family', 'median_estimate')])).toBeNull();
});

test('averages tiny exact decimal rates without numeric projection or sort loss', () => {
  const fact = medianPricingFact([
    donor(rates('0.999999999999999999999999999999')),
    donor(rates('1.000000000000000000000000000001')),
  ]);
  expect(exact.compare(exact.rate(fact.default, 'input'), exact.decimal(1))).toBe(0);
  const tiny = medianPricingFact([donor(rates('1e-330')), donor(rates('3e-330'))]);
  expect(exact.compare(exact.rate(tiny.default, 'input'), exact.decimal('2e-330'))).toBe(0);
});

test('uses declared family, honors special-variant exceptions, and falls back to backend without guessing', () => {
  configure({ 'family-a': rates(2), 'family-b': rates(6), 'family-special': rates(100), outsider: rates(20) });
  expect(charge()).toMatchObject({
    aiCreditsThisResponse: 4, accountingPolicy: 'family_median_estimate',
    pricingEstimate: { basis: 'family', family: 'family', donorCount: 2 },
  });
  expect(charge('unidentified')).toMatchObject({
    aiCreditsThisResponse: 13, accountingPolicy: 'backend_median_estimate',
    pricingEstimate: { basis: 'backend', donorCount: 4 },
  });
  configure({ outsider: rates(20) });
  expect(charge()).toMatchObject({ aiCreditsThisResponse: 20, pricingEstimate: { basis: 'backend' } });
  expect(getMedianPricingFact('empty-backend', 'family-new', 0)).toBeNull();
});

test('each canonical ID is counted once across sources and alias observations', () => {
  configure({ 'family-a': rates(2), 'family-alias': rates(900), 'family-b': rates(6) });
  process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({ 'median-test': { models: {
    'family-a': { cost: { input: '0.00001', output: '0.00001' } },
  } } });
  const runtimeCatalog = { 'median-test': [
    { id: 'family-a', observedAt: new Date().toISOString(), pricing: { default: rates(100) } },
    { id: 'family-a', observedAt: new Date().toISOString(), pricing: { default: rates(100) } },
  ] };
  expect(charge('family-new', { runtimeCatalog })).toMatchObject({
    aiCreditsThisResponse: 8,
    pricingEstimate: { donorCount: 2, sources: ['operator', 'shared_catalog'] },
  });
});

test('publisher-qualified donor identities remain distinct without leaking into native backends', () => {
  const fact = getMedianPricingFact('collision-backend', 'missing', 0);
  expect(fact.default.input).toBe(5);
  expect(fact.metadata.estimate).toMatchObject({ donorCount: 2, sources: ['models.dev'] });
  expect(getMedianPricingFact('publisher-a', 'missing', 0)).toBeNull();
  expect(getMedianPricingFact('unassociated-backend', 'publisher-a/shared', 0)).toBeNull();
});

test('configured defaults and exact overrides outrank estimates; selector and sentinel outputs are never donors', () => {
  configure({ 'family-a': rates(2), 'family-b': rates(6) });
  process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify(rates(9));
  expect(charge().pricingSource).toBe('configured_default');
  expect(charge('family-a').pricingSource).toBe('shared_catalog');
  delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
  configure({ auto: rates(1000), unknown: rates(1000) });
  expect(charge()).toBeNull();
});

test.each([
  ['0.999999999999999999999999999997', false],
  ['1', true],
])('median charges enforce exact budget and reflection at %s', (low, blocked) => {
  configure({ 'family-a': rates(low), 'family-b': rates('1.000000000000000000000000000001') });
  process.env.AWF_MAX_AI_CREDITS = '1';
  const result = charge();
  expect(result.aiCreditsThisResponse).toBe(1);
  expect(getAiCreditsBlockState().maxExceeded).toBe(blocked);
  expect(getAiCreditsReflectState().by_model['family-new']).toMatchObject({
    total: 1, pricing_source: 'median_estimate', fallback_pricing_used: true,
    accounting_policy: 'family_median_estimate', pricing_estimate: { donorCount: 2 },
  });
});

test('quiet probes have no warning/state effects; preflight and repeated usage warn once without leaking configuration', () => {
  configure({ 'family-a': rates(2) });
  const { lines } = collectLogOutput();
  expect(isModelPriceable('family-new', 'median-test', { catalogue: null })).toBe(true);
  expect(lines).toEqual([]);
  expect(getAiCreditsReflectState().total).toBe(0);
  expect(checkModelPricing('family-new', 'median-test', { catalogue: null })).toBeNull();
  charge();
  charge();
  const warnings = lines.filter(line => line.event === 'estimated_model_ai_credits_pricing');
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({ basis: 'family', donor_count: 1, sources: ['shared_catalog'] });
  expect(JSON.stringify(warnings)).not.toContain('AWF_MODEL_PRICING_CATALOG');
});

test('stale provider donors are excluded and pinned exact runtime medians survive refresh and clock advance', () => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T12:00:00Z'));
  replaceRuntimeModels('median-test', [
    { id: 'family-a', observedAt: '2026-11-01T00:00:00Z',
      pricing: { default: exact.rates(rates('0.999999999999999999999999999999')) } },
    { id: 'family-b', observedAt: '2026-11-01T00:00:00Z',
      pricing: { default: exact.rates(rates('1.000000000000000000000000000001')) } },
    { id: 'stale', observedAt: '2025-01-01T00:00:00Z', pricing: { default: rates(900) } },
  ]);
  const pin = captureRuntimePricing();
  replaceRuntimeModels('median-test', [
    { id: 'family-a', observedAt: '2026-11-01T00:00:00Z', pricing: { default: rates(8) } },
  ]);
  Date.now.mockReturnValue(Date.parse('2027-01-01T00:00:00Z'));
  const before = charge('family-new', { runtimeCatalog: pin });
  expect(before).toMatchObject({ aiCreditsThisResponse: 1, pricingEstimate: { donorCount: 2 } });
  expect(charge('family-new', { runtimeCatalog: captureRuntimePricing() })).toBeNull();
  expect(charge('family-new', { runtimeCatalog: pin }).pricingCatalogVersion).toBe(before.pricingCatalogVersion);
  expect(charge('family-new', { runtimeCatalog: { ...pin } }).pricingCatalogVersion)
    .toBe(before.pricingCatalogVersion);
});

test('donor tiers use the requested prompt threshold and partial runtime prices are filled exactly', () => {
  configure({
    'family-a': { ...rates('0.1'), longContext: { ...rates('0.3'), reasoning: '0.3', threshold: 10 } },
    'family-b': { ...rates('0.2'), longContext: { ...rates('0.4'), reasoning: '0.4', threshold: 10 } },
  });
  expect(charge('family-new', {}, 10).inputCreditsThisResponse).toBe(0.00015);
  expect(charge('family-new', {}, 11).inputCreditsThisResponse).toBe(0.000385);
  const usage = applyAiCreditsUsage({
    input_tokens: 10000, cache_read_tokens: 10000, input_tokens_include_cache: false,
  }, 'family-new', 'median-test', { catalogue: null, runtimeCatalog: { 'median-test': [{
    id: 'family-new', observedAt: new Date().toISOString(), pricing: { default: { input: '0.7', output: '0.9' } },
  }] } });
  expect(usage).toMatchObject({
    aiCreditsThisResponse: 0.35, pricingSource: 'provider', fallbackPricingUsed: true,
    accountingPolicy: 'family_median_estimate',
  });
});

test.each([undefined, '0.5'])('estimated partial-provider fill retains reasoning semantics for %s', reasoning => {
  configure({
    'family-a': { ...rates(2, 6), reasoning: 10 },
    'family-b': { ...rates(4, 8), reasoning: 14 },
  });
  const usage = applyAiCreditsUsage({ output_tokens: 10000, reasoning_tokens: 10000 },
    'family-new', 'median-test', { catalogue: null, runtimeCatalog: { 'median-test': [{
      id: 'family-new', observedAt: new Date().toISOString(),
      pricing: { default: { input: '1', output: '2', ...(reasoning ? { reasoning } : {}) } },
    }] } });
  expect(usage.outputCreditsThisResponse).toBe(reasoning ? 0.5 : 12);
});

test('no-donor usage warns once and remains excluded rather than borrowing a backend', () => {
  const { lines } = collectLogOutput();
  expect(charge()).toBeNull();
  expect(charge()).toBeNull();
  expect(getAiCreditsReflectState()).toMatchObject({ total: 0, by_model: {} });
  expect(lines).toEqual([expect.objectContaining({
    event: 'unknown_model_ai_credits_pricing',
    message: expect.stringContaining('budget enforcement may undercount'),
  })]);
});

test('malformed donor prices fail sanitised accounting and block dispatch instead of approximating', () => {
  configure({ 'family-a': rates('https://credential.invalid/private') });
  const { lines } = collectLogOutput();
  expect(() => charge()).toThrow(expect.objectContaining({ code: 'pricing_resolution_error' }));
  expect(checkModelPricing('family-new', 'median-test')).toMatchObject({
    error: { type: 'pricing_resolution_error' },
  });
  expect(getAiCreditsReflectState().total).toBe(0);
  expect(JSON.stringify(lines)).not.toContain('credential');
  expect(lines.filter(line => line.event === 'estimated_model_ai_credits_pricing')).toHaveLength(0);
});

test.each([
  ['0.799999999999999999999999999997', '0.800000000000000000000000000001', false],
  ['0.8', '0.8', true],
])('steering compares the unrounded median at %s', (low, high, crossed) => {
  configure({ 'family-a': rates(low), 'family-b': rates(high) });
  process.env.AWF_MAX_AI_CREDITS = '1';
  expect(charge().aiCreditsThisResponse).toBe(0.8);
  expect(getAiCreditsReflectState().thresholds_crossed.includes(80)).toBe(crossed);
});

test.each([
  ['4999.999999999999999999999999999997', false], ['5000', true],
])('hard cap compares accumulated exact estimated credits at %s', (low, blocked) => {
  configure({ 'family-a': rates(low), 'family-b': rates('5000.000000000000000000000000000001') });
  charge();
  charge();
  expect(getAiCreditsReflectState().total).toBe(10000);
  expect(getAiCreditsBlockState()?.hardCap === true).toBe(blocked);
});
