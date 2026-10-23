'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createCatalogueLoader } = require('./catalogue-loader');
const { buildSnapshot } = require('./catalogue-contract/publication.cjs');
const { createProviderServer } = require('./server-factory');
const { setupTokenTracking } = require('./upstream-token');
const { bootPrimary } = require('./startup');
const baseline = require('../../shared/model-information/catalog.generated.json');

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

test('Docker app/package context includes validators and runs without repository source paths', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-catalogue-package-'));
  try {
    const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8').replace(/\\\n\s*/g, ' ');
    const application = [...dockerfile.matchAll(/^COPY (.+) \.\/$/gm)]
      .flatMap(match => match[1].split(/\s+/)).filter(file => !file.includes('*'));
    for (const file of application) fs.copyFileSync(path.join(__dirname, file), path.join(directory, file));
    for (const folder of ['guards', 'providers', 'transforms', 'catalogue-contract']) {
      expect(dockerfile).toContain(`COPY ${folder}/ ./${folder}/`);
      fs.cpSync(path.join(__dirname, folder), path.join(directory, folder), { recursive: true });
    }
    fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    const result = spawnSync(process.execPath, ['-e', `
      const { createCatalogueLoader, optionsFromEnv } = require('./catalogue-loader');
      const { computeTokenBudgetUsage } = require('./token-budget-log');
      (async () => {
        const loader = createCatalogueLoader(optionsFromEnv(), {
          now: () => Date.parse('2026-10-23T12:00:00Z'), report: () => {},
          getBytes: () => { throw new Error('local mode made a network request'); }
        });
        await loader.start();
        if (!loader.capture()) throw new Error('no active local catalogue');
        const model = loader.capture().snapshot.models[0].identity.rawId;
        const result = computeTokenBudgetUsage({
          logRequest: () => {}, requestId: 'package', provider: 'copilot', catalogue: loader.capture()
        }, { input_tokens: 1000000 }, model);
        if (result.ai_credits_pricing_source !== 'central_feed' ||
            result.ai_credits_this_response !== 200) throw new Error('incorrect package accounting');
        await loader.stop();
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: directory, encoding: 'utf8', env: {
      PATH: process.env.PATH,
      AWF_MODEL_CATALOGUE: JSON.stringify({ trustSource: true, localSnapshot: snapshot() }),
    } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
