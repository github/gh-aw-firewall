'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  adaptiveJob,
  createAdaptivePrice,
  createProductionRoutingController,
  createProductionRoutingSession,
  createRoutingObserver,
  loadAdaptiveInput,
  loadRoutingConversation,
  readPrivateRoutingJson,
} = require('./routing-runtime');

function makeOutputDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-out-'));
}

const SELECTION = Object.freeze({
  schema: 'awf-routing-selection/v1',
  engine: 'copilot',
  provider: 'copilot',
  choice: { id: 'choice-0001', model: 'gpt-5', effort: 'medium' },
  wire_model: 'gpt-5',
});

function controllerReturning(result) {
  return () => ({ run: () => Promise.resolve(Object.freeze(result)) });
}

function readResult(outputDir, name) {
  return JSON.parse(fs.readFileSync(path.join(outputDir, name), 'utf8'));
}

describe('readPrivateRoutingJson', () => {
  test('parses a bounded private file', () => {
    const dir = makeOutputDir();
    const file = path.join(dir, 'conversation.json');
    fs.writeFileSync(file, JSON.stringify({ messages: [] }));
    expect(readPrivateRoutingJson(file)).toEqual({ messages: [] });
  });

  test('rejects a file larger than its bound', () => {
    const dir = makeOutputDir();
    const file = path.join(dir, 'conversation.json');
    fs.writeFileSync(file, JSON.stringify({ padding: 'x'.repeat(64) }));
    expect(() => readPrivateRoutingJson(file, 16)).toThrow(/Invalid private routing file/);
  });

  test('refuses to follow a symlink', () => {
    const dir = makeOutputDir();
    const target = path.join(dir, 'target.json');
    const link = path.join(dir, 'link.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, link);
    expect(() => readPrivateRoutingJson(link)).toThrow();
  });
});

describe('adaptive input', () => {
  const env = {
    GITHUB_WORKFLOW_REF: 'octo/repo/.github/workflows/pr-sous-chef.lock.yml@refs/heads/main',
    GITHUB_RUN_ID: '45000000812',
    GITHUB_RUN_ATTEMPT: '2',
  };

  test('names the job AWF runs in, as gh-aw names its workflow', () => {
    expect(adaptiveJob(env)).toEqual({ workflow: 'pr-sous-chef', run_id: '45000000812', attempt: 2 });
    expect(adaptiveJob({ GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/ci.yml@refs/heads/main', GITHUB_RUN_ID: '7' }))
      .toEqual({ workflow: 'ci', run_id: '7', attempt: 1 });
    expect(adaptiveJob({})).toEqual({ workflow: '', run_id: '', attempt: 1 });
  });

  test.each([
    [{ status: 'present', summary: { v: 2 } }, { v: 2 }],
    [{ status: 'missing' }, null],
    [{ status: 'invalid' }, 'invalid'],
    [{ status: 'present' }, 'invalid'],
    // A file holding JSON null exists, so it is invalid evidence rather than a missing summary.
    [{ status: 'present', summary: null }, 'invalid'],
    [['not', 'an', 'envelope'], 'invalid'],
  ])('reads the staged envelope %j', (envelope, summary) => {
    const file = path.join(makeOutputDir(), 'adaptive-summary.json');
    fs.writeFileSync(file, JSON.stringify(envelope));
    expect(loadAdaptiveInput(file, env)).toEqual({ job: adaptiveJob(env), summary });
  });

  test('treats an unstaged or unreadable copy as invalid evidence', () => {
    const dir = makeOutputDir();
    expect(loadAdaptiveInput(path.join(dir, 'absent.json'), env).summary).toBe('invalid');
    const file = path.join(dir, 'garbled.json');
    fs.writeFileSync(file, '{');
    expect(loadAdaptiveInput(file, env).summary).toBe('invalid');
  });
});

describe('createAdaptivePrice', () => {
  const mapping = { wireModel: 'model-b', provider: 'copilot' };
  const tokens = { input: 1_000_000, cache_read: 2_000_000, cache_write: 100_000, output: 400_000, reasoning: 100_000 };
  const tariff = { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 8 };

  test('prices a run at the model\'s own base tariff with the meter\'s semantics', () => {
    const resolve = jest.fn(() => ({ source: 'provider', pricing: tariff }));
    // $2 + $0.40 + $0.25 + $3.20 = $5.85 = 585 credits; reasoning without its own rate is output.
    expect(createAdaptivePrice(resolve)(mapping, tokens)).toBeCloseTo(585, 9);
    expect(resolve).toHaveBeenCalledWith('model-b', undefined, 'copilot', 0, { quiet: true, allowMedianEstimate: false });
    const reasoningRate = jest.fn(() => ({ source: 'curated', pricing: { ...tariff, reasoning: 16 } }));
    expect(createAdaptivePrice(reasoningRate)(mapping, tokens)).toBeCloseTo(585 + 0.1 * 8 * 100, 9);
    const noReasoningTokens = createAdaptivePrice(reasoningRate)(mapping, { ...tokens, reasoning: null });
    expect(noReasoningTokens).toBeCloseTo(585, 9);
  });

  test.each([
    ['no tariff', () => null],
    ['a median estimate', () => ({ source: 'provider', estimate: { basis: 'median' }, pricing: tariff })],
    ['a fallback price', () => ({ source: 'provider', usedFallbackPricing: true, pricing: tariff })],
    ...['dynamic_selector_fallback', 'configured_default', 'median_estimate', 'builtin_fallback']
      .map(source => [source, () => ({ source, pricing: tariff })]),
    ['a tariff without an output rate', () => ({ source: 'provider', pricing: { ...tariff, output: null } })],
    ['a resolver failure', () => { throw new Error('pricing_resolution_error'); }],
  ])('gives no estimate from %s', (_name, resolve) => {
    expect(createAdaptivePrice(resolve)(mapping, tokens)).toBeNull();
  });

  test('refuses a component a partial tariff filled from a fallback, unless the run used none of it', () => {
    const sources = { input: 'provider', cachedInput: 'configured_default', cacheWrite: 'provider', output: 'provider' };
    const resolve = () => ({
      source: 'provider',
      pricing: tariff,
      componentSources: Object.fromEntries(Object.entries(sources).map(([field, source]) => [field, { source }])),
    });
    expect(createAdaptivePrice(resolve)(mapping, tokens)).toBeNull();
    // $2 + $0.25 + $3.20 = $5.45 = 545 credits with no cache reads to price.
    expect(createAdaptivePrice(resolve)(mapping, { ...tokens, cache_read: 0 })).toBeCloseTo(545, 9);
  });

  describe('cache_write repricing', () => {
    const { resolveModelPricing, resetAiCreditsGuardForTests } = require('./guards/ai-credits-guard');
    const { clearRuntimeModels, replaceRuntimeModels, parseProviderModelMetadata } = require('./runtime-model-catalog');
    const { resetProviderPricingOverlaysForTests } = require('./provider-pricing-overlays');
    const { resetModelPricingCatalogForTests } = require('./model-pricing-catalog');
    const { buildSnapshot, validateSnapshot } = require('./catalogue-contract/publication.v2.cjs');
    const canonicalCatalog = require('../../shared/model-information/catalog.generated.json');
    const claudeTokens = { input: 500, cache_read: 300_000, cache_write: 100_000, output: 5_000, reasoning: null };
    const noCacheWriteTokens = { ...claudeTokens, cache_write: 0 };
    let originalEnv;

    beforeEach(() => {
      originalEnv = { ...process.env };
      delete process.env.AWF_API_PROXY_PROVIDERS;
      delete process.env.AWF_MODEL_PRICING_CATALOG;
      delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
      resetAiCreditsGuardForTests();
      resetProviderPricingOverlaysForTests();
      resetModelPricingCatalogForTests();
      clearRuntimeModels();
    });

    afterEach(() => {
      jest.restoreAllMocks();
      process.env = originalEnv;
      resetAiCreditsGuardForTests();
      resetProviderPricingOverlaysForTests();
      resetModelPricingCatalogForTests();
      clearRuntimeModels();
    });

    test('uses the explicit cacheWrite rate when a verified tariff provides one', () => {
      const price = createAdaptivePrice(resolveModelPricing);
      // claude-sonnet-4-6: $3 input, $0.30 cachedInput, $3.75 cacheWrite, $15 output
      // 0.15 + 9.00 + 37.50 + 7.50 = 54.15 credits
      expect(price({ wireModel: 'claude-sonnet-4-6', provider: 'copilot' }, claudeTokens)).toBeCloseTo(54.15, 9);
      // gpt-5.6-luna: $0.20 input, $0.02 cachedInput, $0.25 cacheWrite, $1.20 output
      // 0.01 + 0.60 + 2.50 + 0.60 = 3.71 credits
      expect(price({ wireModel: 'gpt-5.6-luna', provider: 'copilot' }, claudeTokens)).toBeCloseTo(3.71, 9);
      // An explicit numeric 0 cacheWrite rate stays 0 rather than repricing at input.
      const zeroCacheWrite = () => ({ source: 'provider', pricing: { ...tariff, cacheWrite: 0 } });
      expect(createAdaptivePrice(zeroCacheWrite)(mapping, tokens)).toBeCloseTo(560, 9);
    });

    test('prices cache_write tokens at input for verified models with no separate cache-write charge', () => {
      const price = createAdaptivePrice(resolveModelPricing);
      // gpt-5.4: $2.50 input, $0.25 cachedInput, cacheWrite: null, $15 output
      // 0.125 + 7.50 + 25.00 (cache_write at input) + 7.50 = 40.125 credits
      expect(price({ wireModel: 'gpt-5.4', provider: 'copilot' }, claudeTokens)).toBeCloseTo(40.125, 9);
      // gemini-4-hydrogen: $1.50 input, $0.075 cachedInput, cacheWrite: null, $7.50 output
      // 0.075 + 2.25 + 15.00 (cache_write at input) + 3.75 = 21.075 credits
      expect(price({ wireModel: 'gemini-4-hydrogen', provider: 'copilot' }, claudeTokens)).toBeCloseTo(21.075, 9);
      // shared_catalog with explicit cacheWrite: null also reprices cache_write at input.
      process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
        schemaVersion: 1,
        catalogId: 'test-catalog',
        version: 'v1',
        unit: 'USD_PER_1M_TOKENS',
        providers: {
          copilot: {
            models: {
              'custom-no-cw': { input: 3, cachedInput: 0.3, cacheWrite: null, output: 15, reasoning: 15 },
            },
          },
        },
      });
      resetModelPricingCatalogForTests();
      expect(price({ wireModel: 'custom-no-cw', provider: 'copilot' }, claudeTokens)).toBeCloseTo(46.65, 9);
    });

    test('matches bundled repricing when a validated v2 central feed snapshot is active', () => {
      const snapshotTime = Date.parse('2026-11-24T17:00:00Z');
      const snapshot = validateSnapshot(
        buildSnapshot(canonicalCatalog, 'a'.repeat(40), new Date(snapshotTime).toISOString(), 2),
      );
      const capture = {
        snapshot,
        source: 'github/gh-aw-firewall',
        revision: snapshot.revision,
        time: snapshotTime,
        maxAge: 30 * 24 * 3600 * 1000,
      };
      const withFeed = (model, state, provider, inputTokens, options) =>
        resolveModelPricing(model, state, provider, inputTokens, { ...options, catalogue: capture });
      expect(withFeed('gemini-4-hydrogen', undefined, 'copilot', 0, { quiet: true, allowMedianEstimate: false })?.source)
        .toBe('central_feed');
      expect(withFeed('gemini-4-argon', undefined, 'copilot', 0, { quiet: true, allowMedianEstimate: false })?.source)
        .toBe('central_feed');

      const price = createAdaptivePrice(withFeed);
      // Hydrogen matches its bundled tariff and reprices cache_write at input (21.075 credits).
      expect(price({ wireModel: 'gemini-4-hydrogen', provider: 'copilot' }, claudeTokens)).toBeCloseTo(21.075, 9);
      // Argon stays unavailable on cacheWrite, returning null when cache_write > 0 and 8.10 when 0.
      expect(price({ wireModel: 'gemini-4-argon', provider: 'copilot' }, claudeTokens)).toBeNull();
      expect(price({ wireModel: 'gemini-4-argon', provider: 'copilot' }, noCacheWriteTokens)).toBeCloseTo(8.10, 9);

      // A central-feed tariff whose rates differ from the bundled tariff stays fail-closed.
      const modified = structuredClone(snapshot);
      const hydrogen = modified.models.find(entry => entry.identity.rawId === 'gemini-4-hydrogen');
      hydrogen.tariffs[0].components.input.price = '2';
      const modifiedCapture = { ...capture, snapshot: modified };
      const withModifiedFeed = (model, state, provider, inputTokens, options) =>
        resolveModelPricing(model, state, provider, inputTokens, { ...options, catalogue: modifiedCapture });
      expect(createAdaptivePrice(withModifiedFeed)({ wireModel: 'gemini-4-hydrogen', provider: 'copilot' }, claudeTokens))
        .toBeNull();

      // GPT-5.4 also matches when its central-feed tariff is fresh.
      const gptTime = Date.parse('2026-10-23T12:00:00Z');
      const gptCapture = { ...capture, time: gptTime };
      const withGptFeed = (model, state, provider, inputTokens, options) =>
        resolveModelPricing(model, state, provider, inputTokens, { ...options, catalogue: gptCapture });
      expect(withGptFeed('gpt-5.4', undefined, 'copilot', 0, { quiet: true, allowMedianEstimate: false })?.source)
        .toBe('central_feed');
      expect(createAdaptivePrice(withGptFeed)({ wireModel: 'gpt-5.4', provider: 'copilot' }, claudeTokens))
        .toBeCloseTo(40.125, 9);
    });

    test('returns null when cache_write > 0 and cacheWrite is unavailable or omitted in an operator overlay', () => {
      const price = createAdaptivePrice(resolveModelPricing);
      // Pin time inside gemini-4-argon's promotional window so this does not depend on wall-clock date.
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-24T12:00:00Z'));
      expect(price({ wireModel: 'gemini-4-argon', provider: 'copilot' }, claudeTokens)).toBeNull();
      // With cache_write === 0, gemini-4-argon ($2 input, $0.10 cachedInput, $10 output) is priceable:
      // 0.10 + 3.00 + 0 + 5.00 = 8.10 credits
      expect(price({ wireModel: 'gemini-4-argon', provider: 'copilot' }, noCacheWriteTokens)).toBeCloseTo(8.10, 9);

      // Operator overlay omitting cache_write (e.g., on Claude Sonnet 4.6) must NOT reprice at input.
      process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
        copilot: {
          models: {
            'claude-sonnet-4-6': {
              cost: { input: '3e-06', cache_read: '3e-07', output: '1.5e-05' },
            },
          },
        },
      });
      resetProviderPricingOverlaysForTests();
      expect(price({ wireModel: 'claude-sonnet-4-6', provider: 'copilot' }, claudeTokens)).toBeNull();
      // When cache_write === 0, the omitted cache_write rate is not needed: 0.15 + 9.00 + 7.50 = 16.65 credits.
      expect(price({ wireModel: 'claude-sonnet-4-6', provider: 'copilot' }, noCacheWriteTokens)).toBeCloseTo(16.65, 9);

      // When the operator explicitly supplies cache_write, that rate is used.
      process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
        copilot: {
          models: {
            'claude-sonnet-4-6': {
              cost: { input: '3e-06', cache_read: '3e-07', cache_write: '3.75e-06', output: '1.5e-05' },
            },
          },
        },
      });
      resetProviderPricingOverlaysForTests();
      expect(price({ wireModel: 'claude-sonnet-4-6', provider: 'copilot' }, claudeTokens)).toBeCloseTo(54.15, 9);

      // Omitted cacheWrite (undefined) also refuses when cache_write > 0.
      const missingCacheWrite = () => ({ source: 'provider', pricing: { input: 2, cachedInput: 0.2, output: 8 } });
      expect(createAdaptivePrice(missingCacheWrite)(mapping, claudeTokens)).toBeNull();
    });

    test('returns null when cache_write > 0 and cacheWrite came from a fallback source', () => {
      // Partial runtime-only model missing cacheWrite, filled from configured_default (both numeric and null).
      replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
        data: [{
          id: 'runtime-only-partial',
          billing: {
            token_prices: {
              batch_size: 1_000_000,
              default: { input_price: 200, output_price: 1000, cache_read_price: 20 },
            },
          },
        }],
      }));
      const price = createAdaptivePrice(resolveModelPricing);
      for (const defaultCacheWrite of [null, 3.75]) {
        process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({
          input: 3, cachedInput: 0.3, cacheWrite: defaultCacheWrite, output: 15,
        });
        resetAiCreditsGuardForTests();
        expect(price({ wireModel: 'runtime-only-partial', provider: 'copilot' }, claudeTokens)).toBeNull();
        // With cache_write === 0, the fallback-filled cacheWrite component is unused:
        // $2 input, $0.20 cachedInput, $10 output -> 0.10 + 6.00 + 5.00 = 11.10 credits
        expect(price({ wireModel: 'runtime-only-partial', provider: 'copilot' }, noCacheWriteTokens))
          .toBeCloseTo(11.10, 9);
      }
    });
  });
});

describe('loadRoutingConversation', () => {
  test('loads a conversation under the one MiB bound', async () => {
    const dir = makeOutputDir();
    const file = path.join(dir, 'conversation.json');
    const conversation = { messages: [{ role: 'user', content: 'x'.repeat(20_000) }] };
    fs.writeFileSync(file, JSON.stringify(conversation));
    await expect(loadRoutingConversation(file)).resolves.toEqual(conversation);
  });

  test('translates a missing file into a routing configuration error', async () => {
    const dir = makeOutputDir();
    await expect(loadRoutingConversation(path.join(dir, 'absent.json')))
      .rejects.toMatchObject({ code: 'routing_configuration_error' });
  });

  test('translates invalid JSON into a routing contract error', async () => {
    const dir = makeOutputDir();
    const file = path.join(dir, 'conversation.json');
    fs.writeFileSync(file, 'not json');
    await expect(loadRoutingConversation(file))
      .rejects.toMatchObject({ code: 'routing_contract_error' });
  });

  test('is cancelled by an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(loadRoutingConversation('/nonexistent', { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'routing_cancelled' });
  });
});

describe('createProductionRoutingController', () => {
  test('returns null when routing is not configured', () => {
    expect(createProductionRoutingController({ rawConfig: undefined })).toBeNull();
  });

  test('rejects a configuration without a Copilot adapter owner', () => {
    const rawConfig = JSON.stringify({
      objective: { goal: 'cost', mode: 'balanced' },
      task: { conversationFile: '/run/awf-routing/input/conversation.json' },
    });
    expect(() => createProductionRoutingController({ rawConfig }))
      .toThrow(/The provider adapter owner is unavailable/);
  });

  describe('router call tracing', () => {
    const { EventEmitter } = require('events');
    const { createCopilotAdapter } = require('./providers/copilot');
    const { cachedModels } = require('./key-validation');
    const { clearRuntimeModels, replaceRuntimeModels } = require('./runtime-model-catalog');
    const TRACEPARENT = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    let conversationDir;
    let rawConfig;
    let savedCopilotModels;

    beforeEach(() => {
      savedCopilotModels = cachedModels.copilot;
      conversationDir = makeOutputDir();
      const conversationFile = path.join(conversationDir, 'conversation.json');
      fs.writeFileSync(conversationFile, JSON.stringify([{ role: 'user', parts: [{ text: 'trace test' }] }]));
      rawConfig = JSON.stringify({
        objective: { goal: 'cost', mode: 'balanced' },
        task: { conversationFile },
      });
      cachedModels.copilot = ['gpt-test'];
      replaceRuntimeModels('copilot', [{
        id: 'gpt-test',
        supportedEndpoints: ['/responses'],
        supportedReasoningEfforts: ['medium'],
      }]);
    });

    afterEach(() => {
      cachedModels.copilot = savedCopilotModels;
      clearRuntimeModels();
      fs.rmSync(conversationDir, { recursive: true, force: true });
    });

    // Answers health and returns invalid capabilities, so the router phase stops after one traced call.
    function fakeRouterTransport(seen) {
      return {
        request(options, onResponse) {
          seen.push(options);
          const upstream = new EventEmitter();
          upstream.setTimeout = () => upstream;
          upstream.write = () => true;
          upstream.destroy = () => {};
          upstream.end = () => setImmediate(() => {
            const response = new EventEmitter();
            response.statusCode = options.path === '/healthz' ? 204 : 200;
            response.destroy = () => {};
            onResponse(response);
            if (options.path !== '/healthz') response.emit('data', Buffer.from('{}'));
            response.emit('end');
            response.emit('close');
          });
          return upstream;
        },
      };
    }

    function fakeTracing() {
      return { startCall: jest.fn(() => ({ headers: { traceparent: TRACEPARENT }, end: jest.fn() })) };
    }

    async function runWith(create, routerTracing) {
      const seen = [];
      const controller = create({
        rawConfig,
        getCopilotAdapter: () => createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'test-token' }),
        routerTransport: fakeRouterTransport(seen),
        observer: { record() {} },
        ...(routerTracing === undefined ? {} : { routerTracing }),
      });
      await expect(controller.run()).resolves.toMatchObject({
        ok: true,
        selection: { selection_source: 'fallback', fallback_reason: 'routing_contract_error' },
      });
      return seen.map(options => [options.path, options.headers.traceparent]);
    }

    function loadRuntimeWithOtel(factory) {
      let runtime;
      jest.isolateModules(() => {
        jest.doMock('./otel', factory);
        require('./key-validation').cachedModels.copilot = ['gpt-test'];
        require('./runtime-model-catalog').replaceRuntimeModels('copilot', [{
          id: 'gpt-test',
          supportedEndpoints: ['/responses'],
          supportedReasoningEfforts: ['medium'],
        }]);
        runtime = require('./routing-runtime');
      });
      jest.dontMock('./otel');
      return runtime;
    }

    test('uses the api-proxy tracing hook by default', async () => {
      const tracing = fakeTracing();
      const runtime = loadRuntimeWithOtel(() => ({ routerCallTracing: tracing }));
      expect(await runWith(runtime.createProductionRoutingController))
        .toEqual([['/healthz', undefined], ['/capabilities', TRACEPARENT]]);
      expect(tracing.startCall).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'capabilities',
        serverAddress: 'gh-aw-router',
        serverPort: 8737,
      }));
    });

    test('routes without tracing when the OTEL module is not bundled', async () => {
      const runtime = loadRuntimeWithOtel(() => {
        throw Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
      });
      expect(await runWith(runtime.createProductionRoutingController))
        .toEqual([['/healthz', undefined], ['/capabilities', undefined]]);
    });

    test('accepts an explicit tracing hook', async () => {
      const tracing = fakeTracing();
      expect(await runWith(createProductionRoutingController, tracing))
        .toEqual([['/healthz', undefined], ['/capabilities', TRACEPARENT]]);
      expect(await runWith(createProductionRoutingController, null))
        .toEqual([['/healthz', undefined], ['/capabilities', undefined]]);
    });
  });
});

describe('createRoutingObserver', () => {
  test('logs failure stages at warn and other stages at info', () => {
    const writeLog = jest.fn();
    const observer = createRoutingObserver(writeLog);
    observer.record({ stage: 'selection' });
    observer.record({ stage: 'failure' });
    expect(writeLog.mock.calls[0][0]).toBe('info');
    expect(writeLog.mock.calls[0][1]).toBe('model_routing');
    expect(writeLog.mock.calls[1][0]).toBe('warn');
  });
});

describe('createProductionRoutingSession', () => {
  function selectedRequest(session) {
    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    res.statusCode = 200;
    res.writableFinished = false;
    res.write = jest.fn();
    res.end = jest.fn(() => {
      res.writableFinished = true;
      res.emit('finish');
    });
    const req = { url: '/v1/chat/completions', method: 'POST', headers: {} };
    session.observeRequest(req, res, { name: 'copilot' });
    req.awfRouting.bodyTransform(Buffer.from(JSON.stringify({ model: SELECTION.wire_model })));
    return { req, res };
  }

  test('keeps a recovered 503 in request telemetry without publishing a terminal failure', async () => {
    const outputDir = makeOutputDir();
    const records = [];
    const session = createProductionRoutingSession({
      rawConfig: '{}', outputDir,
      observer: { record: record => records.push(record) },
      createController: controllerReturning({ ok: true, selection: SELECTION }),
    });
    await session.start();
    const failed = selectedRequest(session);
    failed.res.statusCode = 503;
    failed.res.end('unavailable');
    expect(fs.existsSync(path.join(outputDir, 'runtime-failure.json'))).toBe(false);
    expect(session.getReflectState().status).toBe('selected');
    selectedRequest(session).res.end('recovered');
    await session.shutdown();
    session.completeShutdown();
    expect(records).toEqual([
      expect.objectContaining({ stage: 'request', outcome: 'failed', status: 503 }),
      expect.objectContaining({ stage: 'request', outcome: 'completed', status: 200 }),
    ]);
    expect(session.getFailure()).toBeNull();
    expect(fs.existsSync(path.join(outputDir, 'runtime-failure.json'))).toBe(false);
  });

  test('keeps a client-abandoned shutdown request as aborted telemetry without failing', async () => {
    const outputDir = makeOutputDir();
    const records = [];
    const session = createProductionRoutingSession({
      rawConfig: '{}', outputDir,
      observer: { record: record => records.push(record) },
      createController: controllerReturning({ ok: true, selection: SELECTION }),
    });
    await session.start();
    selectedRequest(session).res.end('completed');
    const abandoned = selectedRequest(session);
    const draining = session.shutdown();
    abandoned.res.emit('close');
    await draining;
    session.completeShutdown();
    expect(records).toEqual([
      expect.objectContaining({ stage: 'request', outcome: 'completed', status: 200 }),
      expect.objectContaining({ stage: 'request', outcome: 'aborted', status: 200 }),
    ]);
    expect(session.getFailure()).toBeNull();
    expect(fs.existsSync(path.join(outputDir, 'runtime-failure.json'))).toBe(false);
  });

  test('returns null when routing is not configured', () => {
    expect(createProductionRoutingSession({ rawConfig: undefined })).toBeNull();
  });

  test('publishes the selection atomically and completion only after draining', async () => {
    const outputDir = makeOutputDir();
    const session = createProductionRoutingSession({
      rawConfig: '{}',
      outputDir,
      createController: controllerReturning({ ok: true, selection: SELECTION }),
    });

    await session.start();
    expect(readResult(outputDir, 'selection.json')).toEqual(SELECTION);
    expect(session.getSelection()).toEqual(SELECTION);
    expect(() => session.completeShutdown()).toThrow(/shutdown is incomplete/);
    expect(fs.existsSync(path.join(outputDir, 'complete.json'))).toBe(false);

    await session.shutdown();
    session.completeShutdown();
    expect(readResult(outputDir, 'complete.json')).toEqual({ schema: 'awf-routing-complete/v1' });
    expect(fs.readdirSync(outputDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  test('applies the existing private file size limit to selection plus options before launch', async () => {
    const outputDir = makeOutputDir();
    const pair = { model: `github-copilot/${'a'.repeat(5000)}` };
    const selection = { ...SELECTION, choice: { id: 'one', ...pair }, wire_model: pair.model.split('/')[1] };
    const routeOptions = { ordinaryPick: pair, options: [pair] };
    expect(Buffer.byteLength(JSON.stringify(selection))).toBeLessThan(16_384);
    const session = createProductionRoutingSession({
      rawConfig: '{}', outputDir, createController: controllerReturning({ ok: true, selection, routeOptions }),
    });
    await expect(session.start()).resolves.toMatchObject({ ok: false, failure: { code: 'routing_contract_error' } });
    expect(fs.readdirSync(outputDir)).toEqual(['failure.json']);
  });

  test('reflects the selection the agent must send, and failures without a selection', async () => {
    const pending = createProductionRoutingSession({
      rawConfig: '{}',
      outputDir: makeOutputDir(),
      createController: controllerReturning({ ok: true, selection: SELECTION }),
    });
    expect(pending.getReflectState()).toEqual({ status: 'pending', selection: null });
    await pending.start();
    expect(pending.getReflectState()).toEqual({
      status: 'selected',
      selection: {
        provider: 'copilot', model: 'gpt-5', wire_model: 'gpt-5', effort: 'medium', endpoint: '/responses',
      },
    });

    const cases = [
      [{ provider: 'copilot', choice: { id: 'choice-0001', model: 'github-copilot/claude-haiku-4.5' } },
        { effort: null, endpoint: '/chat/completions' }],
      [{ provider: 'copilot', endpoint: '/v1/messages', choice: { id: 'choice-0001', model: 'github-copilot/claude-sonnet-5', effort: 'max' } },
        { effort: 'max', endpoint: '/v1/messages' }],
      [{ provider: 'anthropic', choice: { id: 'choice-0001', model: 'anthropic/claude-opus-5', effort: 'high' } },
        { effort: 'high', endpoint: '/v1/messages' }],
    ];
    for (const [overrides, expected] of cases) {
      const session = createProductionRoutingSession({
        rawConfig: '{}',
        outputDir: makeOutputDir(),
        createController: controllerReturning({ ok: true, selection: { ...SELECTION, ...overrides } }),
      });
      await session.start();
      expect(session.getReflectState().selection).toMatchObject(expected);
    }

    const failed = createProductionRoutingSession({
      rawConfig: '{}',
      outputDir: makeOutputDir(),
      createController: controllerReturning({
        ok: false,
        failure: { schema: 'awf-routing-failure/v1', code: 'no_route', detail: 'x', retryable: false },
      }),
    });
    await failed.start();
    expect(failed.getReflectState()).toEqual({ status: 'failed', failure_code: 'no_route', selection: null });
  });

  test('publishes a failure record when the controller fails', async () => {
    const outputDir = makeOutputDir();
    const failure = {
      schema: 'awf-routing-failure/v1',
      code: 'no_route',
      detail: 'The router found no eligible model choice',
      retryable: false,
    };
    const session = createProductionRoutingSession({
      rawConfig: '{}',
      outputDir,
      createController: controllerReturning({ ok: false, failure }),
    });

    await session.start();
    expect(readResult(outputDir, 'failure.json')).toEqual(failure);
    expect(session.getSelection()).toBeNull();
    expect(session.getFailure()).toEqual(failure);

    await session.shutdown();
    session.completeShutdown();
    expect(fs.existsSync(path.join(outputDir, 'complete.json'))).toBe(false);
  });

  test('publishes a bootstrap failure when the controller cannot be built', async () => {
    const outputDir = makeOutputDir();
    const session = createProductionRoutingSession({
      rawConfig: '{}',
      outputDir,
      createController: () => {
        throw new Error('adapter exploded');
      },
    });

    await session.start();
    const published = readResult(outputDir, 'failure.json');
    expect(published.code).toBe('routing_configuration_error');
    expect(published.detail).not.toMatch(/exploded/);
  });

  test('terminates with exit code 78 when a bootstrap failure cannot be published', async () => {
    const outputDir = makeOutputDir();
    fs.rmSync(outputDir, { recursive: true, force: true });
    const fatalExit = jest.fn();
    const session = createProductionRoutingSession({
      rawConfig: '{}',
      outputDir,
      fatalExit,
      createController: () => {
        throw new Error('adapter exploded');
      },
    });

    await session.start();

    expect(fatalExit).toHaveBeenCalledWith(78);
  });

  test('refuses to plan when a stale result already exists', async () => {
    const outputDir = makeOutputDir();
    fs.writeFileSync(path.join(outputDir, 'selection.json'), JSON.stringify(SELECTION));
    const createController = jest.fn(controllerReturning({ ok: true, selection: SELECTION }));
    const session = createProductionRoutingSession({ rawConfig: '{}', outputDir, createController });

    const result = await session.start();

    expect(createController).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.failure.code).toBe('routing_contract_error');
    // The stale file stays authoritative rather than being overwritten.
    expect(readResult(outputDir, 'selection.json')).toEqual(SELECTION);
  });

  test('publishes a runtime failure raised after the selection', async () => {
    const outputDir = makeOutputDir();
    const session = createProductionRoutingSession({
      rawConfig: '{}',
      outputDir,
      createController: controllerReturning({ ok: true, selection: SELECTION }),
    });
    await session.start();

    const { res } = selectedRequest(session);
    res.statusCode = 503;
    res.end(JSON.stringify({ error: { code: 'provider_unavailable' } }));

    expect(fs.existsSync(path.join(outputDir, 'runtime-failure.json'))).toBe(false);
    await session.shutdown();
    expect(readResult(outputDir, 'runtime-failure.json')).toMatchObject({
      schema: 'awf-routing-failure/v1',
      code: 'provider_unavailable',
    });
  });

  test('terminates with exit code 78 when a runtime failure cannot be published', async () => {
    const outputDir = makeOutputDir();
    const fatalExit = jest.fn();
    const session = createProductionRoutingSession({
      rawConfig: '{}',
      outputDir,
      fatalExit,
      createController: controllerReturning({ ok: true, selection: SELECTION }),
    });
    await session.start();
    fs.writeFileSync(path.join(outputDir, 'runtime-failure.json'), '{}');

    const { res } = selectedRequest(session);
    res.statusCode = 502;
    res.end(JSON.stringify({ error: { code: 'bad_gateway' } }));

    await session.shutdown();
    expect(fatalExit).toHaveBeenCalledWith(78);
  });
});
