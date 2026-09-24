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
      .toThrow(/Copilot provider adapter owner is unavailable/);
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

    const res = {
      writeHead: jest.fn(),
      end: jest.fn(),
    };
    const rejected = session.screenRequest(
      { url: '/v1/chat/completions', method: 'POST', headers: {} },
      res,
      { name: 'copilot' },
    );

    expect(rejected).toBe(true);
    expect(readResult(outputDir, 'runtime-failure.json')).toMatchObject({
      schema: 'awf-routing-failure/v1',
      code: 'model_routing_mismatch',
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

    session.screenRequest(
      { url: '/v1/chat/completions', method: 'POST', headers: {} },
      { writeHead: jest.fn(), end: jest.fn() },
      { name: 'copilot' },
    );

    expect(fatalExit).toHaveBeenCalledWith(78);
  });
});
