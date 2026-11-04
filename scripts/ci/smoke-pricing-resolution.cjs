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
const { replaceRuntimeModels, clearRuntimeModels, captureRuntimePricing } = load('runtime-model-catalog');
const { trackTokenUsage, trackWebSocketTokenUsage, closeLogStream } = load('token-tracker');
const bundledPricing = load('model-information.fallback-pricing.generated.json');
const maintainedPricing = load('model-information.pricing.generated.json');
const [first, next] = JSON.parse(process.env.AWF_PRICING_SMOKE_SNAPSHOTS);
const rates = { input: 2, output: 4, cachedInput: 0, cacheWrite: null, reasoning: 0 };
const log = () => {};
const context = { provider: 'copilot', catalogue: null, requestId: 'smoke', logRequest: log };
const charge = (model, options = {}, tokens = 1000000) =>
  computeTokenBudgetUsage({ ...context, ...options }, { input_tokens: tokens }, model);
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

function chargeHttpAndWebSocket(provider, model, expectedCredits, tokens = 1000000, tier = 'default') {
  const observed = [];
  const tiers = [];
  const options = {
    requestId: 'smoke-source', provider, path: '/chat/completions',
    startTime: Date.now(), metrics: { increment: log, observe: log, gauge: log },
    requestModel: model,
    onUsage: (usage, reportedModel) => {
      const result = computeTokenBudgetUsage({ ...context, provider }, usage, reportedModel);
      observed.push(result.ai_credits_this_response);
      tiers.push(result.ai_credits_pricing_tier);
      return result;
    },
  };
  const payload = Buffer.from(JSON.stringify({
    model, usage: { prompt_tokens: tokens, completion_tokens: 0, total_tokens: tokens },
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
  assert.equal(guard.getAiCreditsReflectState().total, expectedCredits * 2);
}

async function main() {
  reset();
  const fixtureSources = process.env.AWF_PRICING_SMOKE_IMPORT_FIXTURES === 'true';
  assert.equal(Object.keys(maintainedPricing).length, 42);
  assert.equal(Object.values(bundledPricing.compatibility.providers)
    .reduce((count, models) => count + Object.keys(models).length, 0), 16);
  assert.equal(bundledPricing.compatibility.policy, 'legacy_native_compatibility');
  for (const [provider, model, credits] of [
    ['copilot', 'gpt-5.4', 250],
    ['copilot', 'gpt-5-mini', fixtureSources ? 75 : 25],
    ['openai', 'gpt-5-mini', fixtureSources ? 75 : 25],
    ['openai', 'gpt-5.4', 250],
    ['openrouter', 'openai/gpt-5.4', 250],
    ['openrouter', 'perceptron/perceptron-mk1', 15],
    ['openrouter', 'openai/gpt-4o-2024-05-13', 500],
    ['openrouter', 'google/gemma-4-31b-it:free', 0],
    ['copilot', 'text-embedding-3-small', 2],
  ]) {
    reset();
    chargeHttpAndWebSocket(provider, model, credits);
  }
  reset();
  process.env.AWF_MAX_AI_CREDITS = '500';
  chargeHttpAndWebSocket('copilot', 'gpt-5.4', 250);
  assert.equal(guard.getAiCreditsBlockState().maxExceeded, true);
  reset();
  for (const provider of ['copilot', 'openai', 'perceptron', 'custom-backend', undefined]) {
    assert.equal(charge('perceptron/perceptron-mk1', { provider }), undefined);
    assert.equal(charge('perceptron-mk1', { provider }), undefined);
  }
  assert.equal(charge('gpt-5.4', { provider: 'unassociated-backend' }), undefined);
  assert.equal(charge('openai/gpt-5.4', { provider: 'copilot' }), undefined);
  assert.equal(guard.checkModelPricing('perceptron-mk1', 'custom-backend'), null);
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
  assert.equal(charge('openai/gpt-4-turbo', { provider: 'openrouter' }), undefined);
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
      assert.equal(charge(model, { provider: 'copilot' }), undefined);
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
      assert.equal(charge(model, { provider: 'openrouter' }), undefined);
    }
    assert.throws(() => charge('smoke-a/exact_model-20261212', { provider: 'openrouter' }),
      { code: 'pricing_resolution_error' });
    assert.throws(() => charge('smoke-a/underflow-model', { provider: 'openrouter' }),
      { code: 'pricing_resolution_error' });
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
  assert.equal(charge('smoke-model', { runtimeCatalog: partial }), undefined);
  assert.equal(guard.getAiCreditsReflectState().total, 0);
  assert.equal(charge('concrete-unpriced'), undefined);
  assert.equal(charge('auto').ai_credits_pricing_source, 'dynamic_selector_fallback');
  assert.equal(charge('unknown').ai_credits_pricing_source, 'builtin_fallback');

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
    closeLogStream();
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
  closeLogStream();
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ event: 'pricing_resolution_smoke_passed', networkCalls }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
