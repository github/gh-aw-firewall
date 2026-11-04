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

async function main() {
  reset();
  // Neither override may initialize a lower-priority source.
  const unavailable = {};
  Object.defineProperty(unavailable, 'runtimeCatalog', { enumerable: true, get: denyNetwork });
  process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({ copilot: { models: {
    'smoke-model': { cost: {
      input: 0.000002, output: 0.000004, cache_read: 0,
      long_context: { input: 0.000007, output: 0.000008, cache_read: 0, cache_write: 0, max_prompt_tokens: 100 },
    } },
  } } });
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
    providers: { copilot: { models: {
      'smoke-model': { ...rates, longContext: { ...rates, input: 7, threshold: 100 } },
    } } },
  });
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
