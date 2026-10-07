import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import { HostExecutorJournal } from './host-executor-journal';
import {
  HOST_EXECUTOR_PROTOCOL_VERSION,
  HOST_EXECUTOR_MAX_REQUEST_BYTES,
  HOST_EXECUTOR_MAX_RESPONSE_BYTES,
  HOST_EXECUTOR_MAX_PAYLOAD_BYTES,
  type HostExecutorInvokeRequest,
  canonicalDeniedResponse,
  decodeHostExecutorRequest,
  encodeHostExecutorResponse,
  frameHostExecutorMessage,
  hostExecutorResultDigest,
  isValidHostExecutorResult,
} from './host-executor-protocol';
import { finiteSchemaHash } from '../bounded-execution/schema-hash';
import type { FiniteSchemaNode } from '../bounded-execution/finite-schema';
import {
  type HostEnclaveExecutorBackend,
  type HostExecutorBackendResult,
  type HostExecutorInvocationPlan,
  type HostExecutorRunState,
  type HostExecutorServer,
  type HostExecutorServerOptions,
  deriveHostExecutorInvocationPlan,
  startHostExecutorServer,
} from './host-executor-server';

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  createHostExecutorClient,
  parseHostExecutorResponse,
} = require(path.join(
  __dirname, '..', '..', 'containers', 'enclave', 'mcp-server', 'host-executor-client.js',
));
const { finiteSchemaHash: brokerFiniteSchemaHash } = require(path.join(
  __dirname, '..', '..', 'containers', 'bounded-execution', 'schema-hash.js',
));
/* eslint-enable @typescript-eslint/no-require-imports */

const RUN_ID = 'a'.repeat(32);
const ENTRY_ID = 'script';
const ALT_ENTRY_ID = 'script-alt';
const AGENT_ENTRY_ID = 'agent';
const INVOCATION_ID = 'b'.repeat(24);
const SEED_ID = 'c'.repeat(32);
const ADMISSION_ID = 'd'.repeat(24);
const SCHEMA = { type: 'boolean' } as const;
const SCHEMA_HASH = finiteSchemaHash(SCHEMA as FiniteSchemaNode);
const CAPABILITY = Buffer.alloc(32, 0xab);
const CAPABILITY_HEX = CAPABILITY.toString('hex');

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).padStart(32, '0');
}

function invokeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: HOST_EXECUTOR_PROTOCOL_VERSION,
    type: 'invoke',
    requestId: nextRequestId(),
    runId: RUN_ID,
    entryId: ENTRY_ID,
    invocationId: INVOCATION_ID,
    capability: CAPABILITY_HEX,
    executorKind: 'script',
    seedId: SEED_ID,
    payload: 'print(1)',
    schema: SCHEMA,
    schemaHash: SCHEMA_HASH,
    admissionId: ADMISSION_ID,
    ...overrides,
  };
}

function encode(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function decode(payload: Buffer, capability = CAPABILITY) {
  return decodeHostExecutorRequest(payload, { capability, runId: RUN_ID });
}

/**
 * Keys that would open a general-purpose host control interface if accepted.
 * None of them is part of any request type.
 */
const PROHIBITED_FIELDS: Record<string, unknown> = {
  command: 'rm -rf /',
  cmd: ['/bin/sh', '-c', 'id'],
  argv: ['/bin/sh'],
  args: ['-c', 'id'],
  executable: '/bin/sh',
  entrypoint: '/bin/sh',
  image: 'attacker/image',
  path: '/etc/shadow',
  hostPath: '/',
  seedPath: '/root',
  workDir: '/tmp',
  mount: '/:/host',
  mounts: [{ source: '/', target: '/host' }],
  volumes: ['/:/host'],
  env: { LD_PRELOAD: '/tmp/x.so' },
  environment: { PATH: '/tmp' },
  network: 'host',
  networkMode: 'host',
  endpoint: 'http://169.254.169.254',
  dns: '8.8.8.8',
  proxy: 'http://evil',
  credential: 'ghp_x',
  token: 'x',
  runtime: 'runc',
  runtimeProfile: 'unconfined',
  kernel: '/tmp/vmlinux',
  memory: 999999,
  cpu: 64,
  timeout: 0,
  uid: 0,
  gid: 0,
  maxOutputBytes: 1e9,
  model: 'x',
};

describe('host executor protocol decoding', () => {
  it('accepts each closed request type', () => {
    const invoke = decode(encode(invokeRequest()));
    expect(invoke).toEqual({
      ok: true,
      request: expect.objectContaining({ type: 'invoke', seedId: SEED_ID, executorKind: 'script' }),
    });
    expect(invoke.ok && 'capability' in invoke.request).toBe(false);

    const dynamic = decode(encode(invokeRequest({
      entryId: AGENT_ENTRY_ID, seedId: undefined, selector: 'octo/repo', executorKind: 'agent',
    })));
    expect(dynamic.ok).toBe(true);

    const base = {
      version: HOST_EXECUTOR_PROTOCOL_VERSION, requestId: nextRequestId(), runId: RUN_ID, entryId: ENTRY_ID,
      invocationId: INVOCATION_ID, capability: CAPABILITY_HEX,
    };
    expect(decode(encode({ ...base, type: 'cancel', cancelGeneration: 1 })).ok).toBe(true);
    expect(decode(encode({ ...base, type: 'settle', resultDigest: SCHEMA_HASH })).ok).toBe(true);
    expect(decode(encode({ ...base, type: 'status' })).ok).toBe(true);
  });

  it('matches the broker schema hash for canonical object-key orderings', () => {
    const schema = {
      type: 'object',
      fields: {
        first: { type: 'string' },
        second: { type: 'boolean' },
      },
    };
    const reordered = {
      type: 'object',
      fields: {
        second: { type: 'boolean' },
        first: { type: 'string' },
      },
    };
    const schemaHash = brokerFiniteSchemaHash(schema);
    expect(finiteSchemaHash(schema)).toBe(schemaHash);
    expect(finiteSchemaHash(reordered)).toBe(schemaHash);
    expect(decode(encode(invokeRequest({ schema: reordered, schemaHash }))).ok).toBe(true);
  });

  it.each([
    ['empty payload', Buffer.alloc(0)],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['non-JSON', Buffer.from('not json')],
    ['JSON array', encode([invokeRequest()])],
    ['trailing data', Buffer.concat([encode(invokeRequest()), Buffer.from('{}')])],
    ['duplicate key', Buffer.from(JSON.stringify(invokeRequest()).replace('"type":"invoke"', '"type":"invoke","type":"status"'))],
    ['oversized frame', Buffer.alloc(HOST_EXECUTOR_MAX_REQUEST_BYTES + 1, 0x20)],
  ])('rejects malformed input: %s', (_name, payload) => {
    expect(decode(payload)).toEqual({ ok: false });
  });

  it.each([
    ['missing capability', { capability: undefined }],
    ['wrong capability', { capability: 'f'.repeat(64) }],
    ['uppercase capability', { capability: CAPABILITY_HEX.toUpperCase() }],
    ['short capability', { capability: CAPABILITY_HEX.slice(2) }],
    ['foreign run', { runId: 'f'.repeat(32) }],
  ])('rejects unauthorized requests: %s', (_name, overrides) => {
    expect(decode(encode(invokeRequest(overrides)))).toEqual({ ok: false });
  });

  it.each([
    ['unsupported version', { version: 1 }],
    ['string version', { version: String(HOST_EXECUTOR_PROTOCOL_VERSION) }],
    ['unknown type', { type: 'exec' }],
    ['non-random request ID', { requestId: 'abc' }],
    ['path-shaped invocation ID', { invocationId: '../../etc/passwd' }],
    ['path-shaped seed ID', { seedId: '../' + 'c'.repeat(30) }],
    ['both seed and selector', { selector: 'octo/repo', executorKind: 'agent' }],
    ['neither seed nor selector', { seedId: undefined }],
    ['selector for script', { seedId: undefined, selector: 'octo/repo' }],
    ['non-canonical selector', { seedId: undefined, selector: 'octo/*', executorKind: 'agent' }],
    ['uppercase selector', { entryId: AGENT_ENTRY_ID, seedId: undefined, selector: 'Octo/repo', executorKind: 'agent' }],
    ['selector with parent traversal', { entryId: AGENT_ENTRY_ID, seedId: undefined, selector: 'octo/..', executorKind: 'agent' }],
    ['invalid entry ID', { entryId: '../agent' }],
    ['unknown executor kind', { executorKind: 'shell' }],
    ['empty payload', { payload: '' }],
    ['oversized payload', { payload: 'x'.repeat(HOST_EXECUTOR_MAX_PAYLOAD_BYTES + 1) }],
    ['lone surrogate payload', { payload: '\ud800' }],
    ['bad schema hash', { schemaHash: 'E'.repeat(64) }],
    ['schema hash mismatch', { schema: { type: 'string' } }],
    ['invalid finite schema', { schema: { type: 'object', fields: {} } }],
    ['missing admission ID', { admissionId: undefined }],
  ])('rejects invalid request: %s', (_name, overrides) => {
    expect(decode(encode(invokeRequest(overrides)))).toEqual({ ok: false });
  });

  it.each(Object.keys(PROHIBITED_FIELDS).concat(['__proto__']))(
    'rejects prohibited field injection: %s',
    (field) => {
      const text = JSON.stringify(invokeRequest()).replace(
        /}$/,
        `,${JSON.stringify(field)}:${JSON.stringify(PROHIBITED_FIELDS[field] ?? { polluted: true })}}`,
      );
      expect(decode(Buffer.from(text))).toEqual({ ok: false });
    },
  );

  it('rejects fields borrowed from another request type', () => {
    expect(decode(encode(invokeRequest({ cancelGeneration: 1 })))).toEqual({ ok: false });
    const base = {
      version: HOST_EXECUTOR_PROTOCOL_VERSION, requestId: nextRequestId(), runId: RUN_ID, entryId: ENTRY_ID,
      invocationId: INVOCATION_ID, capability: CAPABILITY_HEX,
    };
    expect(decode(encode({ ...base, type: 'status', payload: 'x' }))).toEqual({ ok: false });
    expect(decode(encode({ ...base, type: 'cancel', cancelGeneration: 0 }))).toEqual({ ok: false });
    expect(decode(encode({ ...base, type: 'cancel', cancelGeneration: 1.5 }))).toEqual({ ok: false });
  });

  it('bounds responses and results', () => {
    expect(isValidHostExecutorResult('success', 'x'.repeat(8 * 1024))).toBe(true);
    expect(isValidHostExecutorResult('success', 'x'.repeat(8 * 1024 + 1))).toBe(false);
    expect(isValidHostExecutorResult('timeout', 'leak')).toBe(false);
    expect(isValidHostExecutorResult('rooted', undefined)).toBe(false);
    // Worst-case JSON escaping of a maximal result still fits the response bound.
    const worst = encodeHostExecutorResponse({
      version: HOST_EXECUTOR_PROTOCOL_VERSION, ok: true, requestId: '0'.repeat(32), invocationId: INVOCATION_ID,
      state: 'terminal', cancelGeneration: 0, outcome: 'success',
      result: '\u0001'.repeat(8 * 1024), resultDigest: SCHEMA_HASH,
    });
    expect(worst.length).toBeLessThanOrEqual(HOST_EXECUTOR_MAX_RESPONSE_BYTES);
    expect(JSON.parse(worst.toString()).ok).toBe(true);
  });
});

describe('host executor plan derivation', () => {
  const runState: HostExecutorRunState = {
    runId: RUN_ID,
    seedsDir: '/var/lib/awf/seeds',
    invocationsDir: '/var/lib/awf/invocations',
    entries: [
      { entryId: ENTRY_ID, executorKind: 'script', timeoutMs: 60_000, staticSeedIds: [SEED_ID], dynamicAgents: false },
      { entryId: ALT_ENTRY_ID, executorKind: 'script', timeoutMs: 60_000, staticSeedIds: [SEED_ID], dynamicAgents: false },
      { entryId: AGENT_ENTRY_ID, executorKind: 'agent', timeoutMs: 60_000, staticSeedIds: [], dynamicAgents: false },
    ],
  };

  function request(overrides: Record<string, unknown> = {}): HostExecutorInvokeRequest {
    const decoded = decode(encode(invokeRequest(overrides)));
    if (!decoded.ok || decoded.request.type !== 'invoke') throw new Error('fixture must decode');
    return decoded.request;
  }

  it('derives host paths only from trusted run state and validated identifiers', () => {
    const plan = deriveHostExecutorInvocationPlan(runState, request());
    expect(plan).toEqual(expect.objectContaining({
      runId: RUN_ID,
      invocationId: INVOCATION_ID,
      seedHostPath: `/var/lib/awf/seeds/${SEED_ID}`,
      invocationHostDir: `/var/lib/awf/invocations/${ENTRY_ID}/${INVOCATION_ID}`,
    }));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.keys(plan).sort()).toEqual([
      'admissionId', 'entryId', 'executorKind', 'invocationHostDir', 'invocationId', 'payload',
      'requestHash', 'runId', 'schema', 'schemaHash', 'seedHostPath', 'seedId', 'timeoutMs',
    ]);
    expect(plan.timeoutMs).toBe(60_000);
  });

  it('denies seeds outside the trusted catalog, disabled kinds, and disabled dynamic admission', () => {
    expect(() => deriveHostExecutorInvocationPlan(runState, request({ seedId: 'f'.repeat(32) }))).toThrow('denied');
    expect(() => deriveHostExecutorInvocationPlan(
      { ...runState, entries: [{ ...runState.entries[2], entryId: ENTRY_ID }] }, request(),
    )).toThrow('denied');
    expect(() => deriveHostExecutorInvocationPlan(
      runState, request({
        entryId: AGENT_ENTRY_ID, seedId: undefined, selector: 'octo/repo', executorKind: 'agent',
      }),
    )).toThrow('denied');
    const dynamic = deriveHostExecutorInvocationPlan(
      {
        ...runState,
        entries: runState.entries.map((entry) => entry.entryId === AGENT_ENTRY_ID
          ? { ...entry, dynamicAgents: true }
          : entry),
      },
      request({ entryId: AGENT_ENTRY_ID, seedId: undefined, selector: 'octo/repo', executorKind: 'agent' }),
    );
    expect(dynamic.selector).toBe('octo/repo');
    expect(dynamic.seedHostPath).toBeUndefined();
  });

  it('denies entry IDs that are not in the trusted run catalog', () => {
    expect(() => deriveHostExecutorInvocationPlan(
      runState, request({ entryId: 'untrusted-entry' }),
    )).toThrow('denied');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function rawExchange(socketPath: string, bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks: Buffer[] = [];
    socket.on('connect', () => socket.end(bytes));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const buffer = Buffer.concat(chunks);
      resolve(buffer.subarray(4, 4 + buffer.readUInt32BE(0)));
    });
  });
}

describe('host executor server', () => {
  let root: string;
  let server: HostExecutorServer | undefined;
  let executions: HostExecutorInvocationPlan[];
  let pending: Array<ReturnType<typeof deferred<HostExecutorBackendResult>>>;
  let signals: AbortSignal[];

  const backend: HostEnclaveExecutorBackend = {
    execute: (plan, signal) => {
      executions.push(plan);
      signals.push(signal);
      const next = deferred<HostExecutorBackendResult>();
      pending.push(next);
      return next.promise;
    },
  };

  async function start(
    overrides: Partial<HostExecutorRunState> = {},
    options: Partial<HostExecutorServerOptions> = {},
  ) {
    server = await startHostExecutorServer({
      runtimeDir: path.join(root, 'runtime'),
      backend,
      runState: {
        runId: RUN_ID,
        seedsDir: path.join(root, 'seeds'),
        invocationsDir: path.join(root, 'invocations'),
        journalDir: path.join(root, 'host-executor-journal'),
        entries: [
          { entryId: ENTRY_ID, executorKind: 'script', timeoutMs: 60_000, staticSeedIds: [SEED_ID], dynamicAgents: false },
          { entryId: ALT_ENTRY_ID, executorKind: 'script', timeoutMs: 60_000, staticSeedIds: [SEED_ID], dynamicAgents: false },
          { entryId: AGENT_ENTRY_ID, executorKind: 'agent', timeoutMs: 60_000, staticSeedIds: [], dynamicAgents: false },
        ],
        ...overrides,
      },
      ...options,
    });
    return server;
  }

  function client() {
    return createHostExecutorClient({
      socketPath: server!.socketPath,
      capabilityPath: server!.capabilityPath,
      runId: RUN_ID,
    });
  }

  const invokeArgs = {
    entryId: ENTRY_ID,
    invocationId: INVOCATION_ID,
    executorKind: 'script',
    seedId: SEED_ID,
    payload: 'print(1)',
    schema: SCHEMA,
    schemaHash: SCHEMA_HASH,
    admissionId: ADMISSION_ID,
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awf-host-')));
    executions = [];
    pending = [];
    signals = [];
  });

  afterEach(async () => {
    for (const entry of pending) entry.resolve({ outcome: 'executor-failure' });
    await server?.close();
    server = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a private socket and capability and destroys both on close', async () => {
    const started = await start();
    expect(fs.statSync(path.join(root, 'runtime')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(started.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(started.capabilityPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(started.capabilityPath, 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    await started.close();
    server = undefined;
    expect(fs.existsSync(started.socketPath)).toBe(false);
    expect(fs.existsSync(started.capabilityPath)).toBe(false);
  });

  it('refuses to reuse an existing socket or capability', async () => {
    fs.mkdirSync(path.join(root, 'runtime'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'runtime', 'capability'), 'f'.repeat(64));
    await expect(start()).rejects.toThrow('already exists');
  });

  it.each(['journal-inside-runtime', 'runtime-inside-journal'] as const)(
    'rejects broker-visible journal overlap: %s',
    async (placement) => {
      await expect(start({
        journalDir: placement === 'journal-inside-runtime' ? path.join(root, 'runtime', 'journal') : root,
      })).rejects.toThrow('must be separate');
      expect(executions).toHaveLength(0);
    },
  );

  it('runs a full invoke → status → settle lifecycle through the broker client', async () => {
    await start();
    const broker = client();
    const accepted = await broker.invoke(invokeArgs);
    expect(accepted).toEqual(expect.objectContaining({ ok: true, state: 'running', invocationId: INVOCATION_ID }));
    expect(executions).toHaveLength(1);
    expect(executions[0].seedHostPath).toBe(path.join(root, 'seeds', SEED_ID));
    expect(executions[0].invocationHostDir).toBe(path.join(root, 'invocations', ENTRY_ID, INVOCATION_ID));

    pending[0].resolve({ outcome: 'success', result: '{"ok":true}' });
    await new Promise((r) => setImmediate(r));
    const terminal = await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID });
    expect(terminal).toEqual(expect.objectContaining({
      state: 'terminal',
      outcome: 'success',
      result: '{"ok":true}',
      resultDigest: hostExecutorResultDigest('success', '{"ok":true}'),
    }));

    const wrong = await broker.settle({ entryId: ENTRY_ID, invocationId: INVOCATION_ID, resultDigest: 'f'.repeat(64) });
    expect(wrong).toEqual(expect.objectContaining({ ok: false, error: 'conflict' }));
    const settled = await broker.settle({
      entryId: ENTRY_ID, invocationId: INVOCATION_ID, resultDigest: terminal.resultDigest,
    });
    expect(settled).toEqual(expect.objectContaining({ ok: true, state: 'settled', outcome: 'success' }));
    expect(settled.result).toBeUndefined();
  });

  it('answers every pre-authentication failure with the identical canonical denial and no side effects', async () => {
    const started = await start();
    const canonical = canonicalDeniedResponse();
    const cases = [
      frameHostExecutorMessage(encode(invokeRequest({ capability: 'f'.repeat(64) }))),
      frameHostExecutorMessage(encode(invokeRequest({ version: 1 }))),
      frameHostExecutorMessage(encode(invokeRequest(PROHIBITED_FIELDS))),
      frameHostExecutorMessage(encode(invokeRequest({ command: '/bin/sh' }))),
      frameHostExecutorMessage(Buffer.from([0xff, 0xfe])),
      Buffer.from([0, 0, 0, 0]),
    ];
    for (const bytes of cases) {
      expect(await rawExchange(started.socketPath, bytes)).toEqual(canonical);
    }
    expect(executions).toHaveLength(0);
  });

  it('rejects an oversized frame from its header without buffering the body', async () => {
    const started = await start();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(HOST_EXECUTOR_MAX_REQUEST_BYTES + 1, 0);
    expect(await rawExchange(started.socketPath, header)).toEqual(canonicalDeniedResponse());
    expect(executions).toHaveLength(0);
  });

  it('rejects trailing bytes after the single request frame', async () => {
    const started = await start();
    const capability = fs.readFileSync(started.capabilityPath, 'utf8');
    const frame = frameHostExecutorMessage(encode(invokeRequest({ capability })));
    const response = await rawExchange(started.socketPath, Buffer.concat([frame, frame]));
    expect(response).toEqual(canonicalDeniedResponse());
    expect(executions).toHaveLength(0);
  });

  it('waits for EOF before executing an exactly sized frame', async () => {
    const started = await start();
    const capability = fs.readFileSync(started.capabilityPath, 'utf8');
    const frame = frameHostExecutorMessage(encode(invokeRequest({ capability })));
    const responsePromise = new Promise<Buffer>((resolve, reject) => {
      const socket = net.createConnection(started.socketPath);
      const chunks: Buffer[] = [];
      socket.on('connect', () => {
        socket.write(frame);
        setTimeout(() => socket.end(Buffer.from('trailing')), 20);
      });
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('error', reject);
      socket.on('close', () => {
        const response = Buffer.concat(chunks);
        resolve(response.subarray(4, 4 + response.readUInt32BE(0)));
      });
    });
    expect(await responsePromise).toEqual(canonicalDeniedResponse());
    expect(executions).toHaveLength(0);
  });

  it('rejects replayed request IDs without executing again', async () => {
    const started = await start();
    const capability = fs.readFileSync(started.capabilityPath, 'utf8');
    const frame = frameHostExecutorMessage(encode(invokeRequest({ capability })));
    expect(JSON.parse((await rawExchange(started.socketPath, frame)).toString()).ok).toBe(true);
    const replay = JSON.parse((await rawExchange(started.socketPath, frame)).toString());
    expect(replay).toEqual(expect.objectContaining({ ok: false, error: 'replayed' }));
    expect(executions).toHaveLength(1);
  });

  it('keys invoke retries by entry and invocation and rejects differing requests', async () => {
    await start();
    const broker = client();
    await broker.invoke(invokeArgs);
    const retry = await broker.invoke(invokeArgs);
    expect(retry).toEqual(expect.objectContaining({ ok: true, state: 'running' }));
    const conflict = await broker.invoke({ ...invokeArgs, payload: 'print(2)' });
    expect(conflict).toEqual(expect.objectContaining({ ok: false, error: 'conflict' }));
    const otherEntry = await broker.invoke({ ...invokeArgs, entryId: ALT_ENTRY_ID });
    expect(otherEntry).toEqual(expect.objectContaining({ ok: false, error: 'conflict' }));
    const newIdentity = await broker.invoke({
      ...invokeArgs, entryId: ALT_ENTRY_ID,
      invocationId: '1'.repeat(32), admissionId: '2'.repeat(32),
    });
    expect(newIdentity).toEqual(expect.objectContaining({ ok: true, state: 'running' }));
    expect(executions).toHaveLength(2);
    expect(executions[0].invocationHostDir).not.toBe(executions[1].invocationHostDir);
  });

  it('denies seeds outside the trusted catalog with no execution', async () => {
    await start();
    const denied = await client().invoke({ ...invokeArgs, seedId: 'f'.repeat(32) });
    expect(denied).toEqual(expect.objectContaining({ ok: false, error: 'denied' }));
    expect(executions).toHaveLength(0);
  });

  it('cancels with monotonic generations and reports a canonical cancelled outcome', async () => {
    await start();
    const broker = client();
    await broker.invoke(invokeArgs);
    const cancelling = await broker.cancel({ entryId: ENTRY_ID, invocationId: INVOCATION_ID, cancelGeneration: 1 });
    expect(cancelling).toEqual(expect.objectContaining({ ok: true, state: 'cancelling', cancelGeneration: 1 }));
    expect(signals[0].aborted).toBe(true);
    const replay = await broker.cancel({ entryId: ENTRY_ID, invocationId: INVOCATION_ID, cancelGeneration: 1 });
    expect(replay).toEqual(expect.objectContaining({ ok: false, error: 'replayed' }));
    const early = await broker.settle({ entryId: ENTRY_ID, invocationId: INVOCATION_ID, resultDigest: SCHEMA_HASH });
    expect(early).toEqual(expect.objectContaining({ ok: false, error: 'invalid-state' }));

    pending[0].resolve({ outcome: 'success', result: 'late' });
    await new Promise((r) => setImmediate(r));
    const status = await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID });
    expect(status).toEqual(expect.objectContaining({ state: 'terminal', outcome: 'cancelled' }));
    expect(status.result).toBeUndefined();
  });

  it('maps invalid or failing backend results to a redacted executor failure', async () => {
    await start();
    const broker = client();
    await broker.invoke(invokeArgs);
    pending[0].resolve({ outcome: 'timeout', result: 'private stdout' } as HostExecutorBackendResult);
    await new Promise((r) => setImmediate(r));
    const status = await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID });
    expect(status).toEqual(expect.objectContaining({ outcome: 'executor-failure' }));
    expect(JSON.stringify(status)).not.toContain('private stdout');
  });

  it('reports unknown invocations and closes admissions without affecting status', async () => {
    const started = await start();
    const broker = client();
    expect(await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID })).toEqual(
      expect.objectContaining({ ok: false, error: 'unknown-invocation' }),
    );
    await broker.invoke(invokeArgs);
    started.closeAdmissions();
    const closed = await broker.invoke({ ...invokeArgs, invocationId: 'f'.repeat(24) });
    expect(closed).toEqual(expect.objectContaining({ ok: false, error: 'closed' }));
    expect(await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID }))
      .toEqual(expect.objectContaining({ ok: true }));
    expect(executions).toHaveLength(1);
  });

  it('aborts running invocations on close', async () => {
    const started = await start();
    await client().invoke(invokeArgs);
    const closing = started.close();
    const secondClose = started.close();
    expect(secondClose).toBe(closing);
    expect(signals[0].aborted).toBe(true);
    expect(fs.existsSync(started.capabilityPath)).toBe(true);
    pending[0].resolve({ outcome: 'executor-failure' });
    await Promise.all([closing, secondClose]);
    expect(fs.existsSync(started.capabilityPath)).toBe(false);
    server = undefined;
  });

  it('rejects terminal/settled invokes and admission identity reuse', async () => {
    await start();
    const broker = client();
    await broker.invoke(invokeArgs);
    const reused = await broker.invoke({ ...invokeArgs, invocationId: 'e'.repeat(24) });
    expect(reused).toEqual(expect.objectContaining({ ok: false, error: 'conflict' }));
    pending[0].resolve({ outcome: 'timeout' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await broker.invoke(invokeArgs)).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid-state' }),
    );
    const terminal = await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID });
    await broker.settle({ entryId: ENTRY_ID, invocationId: INVOCATION_ID, resultDigest: terminal.resultDigest });
    expect(await broker.invoke(invokeArgs)).toEqual(
      expect.objectContaining({ ok: false, error: 'invalid-state' }),
    );
    expect(executions).toHaveLength(1);
  });

  it('persists the invocation before launch and never reopens a closed run', async () => {
    await start();
    await client().invoke(invokeArgs);
    const file = path.join(root, 'host-executor-journal', `${RUN_ID}.journal`);
    const journal = fs.readFileSync(file, 'utf8');
    expect(journal).toContain(ADMISSION_ID);
    expect(journal).toContain(INVOCATION_ID);
    expect(journal).not.toContain(invokeArgs.payload);
    pending[0].resolve({ outcome: 'executor-failure' });
    await server!.close();
    server = undefined;
    await expect(start()).rejects.toThrow('EEXIST');
    expect(executions).toHaveLength(1);
  });

  it.each(['timeout', 'lease'] as const)('enforces host %s and waits for cleanup before terminal', async (reason) => {
    await start({
      entries: [{
        entryId: ENTRY_ID, executorKind: 'script', timeoutMs: reason === 'timeout' ? 30 : 60_000,
        staticSeedIds: [SEED_ID], dynamicAgents: false,
      }],
    }, { statusLeaseMs: reason === 'lease' ? 30 : 1000 });
    const broker = client();
    await broker.invoke(invokeArgs);
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(signals[0].aborted).toBe(true);
    expect(await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID })).toEqual(
      expect.objectContaining({ state: 'cancelling' }),
    );
    pending[0].resolve({ outcome: 'success', result: 'true' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID })).toEqual(
      expect.objectContaining({ state: 'terminal', outcome: reason === 'timeout' ? 'timeout' : 'cancelled' }),
    );
  });

  it('renews liveness only with fresh authenticated status, not invoke retries', async () => {
    await start({}, { statusLeaseMs: 100 });
    const broker = client();
    await broker.invoke(invokeArgs);
    for (let count = 0; count < 3; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID });
      expect(signals[0].aborted).toBe(false);
    }
    for (let count = 0; count < 3; count += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      await broker.invoke(invokeArgs);
    }
    expect(signals[0].aborted).toBe(true);
  });

  it('keeps incomplete cleanup nonterminal and closes further admissions', async () => {
    await start();
    const broker = client();
    await broker.invoke(invokeArgs);
    await broker.cancel({ entryId: ENTRY_ID, invocationId: INVOCATION_ID, cancelGeneration: 1 });
    pending[0].resolve({ outcome: 'executor-failure', cleanupComplete: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID })).toEqual(
      expect.objectContaining({ state: 'cancelling' }),
    );
    const status = await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID });
    expect(status.outcome).toBeUndefined();
    expect(status.resultDigest).toBeUndefined();
    expect(await broker.invoke({
      ...invokeArgs, invocationId: '1'.repeat(24), admissionId: '2'.repeat(24),
    })).toEqual(expect.objectContaining({ ok: false, error: 'closed' }));
  });

  it('does not launch when the durable admission write cannot be synced', async () => {
    await start();
    const sync = jest.spyOn(HostExecutorJournal.prototype, 'record').mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
    try {
      expect(await client().invoke(invokeArgs)).toEqual(
        expect.objectContaining({ ok: false, error: 'denied' }),
      );
      expect(executions).toHaveLength(0);
      expect(await client().invoke(invokeArgs)).toEqual(
        expect.objectContaining({ ok: false, error: 'closed' }),
      );
    } finally { sync.mockRestore(); }
  });

  it('aborts cancellation and closes admissions even when every journal write fails', async () => {
    await start();
    const broker = client();
    await broker.invoke(invokeArgs);
    const writes = jest.spyOn(HostExecutorJournal.prototype, 'record').mockImplementation(() => {
      throw new Error('persistent storage failure');
    });
    try {
      expect(await broker.cancel({
        entryId: ENTRY_ID, invocationId: INVOCATION_ID, cancelGeneration: 1,
      })).toEqual(expect.objectContaining({ ok: false, error: 'denied' }));
      expect(signals[0].aborted).toBe(true);
      expect(await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID })).toEqual(
        expect.objectContaining({ state: 'cancelling' }),
      );
      expect(await broker.invoke({
        ...invokeArgs, invocationId: '1'.repeat(24), admissionId: '2'.repeat(24),
      })).toEqual(expect.objectContaining({ ok: false, error: 'closed' }));
    } finally { writes.mockRestore(); }
  });

  it('does not disguise executor failure as cancellation and stops subsequent execution', async () => {
    await start();
    const broker = client();
    await broker.invoke(invokeArgs);
    await broker.cancel({ entryId: ENTRY_ID, invocationId: INVOCATION_ID, cancelGeneration: 1 });
    pending[0].resolve({ outcome: 'executor-failure' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID })).toEqual(
      expect.objectContaining({ state: 'terminal', outcome: 'executor-failure' }),
    );
    expect(await broker.invoke({
      ...invokeArgs, invocationId: '1'.repeat(24), admissionId: '2'.repeat(24),
    })).toEqual(expect.objectContaining({ ok: false, error: 'closed' }));
  });

  it('keeps backend rejection nonterminal because cleanup is unconfirmed', async () => {
    await start({}, { backend: { execute: async () => { throw new Error('unconfirmed cleanup'); } } });
    const broker = client();
    await broker.invoke(invokeArgs);
    await new Promise((resolve) => setImmediate(resolve));
    const status = await broker.status({ entryId: ENTRY_ID, invocationId: INVOCATION_ID });
    expect(status).toEqual(expect.objectContaining({ state: 'cancelling' }));
    expect(status.outcome).toBeUndefined();
    expect(status.resultDigest).toBeUndefined();
    expect(await broker.invoke({
      ...invokeArgs, invocationId: '1'.repeat(24), admissionId: '2'.repeat(24),
    })).toEqual(expect.objectContaining({ ok: false, error: 'closed' }));
  });

  it('keeps the broker client closed to prohibited fields', async () => {
    await start();
    await expect(client().invoke({ ...invokeArgs, command: '/bin/sh' })).rejects.toThrow('unsupported field');
    await expect(client().invoke({ ...invokeArgs, env: { A: 'b' } })).rejects.toThrow('unsupported field');
    expect(executions).toHaveLength(0);
  });

  it('broker response parser rejects unexpected fields and mismatched request IDs', () => {
    const requestId = '1'.repeat(32);
    const ok = { version: HOST_EXECUTOR_PROTOCOL_VERSION, ok: true, requestId, invocationId: INVOCATION_ID, state: 'running', cancelGeneration: 0 };
    expect(parseHostExecutorResponse(encode(ok), requestId)).toEqual(ok);
    expect(parseHostExecutorResponse(encode({ ...ok, hostPath: '/' }), requestId)).toBeUndefined();
    expect(parseHostExecutorResponse(encode(ok), '2'.repeat(32))).toBeUndefined();
    expect(parseHostExecutorResponse(encode({ ...ok, version: 1 }), requestId)).toBeUndefined();
    expect(parseHostExecutorResponse(canonicalDeniedResponse(), requestId)).toEqual(
      { version: HOST_EXECUTOR_PROTOCOL_VERSION, ok: false, error: 'denied' },
    );
    expect(parseHostExecutorResponse(Buffer.alloc(HOST_EXECUTOR_MAX_RESPONSE_BYTES + 1, 0x20), requestId))
      .toBeUndefined();
  });

  it('broker response parser enforces lifecycle-specific result fields and bounds', () => {
    const requestId = '1'.repeat(32);
    const base = {
      version: HOST_EXECUTOR_PROTOCOL_VERSION, ok: true, requestId, invocationId: INVOCATION_ID, cancelGeneration: 0,
    };
    expect(parseHostExecutorResponse(encode({ ...base, state: 'running', outcome: 'success' }), requestId))
      .toBeUndefined();
    expect(parseHostExecutorResponse(encode({ ...base, state: 'terminal', resultDigest: SCHEMA_HASH }), requestId))
      .toBeUndefined();
    expect(parseHostExecutorResponse(encode({
      ...base, state: 'terminal', outcome: 'success', resultDigest: SCHEMA_HASH, result: 'x'.repeat(8 * 1024 + 1),
    }), requestId)).toBeUndefined();
    expect(parseHostExecutorResponse(encode({
      ...base, state: 'terminal', outcome: 'success', resultDigest: SCHEMA_HASH, result: '\ud800',
    }), requestId)).toBeUndefined();
    expect(parseHostExecutorResponse(encode({
      ...base, state: 'settled', outcome: 'success', resultDigest: SCHEMA_HASH, result: 'settled result',
    }), requestId)).toBeUndefined();
    expect(parseHostExecutorResponse(encode({
      ...base, state: 'terminal', outcome: 'executor-failure', resultDigest: SCHEMA_HASH,
    }), requestId)).toBeDefined();
  });
});
