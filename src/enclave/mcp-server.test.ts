import * as http from 'http';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const root = path.join(__dirname, '..', '..', 'containers');
const {
  dispatchJsonRpc,
  parseJsonRpcBody,
  TOOL_NAME,
} = require(path.join(root, 'enclave', 'mcp-server', 'mcp-protocol.js'));
const {
  createMcpServer,
  createSingleToolAdmission,
  safeCapabilityEquals,
} = require(path.join(root, 'enclave', 'mcp-server', 'server.js'));
const { createExecutorHandler } = require(path.join(root, 'enclave', 'script-executor', 'executor-handler.js'));
const {
  CANONICAL_ERROR_RESPONSE_JSON,
  validateEnclaveScriptRequest,
} = require(path.join(root, 'bounded-execution', 'finite-disclosure.js'));
const {
  createEnclaveInformationBudgetLedger,
} = require(path.join(root, 'bounded-execution', 'sensitivity-ledger.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

const capability = '0123456789abcdef0123456789abcdef';
const validArguments = {
  privateRepo: 'octo/private',
  schema: { type: 'boolean' },
  script: 'import json\nopen("out", "w").write(json.dumps(True))',
};

function rpc(method: string, params?: unknown, id = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

function fakeBroker(response: string, requests: unknown[] = []) {
  return {
    handle(request: unknown, respond: (value: string) => void) {
      requests.push(request);
      respond(response);
      return Promise.resolve();
    },
  };
}

describe('AWF enclave MCP protocol', () => {
  it('implements initialization and the initialized notification', async () => {
    const deps = { handlers: { [TOOL_NAME]: fakeBroker(CANONICAL_ERROR_RESPONSE_JSON) }, maxScriptBytes: 65536 };
    const initialized = await dispatchJsonRpc(rpc('initialize', {}), deps);
    expect(initialized).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'awf-enclave' },
      },
    });
    expect(await dispatchJsonRpc({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }, deps)).toBeUndefined();
  });

  it('publishes one static tool without trusted configuration or repository data', async () => {
    const response = await dispatchJsonRpc(rpc('tools/list', {}), {
      handlers: { [TOOL_NAME]: fakeBroker(CANONICAL_ERROR_RESPONSE_JSON) },
      maxScriptBytes: 65536,
      repositories: ['should-never-appear'],
      runtime: 'gvisor',
      sensitivity: 'confidential',
      model: 'private-model',
    });
    expect(response.result.tools).toHaveLength(1);
    expect(response.result.tools[0].name).toBe(TOOL_NAME);
    expect(response.result.tools[0].inputSchema).toMatchObject({
      required: ['privateRepo', 'schema', 'script'],
      additionalProperties: false,
    });
    expect(JSON.stringify(response)).not.toMatch(
      /should-never-appear|gvisor|confidential|private-model|budget/i,
    );
  });

  it('returns canonical structured success without isError', async () => {
    const response = await dispatchJsonRpc(rpc('tools/call', {
      name: TOOL_NAME,
      arguments: validArguments,
    }), {
      handlers: { [TOOL_NAME]: fakeBroker('{"status":"ok","result":true}') },
      maxScriptBytes: 65536,
    });
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '{"status":"ok","result":true}' }],
        structuredContent: { status: 'ok', result: true },
      },
    });
    expect(JSON.stringify(response)).not.toContain('isError');
  });

  it.each([
    CANONICAL_ERROR_RESPONSE_JSON,
    '{"status":"unexpected"}',
  ])('collapses every broker outcome failure to one public result (%s)', async (outcome) => {
    const response = await dispatchJsonRpc(rpc('tools/call', {
      name: TOOL_NAME,
      arguments: validArguments,
    }), {
      handlers: { [TOOL_NAME]: fakeBroker(outcome) },
      maxScriptBytes: 65536,
    });
    expect(response.result.structuredContent).toEqual({ status: 'error' });
    expect(response.result.content).toEqual([
      { type: 'text', text: '{"status":"error"}' },
    ]);
    expect(response.result).not.toHaveProperty('isError');
  });

  it('passes only exact finite-disclosure arguments and canonically rejects extras', async () => {
    const requests: unknown[] = [];
    const validatingBroker = {
      handle(request: unknown, respond: (value: string) => void) {
        requests.push(request);
        const validation = validateEnclaveScriptRequest(request);
        respond(validation.valid ? '{"status":"ok","result":true}' : CANONICAL_ERROR_RESPONSE_JSON);
        return Promise.resolve();
      },
    };
    const response = await dispatchJsonRpc(rpc('tools/call', {
      name: TOOL_NAME,
      arguments: { ...validArguments, runtime: 'runc' },
    }), { handlers: { [TOOL_NAME]: validatingBroker }, maxScriptBytes: 65536 });
    expect(requests).toEqual([{ ...validArguments, runtime: 'runc' }]);
    expect(response.result.structuredContent).toEqual({ status: 'error' });
  });

  it('uses JSON-RPC errors only for malformed protocol requests', async () => {
    const deps = { handlers: { [TOOL_NAME]: fakeBroker(CANONICAL_ERROR_RESPONSE_JSON) }, maxScriptBytes: 65536 };
    await expect(dispatchJsonRpc(rpc('unknown'), deps)).resolves.toMatchObject({
      error: { code: -32601 },
    });

    await expect(dispatchJsonRpc(rpc('tools/call', { name: 'other', arguments: {} }), deps))
      .resolves.toMatchObject({ error: { code: -32602 } });
    expect(parseJsonRpcBody(Buffer.from('{"jsonrpc":"2.0","id":1,"id":2}'))).toBeUndefined();
  });

  it('admits only one unified enclave tool call at a time', async () => {
    const tryAcquireToolCall = createSingleToolAdmission();
    let finishFirst: (() => void) | undefined;
    const handler = {
      handle: (_request: unknown, respond: (value: string) => void) => new Promise<void>((resolve) => {
        finishFirst = () => {
          respond('{"status":"ok","result":true}');
          resolve();
        };
      }),
    };
    const deps = {
      handlers: { [TOOL_NAME]: handler },
      maxScriptBytes: 65536,
      tryAcquireToolCall,
    };
    const first = dispatchJsonRpc(rpc('tools/call', {
      name: TOOL_NAME,
      arguments: validArguments,
    }), deps);
    await Promise.resolve();
    const busy = await dispatchJsonRpc(rpc('tools/call', {
      name: TOOL_NAME,
      arguments: validArguments,
    }), deps);

    expect(busy.result).toEqual({
      content: [{ type: 'text', text: '{"status":"error"}' }],
      structuredContent: { status: 'error' },
    });
    finishFirst!();
    await expect(first).resolves.toMatchObject({
      result: { structuredContent: { status: 'ok', result: true } },
    });

    const release = tryAcquireToolCall();
    expect(release).toEqual(expect.any(Function));
    release();
  });

  it('authenticates a private bearer capability in constant-length comparisons', () => {
    expect(safeCapabilityEquals(`Bearer ${capability}`, capability)).toBe(true);
    expect(safeCapabilityEquals(`Bearer ${capability.slice(1)}`, capability)).toBe(false);
    expect(safeCapabilityEquals(capability, capability)).toBe(false);
  });
});

describe('AWF enclave MCP HTTP framing', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = createMcpServer({
      handlers: { [TOOL_NAME]: fakeBroker(CANONICAL_ERROR_RESPONSE_JSON) },
      capability,
      maxScriptBytes: 65536,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener');
    port = address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function request(body: string, authorization?: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: authorization ? { authorization } : {},
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it('rejects unauthenticated requests before dispatch', async () => {
    const response = await request(JSON.stringify(rpc('tools/list')));
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe(-32001);
  });

  it('accepts authenticated JSON-RPC and emits no notification body', async () => {
    const listed = await request(
      JSON.stringify(rpc('tools/list')),
      `Bearer ${capability}`,
    );
    expect(listed.status).toBe(200);
    expect(JSON.parse(listed.body).result.tools).toHaveLength(1);

    const notified = await request(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      `Bearer ${capability}`,
    );
    expect(notified).toEqual({ status: 202, body: '' });
  });
});

describe('unified enclave ledger and timing', () => {
  it('debits the shared ledger with executor kind script', () => {
    const ledger = createEnclaveInformationBudgetLedger(new Map([
      ['Octo/Private', { sensitivity: 'confidential' }],
    ]));
    expect(ledger.tryDebit('octo/private', 4, 'script')).toBe(true);
    expect(ledger.tryDebit('OCTO/PRIVATE', 4, 'agent')).toBe(true);
    expect(ledger.tryDebit('octo/private', 1, 'script')).toBe(false);
  });

  it('includes executor cleanup in the selected timing bucket', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const clock = {
      nowMs: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    };
    const ledger = { tryDebit: jest.fn(() => true) };
    const broker = createExecutorHandler({
      config: {
        maxInvocations: 2,
        timeoutSeconds: 30,
        primaryBackend: 'docker',
        executorBackend: 'docker',
      },
      seedMap: new Map([['octo/private', { seedId: 'a'.repeat(16), sensitivity: 'internal' }]]),
      runId: 'a'.repeat(16),
      audit: { failure: jest.fn(), invocation: jest.fn() },
      telemetry: { emit: jest.fn() },
      ledger,
      executorKind: 'script',
      uniformTiming: true,
      clock,
      runner: {
        runScriptContainer: async () => {
          now += 5;
          return { exitCode: 0, timedOut: false };
        },
      },
      workspace: {
        createInvocationWorkspace: () => ({ outPath: 'unused' }),
        readQueryOutput: () => 'true',
        destroyInvocationWorkspace: () => {
          now += 70;
        },
      },
    });
    let result = '';
    await broker.handle(validArguments, (value: string) => { result = value; });
    expect(result).toBe('{"status":"ok","result":true}');
    expect(ledger.tryDebit).toHaveBeenCalledWith('octo/private', 5, 'script');
    expect(sleeps).toEqual([25]);
    expect(now).toBe(100);
  });

  it('buckets repository and budget rejection classes to the same public boundary', async () => {
    async function rejected(seedMap: Map<string, unknown>, debit: boolean) {
      let now = 0;
      const broker = createExecutorHandler({
        config: {
          maxInvocations: 1,
          timeoutSeconds: 30,
          primaryBackend: 'docker',
          executorBackend: 'docker',
        },
        seedMap,
        runId: 'a'.repeat(16),
        audit: { failure: jest.fn(), invocation: jest.fn() },
        telemetry: { emit: jest.fn() },
        ledger: { tryDebit: () => debit },
        executorKind: 'script',
        uniformTiming: true,
        clock: {
          nowMs: () => now,
          sleep: async (ms: number) => { now += ms; },
        },
        runner: {},
      });
      let result = '';
      await broker.handle(validArguments, (value: string) => { result = value; });
      return { now, result };
    }
    const unknown = await rejected(new Map(), true);
    const exhausted = await rejected(new Map([
      ['octo/private', { seedId: 'a'.repeat(16), sensitivity: 'confidential' }],
    ]), false);
    expect(unknown).toEqual({ now: 10, result: CANONICAL_ERROR_RESPONSE_JSON });
    expect(exhausted).toEqual(unknown);
  });

  it('buckets invocation-count exhaustion instead of revealing remaining capacity', async () => {
    let now = 0;
    const clock = {
      nowMs: () => now,
      sleep: async (ms: number) => { now += ms; },
    };
    const broker = createExecutorHandler({
      config: {
        maxInvocations: 1,
        timeoutSeconds: 30,
        primaryBackend: 'docker',
        executorBackend: 'docker',
      },
      seedMap: new Map(),
      runId: 'a'.repeat(16),
      audit: { failure: jest.fn(), invocation: jest.fn() },
      telemetry: { emit: jest.fn() },
      ledger: { tryDebit: jest.fn() },
      executorKind: 'script',
      uniformTiming: true,
      clock,
      runner: {},
    });
    await broker.handle(validArguments, () => undefined);
    const startedAt = now;
    let response = '';
    await broker.handle(validArguments, (value: string) => { response = value; });
    expect(response).toBe(CANONICAL_ERROR_RESPONSE_JSON);
    expect(now - startedAt).toBe(10);
  });

  it('starts an exhausted invocation timing bucket after queued work completes', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const handler = createExecutorHandler({
      config: {
        maxInvocations: 1,
        timeoutSeconds: 30,
        primaryBackend: 'docker',
        executorBackend: 'docker',
      },
      seedMap: new Map([['octo/private', { seedId: 'a'.repeat(16), sensitivity: 'internal' }]]),
      runId: 'a'.repeat(16),
      audit: { failure: jest.fn(), invocation: jest.fn() },
      telemetry: { emit: jest.fn() },
      ledger: { tryDebit: () => true },
      executorKind: 'script',
      uniformTiming: true,
      clock: {
        nowMs: () => now,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          now += ms;
        },
      },
      runner: {
        runScriptContainer: async () => {
          now += 50;
          return { exitCode: 0, timedOut: false };
        },
      },
      workspace: {
        createInvocationWorkspace: () => ({ outPath: 'unused' }),
        readQueryOutput: () => 'true',
        destroyInvocationWorkspace: () => undefined,
      },
    });
    const responses: string[] = [];
    const first = handler.handle(validArguments, (value: string) => responses.push(value));
    const second = handler.handle(validArguments, (value: string) => responses.push(value));
    await Promise.all([first, second]);

    expect(responses).toEqual(['{"status":"ok","result":true}', CANONICAL_ERROR_RESPONSE_JSON]);
    expect(sleeps).toEqual([50, 10]);
    expect(now).toBe(110);
  });
});
