import * as fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { PRIVATE_REPOSITORY_SEED_MAP_VERSION } from '../bounded-execution';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { deriveEnclaveSeedId, resolveEnclavePaths } from './paths';
import type { HostExecutorServer } from './host-executor-server';
import { assertAgentRuntimeAvailable, assertScriptRuntimeAvailable } from './runtime-preflight';
import { startCloudHypervisorEnclaveHostService } from './cloud-hypervisor-host-service';
import {
  assertCloudHypervisorEnclaveLifecycleReady,
  assertCloudHypervisorEnclavePrerequisites,
  closeCloudHypervisorEnclaveAdmissions,
  deriveCloudHypervisorEnclaveRunState,
  startCloudHypervisorEnclaveLifecycle,
  stopCloudHypervisorEnclaveLifecycle,
  type TrustedCloudHypervisorEnclaveStorageProvider,
} from './cloud-hypervisor-lifecycle';

jest.mock('./cloud-hypervisor-host-service');
const start = jest.mocked(startCloudHypervisorEnclaveHostService);

jest.mock('./paths', () => {
  const actual = jest.requireActual('./paths');
  return {
    ...actual,
    resolveEnclavePaths: (workDir: string) => ({
      ...actual.resolveEnclavePaths(workDir, path.dirname(workDir)),
      hostExecutorJournalDir: path.join(process.cwd(), '.ch-global-journal-test'),
    }),
  };
});

describe('trusted Cloud Hypervisor enclave lifecycle', () => {
  let workDir: string;
  let config: WrapperConfig;
  let server: HostExecutorServer;
  let storage: { close: jest.Mock };
  let provider: TrustedCloudHypervisorEnclaveStorageProvider;
  const repository = { repo: 'octo/private', sensitivity: 'internal' as const };
  const runId = 'a'.repeat(32);

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(process.cwd(), '.ch-lifecycle-test-'));
    config = {
      workDir,
      enableApiProxy: true,
      copilotGithubToken: 'test',
      cloudHypervisor: { previewEnabled: true },
      enclaves: normalizeEnclavesConfig([
        { script: {}, runtime: 'cloud-hypervisor', timeout: 30, repos: [repository] },
        {
          agent: { model: 'trusted-model', maxModelRequests: 4, maxModelTokens: 128 },
          runtime: 'cloud-hypervisor', timeout: 60, repos: [repository], maxOutputBytes: 512,
        },
      ]),
    } as WrapperConfig;
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(paths.root, { mode: 0o700 });
    fs.mkdirSync(paths.seedsDir);
    fs.mkdirSync(path.join(paths.seedsDir, deriveEnclaveSeedId(runId, repository.repo)));
    fs.writeFileSync(paths.runIdPath, runId, { mode: 0o600 });
    fs.writeFileSync(paths.seedMapPath, JSON.stringify({
      version: PRIVATE_REPOSITORY_SEED_MAP_VERSION,
      runId,
      seeds: [{ ...repository, seedId: deriveEnclaveSeedId(runId, repository.repo) }],
    }), { mode: 0o600 });
    server = {
      socketPath: path.join(paths.hostExecutorDir, 'executor.sock'),
      capabilityPath: path.join(paths.hostExecutorDir, 'capability'),
      closeAdmissions: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    start.mockReset().mockResolvedValue(server);
    storage = { close: jest.fn().mockResolvedValue(undefined) };
    provider = {
      assertAvailable: jest.fn().mockResolvedValue(undefined),
      prepareRun: jest.fn().mockResolvedValue(storage),
    };
  });

  afterEach(() => {
    const paths = resolveEnclavePaths(workDir);
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    fs.rmSync(paths.hostExecutorJournalDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('requires hard-bounded storage and propagates unavailable-provider failure', async () => {
    await expect(assertCloudHypervisorEnclavePrerequisites(config)).rejects.toThrow(/9394/);
    (provider.assertAvailable as jest.Mock).mockRejectedValue(new Error('capacity enforcement unavailable'));
    await expect(assertCloudHypervisorEnclavePrerequisites(config, provider))
      .rejects.toThrow('capacity enforcement unavailable');
    expect(provider.prepareRun).not.toHaveBeenCalled();
  });

  it('never prepares storage or exposes a listener when provider availability fails', async () => {
    (provider.assertAvailable as jest.Mock).mockRejectedValue(new Error('hard capacity enforcement unavailable'));
    await expect(startCloudHypervisorEnclaveLifecycle(config, provider, {}))
      .rejects.toThrow('hard capacity enforcement unavailable');
    expect(provider.prepareRun).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow(/startup failed/);
    expect(fs.existsSync(resolveEnclavePaths(workDir).seedMapPath)).toBe(true);
  });

  it('derives fixed entry IDs, exact seed IDs, and host-only paths from staged state', () => {
    const paths = resolveEnclavePaths(workDir);
    expect(deriveCloudHypervisorEnclaveRunState(config, paths)).toEqual({
      runId,
      seedsDir: paths.seedsDir,
      invocationsDir: paths.workDir,
      journalDir: paths.hostExecutorJournalDir,
      entries: [
        {
          entryId: 'script', executorKind: 'script', timeoutMs: 30_000,
          staticSeedIds: [deriveEnclaveSeedId(runId, repository.repo)], dynamicAgents: false,
        },
        {
          entryId: 'agent', executorKind: 'agent', timeoutMs: 60_000,
          staticSeedIds: [deriveEnclaveSeedId(runId, repository.repo)], dynamicAgents: false,
        },
      ],
    });
  });

  it.each(['wrong-run', 'unknown-repo', 'wrong-seed', 'missing-repo'])(
    'rejects %s staged catalog before storage or listener effects', async (failure) => {
      const paths = resolveEnclavePaths(workDir);
      const map = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
      if (failure === 'wrong-run') map.runId = 'b'.repeat(32);
      if (failure === 'unknown-repo') map.seeds[0].repo = 'evil/other';
      if (failure === 'wrong-seed') map.seeds[0].seedId = 'b'.repeat(32);
      if (failure === 'missing-repo') map.seeds = [];
      fs.writeFileSync(paths.seedMapPath, JSON.stringify(map));
      await expect(startCloudHypervisorEnclaveLifecycle(config, provider, {})).rejects.toThrow();
      expect(provider.prepareRun).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    },
  );

  it('runs trusted storage preparation before full preflight and admits only one listener', async () => {
    await expect(assertCloudHypervisorEnclaveLifecycleReady(config)).rejects.toThrow(/full preflight/);
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      runtimeDir: resolveEnclavePaths(workDir).hostExecutorDir,
      agentPolicies: {
        agent: {
          model: 'trusted-model', profile: 'openai', maxOutputBytes: 512,
          maxModelRequests: 4, maxModelTokens: 128,
        },
      },
    }));
    expect((provider.prepareRun as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan(start.mock.invocationCallOrder[0]);
    await expect(assertCloudHypervisorEnclaveLifecycleReady(config)).resolves.toBeUndefined();
    await expect(assertCloudHypervisorEnclaveLifecycleReady({ ...config })).rejects.toThrow();
    const noDockerProbe = jest.fn();
    await expect(assertScriptRuntimeAvailable(
      config.enclaves!.executors.script, noDockerProbe, noDockerProbe, config,
    )).resolves.toBeUndefined();
    await expect(assertAgentRuntimeAvailable(
      config.enclaves!.executors.agent, noDockerProbe, noDockerProbe, config,
    )).resolves.toBeUndefined();
    expect(noDockerProbe).not.toHaveBeenCalled();
    await expect(startCloudHypervisorEnclaveLifecycle(config, provider, {}))
      .rejects.toThrow(/already exists/);
    await stopCloudHypervisorEnclaveLifecycle(config);
  });

  it('drains admissions before cancelling the backend, then releases bounded storage', async () => {
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    closeCloudHypervisorEnclaveAdmissions(config);
    await expect(assertCloudHypervisorEnclaveLifecycleReady(config)).rejects.toThrow();
    await Promise.all([stopCloudHypervisorEnclaveLifecycle(config), stopCloudHypervisorEnclaveLifecycle(config)]);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect((server.closeAdmissions as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((server.close as jest.Mock).mock.invocationCallOrder[0]);
    expect((server.close as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan(storage.close.mock.invocationCallOrder[0]);
  });

  it('waits for in-flight startup and immediately drains a late listener', async () => {
    let resolveStart!: (value: HostExecutorServer) => void;
    start.mockImplementationOnce(() => new Promise<HostExecutorServer>((resolve) => { resolveStart = resolve; }));
    const starting = startCloudHypervisorEnclaveLifecycle(config, provider, {});
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = stopCloudHypervisorEnclaveLifecycle(config);
    expect(storage.close).not.toHaveBeenCalled();
    resolveStart(server);
    await Promise.all([starting, stopping]);
    expect(server.closeAdmissions).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('preserves private state and storage enforcement if backend cleanup fails', async () => {
    (server.close as jest.Mock).mockRejectedValue(new Error('VM cleanup uncertain'));
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow('VM cleanup uncertain');
    expect(storage.close).not.toHaveBeenCalled();
    expect(fs.existsSync(resolveEnclavePaths(workDir).seedMapPath)).toBe(true);
    await expect(startCloudHypervisorEnclaveLifecycle(config, provider)).rejects.toThrow(/already exists/);
  });

  it('preserves recovery records even when backend close resolves with pending resources', async () => {
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(paths.hostExecutorJournalDir);
    fs.writeFileSync(path.join(paths.hostExecutorJournalDir, `${runId}-${'b'.repeat(32)}.resources.json`),
      JSON.stringify({ runId, state: 'pending' }), { mode: 0o600 });
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow(/cleanup is uncertain/);
    expect(storage.close).not.toHaveBeenCalled();
  });

  it('preserves cleanup-pending invocation tombstones even if the listener closes normally', async () => {
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(paths.hostExecutorJournalDir);
    fs.writeFileSync(path.join(paths.hostExecutorJournalDir, `${runId}.journal`),
      '{"state":"cleanup-pending"}\n{"state":"closed"}\n', { mode: 0o600 });
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow(/cleanup is uncertain/);
    expect(storage.close).not.toHaveBeenCalled();
  });

  it('retains global cleaned records and ignores unrelated runs during confirmed shutdown', async () => {
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    const paths = resolveEnclavePaths(workDir);
    expect(resolveEnclavePaths(path.join(workDir, 'another-workdir')).hostExecutorJournalDir)
      .toBe(paths.hostExecutorJournalDir);
    fs.mkdirSync(paths.hostExecutorJournalDir);
    const currentJournal = path.join(paths.hostExecutorJournalDir, `${runId}.journal`);
    fs.writeFileSync(currentJournal, '{"state":"closed"}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(paths.hostExecutorJournalDir, `${runId}-${'b'.repeat(32)}.resources.json`),
      JSON.stringify({ runId, state: 'cleaned' }), { mode: 0o600 });
    const otherJournal = path.join(paths.hostExecutorJournalDir, `${'c'.repeat(32)}.journal`);
    fs.writeFileSync(otherJournal, '{"state":"open"}\n', { mode: 0o600 });
    await stopCloudHypervisorEnclaveLifecycle(config);
    await stopCloudHypervisorEnclaveLifecycle(config);
    expect(storage.close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(currentJournal)).toBe(true);
    expect(fs.existsSync(otherJournal)).toBe(true);
  });

  it('preserves startup recovery state and refuses orphan journal deletion after a restart', async () => {
    start.mockRejectedValueOnce(new Error('artifact preflight failed'));
    await expect(startCloudHypervisorEnclaveLifecycle(config, provider, {})).rejects.toThrow(/artifact preflight/);
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow(/startup failed/);
    expect(storage.close).not.toHaveBeenCalled();
    const other = { ...config, workDir: path.join(workDir, 'restarted') };
    const paths = resolveEnclavePaths(other.workDir);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.runIdPath, 'c'.repeat(32));
    fs.mkdirSync(paths.hostExecutorJournalDir, { recursive: true });
    fs.writeFileSync(path.join(paths.hostExecutorJournalDir, `${'c'.repeat(32)}.journal`),
      '{"state":"open"}\n', { mode: 0o600 });
    await expect(stopCloudHypervisorEnclaveLifecycle(other)).rejects.toThrow(/trusted reconciliation/);
  });
});
