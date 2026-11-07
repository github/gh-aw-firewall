#!/usr/bin/env node
'use strict';

// Provider-free smoke of the distributed proxy files, not repository imports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const proxyDirectory = path.resolve(process.argv[2]);
let networkCalls = 0;
const denyNetwork = () => {
  networkCalls++;
  throw new Error('Pricing smoke attempted network access');
};
require('node:http').request = denyNetwork;
require('node:http').get = denyNetwork;
require('node:https').request = denyNetwork;
require('node:https').get = denyNetwork;
require('node:net').connect = denyNetwork;
require('node:net').createConnection = denyNetwork;
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:tls').connect = denyNetwork;
global.fetch = denyNetwork;

const load = file => require(path.join(proxyDirectory, file));
const { createCatalogueLoader } = load('catalogue-loader');
const { computeTokenBudgetUsage } = load('token-budget-log');
const guard = load('guards/ai-credits-guard');
const { buildCommonGuardChecks } = load('guards/common-guard-checks');
const { enforceWebSocketGuards } = load('websocket-guards');
const { replaceRuntimeModels, clearRuntimeModels, captureRuntimePricing, parseProviderModelMetadata } = load('runtime-model-catalog');
const { trackTokenUsage, trackWebSocketTokenUsage, closeLogStream } = load('token-tracker');
const bundledPricing = load('model-information.fallback-pricing.generated.json');
const maintainedPricing = load('model-information.pricing.generated.json');
const [first, next] = JSON.parse(process.env.AWF_PRICING_SMOKE_SNAPSHOTS);
const rates = { input: 2, output: 4, cachedInput: 0, cacheWrite: null, reasoning: 0 };
const log = () => {};
const context = { provider: 'copilot', catalogue: null, requestId: 'smoke', logRequest: log };
const charge = (model, options = {}, tokens = 1000000) =>
  computeTokenBudgetUsage({ ...context, ...options }, { input_tokens: tokens }, model);
const assertEstimated = (model, options = {}) => {
  const usage = charge(model, options);
  assert.equal(usage.ai_credits_pricing_source, 'median_estimate');
  assert.equal(usage.ai_credits_accounting_policy, 'backend_median_estimate');
  return usage;
};
const runtime = (model, prices) => ({ copilot: [{
  id: model, provider: 'copilot', observedAt: '2026-10-23T00:00:00Z',
  pricing: { default: prices },
}] });
const reset = () => {
  guard.resetAiCreditsGuardForTests();
  clearRuntimeModels();
  for (const name of ['AWF_API_PROXY_PROVIDERS', 'AWF_MODEL_PRICING_CATALOG',
    'AWF_DEFAULT_AI_CREDITS_PRICING', 'AWF_MAX_AI_CREDITS', 'COPILOT_PROVIDER_API_KEY']) {
    delete process.env[name];
  }
};

function chargeHttpAndWebSocket(provider, model, expectedCredits, tokens = 1000000, tier = 'default',
  expectedTotal = expectedCredits * 2, extraUsage = {}, pricingOptions = {}) {
  const observed = [];
  const tiers = [];
  const options = {
    requestId: `smoke-source-${process.pid}`, provider, path: '/chat/completions',
    startTime: Date.now(), metrics: { increment: log, observe: log, gauge: log },
    requestModel: model,
    onUsage: (usage, reportedModel) => {
      const result = computeTokenBudgetUsage({ ...context, provider, ...pricingOptions }, usage, reportedModel);
      observed.push(result.ai_credits_this_response);
      tiers.push(result.ai_credits_pricing_tier);
      return result;
    },
  };
  const payload = Buffer.from(JSON.stringify({
    model, usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens, ...extraUsage },
  }));
  const upstream = new EventEmitter();
  upstream.headers = { 'content-type': 'application/json' };
  upstream.statusCode = 200;
  trackTokenUsage(upstream, options);
  upstream.emit('data', payload);
  upstream.emit('end');
  const socket = new EventEmitter();
  trackWebSocketTokenUsage(socket, { ...options, path: '/responses' });
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  socket.emit('data', Buffer.concat([
    Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'), header, payload,
  ]));
  socket.emit('end');
  socket.emit('close');
  assert.deepEqual(observed, [expectedCredits, expectedCredits]);
  assert.deepEqual(tiers, [tier, tier]);
  if (expectedTotal !== null) assert.equal(guard.getAiCreditsReflectState().total, expectedTotal);
}

async function main() {
  reset();
  const fixtureSources = process.env.AWF_PRICING_SMOKE_IMPORT_FIXTURES === 'true';
  assert.ok(Object.keys(maintainedPricing).length > 0);
  for (const [model, pricing] of Object.entries(maintainedPricing)) {
    assert.ok(model.length > 0);
    assert.ok(pricing && typeof pricing === 'object');
    if (pricing.tariffs) {
      assert.ok(Array.isArray(pricing.tariffs) && pricing.tariffs.length > 0);
      assert.ok(pricing.tariffs.some(tariff => tariff.tier === 'default'));
    } else {
      for (const field of ['input', 'cachedInput', 'cacheWrite', 'output']) {
        assert.ok(Object.hasOwn(pricing, field));
      }
    }
  }
  assert.ok(Object.keys(bundledPricing.compatibility.providers).length > 0);
  for (const [provider, models] of Object.entries(bundledPricing.compatibility.providers)) {
    assert.ok(provider.length > 0);
    assert.ok(Object.keys(models).length > 0);
    for (const [model, pricing] of Object.entries(models)) {
      assert.ok(model.length > 0);
      assert.ok(pricing && typeof pricing === 'object');
      for (const field of ['input', 'cachedInput', 'cacheWrite', 'output']) {
        assert.ok(Object.hasOwn(pricing, field));
      }
    }
  }
  assert.equal(bundledPricing.compatibility.policy, 'legacy_native_compatibility');
  for (const [provider, model, credits] of [
    ['copilot', 'gpt-5.4', 250],
    ['copilot', 'gpt-5-mini', fixtureSources ? 75 : 25],
    ['openai', 'gpt-5-mini', 25],
    ['openai', 'gpt-5.4', 250],
    ['openrouter', 'openai/gpt-5.4', 250],
    ['openrouter', 'perceptron/perceptron-mk1', 15],
    ['openrouter', 'openai/gpt-4o-2024-05-13', 500],
    ['openrouter', 'google/gemma-4-31b-it:free', 0],
    ['copilot', 'text-embedding-3-small', 2],
  ]) {
    reset();
    if (fixtureSources && model === 'gpt-5-mini') process.env.AWF_MAX_AI_CREDITS = '150';
    chargeHttpAndWebSocket(provider, model, credits);
    if (fixtureSources && model === 'gpt-5-mini') {
      assert.equal(guard.getAiCreditsBlockState().maxExceeded, false);
    }
  }
  reset();
  process.env.AWF_MAX_AI_CREDITS = '500';
  chargeHttpAndWebSocket('copilot', 'gpt-5.4', 250);
  assert.equal(guard.getAiCreditsBlockState().maxExceeded, true);
  reset();
  for (const provider of ['copilot', 'openai', 'perceptron', 'custom-backend', undefined]) {
    for (const model of ['perceptron/perceptron-mk1', 'perceptron-mk1']) {
      if (['copilot', 'openai'].includes(provider)) assertEstimated(model, { provider });
      else assert.equal(charge(model, { provider }), undefined);
    }
  }
  assert.equal(charge('gpt-5.4', { provider: 'unassociated-backend' }), undefined);
  assertEstimated('openai/gpt-5.4', { provider: 'copilot' });
  assert.equal(guard.checkModelPricing('perceptron-mk1', 'custom-backend'), null);
  reset();
  assert.equal(guard.getAiCreditsReflectState().total, 0);
  assert.equal(guard.applyAiCreditsUsage({
    input_tokens: 1000000, output_tokens: 1000000,
  }, 'openai/gpt-4o-2024-05-13', 'openrouter').aiCreditsThisResponse, 2000);
  for (const [model, credits] of [
    ['google/gemini-2.5-pro', 37.5], ['google/gemini-3.5-flash', 8.333333],
  ]) {
    assert.equal(guard.applyAiCreditsUsage({
      input_tokens: 1000000, cache_write_tokens: 1000000,
    }, model, 'openrouter').aiCreditsThisResponse, credits);
  }
  assertEstimated('openai/gpt-4-turbo', { provider: 'openrouter' });
  assert.equal(charge('openai/gpt-4-turbo:batch', { provider: 'openrouter' })
    .ai_credits_this_response, 500);
  for (const [model, tokens, credits, tier] of [
    ['gpt-6.1-sol', 271999, 54.3998, 'default'],
    ['gpt-6.1-sol', 272000, 54.4, 'default'],
    ['gpt-6.1-sol', 272001, 108.8004, 'long_context'],
    ['claude-haiku-5-5', 99999, 0.99999, 'default'],
    ['claude-haiku-5-5', 100000, 1, 'default'],
    ['claude-haiku-5-5', 100001, 5.00005, 'long_context'],
  ]) {
    reset();
    chargeHttpAndWebSocket('copilot', model, credits, tokens, tier);
    const usage = charge(model, {}, tokens);
    assert.equal(usage.ai_credits_this_response, credits);
    assert.equal(usage.ai_credits_pricing_tier, tier);
    assert.equal(usage.ai_credits_pricing_source, 'curated');
    assert.equal(usage.ai_credits_pricing_catalog_version, bundledPricing.catalogRevision);
  }
  for (const [model, tokens, credits] of [
    ['openai/gpt-6.1-sol', 272001, 54.4002],
    ['anthropic/claude-haiku-5.5', 100001, 1.00001],
  ]) {
    reset();
    chargeHttpAndWebSocket('openrouter', model, credits, tokens);
    const usage = charge(model, { provider: 'openrouter' }, tokens);
    assert.equal(usage.ai_credits_this_response, credits);
    assert.equal(usage.ai_credits_pricing_tier, 'default');
  }

  reset();
  for (const [provider, model] of [['copilot', 'gpt-5.4'], ['openrouter', 'openai/gpt-5.4']]) {
    const usage = charge(model, { provider, runtimeCatalog: {
      [provider]: [{
        id: model, provider, observedAt: '2026-10-23T00:00:00Z',
        pricing: { default: { input: 3, output: 5 } },
      }],
    } });
    assert.equal(usage.ai_credits_pricing_source, 'provider');
    assert.equal(usage.ai_credits_this_response, 300);
  }

  if (fixtureSources) {
    for (const [model, credits] of [
      ['smoke-a/shared-slug', 200], ['smoke-b/shared-slug', 700],
      ['smoke-a/exact-model', 200], ['smoke-a/exact-model-20260101', 900],
      ['smoke-a/zero-model', 0],
    ]) {
      reset();
      chargeHttpAndWebSocket('openrouter', model, credits);
      if (model === 'smoke-a/exact-model') {
        process.env.AWF_MAX_AI_CREDITS = '400';
        assert.equal(guard.getAiCreditsBlockState().maxExceeded, false);
      }
      assertEstimated(model, { provider: 'copilot' });
      assert.equal(charge('shared-slug', { provider: 'smoke-a' }), undefined);
    }
    reset();
    for (const [model, expected] of [
      ['smoke-a/shared-slug', 0], ['smoke-b/shared-slug', 70], ['smoke-a/null-cache', 20],
    ]) {
      const usage = guard.applyAiCreditsUsage({
        input_tokens: 1000000, cache_read_tokens: 1000000,
      }, model, 'openrouter');
      assert.equal(usage.aiCreditsThisResponse, expected);
    }
    for (const model of ['smoke-a/null-model', 'smoke-a/missing-model', 'smoke_a/shared-slug']) {
      assertEstimated(model, { provider: 'openrouter' });
    }
    assert.throws(() => charge('smoke-a/exact_model-20261212', { provider: 'openrouter' }),
      { code: 'pricing_resolution_error' });
    reset();
    process.env.AWF_MAX_AI_CREDITS = `0.${'0'.repeat(328)}1`;
    assert.equal(charge('smoke-a/underflow-model', { provider: 'openrouter' }).ai_credits_this_response, 0);
    assert.equal(guard.getAiCreditsBlockState().maxExceeded, true);
  }

  reset();
  // Neither override may initialize a lower-priority source.
  const unavailable = {};
  Object.defineProperty(unavailable, 'runtimeCatalog', { enumerable: true, get: denyNetwork });
  process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({ copilot: { models: {
    'smoke-model': { cost: {
      input: 0.000002, output: 0.000004, cache_read: 0,
      long_context: { input: 0.000007, output: 0.000008, cache_read: 0, cache_write: 0, max_prompt_tokens: 100 },
    } },
    'gpt-5.4': { cost: { input: 0.000007, output: 0.000008 } },
  } } });
  assert.equal(charge('gpt-5.4').ai_credits_this_response, 700);
  // Invoke guard directly so the context spread does not evaluate the tripwire.
  for (const tokens of [99, 100, 101]) {
    const usage = guard.applyAiCreditsUsage({ input_tokens: tokens }, 'smoke-model', 'copilot', unavailable);
    assert.equal(usage.pricingSource, 'operator');
    assert.equal(usage.pricingTier, tokens > 100 ? 'long_context' : 'default');
    assert.equal(usage.aiCreditsThisResponse, tokens * (tokens > 100 ? 7 : 2) / 10000);
  }
  delete process.env.AWF_API_PROXY_PROVIDERS;
  process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
    schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', catalogId: 'smoke-config', version: 'v1',
    providers: { openrouter: { models: { 'openai/gpt-5.4': rates } }, copilot: { models: {
      'smoke-model': { ...rates, longContext: { ...rates, input: 7, threshold: 100 } },
    } } },
  });
  assert.equal(charge('openai/gpt-5.4', { provider: 'openrouter' }).ai_credits_this_response, 200);
  for (const tokens of [100, 101]) {
    const usage = guard.applyAiCreditsUsage({ input_tokens: tokens }, 'smoke-model', 'copilot', unavailable);
    assert.equal(usage.pricingSource, 'shared_catalog');
    assert.equal(usage.aiCreditsThisResponse, tokens * (tokens > 100 ? 7 : 2) / 10000);
  }

  reset();
  process.env.AWF_MAX_AI_CREDITS = '300';
  const complete = runtime('smoke-model', rates);
  assert.equal(charge('smoke-model', { runtimeCatalog: complete }).ai_credits_this_response, 200);
  assert.equal(guard.getAiCreditsBlockState().maxExceeded, false);
  const partial = runtime('smoke-model', { input: 3, output: 5 });
  process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify(rates);
  assert.equal(charge('smoke-model', { runtimeCatalog: partial }).ai_credits_this_response, 300);
  assert.equal(guard.getAiCreditsBlockState().maxExceeded, true);
  assert.equal(guard.getAiCreditsReflectState().total, 500);

  reset();
  const zero = charge('smoke-model', {
    runtimeCatalog: runtime('smoke-model', { input: 0, output: 0, cachedInput: 0, cacheWrite: null }),
  });
  assert.equal(zero.ai_credits_this_response, 0);
  assert.equal(zero.ai_credits_pricing_source, 'provider');
  assert.equal(charge('smoke-model', { runtimeCatalog: partial }).ai_credits_pricing_source, 'provider');
  assertEstimated('concrete-unpriced');
  assert.equal(charge('auto').ai_credits_pricing_source, 'dynamic_selector_fallback');
  assert.equal(charge('unknown').ai_credits_pricing_source, 'builtin_fallback');

  // The actual HTTP/WebSocket trackers must charge the exact even-count median,
  // reflect its estimate, and retain sub-projection precision in budget checks.
  for (const [low, blocked] of [
    ['0.999999999999999999999999999997', false], ['1', true],
  ]) {
    reset();
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', catalogId: 'smoke-median', version: 'v1',
      providers: { 'smoke-median': { models: {
        a: { ...rates, input: low }, b: { ...rates, input: '1.000000000000000000000000000001' },
      } } },
    });
    process.env.AWF_MAX_AI_CREDITS = '2';
    chargeHttpAndWebSocket('smoke-median', 'missing', 1, 10000);
    assert.equal(guard.getAiCreditsBlockState().maxExceeded, blocked);
    const reflected = guard.getAiCreditsReflectState().by_model.missing;
    assert.equal(reflected.pricing_source, 'median_estimate');
    assert.equal(reflected.accounting_policy, 'backend_median_estimate');
    assert.equal(reflected.pricing_estimate.donorCount, 2);
    assert.equal(reflected.fallback_pricing_used, true);
    assert.equal(charge('missing', { provider: 'smoke-median' }, 10000)
      .ai_credits_pricing_estimate.basis, 'backend');
  }

  // Both real protocol trackers must retain charges smaller than their public
  // six-place response values, and enforce unrounded budgets/steering.
  reset();
  process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({
    input: '0.0001', output: '0', cachedInput: '0', cacheWrite: null,
  });
  for (let i = 0; i < 500; i++) {
    chargeHttpAndWebSocket('openai', 'exact-smoke', 0, 1, 'default', null);
  }
  assert.equal(guard.getAiCreditsReflectState().total, 0.00001);
  assert.equal(guard.getAiCreditsReflectState().by_model['exact-smoke'].total, 0.00001);
  guard.resetAiCreditsGuardForTests();
  assert.equal(charge('exact-smoke', { provider: 'openai' }, 1000).ai_credits_this_response, 0.00001);
  assert.equal(process.env.AWF_AI_CREDITS_USED, '0.00001');
  for (const [price, blocked] of [
    ['0.999999999999999999999999999999', false],
    ['1', true], ['1.000000000000000000000000000001', true],
  ]) {
    reset();
    process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ ...rates, input: price });
    process.env.AWF_MAX_AI_CREDITS = '2';
    chargeHttpAndWebSocket('openai', 'exact-smoke', 1, 10000);
    assert.equal(guard.getAiCreditsBlockState().maxExceeded, blocked);
  }
  for (const [price, crossed] of [
    ['0.799999999999999999999999999999', false], ['0.8', true],
    ['0.800000000000000000000000000001', true],
  ]) {
    reset();
    process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ ...rates, input: price });
    process.env.AWF_MAX_AI_CREDITS = '2';
    chargeHttpAndWebSocket('openai', 'exact-smoke', 0.8, 10000);
    assert.equal(guard.getAiCreditsReflectState().thresholds_crossed.includes(80), crossed);
  }
  for (const [price, blocked] of [
    ['4999.999999999999999999999999999999', false], ['5000', true],
    ['5000.000000000000000000000000000001', true],
  ]) {
    reset();
    process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ ...rates, input: price });
    chargeHttpAndWebSocket('openai', 'exact-smoke', 5000, 10000);
    assert.equal(guard.getAiCreditsBlockState()?.hardCap === true, blocked);
  }
  for (const [price, rounded] of [
    ['0.004999999999999999999999999999', 0], ['0.005', 0.000001],
    ['0.005000000000000000000000000001', 0.000001],
  ]) {
    reset();
    process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ ...rates, input: price });
    chargeHttpAndWebSocket('openai', 'exact-smoke', rounded, 1, 'default', 0.000001);
  }
  reset();
  process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
    schemaVersion: 1, unit: 'USD_PER_1M_TOKENS', catalogId: 'exact-config', version: 'v1',
    providers: { openai: { models: { 'exact-smoke': {
      input: '0.999999999999999999999999999999', output: '0', reasoning: '0',
      cachedInput: '0', cacheWrite: null,
    } } } },
  });
  process.env.AWF_MAX_AI_CREDITS = '2';
  chargeHttpAndWebSocket('openai', 'exact-smoke', 1, 10000);
  assert.equal(guard.getAiCreditsBlockState().maxExceeded, false);

  reset();
  process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({ openai: { models: {
    'exact-smoke': { cost: {
      input: '0.0000000099999999999999999999999999999', output: '0',
    } },
  } } });
  process.env.AWF_MAX_AI_CREDITS = '0.000002';
  chargeHttpAndWebSocket('openai', 'exact-smoke', 0.000001, 1);
  assert.equal(guard.getAiCreditsBlockState().maxExceeded, false);

  reset();
  process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({
    input: '0.1', cachedInput: '0.02', cacheWrite: '0.03', output: '0.7', reasoning: '0.9',
  });
  chargeHttpAndWebSocket('openai', 'exact-smoke', 0.000646, 10, 'default', 0.001292, {
    completion_tokens: 7,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 4 },
  });

  reset();
  const providerRecords = parseProviderModelMetadata('copilot', { data: [{
    id: 'exact-smoke', billing: { token_prices: { batch_size: '3', default: {
      input_price: '0.1', output_price: '0', cache_read_price: '0', cache_write_price: '0',
    } } },
  }] });
  replaceRuntimeModels('copilot', providerRecords);
  const exactPin = captureRuntimePricing();
  replaceRuntimeModels('copilot', runtime('exact-smoke', rates).copilot);
  process.env.AWF_MAX_AI_CREDITS = '0.2';
  chargeHttpAndWebSocket('copilot', 'exact-smoke', 0.1, 3, 'default', 0.2, {}, { runtimeCatalog: exactPin });
  assert.equal(guard.getAiCreditsBlockState().maxExceeded, true);

  reset();
  let published = first;
  let reads = 0;
  const cacheDirectory = fs.mkdtempSync(path.join(proxyDirectory, 'pricing-smoke-cache-'));
  const loader = createCatalogueLoader({
    source: 'https://fixture.invalid/feed', trustSource: true, cacheDirectory,
  }, {
    now: () => Date.parse('2026-10-23T12:00:00Z'), report: log,
    getBytes: async () => { reads++; return JSON.stringify(published); },
  });
  try {
    await loader.start();
    const pinned = loader.capture();
    const model = pinned.snapshot.models[0].identity.rawId;
    published = next;
    await loader.refresh();
    const beforeUsageReads = reads;
    assert.equal(charge(model, { catalogue: pinned, runtimeCatalog: {} }).ai_credits_this_response, 200);
    assert.equal(charge(model, { catalogue: loader.capture(), runtimeCatalog: {} }).ai_credits_this_response, 400);
    assert.equal(charge(model, { catalogue: pinned }).ai_credits_pricing_catalog_version, pinned.revision);
    reset();
    const familyPin = { ...pinned, snapshot: structuredClone(pinned.snapshot) };
    const familyDonor = familyPin.snapshot.models[0];
    familyDonor.identity.family = 'smoke-family';
    const secondDonor = structuredClone(familyDonor);
    secondDonor.identity = { ...secondDonor.identity, rawId: 'median-second',
      lookupId: 'median-second', key: 'copilot/median-second' };
    secondDonor.tariffs[0].components.input.price = '4';
    const missing = structuredClone(secondDonor);
    missing.identity = { ...missing.identity, rawId: 'median-missing',
      lookupId: 'median-missing', key: 'copilot/median-missing' };
    missing.tariffs = [];
    familyPin.snapshot.models.push(secondDonor, missing);
    chargeHttpAndWebSocket('copilot', 'median-missing', 300, 1000000, 'default', 600, {}, {
      catalogue: familyPin, runtimeCatalog: {},
    });
    const familyEstimate = guard.getAiCreditsReflectState().by_model['median-missing'];
    assert.equal(familyEstimate.accounting_policy, 'family_median_estimate');
    assert.equal(familyEstimate.pricing_estimate.donorCount, 2);
    const decimalPin = { ...pinned, snapshot: structuredClone(pinned.snapshot) };
    decimalPin.snapshot.models[0].tariffs[0].components.input.price = '0.999999999999999999999999999999';
    reset();
    process.env.AWF_MAX_AI_CREDITS = '2';
    chargeHttpAndWebSocket('copilot', model, 1, 10000, 'default', 2, {}, {
      catalogue: decimalPin, runtimeCatalog: {},
    });
    assert.equal(guard.getAiCreditsBlockState().maxExceeded, false);
    process.env.COPILOT_PROVIDER_API_KEY = 'provider-free-fixture';
    assert.notEqual(charge(model, { catalogue: pinned })?.ai_credits_pricing_source, 'central_feed');
    delete process.env.COPILOT_PROVIDER_API_KEY;
    assert.equal(reads, beforeUsageReads);
    assert.equal(charge('perceptron/perceptron-mk1', {
      provider: 'openrouter', catalogue: pinned,
    }).ai_credits_this_response, 15);
    assert.equal(charge('perceptron/perceptron-mk1', {
      provider: 'openrouter', catalogue: loader.capture(),
    }).ai_credits_this_response, 15);

    reset();
    const metrics = { increment: log, observe: log, gauge: log };
    const onUsage = (usage, reportedModel) => computeTokenBudgetUsage({
      ...context, catalogue: pinned, runtimeCatalog: {},
    }, usage, reportedModel);
    const upstream = new EventEmitter();
    upstream.headers = { 'content-type': 'application/json' };
    upstream.statusCode = 200;
    trackTokenUsage(upstream, {
      requestId: 'smoke-http', provider: 'copilot', path: '/chat/completions',
      startTime: Date.now(), metrics, onUsage,
    });
    upstream.emit('data', Buffer.from(JSON.stringify({
      model, usage: { prompt_tokens: 1000000, completion_tokens: 0, total_tokens: 1000000 },
    })));
    upstream.emit('end');
    assert.equal(guard.getAiCreditsReflectState().total, 200);
    const socket = new EventEmitter();
    trackWebSocketTokenUsage(socket, {
      requestId: 'smoke-ws', provider: 'copilot', path: '/responses',
      startTime: Date.now(), metrics, onUsage, requestModel: model,
    });
    const payload = Buffer.from(JSON.stringify({
      model, usage: { prompt_tokens: 1000000, completion_tokens: 0, total_tokens: 1000000 },
    }));
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    socket.emit('data', Buffer.concat([
      Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'), header, payload,
    ]));
    socket.emit('end');
    socket.emit('close');
    assert.equal(guard.getAiCreditsReflectState().total, 400);
    assert.equal(reads, beforeUsageReads);

    replaceRuntimeModels('copilot', complete.copilot);
    const runtimePin = captureRuntimePricing();
    replaceRuntimeModels('copilot', runtime('smoke-model', { ...rates, input: 9 }).copilot);
    assert.equal(charge('smoke-model', { runtimeCatalog: runtimePin }).ai_credits_this_response, 200);
    assert.equal(charge('smoke-model').ai_credits_this_response, 900);
  } finally {
    await loader.stop();
    await closeLogStream();
    fs.rmSync(cacheDirectory, { recursive: true, force: true });
  }

  // Invalid selected prices are errors, never legacy fallback or fabricated
  // free usage. The same guard descriptor protects HTTP and WebSocket dispatch.
  reset();
  process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ ...rates, input: -1 });
  assert.throws(() => charge('invalid-tariff'), { code: 'pricing_resolution_error' });
  guard.resetAiCreditsGuardForTests();
  const failingResponse = new EventEmitter();
  failingResponse.headers = { 'content-type': 'application/json' };
  failingResponse.statusCode = 200;
  trackTokenUsage(failingResponse, {
    requestId: 'smoke-http-accounting-failure', provider: 'copilot', path: '/chat/completions',
    startTime: Date.now(), metrics: { increment: log, observe: log, gauge: log },
    onUsage: (usage, model) => computeTokenBudgetUsage(context, usage, model),
  });
  failingResponse.emit('data', Buffer.from(JSON.stringify({
    model: 'invalid-tariff', usage: { prompt_tokens: 1000000, completion_tokens: 0, total_tokens: 1000000 },
  })));
  failingResponse.emit('end');
  assert.equal(guard.getAiCreditsReflectState().total, 0);
  assert.equal(guard.getAiCreditsReflectState().pricing_error, 'pricing_resolution_error');
  delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
  guard.resetAiCreditsGuardForTests();
  replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', { data: [{
    id: 'invalid-tariff', billing: { token_prices: {
      batch_size: 1, default: { input_price: '1e999', output_price: '0' },
    } },
  }] }));
  const failingSocket = new EventEmitter();
  trackWebSocketTokenUsage(failingSocket, {
    requestId: 'smoke-ws-accounting-failure', provider: 'copilot', path: '/responses',
    requestModel: 'invalid-tariff', startTime: Date.now(),
    metrics: { increment: log, observe: log, gauge: log },
    onUsage: (usage, model) => computeTokenBudgetUsage(context, usage, model),
  });
  const failingPayload = Buffer.from(JSON.stringify({
    model: 'invalid-tariff', usage: { prompt_tokens: 1, completion_tokens: 0 },
  }));
  const failingHeader = Buffer.alloc(4);
  failingHeader[0] = 0x81;
  failingHeader[1] = 126;
  failingHeader.writeUInt16BE(failingPayload.length, 2);
  failingSocket.emit('data', Buffer.concat([
    Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'), failingHeader, failingPayload,
  ]));
  failingSocket.emit('end');
  failingSocket.emit('close');
  assert.equal(guard.getAiCreditsReflectState().pricing_error, 'pricing_resolution_error');
  assert.equal(guard.getAiCreditsReflectState().total, 0);
  const deps = Object.fromEntries([
    'getMaxRunsBlockState', 'getMaxCacheMissesBlockState', 'getPermissionDeniedBlockState',
    'getAiCreditsBlockState', 'getModelMultiplierCapBlockState', 'getRetiredModelBlockState',
    'getModelPolicyBlockState',
  ].map(name => [name, () => null]));
  deps.checkModelPricing = guard.checkModelPricing;
  const failure = buildCommonGuardChecks(deps, 'gpt-5-mini', 'copilot')
    .find(check => check.eventName === 'pricing_resolution_error');
  assert.equal(failure.isBlocked(failure.block), true);
  assert.equal(failure.statusCode, 500);
  let response = '';
  let destroyed = false;
  assert.equal(enforceWebSocketGuards({
    socket: { write: text => { response += text; }, destroy: () => { destroyed = true; } },
    logRequest: log, requestId: 'smoke-ws-failure', provider: 'copilot', requestModel: 'gpt-5-mini',
  }, deps), true);
  assert.match(response, /500 Internal Server Error/);
  assert.match(response, /pricing_resolution_error/);
  assert.equal(destroyed, true);
  await closeLogStream();
  const records = fs.readFileSync(load('token-tracker').TOKEN_LOG_FILE, 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  for (const [model, basis, count] of [['missing', 'backend', 4], ['median-missing', 'family', 2]]) {
    const estimated = records.filter(record => record.request_id === `smoke-source-${process.pid}` &&
      record.model === model &&
      record.ai_credits_pricing_source === 'median_estimate');
    assert.equal(estimated.length, count);
    assert.deepEqual([...new Set(estimated.map(record => record.path))].sort(),
      ['/chat/completions', '/responses']);
    for (const record of estimated) {
      assert.equal(record.ai_credits_pricing_estimate.basis, basis);
      assert.equal(record.ai_credits_pricing_estimate.donorCount, 2);
      assert.match(record.ai_credits_pricing_estimate.tariffFingerprint, /^[a-f0-9]{64}$/);
    }
  }
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ event: 'pricing_resolution_smoke_passed', networkCalls }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
