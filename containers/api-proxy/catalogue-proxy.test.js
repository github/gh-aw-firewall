'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { createCatalogueLoader } = require('./catalogue-loader');
const { buildSnapshot } = require('./catalogue-contract/publication.cjs');
const { createProviderServer } = require('./server-factory');
const { setupTokenTracking } = require('./upstream-token');
const { bootPrimary } = require('./startup');
const { createWebSocketTunnel } = require('./websocket-tunnel');
const { collectLogOutput } = require('./test-helpers/log-test-helpers');
const { resetAiCreditsGuardForTests } = require('./guards/ai-credits-guard');
const baseline = require('../../shared/model-information/catalog.generated.json');

function canonicalPricingFixture(directory) {
  const root = path.join(__dirname, '../..');
  const source = path.join(directory, 'fixture-source');
  for (const folder of ['scripts/model-information', 'shared/model-information']) {
    fs.cpSync(path.join(root, folder), path.join(source, folder), { recursive: true });
  }
  const legacyPricingPath = path.join(source, 'containers/api-proxy');
  fs.mkdirSync(legacyPricingPath, { recursive: true });
  fs.copyFileSync(path.join(root, 'containers/api-proxy/ai-credits-pricing.js'),
    path.join(legacyPricingPath, 'ai-credits-pricing.js'));
  const maintainedPath = path.join(source, 'shared/model-information/sources/copilot-main.json');
  const maintained = JSON.parse(fs.readFileSync(maintainedPath, 'utf8'));
  maintained.models.find(model => model.identity.rawId === 'gpt-5-mini')
    .tariffs[0].components.input.price = '0.749999999999999999999999999999';
  fs.writeFileSync(maintainedPath, JSON.stringify(maintained));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(source, 'node_modules'), 'dir');
  const catalog = structuredClone(require('./models.dev.catalog.json'));
  const entry = (id, prompt, completion, extra = {}) => ({
    id, pricing: { prompt, completion, ...extra },
  });
  catalog.data.push(
    entry('smoke-a/shared-slug', '0.000002', '0.000004', { input_cache_read: '0' }),
    entry('smoke-b/shared-slug', '0.000007', '0.000008'),
    entry('smoke-a/exact-model', '0.000001999999999999999999999999999999', '0.000004'),
    entry('smoke-a/exact-model-20260101', '0.000009', '0.000004'),
    entry('smoke-a/zero-model', '0', '0', { input_cache_read: '0', input_cache_write: '0' }),
    entry('smoke-a/null-model', null, '0.000004'),
    entry('smoke-a/missing-model', undefined, '0.000004'),
    entry('smoke-a/null-cache', '0.000002', '0.000004', { input_cache_read: null }),
    entry('smoke-a/underflow-model', `0.${'0'.repeat(330)}1`, '0.000004'),
  );
  if (catalog.total_count !== undefined) catalog.total_count = catalog.data.length;
  const bytes = JSON.stringify(catalog);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const catalogPath = path.join(source, 'containers/api-proxy/models.dev.catalog.json');
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, bytes);
  const metadataPath = path.join(source, 'shared/model-information/imported/legacy-models-dev.metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, revision: hash, sha256: hash }));
  const compiled = spawnSync(process.execPath, [path.join(source, 'scripts/model-information/compile.cjs')], {
    cwd: source, encoding: 'utf8',
  });
  if (compiled.status !== 0) throw new Error(compiled.stderr);
  return path.join(source, 'containers/api-proxy');
}

function snapshot(price = '2') {
  const data = structuredClone(baseline);
  data.models = [data.models.find(model => model.tariffs?.length)];
  data.models[0].tariffs[0].components.input.price = price;
  return JSON.parse(buildSnapshot(data, 'a'.repeat(40), '2026-10-22T00:00:00Z'));
}

test('HTTP and WebSocket dispatch wait for bounded initial catalogue resolution', async () => {
  let ready;
  const catalogueReady = new Promise(resolve => { ready = resolve; });
  const proxyRequest = jest.fn();
  const proxyWebSocket = jest.fn();
  const adapter = {
    name: 'copilot', isEnabled: () => true, getTargetHost: () => 'api.githubcopilot.com',
    getAuthHeaders: () => ({}), getBasePath: () => '', getBodyTransform: () => null,
  };
  const server = createProviderServer(adapter, {
    handleManagementEndpoint: () => false, reflectEndpoints: () => [],
    checkRateLimit: () => false, proxyRequest, proxyWebSocket, catalogueReady,
  });
  const req = { headers: {}, url: '/chat/completions', method: 'POST' };
  const socket = new EventEmitter();
  socket.destroy = jest.fn();
  server.emit('request', req, {});
  server.emit('upgrade', req, socket, Buffer.alloc(0));
  expect(proxyRequest).not.toHaveBeenCalled();
  expect(proxyWebSocket).not.toHaveBeenCalled();
  ready();
  await catalogueReady;
  expect(proxyRequest).toHaveBeenCalledTimes(1);
  expect(proxyWebSocket).toHaveBeenCalledTimes(1);
  await server.shutdownConnections();
});

test('actual upstream usage callback retains request revision across refresh and expiry', async () => {
  let current = snapshot();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-catalogue-proxy-'));
  const loader = createCatalogueLoader({
    source: 'https://mirror.invalid/feed', trustSource: true, cacheDirectory: directory,
  }, { now: () => Date.parse('2026-10-23T12:00:00Z'),
    getBytes: async () => JSON.stringify(current), report: jest.fn() });
  try {
    await loader.start();
    const req = { url: '/chat/completions', awfCatalogue: loader.capture(), awfRuntimePricing: {} };
    let tracking;
    const otel = { setTokenAttributes: jest.fn(), setBudgetAttributes: jest.fn(), endSpan: jest.fn() };
    setupTokenTracking({}, Buffer.from(JSON.stringify({ model: current.models[0].identity.rawId })), {
      requestId: 'fixture', provider: 'copilot', req, res: {}, startTime: 0, billingInfo: {},
      trackTokenUsage: (_response, options) => { tracking = options; },
      sanitizeForLog: value => value, metrics: {}, otel, logRequest: jest.fn(),
    });
    const oldRevision = current.revision;
    current = snapshot('4');
    await loader.refresh();
    const usage = tracking.onUsage({ input_tokens: 1_000_000 }, current.models[0].identity.rawId);
    expect(usage).toMatchObject({
      ai_credits_this_response: 200, ai_credits_pricing_source: 'central_feed',
      ai_credits_pricing_catalog_version: oldRevision,
    });
    expect(loader.capture().revision).not.toBe(oldRevision);
  } finally {
    await loader.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('real WebSocket usage callback retains captured feed revision without extra egress or duplicate billing', async () => {
  resetAiCreditsGuardForTests();
  let current = snapshot();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-catalogue-websocket-'));
  const getBytes = jest.fn(async () => JSON.stringify(current));
  const loader = createCatalogueLoader({
    source: 'https://mirror.invalid/feed', trustSource: true, cacheDirectory: directory,
  }, { now: () => Date.parse('2026-10-23T12:00:00Z'), getBytes, report: jest.fn() });
  const connectRequest = new EventEmitter();
  connectRequest.end = jest.fn();
  const request = jest.spyOn(http, 'request').mockReturnValue(connectRequest);
  const logs = collectLogOutput();
  try {
    await loader.start();
    const pinned = loader.capture();
    const req = {
      url: '/responses?model=opaque', headers: {},
      awfCatalogue: pinned, awfRuntimePricing: {},
    };
    const socket = () => Object.assign(new EventEmitter(), {
      write: jest.fn(), pipe: jest.fn(), destroy: jest.fn(), writable: true,
    });
    const trackWebSocketTokenUsage = jest.fn();
    createWebSocketTunnel({
      HTTPS_PROXY: 'http://squid:3128',
      metrics: { gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() },
      logRequest: jest.fn(), sanitizeForLog: String, shouldStripHeader: () => false,
      trackWebSocketTokenUsage,
    })({
      req, socket: socket(), head: Buffer.alloc(0), targetHost: 'api.githubcopilot.com',
      targetScheme: 'http', injectHeaders: {}, provider: 'copilot',
      requestId: 'ws-pin', startTime: 0, upstreamPath: req.url,
    });
    connectRequest.emit('connect', { statusCode: 200 }, socket());
    expect(trackWebSocketTokenUsage).toHaveBeenCalledTimes(1);
    current = snapshot('9');
    await loader.refresh();
    const beforeUsageRequests = getBytes.mock.calls.length;
    const usage = trackWebSocketTokenUsage.mock.calls[0][1].onUsage(
      { input_tokens: 1000000 }, pinned.snapshot.models[0].identity.rawId,
    );
    expect(usage).toMatchObject({
      ai_credits_this_response: 200, ai_credits_total: 200,
      ai_credits_pricing_source: 'central_feed',
      ai_credits_pricing_catalog_version: pinned.revision,
    });
    expect(loader.capture().revision).not.toBe(pinned.revision);
    expect(getBytes).toHaveBeenCalledTimes(beforeUsageRequests);
    expect(request).toHaveBeenCalledTimes(1);
    expect(logs.lines.filter(line => line.event === 'pricing_resolution_error')).toEqual([]);
  } finally {
    request.mockRestore();
    logs.spy.mockRestore();
    resetAiCreditsGuardForTests();
    await loader.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('startup shares readiness with every adapter and drains the loader before exit', async () => {
  const handlers = {};
  const on = jest.spyOn(process, 'on').mockImplementation((event, handler) => {
    handlers[event] = handler;
    return process;
  });
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => {});
  const ready = Promise.resolve();
  const catalogue = { start: jest.fn(() => ready), stop: jest.fn().mockResolvedValue() };
  const create = jest.fn(() => ({
    listen: jest.fn(), close: callback => callback(), shutdownConnections: async () => {},
  }));
  try {
    bootPrimary({
      registeredAdapters: [{ name: 'copilot', alwaysBind: true, isEnabled: () => true }],
      createProviderServer: create, catalogue,
      logRequest: jest.fn(), closeLogStream: jest.fn(), otelShutdown: jest.fn(),
    });
    expect(create.mock.calls[0][1]).toBe(ready);
    await handlers.SIGTERM();
    expect(catalogue.stop).toHaveBeenCalledTimes(1);
    expect(catalogue.stop.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
  } finally {
    on.mockRestore();
    exit.mockRestore();
  }
});

test.each(['docker', 'npm'])('provider-free pricing smoke runs in the %s package without repository source paths', distribution => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-catalogue-package-'));
  try {
    let proxyDirectory = directory;
    if (distribution === 'docker') {
      const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8').replace(/\\\n\s*/g, ' ');
      const application = [...dockerfile.matchAll(/^COPY (.+) \.\/$/gm)]
        .flatMap(match => match[1].split(/\s+/)).filter(file => !file.includes('*'));
      for (const file of application) fs.copyFileSync(path.join(__dirname, file), path.join(directory, file));
      for (const folder of ['guards', 'providers', 'transforms', 'catalogue-contract']) {
        expect(dockerfile).toContain(`COPY ${folder}/ ./${folder}/`);
        fs.cpSync(path.join(__dirname, folder), path.join(directory, folder), { recursive: true });
      }
    } else {
      const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
        cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 30000,
      });
      expect(packed.status).toBe(0);
      const archive = path.join(directory, JSON.parse(packed.stdout)[0].filename);
      const extracted = spawnSync('tar', ['-xzf', archive, '-C', directory], { encoding: 'utf8' });
      expect(extracted.status).toBe(0);
      proxyDirectory = path.join(directory, 'package/containers/api-proxy');
    }
    fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(proxyDirectory, 'node_modules'), 'dir');
    for (const fixtures of [false, true]) {
      if (fixtures) {
        const generated = canonicalPricingFixture(directory);
        for (const file of ['model-information.pricing.generated.json',
          'model-information.fallback-pricing.generated.json']) {
          fs.copyFileSync(path.join(generated, file), path.join(proxyDirectory, file));
        }
      }
      const result = spawnSync(process.execPath, [
        path.join(__dirname, '../../scripts/ci/smoke-pricing-resolution.cjs'), proxyDirectory,
      ], { cwd: proxyDirectory, encoding: 'utf8', env: {
        PATH: process.env.PATH,
        AWF_VERSION: '0.0.0-smoke', AWF_TOKEN_LOG_DIR: directory,
        AWF_PRICING_SMOKE_IMPORT_FIXTURES: String(fixtures),
        AWF_PRICING_SMOKE_SNAPSHOTS: JSON.stringify([snapshot(), snapshot('4')]),
      }, maxBuffer: 8 * 1024 * 1024 });
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('"event":"pricing_resolution_smoke_passed"');
      expect(result.status).toBe(0);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
