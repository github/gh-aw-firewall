'use strict';

const naming = require('../model-information.naming.generated.json');
const { resolveIdentity } = require('../catalogue-contract/resolution');
const { getMedianPricingFact, getMaintainedPricingFact } = require('../catalogue-pricing');
const { applyAiCreditsUsage, resetAiCreditsGuardForTests, getAiCreditsReflectState,
  getAiCreditsBlockState } = require('./ai-credits-guard');
const { clearRuntimeModels, replaceRuntimeModels, captureRuntimePricing } = require('../runtime-model-catalog');
const { findAvailableModel } = require('../model-identity');
const { isModelPermittedByPolicy } = require('./model-policy-guard');
const { resolveFallbackEntry } = require('../model-fallback-chain');
const { collectLogOutput } = require('../test-helpers/log-test-helpers');

const rates = input => ({ input, output: input, reasoning: input, cachedInput: input, cacheWrite: null });
const scope = { provider: 'copilot', channel: 'copilot-api' };
const at = '2026-11-08T00:00:00Z';
const configure = models => {
  process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
    schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', catalogId: 'bundled-family-test', version: 'v1',
    providers: { copilot: { models } },
  });
};
const estimate = (model, tokens = 0, options = {}) =>
  getMedianPricingFact('copilot', model, tokens, { runtimeCatalog: {}, ...options });
const charge = (model, tokens = 1000000, options = {}) =>
  applyAiCreditsUsage({ input_tokens: tokens }, model, 'copilot', { catalogue: null, runtimeCatalog: {}, ...options });
let env;

beforeEach(() => {
  env = { ...process.env };
  for (const key of ['AWF_API_PROXY_PROVIDERS', 'AWF_MODEL_PRICING_CATALOG',
    'AWF_DEFAULT_AI_CREDITS_PRICING', 'AWF_MAX_AI_CREDITS', 'COPILOT_PROVIDER_API_KEY']) delete process.env[key];
  resetAiCreditsGuardForTests();
  clearRuntimeModels();
  collectLogOutput();
});
afterEach(() => {
  process.env = env;
  clearRuntimeModels();
  jest.restoreAllMocks();
});

test('the real bundled missing-price request changes charge and selected donor basis', () => {
  expect(getMaintainedPricingFact('copilot', 'gemini-3.1-pro-preview')).toBeNull();
  let backend;
  jest.isolateModules(() => {
    jest.doMock('../model-information.naming.generated.json', () => ({
      ...naming, models: naming.models.map(({ identity }) => {
        const { family, ...original } = identity;
        return { identity: original };
      }),
    }));
    const originalGuard = require('./ai-credits-guard');
    originalGuard.resetAiCreditsGuardForTests();
    backend = originalGuard.applyAiCreditsUsage({ input_tokens: 10000 },
      'gemini-3.1-pro-preview', 'copilot', { catalogue: null, runtimeCatalog: {} });
  });
  jest.dontMock('../model-information.naming.generated.json');
  expect(backend).toMatchObject({
    aiCreditsThisResponse: 1.875, pricingEstimate: { basis: 'backend', donorCount: 46 },
  });
  const usage = charge('gemini-3.1-pro-preview', 10000);
  expect(usage).toMatchObject({
    aiCreditsThisResponse: 2, pricingSource: 'median_estimate',
    accountingPolicy: 'family_median_estimate', fallbackPricingUsed: true,
    pricingEstimate: { basis: 'family', family: 'gemini-3-1-pro', donorCount: 1,
      componentDonors: { input: 1, output: 1, cachedInput: 1, cacheWrite: 0, reasoning: 1 },
      sources: ['curated'] },
  });
  expect(estimate('gemini-3.1-pro-preview').default).toEqual({
    input: 2, output: 12, cachedInput: 0.2, cacheWrite: null, reasoning: 12,
  });
  expect(getAiCreditsReflectState().by_model['gemini-3.1-pro-preview']).toMatchObject({
    total: 2, accounting_policy: 'family_median_estimate',
    pricing_estimate: { donorCount: 1 }, fallback_pricing_used: true,
  });
  expect(charge('gemini-3.1-pro').pricingSource).toBe('curated');
});

test('compiler-owned Claude lookup keys recover all reviewed family donors without duplicate votes', () => {
  expect(estimate('claude-sonnet-4.6').metadata.estimate).toMatchObject({
    basis: 'family', family: 'claude-sonnet-4', donorCount: 3, sources: ['curated'],
  });
  expect(estimate('claude-opus-4-6').metadata.estimate.donorCount).toBe(4);
  const runtimeCatalog = { copilot: [{
    id: 'claude-sonnet-4.5', observedAt: at, pricing: { default: rates(90) },
  }] };
  const fact = estimate('claude-sonnet-4.6', 0, { runtimeCatalog });
  expect(fact.default.input).toBe(3);
  expect(fact.metadata.estimate).toMatchObject({ donorCount: 3, sources: ['curated', 'provider'] });
  expect(estimate('unknown-family', 0, { runtimeCatalog }).metadata.estimate.donorCount).toBe(46);
});

test('families without eligible donors and unknown families retain backend fallback', () => {
  for (const id of ['gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'gpt-5.1']) {
    expect(charge(id)).toMatchObject({
      aiCreditsThisResponse: 200, accountingPolicy: 'backend_median_estimate',
      pricingEstimate: { basis: 'backend', donorCount: 46 },
    });
  }
  expect(getMedianPricingFact('unassociated-backend', 'gemini-3.1-pro-preview', 0)).toBeNull();
  for (const [provider, model] of [
    ['openai', 'gemini-3.1-pro-preview'], ['anthropic', 'claude-sonnet-4.6'],
    ['openrouter', 'google/gemini-3.1-pro-preview'],
  ]) {
    expect(getMedianPricingFact(provider, model, 0).metadata.estimate.basis).toBe('backend');
  }
});

test('explicit specialization boundaries exclude prefix-lookalikes from family donor selection', () => {
  configure({
    'gpt-4o-mini': rates(2), 'gpt-4o-audio-preview': rates(900),
    'gpt-5.4-pro': rates(900), 'claude-mythos-preview': rates(900),
    'gemini-3.1-pro-preview-customtools': rates(900),
  });
  expect(charge('gpt-4o')).toMatchObject({
    aiCreditsThisResponse: 200, pricingEstimate: { basis: 'family', donorCount: 1 },
  });
  for (const id of ['gpt-5.4-pro', 'gpt-5.4-codex', 'claude-mythos-preview',
    'gemini-3.1-pro-preview-customtools', 'gpt-5-codex-mini']) {
    expect(resolveIdentity(id, scope, naming).family).toBeUndefined();
  }
  expect(estimate('gpt-5.4').metadata.estimate.donorCount).toBe(3);
  expect(estimate('gpt-5.4').default.input).toBe(0.75);
});

test('fresh runtime family donors, strict tier thresholds and captured state control actual charges', () => {
  configure({ 'gpt-4o-mini': {
    ...rates('0.1'), longContext: { ...rates('0.3'), threshold: 10 },
  } });
  expect(charge('gpt-4o', 10).aiCreditsThisResponse).toBe(0.0001);
  expect(charge('gpt-4o', 11).aiCreditsThisResponse).toBe(0.00033);
  delete process.env.AWF_MODEL_PRICING_CATALOG;
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-08T12:00:00Z'));
  replaceRuntimeModels('copilot', [
    { id: 'o3-mini', observedAt: at, pricing: { default: rates('0.7') } },
  ]);
  const pin = captureRuntimePricing();
  expect(charge('o3', 10000, { runtimeCatalog: pin })).toMatchObject({
    aiCreditsThisResponse: 0.7, pricingEstimate: { basis: 'family', donorCount: 1, sources: ['provider'] },
  });
  replaceRuntimeModels('copilot', [
    { id: 'o3-mini', observedAt: '2025-01-01T00:00:00Z', pricing: { default: rates(900) } },
  ]);
  expect(charge('o3', 10000, { runtimeCatalog: captureRuntimePricing() }).pricingEstimate.basis).toBe('backend');
  Date.now.mockReturnValue(Date.parse('2027-01-01T00:00:00Z'));
  expect(charge('o3', 10000, { runtimeCatalog: pin }).aiCreditsThisResponse).toBe(0.7);
});

test('central family donor tariffs retain channel, deployment, freshness and effective-time applicability', () => {
  const record = structuredClone(require('../../../shared/model-information/catalog.generated.json')
    .models.find(model => model.identity.key === 'copilot/gemini-3.1-pro'));
  record.provenance = { at };
  for (const tariff of record.tariffs) {
    tariff.provenance = { at };
    for (const component of Object.values(tariff.components)) {
      component.provenance = { at };
      if (typeof component.price === 'string') component.price = '7';
    }
  }
  const catalogue = { time: Date.parse('2026-11-08T12:00:00Z'), maxAge: 86400000,
    source: 'fixture', revision: 'v1', snapshot: { models: [record] } };
  const options = { catalogue, centralAllowed: true };
  expect(estimate('gemini-3.1-pro-preview', 0, options).default.input).toBe(7);
  for (const mutate of [
    donor => { donor.tariffs[0].scope.channel = 'byok'; },
    donor => { donor.tariffs[0].scope.deployment = 'prod'; },
    donor => { donor.provenance.at = '2025-01-01T00:00:00Z'; },
    donor => { donor.tariffs[0].effectiveUntil = at; },
  ]) {
    const excluded = structuredClone(catalogue);
    mutate(excluded.snapshot.models[0]);
    const fact = estimate('gemini-3.1-pro-preview', 0, { ...options, catalogue: excluded });
    expect(fact.default.input).toBe(2);
    expect(fact.metadata.estimate).toMatchObject({ basis: 'family', donorCount: 1, sources: ['curated'] });
  }
  expect(estimate('gemini-3.1-pro-preview', 0, {
    ...options, scope: { ...scope, channel: 'byok' },
  })).toMatchObject({ default: { input: 2 }, metadata: { estimate: { sources: ['curated'] } } });
  const retired = structuredClone(catalogue);
  retired.snapshot.models[0].lifecycle.status = 'retired';
  expect(estimate('gemini-3.1-pro-preview', 0, { ...options, catalogue: retired })
    .metadata.estimate).toMatchObject({ basis: 'backend', donorCount: 45, sources: ['curated'] });
});

test.each([
  ['0.999999999999999999999999999999', false], ['1', true],
])('bundled singleton family budget compares the exact rate %s', (price, blocked) => {
  configure({ 'gpt-4o-mini': rates(price) });
  process.env.AWF_MAX_AI_CREDITS = '1';
  expect(charge('gpt-4o', 10000)).toMatchObject({
    aiCreditsThisResponse: 1, pricingEstimate: { basis: 'family', donorCount: 1 },
  });
  expect(getAiCreditsBlockState().maxExceeded).toBe(blocked);
});

test('family membership does not authorize availability, policy, fallback substitution or normalization', () => {
  expect(findAvailableModel('gemini-3.1-pro-preview', 'copilot', ['gemini-3.1-pro'])).toBeNull();
  expect(isModelPermittedByPolicy('gemini-3.1-pro-preview', ['gemini-3.1-pro'], null, 'copilot')).toBe(false);
  expect(resolveFallbackEntry('gemini-3.1-pro-preview', 'copilot').model).toBe('gemini-3.1-pro-preview');
  expect(resolveIdentity('COPILOT/GEMINI-3.1-PRO-PREVIEW?effort=high', scope, naming,
    { caseInsensitive: true })).toMatchObject({
    wireId: 'gemini-3.1-pro-preview', model: 'gemini-3.1-pro-preview?effort=high', matchKind: 'exact',
  });
  for (const id of ['gemini_3_1_pro_preview', 'gemini-3.1-pro-preview-20260101', 'gpt-5.4-future']) {
    expect(resolveIdentity(id, scope, naming).matchKind).toBe('unmatched');
    expect(resolveIdentity(id, scope, naming).family).toBeUndefined();
  }
});
