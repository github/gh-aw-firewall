'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createProductionRoutingController,
  createProductionRoutingSession,
  createRoutingObserver,
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
    const TRACEPARENT = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01';
    const rawConfig = JSON.stringify({
      objective: { goal: 'cost', mode: 'balanced' },
      task: { conversationFile: '/run/awf-routing/input/conversation.json' },
    });

    // Answers health and returns invalid capabilities, so the run stops after one traced call.
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
        getCopilotAdapter: () => null,
        routerTransport: fakeRouterTransport(seen),
        observer: { record() {} },
        ...(routerTracing === undefined ? {} : { routerTracing }),
      });
      await expect(controller.run()).resolves.toMatchObject({ ok: false });
      return seen.map(options => [options.path, options.headers.traceparent]);
    }

    function loadRuntimeWithOtel(factory) {
      let runtime;
      jest.isolateModules(() => {
        jest.doMock('./otel', factory);
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

    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    res.statusCode = 200;
    res.writableFinished = false;
    res.write = jest.fn();
    res.end = jest.fn(() => { res.writableFinished = true; res.emit('finish'); });
    const req = { url: '/v1/chat/completions', method: 'POST', headers: {} };
    session.observeRequest(req, res, { name: 'copilot' });
    req.awfRouting.bodyTransform(Buffer.from(JSON.stringify({ model: SELECTION.wire_model })));
    res.statusCode = 503;
    res.end(JSON.stringify({ error: { code: 'provider_unavailable' } }));

    // Decided only once observed requests have drained.
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

    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    res.statusCode = 502;
    res.write = jest.fn();
    res.end = jest.fn(() => { res.writableFinished = true; res.emit('finish'); });
    const req = { url: '/v1/chat/completions', method: 'POST', headers: {} };
    session.observeRequest(req, res, { name: 'copilot' });
    req.awfRouting.bodyTransform(Buffer.from(JSON.stringify({ model: SELECTION.wire_model })));
    res.end(JSON.stringify({ error: { code: 'bad_gateway' } }));
    await session.shutdown();

    expect(fatalExit).toHaveBeenCalledWith(78);
  });
});

describe('routed run completion after per-request failures', () => {
  const { EventEmitter } = require('events');

  // github-copilot/claude-haiku-5.5:xhigh served over /chat/completions, as
  // the Copilot SDK reviewer runs in github/gh-aw-firewall#11002 selected it.
  const HAIKU = Object.freeze({
    schema: 'awf-routing-selection/v1',
    engine: 'copilot',
    provider: 'copilot',
    endpoint: '/chat/completions',
    choice: Object.freeze({ id: 'choice-haiku', model: 'github-copilot/claude-haiku-5.5', effort: 'xhigh' }),
    wire_model: 'claude-haiku-5.5',
  });
  const HAIKU_BODY = { model: 'claude-haiku-5.5', reasoning_effort: 'xhigh', stream: true };

  class Response extends EventEmitter {
    constructor() {
      super();
      this.statusCode = 200;
      this.writableFinished = false;
      this.destroyed = false;
    }

    writeHead(statusCode) {
      this.statusCode = statusCode;
      return this;
    }

    write() {
      return true;
    }

    end() {
      this.writableFinished = true;
      this.emit('finish');
      this.emit('close');
      return this;
    }

    destroy() {
      if (this.destroyed) return this;
      this.destroyed = true;
      this.emit('close');
      return this;
    }
  }

  async function startRun(selection = HAIKU) {
    const outputDir = makeOutputDir();
    const records = [];
    const session = createProductionRoutingSession({
      rawConfig: '{}',
      outputDir,
      observer: { record: record => records.push(record) },
      createController: controllerReturning({ ok: true, selection }),
      fatalExit: jest.fn(),
    });
    await session.start();
    let counter = 0;
    function begin(body = HAIKU_BODY, url = '/chat/completions') {
      const req = { url, method: 'POST', headers: { 'x-request-id': `request-${++counter}` } };
      const res = new Response();
      session.observeRequest(req, res, { name: 'copilot' });
      req.awfRouting.bodyTransform(Buffer.from(JSON.stringify(body)));
      return { req, res };
    }
    function completed(count = 1) {
      for (let i = 0; i < count; i++) {
        const { req, res } = begin();
        req.awfRouting.onSseInspectionStart();
        req.awfRouting.onSseData(JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] }));
        req.awfRouting.onSseData('[DONE]');
        res.end();
        req.awfRouting.onSseInspectionComplete();
      }
    }
    function upstream503() {
      const { res } = begin();
      res.writeHead(503);
      res.end('upstream connect error or disconnect/reset before headers. reset reason: connection termination');
    }
    return { outputDir, records, session, begin, completed, upstream503 };
  }

  // Mirrors verifyRoutingCompletion in src/routing/bootstrap.ts: any failure
  // record fails the routed run with 78; otherwise the agent's exit code
  // stands once selection and completion are both published.
  function hostExitCode(outputDir, agentExitCode) {
    for (const name of ['failure.json', 'runtime-failure.json']) {
      if (fs.existsSync(path.join(outputDir, name))) return 78;
    }
    for (const name of ['selection.json', 'complete.json']) {
      if (!fs.existsSync(path.join(outputDir, name))) return 78;
    }
    return agentExitCode;
  }

  async function finish(run, agentExitCode = 0) {
    await run.session.shutdown();
    run.session.completeShutdown();
    return hostExitCode(run.outputDir, agentExitCode);
  }

  const requests = run => run.records.filter(record => record.stage === 'request');
  const failures = run => run.records.filter(record => record.stage === 'failure');

  test('a 503 recovered by later selected-model requests exits 0 (run 41462389118)', async () => {
    const run = await startRun();
    run.completed(12);
    run.upstream503();
    run.completed(5);

    expect(await finish(run)).toBe(0);
    const recorded = requests(run);
    expect(recorded).toHaveLength(18);
    expect(recorded.filter(record => record.outcome === 'completed')).toHaveLength(17);
    expect(recorded[12]).toMatchObject({
      request_id: 'request-13', routed: 'as_selected', outcome: 'failed', status: 503,
    });
    expect(failures(run)).toEqual([]);
    expect(run.session.getFailure()).toBeNull();
  });

  test('a final request abandoned by the client at shutdown exits 0 (run 41467590803)', async () => {
    const run = await startRun();
    run.completed(51);
    // Background compaction is in flight when the harness exits.
    const compaction = run.begin();
    compaction.req.awfRouting.onSseInspectionStart();
    let drained = false;
    const shutdown = run.session.shutdown().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    compaction.res.emit('close');
    compaction.req.awfRouting.onSseInspectionComplete();
    await shutdown;
    run.session.completeShutdown();

    expect(hostExitCode(run.outputDir, 0)).toBe(0);
    expect(requests(run).at(-1)).toMatchObject({ request_id: 'request-52', outcome: 'aborted', status: 200 });
    expect(failures(run)).toEqual([]);
  });

  test('every selected-model request failing still exits 78 with provider_unavailable', async () => {
    const run = await startRun();
    run.upstream503();
    run.upstream503();
    // An unreachable provider: AWF answers 502 itself.
    const unreachable = run.begin();
    unreachable.res.writeHead(502);
    unreachable.res.end(JSON.stringify({ error: { message: 'Proxy error' } }));

    expect(await finish(run, 1)).toBe(78);
    expect(requests(run).map(record => [record.outcome, record.status])).toEqual([
      ['failed', 503], ['failed', 503], ['failed', 502],
    ]);
    expect(failures(run)).toEqual([{ stage: 'failure', phase: 'primary', code: 'provider_unavailable' }]);
    expect(readResult(run.outputDir, 'runtime-failure.json')).toMatchObject({ code: 'provider_unavailable' });
  });

  test('a failure with no later selected-model success stays fatal', async () => {
    const run = await startRun();
    run.completed(3);
    run.upstream503();
    // A later request on another model does not show the selected model recovered.
    const deviating = run.begin({ model: 'gpt-5.6-luna', reasoning_effort: 'xhigh' });
    deviating.res.end();
    // Nor does a stream that never delivered its terminal success.
    const truncated = run.begin();
    truncated.req.awfRouting.onSseInspectionStart();
    truncated.res.end();
    truncated.req.awfRouting.onSseInspectionComplete();

    expect(await finish(run)).toBe(78);
    expect(failures(run)).toEqual([{ stage: 'failure', phase: 'primary', code: 'provider_unavailable' }]);
  });

  test('an upstream reset that AWF tears down mid-stream stays fatal when unrecovered', async () => {
    const run = await startRun();
    run.completed(2);
    const reset = run.begin();
    reset.req.awfRouting.onSseInspectionStart();
    reset.res.destroy(new Error('aborted'));
    reset.req.awfRouting.onSseInspectionComplete();

    expect(await finish(run)).toBe(78);
    expect(requests(run).at(-1)).toMatchObject({ outcome: 'aborted', status: 200 });
    expect(failures(run)).toEqual([{ stage: 'failure', phase: 'primary', code: 'provider_unavailable' }]);
  });

  test('a Codex client close at response.completed is unchanged', async () => {
    const luna = Object.freeze({
      schema: 'awf-routing-selection/v1',
      engine: 'codex',
      provider: 'copilot',
      choice: Object.freeze({ id: 'choice-luna', model: 'github-copilot/gpt-5.6-luna', effort: 'max' }),
      wire_model: 'gpt-5.6-luna',
    });
    const run = await startRun(luna);
    const { req, res } = run.begin({ model: 'gpt-5.6-luna', reasoning: { effort: 'max' } }, '/responses');
    req.awfRouting.onSseInspectionStart();
    req.awfRouting.onSseData(JSON.stringify({ type: 'response.completed', response: { status: 'completed' } }));
    res.emit('close');
    req.awfRouting.onSseInspectionComplete();

    expect(await finish(run)).toBe(0);
    expect(requests(run)).toEqual([expect.objectContaining({ outcome: 'client_closed', status: 200 })]);
    expect(failures(run)).toEqual([]);
  });

  test('the Avenger shape still reports its policy rejections and never succeeds', async () => {
    const luna = Object.freeze({ ...HAIKU, choice: Object.freeze({ id: 'choice-luna', model: 'github-copilot/gpt-5.6-luna', effort: 'max' }), wire_model: 'gpt-5.6-luna' });
    const lunaBody = { model: 'gpt-5.6-luna', reasoning_effort: 'max', stream: true };
    const run = await startRun(luna);
    const succeed = count => {
      for (let i = 0; i < count; i++) {
        const { req, res } = run.begin(lunaBody);
        req.awfRouting.onSseInspectionStart();
        req.awfRouting.onSseData('[DONE]');
        res.end();
        req.awfRouting.onSseInspectionComplete();
      }
    };
    succeed(10);
    // A client abort mid-run, then later successful requests.
    const aborted = run.begin(lunaBody);
    aborted.res.emit('close');
    succeed(39);
    // The invocation budget is exhausted: six policy-rejected 429s.
    for (let i = 0; i < 6; i++) {
      const { req, res } = run.begin(lunaBody);
      req.awfRouting.rejected = true;
      res.writeHead(429);
      res.end(JSON.stringify({ error: { type: 'max_runs_exceeded', message: 'Maximum LLM invocations exceeded (50 / 50)' } }));
    }

    // The policy rejection latches immediately, as it did before.
    expect(run.session.getFailure()).toMatchObject({ code: 'max_runs_exceeded' });
    expect(await finish(run, 1)).toBe(78);
    const recorded = requests(run);
    expect(recorded[10]).toMatchObject({ outcome: 'aborted', status: 200 });
    expect(recorded.filter(record => record.outcome === 'completed')).toHaveLength(49);
    expect(recorded.filter(record => record.outcome === 'rejected' && record.status === 429)).toHaveLength(6);
    expect(failures(run)).toEqual([{ stage: 'failure', phase: 'primary', code: 'max_runs_exceeded' }]);
  });
});
