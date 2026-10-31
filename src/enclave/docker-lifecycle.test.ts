import fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { createDockerHostEnclaveExecutor } from './docker-host-executor';
import { deriveHostExecutorRunState } from './host-executor-run-state';
import { startHostExecutorService } from './host-service';
import { deriveEnclaveSeedId, resolveEnclavePaths } from './paths';
import { getEnclaveHostDynamicAuthority } from './dynamic-delegation';
import type { HostEnclaveExecutorBackend, HostExecutorInvocationPlan, HostExecutorServer } from './host-executor-server';
import { typedDynamicEnclavePolicyFixture } from './dynamic-policy.test-utils';
import { deriveDockerEnclaveRunnerConfig } from '../services/enclave-mcp-service';
import { parseImageTag } from '../image-tag';
import { assertDockerStorageHelperAvailable, dockerHelperHostStateRoot } from './docker-storage-helper';
import { PRIVATE_REPOSITORY_SEED_MAP_VERSION } from '../bounded-execution';
import {
  assertDockerEnclaveLifecycleReady,
  closeDockerEnclaveAdmissions,
  isDockerEnclaveSelected,
  startDockerEnclaveLifecycle,
  stopDockerEnclaveLifecycle,
  assertDockerEnclaveHostPrerequisites,
} from './docker-lifecycle';

jest.mock('./docker-host-executor', () => ({ createDockerHostEnclaveExecutor: jest.fn() }));
jest.mock('./docker-storage-helper', () => ({
  ...jest.requireActual('./docker-storage-helper'), assertDockerStorageHelperAvailable: jest.fn(),
  dockerHelperHostStateRoot: jest.fn(),
}));
jest.mock('./host-service', () => ({ startHostExecutorService: jest.fn() }));
jest.mock('./host-executor-run-state', () => ({ deriveHostExecutorRunState: jest.fn() }));
jest.mock('./dynamic-delegation', () => ({ getEnclaveHostDynamicAuthority: jest.fn() }));
jest.mock('../services/enclave-mcp-service', () => ({
  deriveDockerEnclaveRunnerConfig: jest.fn((_config, _imageConfig, kind) => ({ executorKind: kind })),
}));
jest.mock('./paths', () => {
  const actual = jest.requireActual('./paths');
  return {
    ...actual,
    resolveEnclavePaths: (workDir: string) => ({
      ...actual.resolveEnclavePaths(workDir, path.dirname(workDir)),
      hostExecutorJournalDir: path.join(workDir, 'journal'),
      hostExecutorDir: path.join(workDir, 'ipc'),
    }),
  };
});

describe('Docker enclave host run lifecycle', () => {
  let config: WrapperConfig;
  let server: HostExecutorServer;
  let directory: string;
  let backend: HostEnclaveExecutorBackend;
  let readFileSpy: jest.SpyInstance;
  let originalReadFileSync: typeof fs.readFileSync;
  const runId = 'c'.repeat(32);

  beforeEach(() => {
    originalReadFileSync = fs.readFileSync.bind(fs);
    readFileSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) =>
      file === '/proc/self/status'
        ? 'CapEff:\t0000000000200000\n'
        : originalReadFileSync(file as fs.PathOrFileDescriptor, ...(args as [any]))
    ) as typeof fs.readFileSync);
    directory = fs.mkdtempSync(path.join(process.cwd(), '.docker-lifecycle-test-'));
    jest.mocked(dockerHelperHostStateRoot).mockReturnValue(path.join(directory, 'helper-state'));
    config = {
      workDir: directory,
      awfDockerHost: 'unix:///run/trusted-docker.sock',
      enclaves: normalizeEnclavesConfig([{ script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] }]),
    } as WrapperConfig;
    const paths = resolveEnclavePaths(directory);
    fs.mkdirSync(paths.root, { mode: 0o700 });
    jest.mocked(deriveHostExecutorRunState).mockReturnValue({
      runId, seedsDir: paths.seedsDir, invocationsDir: path.join(directory, 'invocations'),
      journalDir: paths.hostExecutorJournalDir, entries: [],
    });
    server = {
      socketPath: path.join(paths.hostExecutorDir, 'executor.sock'),
      capabilityPath: path.join(paths.hostExecutorDir, 'capability'),
      closeAdmissions: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    jest.mocked(createDockerHostEnclaveExecutor).mockReset().mockReturnValue({
      prepare: jest.fn().mockResolvedValue(undefined), execute: jest.fn(), close: jest.fn(),
    });
    jest.mocked(startHostExecutorService).mockReset().mockImplementation(async (options) => {
      backend = await options.createBackend();
      return server;
    });
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    const paths = resolveEnclavePaths(directory);
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('publishes readiness only after backend preparation, preserving the Docker endpoint', async () => {
    await expect(assertDockerEnclaveLifecycleReady(config)).rejects.toThrow(/preflight/);
    await startDockerEnclaveLifecycle(config, { DOCKER_HOST: 'unix:///ignored.sock' });
    expect(deriveHostExecutorRunState).toHaveBeenLastCalledWith(
      config, resolveEnclavePaths(directory), 'Docker enclave', { dynamicAgents: true },
    );
    const seccompPath = path.join(resolveEnclavePaths(directory).root, 'docker-enclave-seccomp.json');
    const seccompFile = fs.openSync(seccompPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(seccompFile).mode & 0o777).toBe(0o400);
      expect(JSON.parse(fs.readFileSync(seccompFile, 'utf8')))
        .toEqual(jest.requireActual('../../containers/enclave/seccomp.json'));
    } finally {
      fs.closeSync(seccompFile);
    }
    await expect(assertDockerEnclaveLifecycleReady(config)).resolves.toBeUndefined();
    expect(createDockerHostEnclaveExecutor).toHaveBeenCalledWith(expect.objectContaining({
      dockerSocketPath: '/run/trusted-docker.sock',
      journalDir: path.join(resolveEnclavePaths(directory).hostExecutorJournalDir, 'docker'),
      entries: [expect.objectContaining({
        entryId: 'script', executorKind: 'script',
        config: { executorKind: 'script' }, hostWritableBytes: 64 * 1024 ** 2,
      })],
      resolveAgentAuthority: expect.any(Function),
      settleAgentAuthority: expect.any(Function),
    }));
    await stopDockerEnclaveLifecycle(config);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('fails closed on unsupported split filesystems rather than silently ignoring the path prefix', async () => {
    config.dockerHostPathPrefix = '/host';
    await expect(startDockerEnclaveLifecycle(config)).rejects.toThrow(/dockerHostPathPrefix.*mount policy/);
    expect(startHostExecutorService).not.toHaveBeenCalled();
    expect(createDockerHostEnclaveExecutor).not.toHaveBeenCalled();
  });

  it('rejects Docker host prerequisites before staging when tmpfs mount authority is unavailable', () => {
    readFileSpy.mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => file === '/proc/self/status'
      ? 'CapEff:\t0000000000000000\n'
      : originalReadFileSync(file as fs.PathOrFileDescriptor, ...(args as [any]))
    ) as typeof fs.readFileSync);
    jest.mocked(assertDockerStorageHelperAvailable).mockImplementationOnce(() => {
      throw new Error('matching AWF host storage helper unavailable');
    });
    expect(() => assertDockerEnclaveHostPrerequisites(config)).toThrow(/storage helper unavailable/);
  });

  it('accepts unprivileged orchestration only after helper preflight', () => {
    readFileSpy.mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => file === '/proc/self/status'
      ? 'CapEff:\t0000000000000000\n'
      : originalReadFileSync(file as fs.PathOrFileDescriptor, ...(args as [any]))
    ) as typeof fs.readFileSync);
    expect(() => assertDockerEnclaveHostPrerequisites(config)).not.toThrow();
    expect(assertDockerStorageHelperAvailable).toHaveBeenCalled();
    config.volumeMounts = ['/var/lib:/data:ro'];
    expect(() => assertDockerEnclaveHostPrerequisites(config)).toThrow(/agent-visible/);
  });

  it('uses the helper-bootstrapped caller journal instead of privileged VM defaults', async () => {
    readFileSpy.mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => file === '/proc/self/status'
      ? 'CapEff:\t0000000000000000\n'
      : originalReadFileSync(file as fs.PathOrFileDescriptor, ...(args as [any]))
    ) as typeof fs.readFileSync);
    await startDockerEnclaveLifecycle(config);
    const journal = path.join(dockerHelperHostStateRoot(), 'host-executor-journal');
    expect(deriveHostExecutorRunState).toHaveBeenLastCalledWith(config,
      expect.objectContaining({ hostExecutorJournalDir: journal }), 'Docker enclave', { dynamicAgents: true });
    expect(createDockerHostEnclaveExecutor).toHaveBeenCalledWith(
      expect.objectContaining({ journalDir: path.join(journal, 'docker') }));
    await stopDockerEnclaveLifecycle(config);
  });

  it('creates durable journals through the ordinary unprivileged host lifecycle', async () => {
    readFileSpy.mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => file === '/proc/self/status'
      ? 'CapEff:\t0000000000000000\n'
      : originalReadFileSync(file as fs.PathOrFileDescriptor, ...(args as [any]))
    ) as typeof fs.readFileSync);
    const paths = resolveEnclavePaths(directory);
    const seedId = deriveEnclaveSeedId(runId, 'octo/private');
    fs.mkdirSync(path.join(paths.seedsDir, seedId), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.runIdPath, runId, { mode: 0o600 });
    fs.writeFileSync(paths.seedMapPath, JSON.stringify({
      version: PRIVATE_REPOSITORY_SEED_MAP_VERSION, runId,
      seeds: [{ repo: 'octo/private', sensitivity: 'internal', seedId }],
    }), { mode: 0o600 });
    jest.mocked(deriveHostExecutorRunState).mockImplementationOnce(
      jest.requireActual('./host-executor-run-state').deriveHostExecutorRunState,
    );
    jest.mocked(startHostExecutorService).mockImplementationOnce(
      jest.requireActual('./host-service').startHostExecutorService,
    );
    await startDockerEnclaveLifecycle(config);
    const state = jest.mocked(startHostExecutorService).mock.calls[0][0].runState;
    expect(state.journalDir).toBe(path.join(dockerHelperHostStateRoot(), 'host-executor-journal'));
    expect(state.invocationsDir).toBe(path.join(dockerHelperHostStateRoot(), 'host-invocations', runId));
    const tombstone = path.join(state.journalDir!, `${runId}.journal`);
    expect(fs.statSync(tombstone).uid).toBe(process.getuid?.());
    expect(fs.statSync(state.journalDir!).mode & 0o777).toBe(0o700);
    await stopDockerEnclaveLifecycle(config);
    fs.rmSync(paths.root, { recursive: true, force: true });
    expect(fs.existsSync(tombstone)).toBe(true);
  });

  it.each(['script', 'agent'] as const)('preserves the trusted Docker %s UID/GID defaults', async (kind) => {
    if (kind === 'agent') {
      config.enclaves = normalizeEnclavesConfig([{
        agent: { model: 'trusted-model' },
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      }]);
    }
    jest.mocked(deriveDockerEnclaveRunnerConfig).mockImplementationOnce(
      jest.requireActual('../services/enclave-mcp-service').deriveDockerEnclaveRunnerConfig,
    );
    await startDockerEnclaveLifecycle(config);
    const entry = jest.mocked(createDockerHostEnclaveExecutor).mock.calls[0][0].entries[0];
    expect(entry.config).toMatchObject(kind === 'script'
      ? { queryUid: 65534, queryGid: 65534 }
      : { enclaveUid: 65534, enclaveGid: 65534 });
    await stopDockerEnclaveLifecycle(config);
  });

  it.each(['script', 'agent'] as const)('derives %s host and aggregate storage from configured Docker tmpfs limits', async (kind) => {
    config.enclaves = normalizeEnclavesConfig([{
      ...(kind === 'script' ? { script: {} } : { agent: { model: 'trusted-model' } }),
      tmpfsLimit: '32m', repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
    }]);
    await startDockerEnclaveLifecycle(config);
    const entry = jest.mocked(createDockerHostEnclaveExecutor).mock.calls[0][0].entries[0];
    expect(entry.hostWritableBytes).toBe(32 * 1024 ** 2);
    expect(entry.aggregateWritableBytes).toBe((3 * 32 + (kind === 'script' ? 64 : 0)) * 1024 ** 2);
    await stopDockerEnclaveLifecycle(config);
  });

  it('never overwrites an existing private seccomp file or publishes a listener after staging fails', async () => {
    const seccompPath = path.join(resolveEnclavePaths(directory).root, 'docker-enclave-seccomp.json');
    fs.writeFileSync(seccompPath, 'existing', { mode: 0o600 });
    await expect(startDockerEnclaveLifecycle(config)).rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(seccompPath, 'utf8')).toBe('existing');
    expect(createDockerHostEnclaveExecutor).not.toHaveBeenCalled();
    await expect(stopDockerEnclaveLifecycle(config)).rejects.toThrow(/startup failed/);
  });

  it('rejects an existing listener before acquiring or reconciling any Docker resources', async () => {
    const paths = resolveEnclavePaths(directory);
    fs.mkdirSync(paths.hostExecutorDir, { mode: 0o700 });
    fs.writeFileSync(path.join(paths.hostExecutorDir, 'executor.sock'), 'existing-listener', { mode: 0o600 });
    await expect(startDockerEnclaveLifecycle(config)).rejects.toThrow(/listener already exists/);
    expect(createDockerHostEnclaveExecutor).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(paths.root, 'docker-enclave-seccomp.json'))).toBe(false);
    await expect(stopDockerEnclaveLifecycle(config)).rejects.toThrow(/startup failed/);
  });

  it('keeps the launcher seccomp outside every generated broker bind source', async () => {
    await startDockerEnclaveLifecycle(config);
    const paths = resolveEnclavePaths(directory);
    fs.writeFileSync(paths.runIdPath, runId, { mode: 0o600 });
    const serviceModule = jest.requireActual('../services/enclave-mcp-service') as typeof import('../services/enclave-mcp-service');
    const generated = serviceModule.buildEnclaveMcpService({
      config,
      imageConfig: {
        useGHCR: true, registry: 'ghcr.io/github/gh-aw-firewall',
        parsedTag: parseImageTag('latest'), projectRoot: '/no-source-tree',
      },
    });
    const profile = path.join(paths.root, 'docker-enclave-seccomp.json');
    for (const volume of generated.service.volumes as string[]) {
      const source = volume.split(':')[0];
      const relative = path.relative(source, profile);
      expect(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))).toBe(false);
    }
    await stopDockerEnclaveLifecycle(config);
  });

  it('keeps listener readiness closed until durable resource reconciliation completes', async () => {
    let release!: () => void;
    const prepare = jest.fn().mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    jest.mocked(createDockerHostEnclaveExecutor).mockReturnValue({
      prepare, execute: jest.fn(), close: jest.fn(),
    });
    const starting = startDockerEnclaveLifecycle(config);
    await expect(assertDockerEnclaveLifecycleReady(config)).rejects.toThrow(/preflight/);
    expect(prepare).toHaveBeenCalledTimes(1);
    release();
    await starting;
    await expect(assertDockerEnclaveLifecycleReady(config)).resolves.toBeUndefined();
    await stopDockerEnclaveLifecycle(config);
  });

  it('takes static GitHub identity custody at startup instead of giving the broker its file', async () => {
    config.enclaves = normalizeEnclavesConfig([{
      agent: { model: 'trusted-model', github: { cli: 'issues-read-v1' } },
      repos: [
        { repo: 'Octo/Private', sensitivity: 'internal' },
        { repo: 'octo/other', sensitivity: 'internal' },
      ],
    }]);
    jest.mocked(deriveDockerEnclaveRunnerConfig).mockReturnValueOnce({ githubEnabled: true });
    const paths = resolveEnclavePaths(directory);
    fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
    const identity = 'trusted-enclave-identity-0123456789';
    fs.writeFileSync(paths.githubAgentIdPath, `${identity}\n`, { mode: 0o600 });
    await startDockerEnclaveLifecycle(config);
    fs.writeFileSync(paths.githubAgentIdPath, 'different-identity-after-startup');
    const options = jest.mocked(createDockerHostEnclaveExecutor).mock.calls[0][0];
    expect(await options.resolveAgentAuthority!({
      entryId: 'agent', seedId: deriveEnclaveSeedId(runId, 'octo/private'),
    } as HostExecutorInvocationPlan, new AbortController().signal))
      .toEqual({ githubAgentId: identity, repository: 'octo/private' });
    expect(await options.resolveAgentAuthority!({
      entryId: 'agent', seedId: deriveEnclaveSeedId(runId, 'octo/other'),
    } as HostExecutorInvocationPlan, new AbortController().signal))
      .toEqual({ githubAgentId: identity, repository: 'octo/other' });
    await expect(options.resolveAgentAuthority!({
      entryId: 'agent', seedId: deriveEnclaveSeedId(runId, 'wrong/target'),
    } as HostExecutorInvocationPlan, new AbortController().signal)).rejects.toThrow(/trusted seed catalog/);
    await expect(options.resolveAgentAuthority!({
      entryId: 'agent',
    } as HostExecutorInvocationPlan, new AbortController().signal)).rejects.toThrow(/trusted seed catalog/);
    await stopDockerEnclaveLifecycle(config);
  });

  it('starts dynamic-only host authority without a seed map or a live delegation service', async () => {
    config.enableApiProxy = true;
    config.copilotGithubToken = 'test';
    config.enclaves = normalizeEnclavesConfig([{
      agent: { model: 'trusted-model' }, dynamic: typedDynamicEnclavePolicyFixture(),
    }]);
    const paths = resolveEnclavePaths(directory);
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.runIdPath, runId, { mode: 0o600 });
    jest.mocked(deriveHostExecutorRunState).mockImplementationOnce(
      jest.requireActual('./host-executor-run-state').deriveHostExecutorRunState,
    );
    await startDockerEnclaveLifecycle(config);
    expect(fs.existsSync(paths.seedMapPath)).toBe(false);
    expect(jest.mocked(startHostExecutorService).mock.calls[0][0].runState.entries)
      .toEqual([expect.objectContaining({
        entryId: 'agent', staticSeedIds: [], dynamicAgents: true,
      })]);
    await stopDockerEnclaveLifecycle(config);
  });

  it('closes admissions and drains even when containers are kept, idempotently', async () => {
    config.keepContainers = true;
    await startDockerEnclaveLifecycle(config);
    closeDockerEnclaveAdmissions(config);
    await expect(assertDockerEnclaveLifecycleReady(config)).rejects.toThrow(/preflight/);
    await Promise.all([stopDockerEnclaveLifecycle(config), stopDockerEnclaveLifecycle(config)]);
    expect(server.closeAdmissions).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('rejects another configuration owner and preserves uncertain cleanup', async () => {
    await startDockerEnclaveLifecycle(config);
    expect(() => closeDockerEnclaveAdmissions({ ...config })).toThrow(/another configuration/);
    jest.mocked(server.close).mockRejectedValue(new Error('recovery pending'));
    await expect(stopDockerEnclaveLifecycle(config)).rejects.toThrow('recovery pending');
    await expect(stopDockerEnclaveLifecycle(config)).rejects.toThrow('recovery pending');
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('does not clean private state after backend startup failure', async () => {
    jest.mocked(startHostExecutorService).mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(startDockerEnclaveLifecycle(config)).rejects.toThrow('storage unavailable');
    await expect(stopDockerEnclaveLifecycle(config)).rejects.toThrow(/startup failed/);
  });

  it('blocks private-state deletion when completed execution left a resource recovery record', async () => {
    await startDockerEnclaveLifecycle(config);
    const directory = path.join(resolveEnclavePaths(config.workDir).hostExecutorJournalDir, 'docker');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, `${runId}-agent-${'f'.repeat(32)}.json`), '{}', { mode: 0o600 });
    await expect(stopDockerEnclaveLifecycle(config)).rejects.toThrow(/resource cleanup is pending/);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('settles and revokes host-only dynamic authority before releasing results (revoked=%s)', async (revoked) => {
    config.enclaves = normalizeEnclavesConfig([{
      agent: { model: 'trusted-model' }, dynamic: typedDynamicEnclavePolicyFixture(),
    }]);
    const service = {
      admit: jest.fn().mockResolvedValue({
        admitted: true, repository: 'octo/private', executorBearer: 'private-executor-bearer', readMode: 'live',
      }),
      settle: jest.fn().mockResolvedValue({ settled: true, revoked }),
    };
    jest.mocked(getEnclaveHostDynamicAuthority)
      .mockReturnValue(service as unknown as ReturnType<typeof getEnclaveHostDynamicAuthority>);
    jest.mocked(createDockerHostEnclaveExecutor).mockImplementation((options) => ({
      prepare: jest.fn().mockResolvedValue(undefined),
      async execute(plan, signal) {
        expect(await options.resolveAgentAuthority!(plan, signal)).toEqual({
          repository: 'octo/private', githubBearer: 'private-executor-bearer', readMode: 'live',
        });
        expect(await options.settleAgentAuthority!(plan, {
          outcome: 'success', outputBytes: 11, executionSeconds: 3,
          cleanupComplete: true, uncertain: false,
        })).toEqual({ revoked });
        return { outcome: 'success', result: '{"ok":true}' };
      },
      close: jest.fn(),
    }));
    await startDockerEnclaveLifecycle(config);
    expect(service.admit).not.toHaveBeenCalled();
    const plan = {
      invocationId: 'd'.repeat(32), selector: 'octo/private', schemaHash: 'e'.repeat(64),
    } as HostExecutorInvocationPlan;
    const result = await backend.execute(plan, new AbortController().signal);
    expect(service.admit).toHaveBeenCalledWith({
      version: 1, invocationId: plan.invocationId, selector: plan.selector, schemaHash: plan.schemaHash,
    });
    expect(service.settle).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: plan.invocationId, outcome: 'success', outputBytes: 11, executionSeconds: 3,
    }));
    expect(service.settle).toHaveBeenCalledTimes(1);
    if (revoked) {
      expect(result).toEqual({ outcome: 'success', result: '{"ok":true}' });
      await stopDockerEnclaveLifecycle(config);
    } else {
      expect(result).toEqual({ outcome: 'executor-failure', cleanupComplete: false });
      await expect(backend.close!()).rejects.toThrow(/settlement requires trusted recovery/);
    }
  });

  it('settles and revokes a cancelled dynamic invocation after workload cleanup', async () => {
    config.enclaves = normalizeEnclavesConfig([{
      agent: { model: 'trusted-model' }, dynamic: typedDynamicEnclavePolicyFixture(),
    }]);
    const order: string[] = [];
    const controller = new AbortController();
    const service = {
      admit: jest.fn().mockResolvedValue({
        admitted: true, repository: 'octo/private', executorBearer: 'private-executor-bearer', readMode: 'live',
      }),
      settle: jest.fn().mockImplementation(async () => {
        order.push('revoke');
        return { settled: true, revoked: true };
      }),
    };
    jest.mocked(getEnclaveHostDynamicAuthority)
      .mockReturnValue(service as unknown as ReturnType<typeof getEnclaveHostDynamicAuthority>);
    jest.mocked(createDockerHostEnclaveExecutor).mockImplementation((options) => ({
      prepare: jest.fn().mockResolvedValue(undefined),
      async execute(plan, signal) {
        await options.resolveAgentAuthority!(plan, signal);
        controller.abort();
        order.push('container-cleanup');
        return { outcome: 'cancelled' };
      },
      close: jest.fn(),
    }));
    await startDockerEnclaveLifecycle(config);
    const plan = {
      invocationId: 'f'.repeat(32), selector: 'octo/private', schemaHash: 'e'.repeat(64),
    } as HostExecutorInvocationPlan;
    expect(await backend.execute(plan, controller.signal)).toEqual({ outcome: 'cancelled' });
    expect(order).toEqual(['container-cleanup', 'revoke']);
    expect(service.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'cancelled', outputBytes: 0,
    }));
    await stopDockerEnclaveLifecycle(config);
  });

  it('revokes an identity when cancellation lands immediately after admission without launching', async () => {
    config.enclaves = normalizeEnclavesConfig([{
      agent: { model: 'trusted-model' }, dynamic: typedDynamicEnclavePolicyFixture(),
    }]);
    const controller = new AbortController();
    const service = {
      admit: jest.fn().mockImplementation(async () => {
        controller.abort();
        return {
          admitted: true, repository: 'octo/private', executorBearer: 'private-executor-bearer', readMode: 'live',
        };
      }),
      settle: jest.fn().mockResolvedValue({ settled: true, revoked: true }),
    };
    jest.mocked(getEnclaveHostDynamicAuthority)
      .mockReturnValue(service as unknown as ReturnType<typeof getEnclaveHostDynamicAuthority>);
    const execute = jest.fn();
    jest.mocked(createDockerHostEnclaveExecutor).mockReturnValue({
      prepare: jest.fn(), execute, close: jest.fn(),
    });
    await startDockerEnclaveLifecycle(config);
    expect(await backend.execute({
      invocationId: 'd'.repeat(32), selector: 'octo/private', schemaHash: 'e'.repeat(64),
    } as HostExecutorInvocationPlan, controller.signal)).toEqual({ outcome: 'cancelled' });
    expect(execute).not.toHaveBeenCalled();
    expect(service.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'cancelled', outputBytes: 0, executionSeconds: 0,
    }));
    await stopDockerEnclaveLifecycle(config);
  });

  it.each(['denied', 'throws'] as const)('settles dynamic admission %s without launching or poisoning clean recovery', async (admission) => {
    config.enclaves = normalizeEnclavesConfig([{
      agent: { model: 'trusted-model' }, dynamic: typedDynamicEnclavePolicyFixture(),
    }]);
    const service = {
      isAdmitting: admission === 'denied',
      admit: admission === 'denied'
        ? jest.fn().mockResolvedValue({ admitted: false })
        : jest.fn().mockRejectedValue(new Error('audit write failed after identity creation')),
      settle: jest.fn().mockResolvedValue({ settled: true, revoked: true }),
    };
    jest.mocked(getEnclaveHostDynamicAuthority)
      .mockReturnValue(service as unknown as ReturnType<typeof getEnclaveHostDynamicAuthority>);
    const execute = jest.fn();
    jest.mocked(createDockerHostEnclaveExecutor).mockReturnValue({
      prepare: jest.fn(), execute, close: jest.fn(),
    });
    await startDockerEnclaveLifecycle(config);
    const plan = {
      invocationId: 'b'.repeat(32), selector: 'octo/private', schemaHash: 'e'.repeat(64),
    } as HostExecutorInvocationPlan;
    expect(await backend.execute(plan, new AbortController().signal))
      .toEqual(admission === 'denied'
        ? { outcome: 'executor-failure', recoverableFailure: true, cleanupComplete: true }
        : { outcome: 'executor-failure' });
    expect(execute).not.toHaveBeenCalled();
    expect(service.settle).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: plan.invocationId, outcome: 'agent-failure', outputBytes: 0,
    }));
    await expect(backend.close!()).resolves.toBeUndefined();
    await stopDockerEnclaveLifecycle(config);
  });

  it('preserves recovery state when admission denial leaves delegation reconciliation incomplete', async () => {
    config.enclaves = normalizeEnclavesConfig([{
      agent: { model: 'trusted-model' }, dynamic: typedDynamicEnclavePolicyFixture(),
    }]);
    const service = {
      isAdmitting: false,
      admit: jest.fn().mockResolvedValue({ admitted: false }),
      settle: jest.fn().mockResolvedValue({ settled: true, revoked: true }),
    };
    jest.mocked(getEnclaveHostDynamicAuthority)
      .mockReturnValue(service as unknown as ReturnType<typeof getEnclaveHostDynamicAuthority>);
    await startDockerEnclaveLifecycle(config);
    const plan = {
      invocationId: 'b'.repeat(32), selector: 'octo/private', schemaHash: 'e'.repeat(64),
    } as HostExecutorInvocationPlan;
    expect(await backend.execute(plan, new AbortController().signal))
      .toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(service.settle).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'agent-failure', outputBytes: 8192, executionSeconds: 120,
    }));
    await expect(backend.close!()).rejects.toThrow(/settlement requires trusted recovery/);
  });

  it.each(['uncertain', 'unknown'] as const)('charges worst-case dynamic usage before revocation when workload usage is %s', async (usage) => {
    const policy = typedDynamicEnclavePolicyFixture();
    config.enclaves = normalizeEnclavesConfig([{
      agent: { model: 'trusted-model' }, dynamic: policy,
    }]);
    const service = {
      admit: jest.fn().mockResolvedValue({
        admitted: true, repository: 'octo/private', executorBearer: 'private-executor-bearer', readMode: 'live',
      }),
      settle: jest.fn().mockResolvedValue({ settled: true, revoked: true }),
    };
    jest.mocked(getEnclaveHostDynamicAuthority)
      .mockReturnValue(service as unknown as ReturnType<typeof getEnclaveHostDynamicAuthority>);
    jest.mocked(createDockerHostEnclaveExecutor).mockReturnValue({
      prepare: jest.fn(),
      execute: jest.fn().mockResolvedValue(usage === 'uncertain'
        ? { outcome: 'executor-failure', cleanupComplete: false } : undefined),
      close: jest.fn(),
    });
    await startDockerEnclaveLifecycle(config);
    const plan = {
      invocationId: 'a'.repeat(32), selector: 'octo/private', schemaHash: 'e'.repeat(64),
    } as HostExecutorInvocationPlan;
    expect(await backend.execute(plan, new AbortController().signal))
      .toEqual({ outcome: 'executor-failure', cleanupComplete: false });
    expect(service.settle).toHaveBeenCalledWith(expect.objectContaining({
      outputBytes: policy.limits.maxOutputBytes, executionSeconds: policy.limits.timeoutSeconds,
    }));
    await stopDockerEnclaveLifecycle(config);
  });

  it.each([false, true])('requires recovery after process state is lost even without a resource journal (journal=%s)', async (journal) => {
    const paths = resolveEnclavePaths(directory);
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.hostExecutorJournalDir, { mode: 0o700 });
    fs.writeFileSync(paths.runIdPath, runId, { mode: 0o600 });
    if (journal) {
      fs.writeFileSync(path.join(paths.hostExecutorJournalDir, `${runId}.journal`), 'pending', { mode: 0o600 });
    }
    await expect(stopDockerEnclaveLifecycle(config)).rejects.toThrow(/trusted reconciliation/);
    expect(fs.existsSync(paths.runIdPath)).toBe(true);
  });

  it('never selects legacy gVisor or runs a listener for disabled enclaves', async () => {
    const disabled = { ...config, enclaves: undefined };
    expect(isDockerEnclaveSelected(disabled)).toBe(false);
    await startDockerEnclaveLifecycle(disabled);
    await stopDockerEnclaveLifecycle(disabled);
    expect(startHostExecutorService).not.toHaveBeenCalled();
  });
});
