'use strict';

jest.mock('../catalogue-contract/pricing-resolution', () => {
  const actual = jest.requireActual('../catalogue-contract/pricing-resolution');
  return { ...actual, resolvePricing: jest.fn(actual.resolvePricing) };
});
jest.mock('../catalogue-loader', () => ({
  getCatalogueLoader: jest.fn(() => ({ capture: mockCaptureLoader })),
}));
const mockCaptureLoader = jest.fn(() => null);
const { resolvePricing } = require('../catalogue-contract/pricing-resolution');
const actualResolver = jest.requireActual('../catalogue-contract/pricing-resolution').resolvePricing;
const { applyAiCreditsUsage, resetAiCreditsGuardForTests, getAiCreditsReflectState,
  getAiCreditsBlockState, isModelPriceable, checkModelPricing } = require('./ai-credits-guard');
const { buildCommonGuardChecks } = require('./common-guard-checks');
const { collectLogOutput } = require('../test-helpers/log-test-helpers');
const { clearRuntimeModels, replaceRuntimeModels, captureRuntimePricing } = require('../runtime-model-catalog');
const { buildCatalogIndex, resolveCatalogModel } = require('../models-dev-catalog');

const at = '2026-11-01T00:00:00Z';
const rates = { input: 2, cachedInput: 0, cacheWrite: null, output: 4 };
let logs;
let originalEnv;

function central({ model = 'fixture', price = '3', deployment, channel = 'copilot-api' } = {}) {
  const provenance = { at };
  return {
    time: Date.parse('2026-11-01T12:00:00Z'), maxAge: 86400000, source: 'fixture', revision: 'r1',
    snapshot: { models: [{
      identity: { provider: 'copilot', key: `copilot/${model}`, rawId: model, lookupId: model },
      provenance, tariffs: [{
        tier: 'default', unit: 'USD_PER_1M_TOKENS', provenance,
        scope: { provider: 'copilot', channel, deployment },
        components: Object.fromEntries(['input', 'cachedInput', 'cacheWrite', 'output']
          .map(field => [field, { price, provenance }])),
      }],
    }] },
  };
}

function runtime(pricing = rates, longContext, observedAt = at) {
  return { copilot: [{
    id: 'fixture', provider: 'copilot', source: 'provider', observedAt,
    pricing: { default: pricing, ...(longContext ? { longContext } : {}) },
  }] };
}

function charge(model = 'fixture', options = {}, provider = 'copilot', tokens = 1000000) {
  return applyAiCreditsUsage({ input_tokens: tokens }, model, provider, { catalogue: null, ...options });
}

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const key of ['AWF_API_PROXY_PROVIDERS', 'AWF_MODEL_PRICING_CATALOG',
    'AWF_DEFAULT_AI_CREDITS_PRICING', 'AWF_MAX_AI_CREDITS', 'COPILOT_PROVIDER_API_KEY',
    'COPILOT_API_TARGET', 'GITHUB_SERVER_URL']) delete process.env[key];
  resetAiCreditsGuardForTests();
  clearRuntimeModels();
  mockCaptureLoader.mockClear();
  resolvePricing.mockReset().mockImplementation(actualResolver);
  logs = collectLogOutput();
});

afterEach(() => {
  if (!expect.getState().currentTestName.includes('injected')) {
    expect(logs.lines.filter(line => line.event === 'pricing_resolution_error')).toEqual([]);
    if (resolvePricing.mock.calls.length) {
      expect(resolvePricing.mock.results.every(result => result.type === 'return')).toBe(true);
    }
  }
  jest.restoreAllMocks();
  process.env = originalEnv;
  clearRuntimeModels();
});

test.each([199999, 200000, 200001])('operator tier %s short-circuits catalogue/provider initialization', tokens => {
  process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({ copilot: { models: {
    fixture: { cost: { input: 0.000002, output: 0.000004, cache_read: 0, long_context: {
      input: 0.000009, output: 0.00001, cache_read: 0, cache_write: 0, max_prompt_tokens: 200000,
    } } },
  } } });
  const options = {};
  Object.defineProperties(options, {
    runtimeCatalog: { enumerable: true, get: () => { throw new Error('eager runtime'); } },
  });
  const usage = applyAiCreditsUsage({ input_tokens: tokens }, 'fixture', 'copilot', options);
  expect(usage.pricingSource).toBe('operator');
  expect(usage.pricingTier).toBe(tokens > 200000 ? 'long_context' : 'default');
  expect(usage.aiCreditsThisResponse).toBeCloseTo(tokens * (tokens > 200000 ? 9 : 2) / 10000, 6);
  expect(mockCaptureLoader).not.toHaveBeenCalled();
  expect(resolvePricing).toHaveBeenCalledTimes(1);
  expect(resolvePricing.mock.results[0].value.result.source).toBe('operator');
});

test.each([199999, 200000, 200001])('configured catalogue tier %s outranks runtime and central', tokens => {
  process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
    schemaVersion: 1, catalogId: 'private-config', version: 'v1', unit: 'USD_PER_1M_TOKENS',
    providers: { github: { models: { 'FIXTURE.1': {
      ...rates, reasoning: 0, longContext: { ...rates, input: 7, reasoning: 0, threshold: 200000 },
    } } } },
  });
  const providerCatalog = runtime();
  providerCatalog.copilot[0].id = 'fixture_1';
  const usage = charge('fixture_1-20260101', {
    runtimeCatalog: providerCatalog, catalogue: central({ model: 'fixture_1-20260101' }),
  }, 'copilot', tokens);
  expect(usage.pricingSource).toBe('shared_catalog');
  expect(usage.pricingTier).toBe(tokens > 200000 ? 'long_context' : 'default');
  expect(usage.pricingCatalogVersion).toBe('v1');
  expect(resolvePricing.mock.results[0].value.result.source).toBe('shared_catalog');
});

test.each([199999, 200000, 200001])('provider whole/partial tiers %s retain component merge semantics', tokens => {
  const options = { runtimeCatalog: runtime(
    { input: 1, output: 3, threshold: 200000 },
    { input: 6, output: 8, cacheWrite: 0 },
  ) };
  const usage = charge('fixture', options, 'copilot', tokens);
  // No fallback exists for fixture, so the missing cache component stays unpriced.
  expect(usage).toBeNull();
  expect(resolvePricing.mock.results[0].value.result).toBeNull();
  resetAiCreditsGuardForTests();
  process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify(rates);
  const priced = charge('fixture', options, 'copilot', tokens);
  expect(priced.pricingSource).toBe('provider');
  expect(priced.pricingTier).toBe(tokens > 200000 ? 'long_context' : 'default');
  expect(priced.aiCreditsThisResponse).toBeCloseTo(tokens * (tokens > 200000 ? 6 : 1) / 10000, 6);
  const resolution = resolvePricing.mock.results[1].value;
  expect(resolution.componentSources.cachedInput.source).toBe('configured_default');
  expect(resolution.result.pricing.cacheWrite).toBe(tokens > 200000 ? 0 : null);
});

test('complete fresh runtime beats central, partial runtime yields to central, stale-complete quirk stays', () => {
  expect(charge('fixture', { runtimeCatalog: runtime(), catalogue: central() }).pricingSource).toBe('provider');
  expect(charge('fixture', {
    runtimeCatalog: runtime({ input: 9, output: 9 }), catalogue: central(),
  }).pricingSource).toBe('central_feed');
  const stale = runtime(rates, null, '2026-10-01T00:00:00Z');
  expect(charge('fixture', { runtimeCatalog: stale, catalogue: central() }).pricingSource).toBe('central_feed');
  const expired = central();
  expired.time += 86400000;
  const legacy = charge('fixture', { runtimeCatalog: stale, catalogue: expired });
  expect(legacy.pricingSource).toBe('provider');
  expect(legacy.aiCreditsThisResponse).toBe(200);
});

test.each(['boundary', 'future', 'stale', 'freshUntil', 'deployment', 'channel', 'byok', 'custom-target'])(
  'central freshness/scope %s retains exact authority and exclusions', boundary => {
    const catalogue = central();
    const record = catalogue.snapshot.models[0];
    if (boundary === 'boundary') catalogue.time = Date.parse(at) + catalogue.maxAge;
    if (boundary === 'future') record.provenance = { at: '2026-11-02T00:00:00Z' };
    if (boundary === 'stale') catalogue.time = Date.parse(at) + catalogue.maxAge + 1;
    if (boundary === 'freshUntil') record.provenance = { at, freshUntil: new Date(catalogue.time).toISOString() };
    if (boundary === 'deployment') record.tariffs[0].scope.deployment = 'private';
    if (boundary === 'channel') record.tariffs[0].scope.channel = 'cli';
    if (boundary === 'byok') process.env.COPILOT_PROVIDER_API_KEY = 'test-secret';
    if (boundary === 'custom-target') process.env.COPILOT_API_TARGET = 'https://private.invalid';
    const usage = charge('fixture', { catalogue });
    expect(usage?.pricingSource || null).toBe(boundary === 'boundary' ? 'central_feed' : null);
  },
);

test('partial provider merge uses its selected tier, preserves zero/null, and drops fallback reasoning', () => {
  const catalog = runtime({ input: 1, output: 3, threshold: 10 },
    { input: 6, output: 8, cacheWrite: 0 });
  catalog.copilot[0].id = 'gpt-6.1-sol';
  const usage = charge('gpt-6.1-sol', { runtimeCatalog: catalog }, 'copilot', 11);
  expect(usage.pricingTier).toBe('long_context');
  const resolution = resolvePricing.mock.results[0].value;
  expect(resolution.result.pricing).toEqual({ input: 6, output: 8, cacheWrite: 0, cachedInput: 0.2 });
  expect(resolution.componentSources.cachedInput).toEqual({ source: 'curated', tier: 'long_context' });
});

test('complete provider discounts stay informational and never reduce AI-credit budget charges', () => {
  const catalog = runtime();
  catalog.copilot[0].promotion = { discountPercent: 100, endsAt: '2027-01-01T00:00:00Z' };
  process.env.AWF_MAX_AI_CREDITS = '1';
  expect(charge('fixture', { runtimeCatalog: catalog }).aiCreditsThisResponse).toBe(200);
  expect(getAiCreditsBlockState().maxExceeded).toBe(true);
});

test.each([199999, 200000, 200001])('central long-context strict boundary %s and expired-tier rejection', tokens => {
  const catalogue = central();
  const tariffs = catalogue.snapshot.models[0].tariffs;
  tariffs.push({ ...structuredClone(tariffs[0]), tier: 'long_context', promptTokensAbove: 200000,
    components: Object.fromEntries(Object.keys(rates).map(field => [field, { price: '8', provenance: { at } }])) });
  const usage = charge('fixture', { catalogue }, 'copilot', tokens);
  expect(usage.pricingTier).toBe(tokens > 200000 ? 'long_context' : 'default');
  expect(usage.aiCreditsThisResponse).toBeCloseTo(tokens * (tokens > 200000 ? 8 : 3) / 10000, 6);
  tariffs[1].effectiveUntil = new Date(catalogue.time).toISOString();
  const afterExpiry = charge('fixture', { catalogue }, 'copilot', tokens);
  expect(afterExpiry?.pricingSource || null).toBe(tokens > 200000 ? null : 'central_feed');
});

test.each([271999, 272000, 272001])('curated long-context strict boundary %s is independently selected', tokens => {
  const usage = charge('gpt-6.1-sol', {}, 'copilot', tokens);
  const pricing = require('../ai-credits-pricing')['gpt-6.1-sol'];
  expect(usage.pricingTier).toBe(tokens > pricing.longContext.threshold ? 'long_context' : 'default');
});

test('curated/import matching and cross-provider slug collisions remain named nonactivated fixtures', () => {
  expect(charge('anthropic/claude_sonnet_4-20260101').pricingSource).toBe('curated');
  expect(charge('ANTHROPIC/CLAUDE_SONNET_4-20260101')).toBeNull();
  const entry = require('../models.dev.catalog.json').data.find(entry =>
    entry.pricing && entry.id.includes('/') && !require('../ai-credits-pricing')[entry.id.split('/').slice(1).join('/')]);
  expect(entry).toBeDefined();
  expect(charge(entry.id, {}, 'custom-provider').pricingSource).toBe('models.dev');
  const last = resolvePricing.mock.calls.at(-1)[0];
  expect(last.identity.provider).toBe('custom-provider');
  expect(resolvePricing.mock.results.at(-1).value.result.source).toBe('models.dev');
  const index = buildCatalogIndex([
    { id: 'alpha/collision', pricing: { prompt: '0.000001', completion: '0.000002' } },
    { id: 'beta/collision', pricing: { prompt: '0.000009', completion: '0.00001' } },
  ]);
  // Governed imports would keep these identities distinct. The compatibility
  // resolver deliberately preserves legacy first-slug matching, not that target.
  expect(resolveCatalogModel('beta/collision', index).pricing.input).toBe(1);
});

test('selector/default/sentinel and concrete-unpriced accounting retain warnings and budget behavior', () => {
  const selector = charge('auto');
  expect(selector).toMatchObject({ pricingSource: 'dynamic_selector_fallback', fallbackPricingUsed: true });
  expect(charge('unknown').pricingSource).toBe('builtin_fallback');
  expect(charge('concrete-unpriced')).toBeNull();
  expect(charge('concrete-unpriced')).toBeNull();
  expect(logs.lines.filter(line => line.event === 'unknown_model_ai_credits_pricing')).toHaveLength(2);
  process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify(rates);
  expect(charge('concrete-unpriced').pricingSource).toBe('configured_default');
  process.env.AWF_MAX_AI_CREDITS = '1';
  expect(getAiCreditsBlockState().maxExceeded).toBe(true);
  const before = structuredClone(getAiCreditsReflectState());
  expect(isModelPriceable('concrete-unpriced', 'copilot', { catalogue: null })).toBe(true);
  expect(getAiCreditsReflectState()).toEqual(before);
});

test('capture is reused once and immutable request runtime pricing survives replacement', () => {
  replaceRuntimeModels('copilot', runtime().copilot);
  const pinned = captureRuntimePricing();
  replaceRuntimeModels('copilot', runtime({ ...rates, input: 9 }).copilot);
  const before = structuredClone(pinned);
  const options = { runtimeCatalog: pinned };
  expect(applyAiCreditsUsage({ input_tokens: 1000000 }, 'fixture', 'copilot', options).aiCreditsThisResponse).toBe(200);
  expect(mockCaptureLoader).toHaveBeenCalledTimes(1);
  expect(resolvePricing).toHaveBeenCalledTimes(1);
  expect(pinned).toEqual(before);
});

test('injected shared resolver tariff is authoritative for real charges and budgets', () => {
  resolvePricing.mockImplementation(capture => {
    const resolution = actualResolver(capture);
    return { ...resolution, result: { ...resolution.result, pricing: { ...rates, input: 9 } } };
  });
  process.env.AWF_MAX_AI_CREDITS = '1000';
  expect(charge('gpt-5-mini').aiCreditsThisResponse).toBe(900);
  expect(getAiCreditsBlockState().maxExceeded).toBe(false);
  expect(charge('gpt-5-mini').aiCreditsThisResponse).toBe(900);
  expect(getAiCreditsReflectState().total).toBe(1800);
  expect(getAiCreditsBlockState().maxExceeded).toBe(true);
});

test('injected resolver failures log sanitized errors, never fall back, and block subsequent dispatch', () => {
  resolvePricing.mockImplementation(() => { throw new Error('https://credential.invalid/secret'); });
  expect(() => charge('gpt-5-mini')).toThrow(expect.objectContaining({
    code: 'pricing_resolution_error', statusCode: 500,
  }));
  expect(logs.lines.filter(line => line.event === 'pricing_resolution_error')).toHaveLength(1);
  expect(logs.lines.filter(line => line.event === 'unknown_model_ai_credits_pricing')).toHaveLength(0);
  expect(getAiCreditsReflectState().total).toBe(0);
  expect(getAiCreditsReflectState().pricing_error).toBe('pricing_resolution_error');
  expect(JSON.stringify(logs.lines)).not.toContain('credential');
  expect(mockCaptureLoader).not.toHaveBeenCalled();
  resolvePricing.mockImplementation(actualResolver);
  const deps = Object.fromEntries([
    'getMaxRunsBlockState', 'getMaxCacheMissesBlockState', 'getPermissionDeniedBlockState',
    'getAiCreditsBlockState', 'getModelMultiplierCapBlockState', 'getRetiredModelBlockState',
    'getModelPolicyBlockState',
  ].map(name => [name, () => null]));
  const guard = buildCommonGuardChecks({ ...deps, checkModelPricing }, 'gpt-5-mini', 'copilot')
    .find(check => check.eventName === 'pricing_resolution_error');
  expect(guard.isBlocked(guard.block)).toBe(true);
  expect(guard.statusCode).toBe(500);
  expect(guard.buildError(guard.block).error.type).toBe('pricing_resolution_error');
});

test('injected preflight failures return a structured error without consuming or inventing credits', () => {
  resolvePricing.mockImplementation(() => { throw new Error('private configuration'); });
  expect(checkModelPricing('gpt-5-mini', 'copilot', { catalogue: null })).toMatchObject({
    error: { type: 'pricing_resolution_error' },
  });
  expect(getAiCreditsReflectState().total).toBe(0);
  expect(JSON.stringify(logs.lines)).not.toContain('private configuration');
});
