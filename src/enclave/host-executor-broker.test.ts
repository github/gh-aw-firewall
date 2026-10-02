import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { CloudHypervisorHostEnclaveExecutorBackend } from '../cloud-hypervisor/host-enclave-executor';
import type {
  HostEnclaveExecutorDependencies,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from '../cloud-hypervisor/host-enclave-executor';
import type { CloudHypervisorPreflightResult } from '../cloud-hypervisor/preflight';
import { startHostExecutorServer, type HostExecutorServer, type HostExecutorRunState } from './host-executor-server';

/* eslint-disable @typescript-eslint/no-require-imports */
const { createHostExecutorRunner } = require('../../containers/enclave/mcp-server/host-executor-runner');
const { createExecutorHandler } = require('../../containers/enclave/script-executor/executor-handler');
const { createAgentRequestValidator } = require('../../containers/enclave/mcp-server/agent-executor');
const { createMcpServer } = require('../../containers/enclave/mcp-server/server');
const { createEnclaveInformationBudgetLedger } = require('../../containers/bounded-execution/sensitivity-ledger');
const { loadConfig, loadAgentConfig, HOST_EXECUTOR_DIR } = require('../../containers/enclave/mcp-server/config');
/* eslint-enable @typescript-eslint/no-require-imports */

const runId = 'a'.repeat(32);
const seedId = 'b'.repeat(32);
const schema = { type: 'boolean' };
const noop = async () => undefined;
type Role = 'script' | 'agent';

describe('finite-disclosure broker → authenticated Unix host → concrete microVM backend', () => {
  let root: string;
  let host: HostExecutorServer | undefined;
  let proxy: net.Server | undefined;
  let httpServer: http.Server | undefined;
  let output: string;
  let executeError: boolean;
  let cleanupError: boolean;
  let hanging: boolean;
  let startupHanging: boolean;
  let corrupt: 'digest' | 'schema' | 'settle' | 'truncate' | undefined;
  let resolveExecution: (() => void) | undefined;
  let offset: number;
  const started = jest.fn();
  const stopped = jest.fn();
  const cancelled = jest.fn();
  const cleaned = jest.fn();
  const plans: Array<{ entryId: string; invocationId: string; admissionId: string; executorKind: string }> = [];
  const requests: Array<Record<string, unknown>> = [];
  const journalEvents: string[] = [];
  const seedMap = new Map([['octo/private', { seedId, sensitivity: 'internal' }]]);
  let runState: HostExecutorRunState;
  let backend: CloudHypervisorHostEnclaveExecutorBackend;
  const activeHandlers: Array<{ close(): void; drain(): Promise<void> }> = [];

  beforeEach(async () => {
    root = path.join(process.cwd(), `.broker-fixture-${randomBytes(8).toString('hex')}`);
    await fs.mkdir(root, { mode: 0o700 });
    root = await fs.realpath(root);
    await fs.mkdir(path.join(root, 'seeds'), { mode: 0o700 });
    await fs.mkdir(path.join(root, 'seeds', seedId), { mode: 0o700 });
    await fs.mkdir(path.join(root, 'invocations'), { mode: 0o700 });
    output = 'true';
    hanging = false;
    startupHanging = false;
    executeError = false;
    cleanupError = false;
    corrupt = undefined;
    offset = 0;
    resolveExecution = undefined;
    plans.length = 0;
    requests.length = 0;
    journalEvents.length = 0;
    activeHandlers.length = 0;
    for (const spy of [started, stopped, cancelled, cleaned]) spy.mockClear();
    runState = {
      runId,
      seedsDir: path.join(root, 'seeds'),
      invocationsDir: path.join(root, 'invocations'),
      entries: (['script', 'agent'] as const).map((role) => ({
        entryId: `${role}-entry`, executorKind: role, timeoutMs: 30_000,
        staticSeedIds: [seedId], dynamicAgents: false,
      })),
    };
    const artifact = {
      sizeBytes: 7,
      sha256: createHash('sha256').update('fixture').digest('hex'),
    };
    const artifacts = {
      manifest: { release: { tag: 'v0.23.1' }, rootfs: {
        script: { entrypoint: '/usr/local/bin/run-enclave-script' },
        agent: { entrypoint: '/usr/local/bin/run-enclave-agent' },
      } },
      manifestPath: '/trusted/manifest',
      manifestBundlePath: '/trusted/bundle',
      rootfs: {
        script: { path: '/trusted/script-rootfs', artifact },
        agent: { path: '/trusted/agent-rootfs', artifact },
      },
    } as unknown as VerifiedCloudHypervisorEnclaveArtifacts;
    const dependencies: Partial<HostEnclaveExecutorDependencies> = {
      createArtifactSnapshot: async (_sources, _copy, onDirectoryCreated) => {
        const directory = path.join(root, `snapshot-${randomBytes(6).toString('hex')}`);
        await fs.mkdir(directory, { mode: 0o700 });
        await onDirectoryCreated?.(directory);
        const rootfsPath = path.join(directory, 'rootfs');
        await fs.writeFile(rootfsPath, 'fixture', { mode: 0o400 });
        return {
          directory, rootfsPath,
          cloudHypervisorBinary: '/trusted/ch', virtiofsdBinary: '/trusted/virtiofsd',
          kernelPath: '/trusted/kernel', supervisorPath: '/trusted/supervisor',
        };
      },
      createResourceJournal: async () => ({
        captureDirectory: noop, captureMount: noop,
        prepareSnapshot: async () => { journalEvents.push('prepare'); },
        captureSnapshot: async () => { journalEvents.push('capture'); },
        verifyDirectory: noop, verifyMount: noop, verifySnapshot: noop, complete: noop,
      }),
      copySparseFile: noop,
      removeArtifactSnapshot: async (directory) => fs.rm(directory, { recursive: true, force: true }),
      mountTmpfs: noop,
      unmount: async () => {
        cleaned();
        if (cleanupError) throw new Error('PRIVATE_RAW_CLEANUP_ERROR');
      },
      chown: noop,
      resolveIdentity: () => ({ uid: process.getuid?.() || 1000, gid: process.getgid?.() || 1000 }),
      createManager: (_config, _workDir, profile) => ({
        start: async () => {
          started();
          if (startupHanging) await new Promise<void>((resolve) => { resolveExecution = resolve; });
        },
        startInstance: noop,
        execute: async () => {
          if (executeError) throw new Error('PRIVATE_RAW_HOST_ERROR');
          if (hanging) await new Promise<void>((resolve) => { resolveExecution = resolve; });
          const source = profile.guest?.exports.find(({ tag }) => tag === 'enclave-output')?.source;
          if (!source) throw new Error('Missing trusted output export');
          await fs.writeFile(path.join(source, 'out'), output);
          return { exitCode: 0, timedOut: false, signal: null };
        },
        cancel: async () => { cancelled(); resolveExecution?.(); },
        stop: async () => { stopped(); resolveExecution?.(); },
        completeCleanupRecord: noop,
      }),
    };
    backend = new CloudHypervisorHostEnclaveExecutorBackend({
      runState,
      workDir: root,
      config: {
        previewEnabled: true, mountPolicy: 'workspace-only', cloudHypervisorBinary: '/trusted/ch',
        artifactReleaseTag: 'v0.23.1', vcpuCount: 1, memoryMib: 768, apiTimeoutMs: 1000,
      },
      preflight: {
        tools: { rsync: '/trusted/rsync', mount: '/trusted/mount', umount: '/trusted/umount' },
        artifactSnapshotDirectory: '/trusted/preflight',
        artifactDigests: { supervisor: 'e'.repeat(64) },
      } as CloudHypervisorPreflightResult,
      enclaveArtifacts: artifacts,
      agentPolicies: { 'agent-entry': { model: 'gpt-4.1', profile: 'openai', maxOutputBytes: 4096 } },
    }, dependencies);
    const execute = backend.execute.bind(backend);
    jest.spyOn(backend, 'execute').mockImplementation(async (plan, signal) => {
      plans.push(plan);
      return execute(plan, signal);
    });
    host = await startHostExecutorServer({
      runtimeDir: path.join(root, 'runtime'),
      runState: { ...runState, journalDir: path.join(root, 'journal') },
      backend,
    });
    proxy = net.createServer({ allowHalfOpen: true }, (brokerSocket) => {
      const upstream = net.createConnection(host!.socketPath);
      const requestChunks: Buffer[] = [];
      const responseChunks: Buffer[] = [];
      brokerSocket.on('data', (chunk) => requestChunks.push(Buffer.from(chunk)));
      brokerSocket.on('end', () => {
        const frame = Buffer.concat(requestChunks);
        const request = JSON.parse(frame.subarray(4).toString());
        requests.push(request);
        upstream.end(frame);
      });
      upstream.on('data', (chunk) => responseChunks.push(Buffer.from(chunk)));
      upstream.on('end', () => {
        const frame = Buffer.concat(responseChunks);
        if (frame.length <= 4) {
          brokerSocket.end(frame);
          return;
        }
        const response = JSON.parse(frame.subarray(4).toString());
        if (corrupt === 'truncate') {
          brokerSocket.end(frame.subarray(0, 3));
          return;
        }
        if (corrupt === 'settle' && response.state === 'settled') response.state = 'terminal';
        if (response.state === 'terminal' && corrupt === 'digest') response.resultDigest = '0'.repeat(64);
        if (response.state === 'terminal' && response.outcome === 'success' && corrupt === 'schema') {
          response.result = '"PRIVATE_RAW_OUTPUT"';
          response.resultDigest = createHash('sha256')
            .update(JSON.stringify(['success', response.result])).digest('hex');
        }
        const payload = Buffer.from(JSON.stringify(response));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.length);
        brokerSocket.end(Buffer.concat([header, payload]));
      });
      brokerSocket.on('error', () => upstream.destroy());
      upstream.on('error', () => brokerSocket.destroy());
    });
    await new Promise<void>((resolve) => proxy!.listen(path.join(root, 'proxy.sock'), resolve));
  });

  afterEach(async () => {
    try {
      for (const handler of activeHandlers) handler.close();
      await Promise.all(activeHandlers.map((handler) => handler.drain()));
      if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      if (proxy?.listening) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
      await host?.close();
    } finally {
      httpServer = undefined;
      proxy = undefined;
      host = undefined;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  function makeHandler(role: Role, options: {
    capabilityPath?: string; entryId?: string; timeoutSeconds?: number; lane?: object; ledger?: object;
    socketPath?: string; admission?: object;
  } = {}) {
    const clock = {
      nowMs: () => performance.now() + offset,
      sleep: async (milliseconds: number) => { offset += milliseconds; },
    };
    const config = {
      runId, entryId: options.entryId || `${role}-entry`, executorBackend: 'cloud-hypervisor',
      primaryBackend: 'docker', timeoutSeconds: options.timeoutSeconds ?? 2,
      maxInvocations: 32, maxOutputBytes: 8192,
      hostExecutorSocketPath: options.socketPath || path.join(root, 'proxy.sock'),
      hostExecutorCapabilityPath: options.capabilityPath || host!.capabilityPath,
    };
    const runner = createHostExecutorRunner(config, {
      nowMs: clock.nowMs, pollMs: 2, drainMs: 1000, requestTimeoutMs: 200,
    });
    const localWorkspace = {
      createInvocationWorkspace: jest.fn(() => { throw new Error('Local workspace must not be used'); }),
      readQueryOutput: jest.fn(),
      destroyInvocationWorkspace: jest.fn(),
    };
    const handler = createExecutorHandler({
      config, runId, seedMap, runner, workspace: localWorkspace,
      audit: { failure: jest.fn(), invocation: jest.fn() },
      clock, responseJitterSource: () => 0, uniformTiming: true,
      executorKind: role, payloadKey: role === 'script' ? 'script' : 'prompt',
      ...(role === 'agent' ? { validateRequest: createAgentRequestValidator(4096) } : {}),
      ...(options.lane ? { lane: options.lane } : {}),
      ...(options.ledger ? { ledger: options.ledger } : {}),
      ...(options.admission ? { admission: options.admission } : {}),
    });
    activeHandlers.push(handler);
    return { handler, runner, localWorkspace };
  }

  async function until(check: () => boolean) {
    const deadline = performance.now() + 2000;
    while (!check()) {
      if (performance.now() > deadline) throw new Error('Concrete manager did not reach the expected lifecycle stage');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  function args(role: Role, extra = {}) {
    return { privateRepo: 'octo/private', schema, [role === 'script' ? 'script' : 'prompt']: 'Return true', ...extra };
  }

  async function call(handler: ReturnType<typeof makeHandler>['handler'], request: object, signal?: AbortSignal) {
    let result = '';
    await handler.handle(request, (json: string) => { result = json; }, { signal });
    return result;
  }

  it('preserves local runner semantics when the HTTP request signal is cancelled', async () => {
    let elapsed = 0;
    const runner = {
      runInvocation: jest.fn(async ({ signal }: { signal: AbortSignal }) => {
        expect(signal.aborted).toBe(false);
        return { exitCode: 0, timedOut: false };
      }),
    };
    const handler = createExecutorHandler({
      config: { executorBackend: 'docker', timeoutSeconds: 2, maxInvocations: 8, maxOutputBytes: 8192 },
      runId, seedMap, runner,
      audit: { failure: jest.fn(), invocation: jest.fn() },
      workspace: {
        createInvocationWorkspace: () => ({ outPath: 'unused' }),
        readQueryOutput: () => 'true',
        destroyInvocationWorkspace: () => undefined,
      },
      clock: { nowMs: () => elapsed, sleep: async (ms: number) => { elapsed += ms; } },
      responseJitterSource: () => 0,
    });
    const cancellation = new AbortController();
    cancellation.abort();
    expect(await call(handler, args('script'), cancellation.signal)).toBe('{"status":"ok","result":true}');
    expect(runner.runInvocation).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
  });

  it('bounds status-poll exchanges and sleep within the host status lease', () => {
    const config = {
      executorBackend: 'cloud-hypervisor', entryId: 'script-entry', runId,
      hostExecutorSocketPath: path.join(root, 'proxy.sock'),
      hostExecutorCapabilityPath: host!.capabilityPath,
    };
    expect(() => createHostExecutorRunner(config)).not.toThrow();
    expect(() => createHostExecutorRunner(config, { requestTimeoutMs: 4_000, pollMs: 10_000 }))
      .not.toThrow();
    for (const deps of [
      { requestTimeoutMs: 5_000, pollMs: 10_000 },
      { requestTimeoutMs: 1, pollMs: 14_000 },
      { requestTimeoutMs: 0 },
      { pollMs: 0 },
    ]) expect(() => createHostExecutorRunner(config, deps)).toThrow(/polling bounds/);
  });

  it.each(['script', 'agent'] as const)('validates and settles %s before disclosure without local files', async (role) => {
    const { handler, runner, localWorkspace } = makeHandler(role);
    await expect(runner.assertAvailable()).resolves.toBeUndefined();
    expect(started).not.toHaveBeenCalled();
    const before = handler.ledger.remainingBits('octo/private');
    expect(await call(handler, args(role))).toBe('{"status":"ok","result":true}');
    expect(handler.ledger.remainingBits('octo/private')).toBeLessThan(before);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ entryId: `${role}-entry`, executorKind: role });
    expect(plans[0].admissionId).toBe(plans[0].invocationId);
    expect(requests.map(({ type }) => type)).toContain('settle');
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalled();
    expect(journalEvents).toEqual(['prepare', 'capture', 'capture']);
    for (const method of Object.values(localWorkspace)) expect(method).not.toHaveBeenCalled();
    const invoke = requests.find(({ type }) => type === 'invoke')!;
    expect(Object.keys(invoke).sort()).toEqual([
      'version', 'type', 'requestId', 'runId', 'entryId', 'invocationId', 'capability',
      'executorKind', 'seedId', 'payload', 'schema', 'schemaHash', 'admissionId',
    ].sort());
  });

  it.each(['script', 'agent'] as const)('rejects invalid %s calls before host invocation', async (role) => {
    const { handler } = makeHandler(role);
    for (const request of [
      args(role, { entryId: 'attacker' }),
      args(role, { privateRepo: 'evil/private' }),
      args(role, { schema: { type: 'string' } }),
      args(role, { command: 'id' }),
    ]) expect(await call(handler, request)).toBe('{"status":"error"}');
    expect(requests).toHaveLength(0);
    expect(plans).toHaveLength(0);
  });

  it.each(['script', 'agent'] as const)('denies unauthenticated %s and closes the shared admission lane', async (role) => {
    const capabilityPath = path.join(root, 'wrong-capability');
    await fs.writeFile(capabilityPath, 'f'.repeat(64), { mode: 0o600 });
    const lane = { tail: Promise.resolve(), closed: false };
    const { handler } = makeHandler(role, { capabilityPath, lane });
    const peer = makeHandler(role === 'script' ? 'agent' : 'script', { lane }).handler;
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
    const count = requests.length;
    expect(lane.closed).toBe(true);
    expect(await call(peer, args(role === 'script' ? 'agent' : 'script'))).toBe('{"status":"error"}');
    expect(requests).toHaveLength(count);
    expect(plans).toHaveLength(0);
  });

  it('rejects an invalid capability during startup without launching a VM', async () => {
    const capabilityPath = path.join(root, 'wrong-startup-capability');
    await fs.writeFile(capabilityPath, 'f'.repeat(64), { mode: 0o600 });
    const { runner } = makeHandler('script', { capabilityPath });
    await expect(runner.assertAvailable()).rejects.toThrow(/unavailable.*no runtime fallback/);
    await expect(runner.reconcileRun()).rejects.toThrow(/unresolved/);
    expect(started).not.toHaveBeenCalled();
    expect(plans).toHaveLength(0);
  });

  it('rejects a missing listener during startup without selecting another runtime', async () => {
    const { runner } = makeHandler('agent', { socketPath: path.join(root, 'missing.sock') });
    await expect(runner.assertAvailable()).rejects.toThrow(/unavailable.*no runtime fallback/);
    await expect(runner.reconcileRun()).rejects.toThrow(/unresolved/);
    expect(started).not.toHaveBeenCalled();
    expect(plans).toHaveLength(0);
  });

  it.each(['script', 'agent'] as const)('denies host policy mismatch for %s without fallback', async (role) => {
    const { handler } = makeHandler(role, { entryId: role === 'script' ? 'agent-entry' : 'script-entry' });
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
    expect(plans).toHaveLength(0);
  });

  it.each(['script', 'agent'] as const)('does not disclose raw %s output or errors', async (role) => {
    const { handler } = makeHandler(role);
    output = '"PRIVATE_RAW_OUTPUT"';
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
    executeError = true;
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
    expect(requests.filter(({ type }) => type === 'settle')).toHaveLength(2);
  });

  it.each(['script', 'agent'] as const)('never publishes terminal %s when concrete cleanup is unresolved', async (role) => {
    cleanupError = true;
    const lane = { tail: Promise.resolve(), closed: false };
    const { handler } = makeHandler(role, { lane, timeoutSeconds: 0.2 });
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
    expect(started).toHaveBeenCalled();
    expect(cleaned).toHaveBeenCalled();
    expect(lane.closed).toBe(true);
    expect(requests.some(({ type }) => type === 'settle')).toBe(false);
  });

  it.each((['script', 'agent'] as const).flatMap((role) =>
    (['digest', 'schema', 'settle', 'truncate'] as const).map((mode) => ({ role, mode })),
  ))('fails closed on $role $mode protocol ambiguity', async ({ role, mode }) => {
    corrupt = mode;
    const lane = { tail: Promise.resolve(), closed: false };
    const { handler } = makeHandler(role, { lane });
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
    expect(lane.closed).toBe(true);
    if (mode === 'schema') {
      expect(requests.filter(({ type }) => type === 'settle')).toHaveLength(0);
    }
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
  });

  it.each(['script', 'agent'] as const)('fails %s closed when the host socket is absent', async (role) => {
    const { handler, localWorkspace } = makeHandler(role, { socketPath: path.join(root, 'absent.sock') });
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
    expect(requests).toHaveLength(0);
    expect(plans).toHaveLength(0);
    expect(localWorkspace.createInvocationWorkspace).not.toHaveBeenCalled();
  });

  it('denies admission and exhausted information budget before host invocation', async () => {
    const admission = { admit: jest.fn(async () => ({ admitted: false })), settle: jest.fn() };
    const dynamic = makeHandler('agent', { admission }).handler;
    expect(await call(dynamic, args('agent'))).toBe('{"status":"error"}');
    expect(admission.admit).toHaveBeenCalledTimes(1);
    const deniedLedger = { tryDebit: jest.fn(() => false) };
    const script = makeHandler('script', { ledger: deniedLedger }).handler;
    expect(await call(script, args('script'))).toBe('{"status":"error"}');
    expect(requests).toHaveLength(0);
    expect(plans).toHaveLength(0);
  });

  it.each(['script', 'agent'] as const)('cancels and settles active %s on caller cancellation', async (role) => {
    hanging = true;
    const { handler } = makeHandler(role);
    const controller = new AbortController();
    const pending = call(handler, args(role), controller.signal);
    await until(() => resolveExecution !== undefined);
    controller.abort();
    expect(await pending).toBe('{"status":"error"}');
    expect(cancelled).toHaveBeenCalled();
    expect(cleaned).toHaveBeenCalled();
    expect(requests.map(({ type }) => type)).toContain('settle');
  });

  it.each(['script', 'agent'] as const)('cancels and settles %s at the broker deadline', async (role) => {
    hanging = true;
    const { handler } = makeHandler(role, { timeoutSeconds: 0.5 });
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
    expect(cancelled).toHaveBeenCalled();
    expect(requests.map(({ type }) => type)).toContain('settle');
  });

  it('settles after interruption during startup and drains queued calls without launching', async () => {
    startupHanging = true;
    const { handler } = makeHandler('script');
    const pending = call(handler, args('script'));
    const queued = call(handler, args('script'));
    await until(() => started.mock.calls.length > 0);
    handler.close();
    expect(await pending).toBe('{"status":"error"}');
    expect(await queued).toBe('{"status":"error"}');
    await handler.drain();
    expect(plans).toHaveLength(1);
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(requests.map(({ type }) => type)).toContain('settle');
  });

  it.each(['script', 'agent'] as const)('does not resume %s after host interruption or reset its run identity', async (role) => {
    hanging = true;
    const lane = { tail: Promise.resolve(), closed: false };
    const { handler } = makeHandler(role, { lane });
    const pending = call(handler, args(role));
    await until(() => resolveExecution !== undefined);
    await host!.close();
    expect(await pending).toBe('{"status":"error"}');
    expect(cancelled).toHaveBeenCalled();
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(lane.closed).toBe(true);
    await expect(startHostExecutorServer({
      runtimeDir: path.join(root, 'restarted-runtime'),
      runState: { ...runState, journalDir: path.join(root, 'journal') },
      backend,
    })).rejects.toThrow(/EEXIST/);
    expect(await call(handler, args(role))).toBe('{"status":"error"}');
    expect(plans).toHaveLength(1);
    const journal = await fs.readFile(path.join(root, 'journal', `${runId}.journal`), 'utf8');
    expect(journal).toContain('"state":"closed"');
    expect(journal).not.toMatch(/Return true|PRIVATE_RAW|capability/);
  });

  it('shares script/agent ledger and serialization through host settlement', async () => {
    const lane = { tail: Promise.resolve() };
    const ledger = createEnclaveInformationBudgetLedger(seedMap);
    const script = makeHandler('script', { lane, ledger }).handler;
    const agent = makeHandler('agent', { lane, ledger }).handler;
    const before = ledger.remainingBits('octo/private');
    expect(await Promise.all([call(script, args('script')), call(agent, args('agent'))]))
      .toEqual(['{"status":"ok","result":true}', '{"status":"ok","result":true}']);
    expect(ledger.remainingBits('octo/private')).toBeLessThan(before);
    const firstSettle = requests.findIndex(({ type }) => type === 'settle');
    const secondInvoke = requests.findIndex(({ type, executorKind }) => type === 'invoke' && executorKind === 'agent');
    expect(secondInvoke).toBeGreaterThan(firstSettle);
  });

  it.each(['disconnect', 'notification'] as const)('propagates HTTP %s into real host cancellation', async (mode) => {
    hanging = true;
    const { handler } = makeHandler('script', { timeoutSeconds: 30 });
    httpServer = createMcpServer({
      handlers: { enclave_run_script: handler }, capability: 'capability', maxScriptBytes: 65536,
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
    const address = httpServer!.address() as net.AddressInfo;
    const post = (body: object) => http.request({
      host: '127.0.0.1', port: address.port, path: '/mcp', method: 'POST',
      headers: { authorization: ['Bearer', 'capability'].join(' '), 'content-type': 'application/json' },
    }).end(JSON.stringify(body));
    const req = post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
      name: 'enclave_run_script', arguments: args('script'),
    } });
    req.on('error', () => undefined);
    req.on('response', (response) => response.resume());
    await until(() => resolveExecution !== undefined);
    const cancellationStart = performance.now();
    if (mode === 'disconnect') req.destroy();
    else {
      await new Promise<void>((resolve, reject) => {
        const notification = post({
          jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 },
        });
        notification.on('error', reject);
        notification.on('response', (response) => {
          expect(response.statusCode).toBe(202);
          response.resume();
          response.on('end', resolve);
        });
      });
    }
    await until(() => cancelled.mock.calls.length > 0);
    await handler.drain();
    expect(performance.now() - cancellationStart).toBeLessThan(2000);
    expect(cancelled).toHaveBeenCalled();
    expect(requests.map(({ type }) => type)).toContain('settle');
  });

  it('loads only trusted fixed host paths and never selects local Docker execution', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, {
        AWF_ENCLAVE_BACKEND: 'cloud-hypervisor', AWF_ENCLAVE_AGENT_BACKEND: 'cloud-hypervisor',
        AWF_ENCLAVE_PRIMARY_BACKEND: 'cloud-hypervisor', AWF_ENCLAVE_RUN_ID: runId,
        AWF_ENCLAVE_ENTRY_ID: 'script-entry', AWF_ENCLAVE_AGENT_ENTRY_ID: 'agent-entry',
      });
      delete process.env.AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED;
      const script = loadConfig({ readFileSync: () => 'f'.repeat(64) });
      const agent = loadAgentConfig({ runId, primaryBackend: 'cloud-hypervisor' });
      for (const config of [script, agent]) {
        expect(config.hostExecutorSocketPath).toBe(`${HOST_EXECUTOR_DIR}/executor.sock`);
        expect(config.hostExecutorCapabilityPath).toBe(`${HOST_EXECUTOR_DIR}/capability`);
        expect(config.executorBackend).toBe('cloud-hypervisor');
        expect(config.hostWorkDir).toBeUndefined();
      }
      expect(() => createHostExecutorRunner(script)).toThrow(/capability is unavailable/);
      process.env.AWF_ENCLAVE_BACKEND = 'attacker-runtime';
      process.env.AWF_ENCLAVE_AGENT_BACKEND = 'attacker-runtime';
      expect(() => loadConfig()).toThrow(/AWF_ENCLAVE_BACKEND/);
      expect(() => loadAgentConfig({ runId })).toThrow(/AWF_ENCLAVE_AGENT_BACKEND/);
    } finally {
      process.env = saved;
    }
  });
});
