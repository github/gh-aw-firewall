import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { createDockerHostContext, type DockerHostContext, type DockerHostExecutorEntry } from './docker-host-context';
import {
  DockerHostRecoveryJournal, expectedDockerHostContainer, initializeDockerHostRecovery, type DockerHostRecoveryRecord,
  buildDockerHostAuthoritySettlement, createDockerHostRecoveryRecord, settleDockerHostAuthority,
} from './docker-host-recovery';
import { createDockerHostEnclaveExecutor } from './docker-host-executor';
import type { HostExecutorBackendResult, HostExecutorInvocationPlan } from './host-executor-server';
import { HOST_EXECUTOR_MAX_RESULT_BYTES } from './host-executor-protocol';

const runId = 'a'.repeat(32);
const invocationId = 'b'.repeat(32);
const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describe('Docker host recovery records and authority settlement', () => {
  const plan: HostExecutorInvocationPlan = {
    runId, invocationId, entryId: 'agent', executorKind: 'agent', timeoutMs: 1201,
    requestHash: 'c'.repeat(64), admissionId: 'd'.repeat(32), schemaHash: 'e'.repeat(64),
    schema: { type: 'boolean' }, payload: 'task', invocationHostDir: path.join(process.cwd(), invocationId),
  };
  const entry: DockerHostExecutorEntry = {
    entryId: 'agent', executorKind: 'agent', hostWritableBytes: 4096, aggregateWritableBytes: 8192,
    config: { maxOutputBytes: 8192, timeoutSeconds: 120 },
  };

  afterEach(() => jest.restoreAllMocks());

  test.each([false, true])('creates the initial durable intent with publicDebug=%s', publicDebug => {
    const owner = { pid: 123, startTicks: '456', bootId: 'test-owner' };
    expect(createDockerHostRecoveryRecord(plan, entry, plan.invocationHostDir, owner, publicDebug)).toEqual({
      version: 1, runId, entryId: 'agent', invocationId, storageTarget: plan.invocationHostDir,
      storageSource: `awf-enclave-${runId}-agent-${invocationId}`, storageBytes: 4096, mountPending: true, owner,
      ...(publicDebug ? { publicDebug: { pending: true, stage: 'setup', failure: 'setup-failed', exitCode: null } } : {}),
    });
  });

  test('charges UTF-8 output bytes and rounds elapsed execution seconds up', () => {
    jest.spyOn(Date, 'now').mockReturnValue(10_001);
    expect(buildDockerHostAuthoritySettlement(plan, entry, { outcome: 'success', result: '"é"' }, {
      resolved: true, launchedAt: 9000,
    })).toEqual({ outcome: 'success', uncertain: false, cleanupComplete: true, outputBytes: 4, executionSeconds: 2 });
  });

  test.each([undefined, 11_000])('charges zero elapsed time for absent or future launch time %s', launchedAt => {
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    expect(buildDockerHostAuthoritySettlement(plan, entry, { outcome: 'cancelled' }, { resolved: true, launchedAt }))
      .toMatchObject({ uncertain: false, outputBytes: 0, executionSeconds: 0 });
  });

  test.each([
    [false, undefined, true], [true, false, false], [false, false, false],
  ] as [boolean, boolean | undefined, boolean][])(
    'charges maximums for resolved=%s cleanupComplete=%s', (resolved, cleanupComplete, expectedCleanup) => {
      const result: HostExecutorBackendResult = { outcome: 'executor-failure', cleanupComplete };
      expect(buildDockerHostAuthoritySettlement(plan, entry, result, { resolved, launchedAt: Date.now() }))
        .toEqual({
          outcome: result.outcome, uncertain: true, cleanupComplete: expectedCleanup, outputBytes: 8192, executionSeconds: 120,
        });
      expect(buildDockerHostAuthoritySettlement({ ...plan, timeoutMs: 120_001 }, entry, result, { resolved }))
        .toMatchObject({ executionSeconds: 121 });
    },
  );

  test('uses protocol output and plan timeout bounds when configured limits are absent or zero', () => {
    for (const config of [{}, { maxOutputBytes: 0, timeoutSeconds: 0 }]) {
      expect(buildDockerHostAuthoritySettlement(plan, { ...entry, config }, { outcome: 'cancelled' }, { resolved: false }))
        .toMatchObject({ outputBytes: HOST_EXECUTOR_MAX_RESULT_BYTES, executionSeconds: 2 });
    }
  });

  test('releases the original result only after proved authority revocation', async () => {
    const result: HostExecutorBackendResult = { outcome: 'success', result: 'true' };
    const settle = jest.fn().mockResolvedValue({ revoked: true });
    await expect(settleDockerHostAuthority(plan, entry, result, { resolved: true }, settle)).resolves.toBe(result);
    expect(settle).toHaveBeenCalledWith(plan, {
      outcome: 'success', uncertain: false, cleanupComplete: true, outputBytes: 4, executionSeconds: 0,
    });
  });

  test.each(['not-revoked', 'exception'])('fails closed on revocation %s', async failure => {
    const settle = failure === 'exception' ? jest.fn().mockRejectedValue(new Error('unavailable'))
      : jest.fn().mockResolvedValue({ revoked: false });
    await expect(settleDockerHostAuthority(plan, entry, { outcome: 'cancelled' }, { resolved: true }, settle))
      .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
  });
});

describeLinux('Docker host recovery initialization', () => {
  let root: string;
  let context: DockerHostContext;
  let docker: jest.MockedFunction<DockerHostContext['docker']>;
  let containers: {
    labelledIds: jest.Mock<Promise<string[]>, [string?]>;
    reconcileCreate: jest.Mock<Promise<void>, [DockerHostRecoveryRecord]>;
    cleanup: jest.Mock<Promise<void>, [DockerHostRecoveryRecord]>;
  };

  beforeEach(() => {
    root = path.join(process.cwd(), `.docker-host-recovery-${randomBytes(8).toString('hex')}`);
    fs.mkdirSync(root, { mode: 0o700 });
    docker = jest.fn().mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ OSType: 'linux', SecurityOptions: [] }) });
    context = createDockerHostContext({ runId, journalDir: path.join(root, 'journal'), entries: [], dockerCommand: docker });
    context.backendOwners = new Map();
    containers = {
      labelledIds: jest.fn().mockResolvedValue([]),
      reconcileCreate: jest.fn().mockResolvedValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function record(recordRunId = runId): DockerHostRecoveryRecord {
    return {
      version: 1, runId: recordRunId, invocationId, entryId: 'script', owner: context.owner,
      storageTarget: path.join(root, invocationId),
      storageSource: `awf-enclave-${recordRunId}-script-${invocationId}`, storageBytes: 64 * 1024 ** 2,
    };
  }

  test('rejects another active backend before contacting Docker or recovery operations', async () => {
    context.backendOwners.set(context.ownerKey, new Set([Symbol('another-backend')]));
    await expect(initializeDockerHostRecovery(context, containers)).rejects.toThrow('another active host executor');
    expect(docker).not.toHaveBeenCalled();
    expect(containers.labelledIds).not.toHaveBeenCalled();
    expect(containers.cleanup).not.toHaveBeenCalled();
  });

  test.each([
    { OSType: 'windows', SecurityOptions: [] },
    { OSType: 'linux', SecurityOptions: ['name=rootless'] },
    { OSType: 'linux', SecurityOptions: ['name=userns'] },
  ])('rejects unsupported daemon identity mode %j before cleanup', async daemon => {
    docker.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(daemon) });
    await expect(initializeDockerHostRecovery(context, containers)).rejects.toThrow('filesystem/identity mode is unsupported');
    expect(containers.cleanup).not.toHaveBeenCalled();
  });

  test('uses durable intents to recover current and stopped prior runs', async () => {
    const current = record();
    const previous = record('d'.repeat(32));
    previous.owner = { ...context.owner, bootId: '00000000-0000-0000-0000-000000000000' };
    context.journal.write(current);
    new DockerHostRecoveryJournal(context.options.journalDir, previous.runId).write(previous);
    await initializeDockerHostRecovery(context, containers);
    expect(containers.cleanup.mock.calls.map(([item]) => item.runId)).toEqual([runId, previous.runId]);
    expect(containers.reconcileCreate).not.toHaveBeenCalled();
  });

  test('skips a prior run with a still-live host owner', async () => {
    const previous = record('d'.repeat(32));
    new DockerHostRecoveryJournal(context.options.journalDir, previous.runId).write(previous);
    await initializeDockerHostRecovery(context, containers);
    expect(containers.cleanup).not.toHaveBeenCalled();
    expect(context.journal.records(true)).toHaveLength(1);
  });

  test('rejects unjournaled labels before cleaning any recoverable record', async () => {
    context.journal.write(record());
    containers.labelledIds.mockResolvedValueOnce(['c'.repeat(64)]);
    docker.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ OSType: 'linux' }) })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify([{ Name: '/unjournaled' }]) });
    await expect(initializeDockerHostRecovery(context, containers)).rejects.toThrow('Unjournaled Docker enclave resources');
    expect(containers.cleanup).not.toHaveBeenCalled();
  });

  test('preserves prior-run public diagnostic sources without delegating retention cleanup', async () => {
    const previous = record('d'.repeat(32));
    previous.owner = { ...context.owner, bootId: '00000000-0000-0000-0000-000000000000' };
    previous.expected = expectedDockerHostContainer(['run', '--name', 'prior-workload', '--memory', '64m', 'trusted/script']);
    previous.publicDebug = { pending: true, stage: 'setup', failure: 'setup-failed', exitCode: null };
    new DockerHostRecoveryJournal(context.options.journalDir, previous.runId).write(previous);
    docker.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ OSType: 'linux' }) })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '' }).mockResolvedValueOnce({ exitCode: 0, stdout: '' });
    await initializeDockerHostRecovery(context, containers);
    expect(containers.reconcileCreate).toHaveBeenCalledWith(previous);
    expect(containers.cleanup).not.toHaveBeenCalled();
    expect(context.journal.records(true)).toEqual([previous]);
  });

  test('concurrent prepare shares a single initialization promise', async () => {
    const backend = createDockerHostEnclaveExecutor(context.options);
    let resolveInfo!: (value: { exitCode: number; stdout: string }) => void;
    docker.mockImplementationOnce(() => new Promise(resolve => { resolveInfo = resolve; }))
      .mockResolvedValue({ exitCode: 0, stdout: '' });
    const first = backend.prepare();
    const second = backend.prepare();
    expect(docker).toHaveBeenCalledTimes(1);
    resolveInfo({ exitCode: 0, stdout: JSON.stringify({ OSType: 'linux' }) });
    await Promise.all([first, second]);
    await backend.close();
  });

  test('readiness rejection is cached for later prepare and close without retries', async () => {
    const backend = createDockerHostEnclaveExecutor(context.options);
    docker.mockResolvedValueOnce({ exitCode: 1, stdout: '' });
    await expect(backend.prepare()).rejects.toThrow('daemon is unavailable');
    await expect(backend.prepare()).rejects.toThrow('daemon is unavailable');
    await expect(backend.close()).rejects.toThrow('daemon is unavailable');
    expect(docker).toHaveBeenCalledTimes(1);
  });
});
