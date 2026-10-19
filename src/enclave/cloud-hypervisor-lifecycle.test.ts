import * as fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { PRIVATE_REPOSITORY_SEED_MAP_VERSION } from '../bounded-execution';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { deriveEnclaveSeedId, resolveEnclavePaths } from './paths';
import { startHostExecutorServer, type HostExecutorServer } from './host-executor-server';
import { assertAgentRuntimeAvailable, assertScriptRuntimeAvailable } from './runtime-preflight';
import { startCloudHypervisorEnclaveHostService } from './cloud-hypervisor-host-service';
import { getEnclaveStartupProgress } from './startup-progress';
import {
  HostExecutorInvocationDiagnostics, HostExecutorControlDiagnostics, readHostExecutorInvocationDiagnostics,
} from './host-executor-journal';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import type { HostExecutorInvocationPlan } from './host-executor-server';
import * as cloudHypervisorManager from '../cloud-hypervisor/manager';
import { ProductionTrustedCloudHypervisorEnclaveStorageProvider } from '../cloud-hypervisor/trusted-enclave-storage';
import { ENCLAVE_DEBUG_ARTIFACT_ROOT } from './public-debug';
import * as proxyDebugRetention from './proxy-debug-retention';
import { logger } from '../logger';
import {
  assertCloudHypervisorEnclaveLifecycleReady,
  assertCloudHypervisorEnclavePrerequisites,
  closeCloudHypervisorEnclaveAdmissions,
  deriveCloudHypervisorEnclaveRunState,
  startCloudHypervisorEnclaveLifecycle,
  stopCloudHypervisorEnclaveLifecycle,
  type TrustedCloudHypervisorEnclaveStorageProvider,
} from './cloud-hypervisor-lifecycle';

jest.mock('./cloud-hypervisor-host-service', () => ({ startCloudHypervisorEnclaveHostService: jest.fn() }));
const start = jest.mocked(startCloudHypervisorEnclaveHostService);
jest.mock('../host-identity', () => ({
  ...jest.requireActual('../host-identity'),
  getSafeHostUid: () => String(process.getuid!()),
  getSafeHostGid: () => String(process.getgid!()),
}));

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
    jest.spyOn(proxyDebugRetention, 'captureEnclaveProxyContainerLog')
      .mockResolvedValue('capture_status=unavailable\n');
    const dependencies = cloudHypervisorManager.resolveCloudHypervisorManagerDependencies();
    jest.spyOn(cloudHypervisorManager, 'resolveCloudHypervisorManagerDependencies').mockReturnValue({
      ...dependencies, resolveIdentity: () => ({ uid: process.getuid!(), gid: process.getgid!() }),
    });
    workDir = fs.mkdtempSync(path.join(process.cwd(), '.ch-lifecycle-test-'));
    config = {
      workDir,
      containerRuntime: 'cloud-hypervisor',
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
    jest.restoreAllMocks();
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
    expect(getEnclaveStartupProgress(config)).toMatchObject({
      stage: 'host-preflight', readiness: 'not-attempted',
    });
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow(/startup failed/);
    expect(fs.existsSync(resolveEnclavePaths(workDir).seedMapPath)).toBe(true);
  });

  it('publishes the origin subcheck for actual production admission before listener or network readiness', async () => {
    const production = new ProductionTrustedCloudHypervisorEnclaveStorageProvider({
      platform: 'linux', arch: 'x64', uid: 1000, environment: {},
      readFile: jest.fn(), access: jest.fn(), lstat: jest.fn(), openKvm: jest.fn(),
    });
    const prepare = jest.spyOn(production, 'prepareRun');
    await expect(startCloudHypervisorEnclaveLifecycle(config, production, {})).rejects.toThrow(/9394/);
    const progress = getEnclaveStartupProgress(config);
    expect(progress).toMatchObject({
      stage: 'host-preflight', readiness: 'not-attempted', code: 'none', attempts: 0, httpStatus: null,
      hostPreflight: {
        schemaVersion: 1, scope: 'storage-admission',
        checks: expect.arrayContaining([
          { id: 'root', result: 'failed', reason: 'requirement-not-met' },
          { id: 'kvm-open', result: 'not-attempted', reason: 'none' },
        ]),
      },
    });
    expect(start).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    progress!.hostPreflight!.checks[0].result = 'passed';
    expect(getEnclaveStartupProgress(config)!.hostPreflight!.checks[0].result).toBe('failed');
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow(/startup failed/);
  });
  it('derives fixed entry IDs, exact seed IDs, and host-only paths from staged state', () => {
    const paths = resolveEnclavePaths(workDir);
    expect(deriveCloudHypervisorEnclaveRunState(config, paths)).toEqual({
      runId,
      seedsDir: paths.seedsDir,
      invocationsDir: path.join(path.dirname(paths.hostExecutorJournalDir), 'host-invocations', runId),
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

  it('authorizes agent invocations against the run-wide static repository catalog', () => {
    const agentRepository = { repo: 'octo/agent-only', sensitivity: 'internal' as const };
    config.enclaves!.executors.agent.repos = [agentRepository];
    config.enclaves!.privateRepos = [...config.enclaves!.privateRepos, agentRepository];
    const seedId = deriveEnclaveSeedId(runId, agentRepository.repo);
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(path.join(paths.seedsDir, seedId));
    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
    seedMap.seeds.push({ ...agentRepository, seedId });
    fs.writeFileSync(paths.seedMapPath, JSON.stringify(seedMap));

    const state = deriveCloudHypervisorEnclaveRunState(config, paths);
    expect(state.entries.find((entry) => entry.entryId === 'agent')?.staticSeedIds)
      .toEqual([deriveEnclaveSeedId(runId, repository.repo), seedId]);
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
    const onPreflightStage = start.mock.calls[0][0].onPreflightStage;
    onPreflightStage?.('artifact-preflight');
    expect(getEnclaveStartupProgress(config)).toMatchObject({
      stage: 'artifact-preflight', readiness: 'not-attempted', code: 'none',
    });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      runtimeDir: resolveEnclavePaths(workDir).hostExecutorDir,
      workDir: resolveEnclavePaths(workDir).workDir,
      agentPolicies: {
        agent: {
          model: 'trusted-model', profile: 'openai', maxOutputBytes: 512,
          maxModelRequests: 4, maxModelTokens: 128,
          modelBudgetSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    }));
    expect(start.mock.calls[0][0].publicDebugArtifactDirectory).toBeUndefined();
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

  it.each([
    { isPublic: true, explicit: true },
    { isPublic: false, explicit: true },
    { isPublic: true, explicit: undefined },
    { isPublic: false, explicit: undefined },
  ])('verifies public fixtures before retention (public=$isPublic, explicit=$explicit)', async ({ isPublic, explicit }) => {
    config.cloudHypervisor!.enclaveDebugPublic = explicit;
    config.enclaves!.privateRepos[0].sensitivity = 'public';
    const paths = resolveEnclavePaths(workDir);
    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
    seedMap.seeds[0].sensitivity = 'public';
    fs.writeFileSync(paths.seedMapPath, JSON.stringify(seedMap));
    const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      full_name: repository.repo, private: !isPublic, visibility: isPublic ? 'public' : 'private',
    })));
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    if (isPublic) {
      expect(start).toHaveBeenCalledWith(expect.objectContaining({
        config: expect.objectContaining({ enclaveDebugPublic: true }),
        publicDebugArtifactDirectory: ENCLAVE_DEBUG_ARTIFACT_ROOT,
        publicDebugArtifactProtectedRoot: path.dirname(path.dirname(ENCLAVE_DEBUG_ARTIFACT_ROOT)),
      }));
      expect(request.mock.invocationCallOrder[0])
        .toBeLessThan((provider.prepareRun as jest.Mock).mock.invocationCallOrder[0]);
    } else {
      expect(start.mock.calls[0][0].config.enclaveDebugPublic).toBe(false);
      expect(start.mock.calls[0][0].publicDebugArtifactDirectory).toBeUndefined();
      expect(start.mock.calls[0][0].publicDebugArtifactProtectedRoot).toBeUndefined();
    }
    expect(config.cloudHypervisor!.enclaveDebugPublic).toBe(explicit);
    await stopCloudHypervisorEnclaveLifecycle(config);
    if (!isPublic) expect(proxyDebugRetention.captureEnclaveProxyContainerLog).not.toHaveBeenCalled();
  });

  it.each([
    [() => new Response('PRIVATE_SENTINEL', { status: 403 }), 'http-status; status=403'],
    [() => new Response('PRIVATE_SENTINEL', { status: 429 }), 'http-status; status=429'],
    [() => new Response('PRIVATE_SENTINEL', { status: 503 }), 'http-status; status=503'],
    [() => new Response('PRIVATE_SENTINEL'), 'invalid-json; code=unknown; status=200'],
    [() => { throw new TypeError('PRIVATE_SENTINEL'); }, 'request-failed; code=unknown'],
  ] as const)('disables all public capture without blocking execution on visibility failure %s', async (response, reason) => {
    config.cloudHypervisor!.enclaveDebugPublic = true;
    config.enclaves!.privateRepos[0].sensitivity = 'public';
    const paths = resolveEnclavePaths(workDir);
    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
    seedMap.seeds[0].sensitivity = 'public';
    fs.writeFileSync(paths.seedMapPath, JSON.stringify(seedMap));
    const request = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
    const warning = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await startCloudHypervisorEnclaveLifecycle(config, provider, {});

    expect(request).toHaveBeenCalledTimes(1);
    const options = start.mock.calls[0][0];
    expect(options.config.enclaveDebugPublic).toBe(false);
    expect(options.publicDebugArtifactDirectory).toBeUndefined();
    expect(options.publicDebugArtifactProtectedRoot).toBeUndefined();
    expect(provider.prepareRun).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ enclaveDebugPublic: false }),
    }));
    expect(config.cloudHypervisor!.enclaveDebugPublic).toBe(true);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(
      `Public enclave debug capture and export disabled: Public enclave debug repository visibility could not be verified (reason=${reason})`,
    ));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_SENTINEL');
    await expect(assertCloudHypervisorEnclaveLifecycleReady(config)).resolves.toBeUndefined();

    await stopCloudHypervisorEnclaveLifecycle(config);

    expect(storage.close).toHaveBeenCalledTimes(1);
    expect(proxyDebugRetention.captureEnclaveProxyContainerLog).not.toHaveBeenCalled();
    expect(readHostExecutorInvocationDiagnostics({ runId, journalDir: paths.hostExecutorJournalDir })
      .some(file => JSON.parse(file.contents).component === 'enclave-proxy-response')).toBe(false);
  });

  it('keeps invalid explicit public-debug scopes fatal rather than treating them as unavailable metadata', async () => {
    config.cloudHypervisor!.enclaveDebugPublic = true;
    const request = jest.spyOn(globalThis, 'fetch');
    await expect(startCloudHypervisorEnclaveLifecycle(config, provider, {}))
      .rejects.toThrow(/static public-only/);
    expect(request).not.toHaveBeenCalled();
    expect(provider.prepareRun).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).resolves.toBeUndefined();
    expect(server.close).not.toHaveBeenCalled();
    expect(storage.close).not.toHaveBeenCalled();
  });

  it('honors an explicit public log opt-out without requesting visibility', async () => {
    config.cloudHypervisor!.enclaveDebugPublic = false;
    config.enclaves!.privateRepos[0].sensitivity = 'public';
    const paths = resolveEnclavePaths(workDir);
    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
    seedMap.seeds[0].sensitivity = 'public';
    fs.writeFileSync(paths.seedMapPath, JSON.stringify(seedMap));
    const request = jest.spyOn(globalThis, 'fetch');
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    expect(request).not.toHaveBeenCalled();
    expect(start.mock.calls[0][0].publicDebugArtifactDirectory).toBeUndefined();
    await stopCloudHypervisorEnclaveLifecycle(config);
    expect(proxyDebugRetention.captureEnclaveProxyContainerLog).not.toHaveBeenCalled();
    expect(readHostExecutorInvocationDiagnostics({ runId, journalDir: paths.hostExecutorJournalDir })
      .some(file => JSON.parse(file.contents).component === 'enclave-proxy-response')).toBe(false);
  });

  it('captures public dedicated proxy statuses before private storage teardown and excludes request secrets', async () => {
    config.cloudHypervisor!.enclaveDebugPublic = true;
    config.enclaves!.privateRepos[0].sensitivity = 'public';
    const paths = resolveEnclavePaths(workDir);
    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
    seedMap.seeds[0].sensitivity = 'public';
    fs.writeFileSync(paths.seedMapPath, JSON.stringify(seedMap));
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      full_name: repository.repo, private: false, visibility: 'public',
    })));
    fs.mkdirSync(paths.apiProxyLogsDir, { mode: 0o700 });
    (server.close as jest.Mock).mockImplementation(async () => {
      fs.writeFileSync(path.join(paths.apiProxyLogsDir, 'enclave-proxy-events.jsonl'), [
        { schemaVersion: 1, status: 403, origin: 'local', authorization: 'PRIVATE_CREDENTIAL' },
        { schemaVersion: 1, status: 401, origin: 'upstream', response_body: 'PRIVATE_PAYLOAD' },
      ].map(value => JSON.stringify(value) + '\n').join(''), { mode: 0o600 });
    });
    storage.close.mockImplementation(async () => {
      const evidence = readHostExecutorInvocationDiagnostics({ runId, journalDir: paths.hostExecutorJournalDir });
      expect(evidence.some(file =>
        JSON.parse(file.contents).component === 'enclave-proxy-response')).toBe(true);
      expect(proxyDebugRetention.captureEnclaveProxyContainerLog).toHaveBeenCalledTimes(1);
      const retained = fs.readdirSync(path.join(paths.hostExecutorJournalDir, 'diagnostics'))
        .filter(name => name.endsWith('.proxy-debug.json'));
      expect(retained).toHaveLength(1);
      const runEvidence = JSON.parse(fs.readFileSync(
        path.join(paths.hostExecutorJournalDir, 'diagnostics', retained[0]), 'utf8'));
      expect(runEvidence).toMatchObject({ runId, scope: 'run-cumulative',
        events: [{ schemaVersion: 1, status: 403, origin: 'local' },
          { schemaVersion: 1, status: 401, origin: 'upstream' }] });
      fs.rmSync(paths.apiProxyLogsDir, { recursive: true, force: true });
    });
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    await stopCloudHypervisorEnclaveLifecycle(config);
    const evidence = readHostExecutorInvocationDiagnostics({ runId, journalDir: paths.hostExecutorJournalDir });
    const response = evidence.find(file => JSON.parse(file.contents).component === 'enclave-proxy-response')!;
    expect(JSON.parse(response.contents).diagnostics).toEqual({
      scope: 'run-cumulative', status: 'captured', records: 2,
      local: { '403': 1 }, upstream: { '401': 1 },
    });
    expect(response.contents).not.toMatch(/PRIVATE|authorization|response_body|credential/);
    expect(fs.readFileSync(path.join(workDir, 'audit/diagnostics/cloud-hypervisor/host-executor',
      response.name), 'utf8')).toBe(response.contents);
  });

  it('tracks deferred public visibility verification for duplicate startup and shutdown', async () => {
    config.cloudHypervisor!.enclaveDebugPublic = true;
    config.enclaves!.privateRepos[0].sensitivity = 'public';
    const paths = resolveEnclavePaths(workDir);
    const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8'));
    seedMap.seeds[0].sensitivity = 'public';
    fs.writeFileSync(paths.seedMapPath, JSON.stringify(seedMap));
    let resolveVisibility!: (response: Response) => void;
    const request = jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
      new Promise<Response>((resolve) => { resolveVisibility = resolve; }));

    const startup = startCloudHypervisorEnclaveLifecycle(config, provider, {});
    expect(request).toHaveBeenCalledTimes(1);
    expect(provider.prepareRun).not.toHaveBeenCalled();
    await expect(startCloudHypervisorEnclaveLifecycle(config, provider, {})).rejects.toThrow(/already exists/);

    let shutdownSettled = false;
    const shutdown = stopCloudHypervisorEnclaveLifecycle(config).then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(provider.prepareRun).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();

    resolveVisibility(new Response(JSON.stringify({
      full_name: repository.repo, private: false, visibility: 'public',
    })));
    await Promise.all([startup, shutdown]);
    expect(provider.prepareRun).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(server.closeAdmissions).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(storage.close).toHaveBeenCalledTimes(1);
  });

  it('keeps an allocation failure explicitly before gateway readiness', async () => {
    const failure = new Error('PRIVATE_STORAGE_PATH_TOKEN');
    (provider.prepareRun as jest.Mock).mockRejectedValueOnce(failure);
    await expect(startCloudHypervisorEnclaveLifecycle(config, provider, {})).rejects.toBe(failure);
    expect(getEnclaveStartupProgress(config)).toMatchObject({
      stage: 'storage-preflight', readiness: 'not-attempted', attempts: 0,
    });
    expect(start).not.toHaveBeenCalled();
  });

  it('releases bounded storage after failed backend startup when recovery is complete', async () => {
    start.mockRejectedValueOnce(new Error('artifact preflight failed'));
    await expect(startCloudHypervisorEnclaveLifecycle(config, provider, {}))
      .rejects.toThrow('artifact preflight failed');
    await expect(assertCloudHypervisorEnclaveLifecycleReady(config)).rejects.toThrow(/full preflight/);
    expect(storage.close).not.toHaveBeenCalled();
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow(/startup failed/);
    expect(storage.close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(resolveEnclavePaths(workDir).seedMapPath)).toBe(true);
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

  it('rejects cross-owner shutdown without closing admissions or releasing storage', async () => {
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    const other = { ...config };
    expect(() => closeCloudHypervisorEnclaveAdmissions(other)).toThrow(/owned by another/);
    await expect(stopCloudHypervisorEnclaveLifecycle(other)).rejects.toThrow(/owned by another/);
    expect(server.closeAdmissions).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();
    expect(storage.close).not.toHaveBeenCalled();
    await expect(assertCloudHypervisorEnclaveLifecycleReady(config)).resolves.toBeUndefined();
    await stopCloudHypervisorEnclaveLifecycle(config);
  });

  it('rejects mixed workload backends at the internal lifecycle boundary', async () => {
    config.containerRuntime = undefined;
    await expect(startCloudHypervisorEnclaveLifecycle(config, provider, {}))
      .rejects.toThrow(/differs from primary backend/);
    expect(provider.prepareRun).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
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

  it('exports protected invocation and pre-launch control evidence even when host shutdown rejects', async () => {
    const dependencies = cloudHypervisorManager.resolveCloudHypervisorManagerDependencies();
    jest.spyOn(cloudHypervisorManager, 'resolveCloudHypervisorManagerDependencies').mockReturnValue({
      ...dependencies, resolveIdentity: () => ({ uid: process.getuid!(), gid: process.getgid!() }),
    });

    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    const run = deriveCloudHypervisorEnclaveRunState(config, resolveEnclavePaths(workDir));
    const control = new HostExecutorControlDiagnostics(run);
    control.record('request-rejected', new Error('PRIVATE_REQUEST_BYTES'), 'denied', undefined, 'schema');
    const diagnostic = new HostExecutorInvocationDiagnostics(run, {
      runId, entryId: 'script', invocationId: 'b'.repeat(32), executorKind: 'script',
    } as HostExecutorInvocationPlan);
    const report = new HostPreflightReporter('host-invocation', diagnostic.publish);
    const launch = report.fork('vm-launch');
    const launchError = Object.assign(new Error('SECRET request/script/repository'), { code: 'EPERM' });
    await expect(diagnostic.check(report, 'manager-start', () =>
      launch.check('vm-create', () => { throw launchError; }))).rejects.toBe(launchError);
    const cleanup = report.fork('host-invocation-cleanup');
    const cleanupError = Object.assign(new Error('SECRET Bearer token'), { code: 'EIO' });
    const directory = path.join(workDir, 'audit', 'diagnostics', 'cloud-hypervisor', 'host-executor');
    (server.close as jest.Mock).mockImplementation(async () => {
      const before = fs.readdirSync(directory).find(name =>
        JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).invocationId)!;
      expect(JSON.parse(fs.readFileSync(path.join(directory, before), 'utf8'))).toMatchObject({
        failure: { stage: 'vm-launch/vm-create', code: 'EPERM' },
      });
      await expect(diagnostic.check(cleanup, 'manager-stop', () => { throw cleanupError; })).rejects.toBe(cleanupError);
      control.record('shutdown-failed', cleanupError);
      throw new Error('shutdown uncertain');
    });
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow('shutdown uncertain');
    const files = fs.readdirSync(directory);
    expect(files).toHaveLength(3);
    const usageFile = files.find(name =>
      JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).component === 'enclave-proxy-usage')!;
    expect(JSON.parse(fs.readFileSync(path.join(directory, usageFile), 'utf8')).usage).toEqual({
      scope: 'run-cumulative', requests: { status: 'not-drained' }, tokens: { status: 'not-drained' },
    });
    const controlFile = files.find(name =>
      JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).component === 'host-executor-control')!;
    const controlContents = fs.readFileSync(path.join(directory, controlFile), 'utf8');
    expect(JSON.parse(controlContents)).toMatchObject({
      failure: { phase: 'request-rejected', reason: 'denied', rejectionStage: 'schema' },
      cleanupFailure: { phase: 'shutdown-failed', reason: 'EIO' },
    });
    expect(JSON.parse(controlContents).failure).not.toHaveProperty('invocationId');
    expect(controlContents).not.toContain('PRIVATE_REQUEST_BYTES');
    const invocationFile = files.find(name => name !== controlFile && name !== usageFile)!;
    const file = path.join(directory, invocationFile);
    const contents = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(contents)).toMatchObject({
      failure: { stage: 'vm-launch/vm-create', code: 'EPERM' },
      cleanupFailure: { stage: 'host-invocation-cleanup/manager-stop', code: 'EIO' },
    });
    expect(contents).not.toMatch(/SECRET|Bearer|token|request\/script\/repository/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    for (const name of files) {
      expect(fs.existsSync(path.join(run.journalDir!, 'diagnostics', name))).toBe(true);
      expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
    }
    expect(storage.close).not.toHaveBeenCalled();
  });

  it('captures final proxy usage after host drain and retains protected evidence after private-root removal', async () => {
    const dependencies = cloudHypervisorManager.resolveCloudHypervisorManagerDependencies();
    jest.spyOn(cloudHypervisorManager, 'resolveCloudHypervisorManagerDependencies').mockReturnValue({
      ...dependencies, resolveIdentity: () => ({ uid: process.getuid!(), gid: process.getgid!() }),
    });
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(paths.apiProxyLogsDir, { mode: 0o700 });
    (server.close as jest.Mock).mockImplementation(async () => {
      fs.writeFileSync(path.join(paths.apiProxyLogsDir, 'token-tracker-audit.jsonl'), [
        { event: 'TRACK_START', status: 401, path: '/PRIVATE_PATH' },
        { event: 'TRACK_END', result: 'skip_status', error: 'PRIVATE_ERROR' },
      ].map(value => JSON.stringify(value) + '\n').join(''), { mode: 0o600 });
    });
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    await stopCloudHypervisorEnclaveLifecycle(config);
    fs.rmSync(paths.root, { recursive: true, force: true });
    const evidence = readHostExecutorInvocationDiagnostics({ runId, journalDir: paths.hostExecutorJournalDir });
    const summary = evidence.find(file => JSON.parse(file.contents).component === 'enclave-proxy-usage')!;
    expect(JSON.parse(summary.contents).usage).toEqual({
      scope: 'run-cumulative',
      requests: {
        status: 'captured', records: 2, trackedResponses: 1, websocketSessions: 0,
        statuses: { '401': 1 }, results: { skip_status: 1 },
      },
      tokens: { status: 'missing' },
    });
    expect(summary.contents).not.toMatch(/PRIVATE|error|path|model|payload|credential/);
    const copied = path.join(workDir, 'audit/diagnostics/cloud-hypervisor/host-executor', summary.name);
    expect(fs.readFileSync(copied, 'utf8')).toBe(summary.contents);
    expect(fs.statSync(copied).mode & 0o777).toBe(0o600);
    expect(storage.close).toHaveBeenCalledTimes(1);
  });

  it('exports the real host server shutdown-failure snapshot without releasing uncertain storage', async () => {
    const runtime = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.he-')));
    const dependencies = cloudHypervisorManager.resolveCloudHypervisorManagerDependencies();
    jest.spyOn(cloudHypervisorManager, 'resolveCloudHypervisorManagerDependencies').mockReturnValue({
      ...dependencies, resolveIdentity: () => ({ uid: process.getuid!(), gid: process.getgid!() }),
    });
    start.mockImplementationOnce(options => startHostExecutorServer({
      runtimeDir: runtime,
      runState: options.runState,
      backend: {
        execute: async () => ({ outcome: 'executor-failure' }),
        close: async () => { throw Object.assign(new Error('PRIVATE_SHUTDOWN_PATH'), { code: 'EACCES' }); },
      },
    }));
    try {
      await startCloudHypervisorEnclaveLifecycle(config, provider, {});
      await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow('PRIVATE_SHUTDOWN_PATH');
      const directory = path.join(workDir, 'audit/diagnostics/cloud-hypervisor/host-executor');
      const name = fs.readdirSync(directory).find(file =>
        JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')).component === 'host-executor-control')!;
      const contents = fs.readFileSync(path.join(directory, name), 'utf8');
      expect(JSON.parse(contents)).toMatchObject({
        component: 'host-executor-control',
        cleanupFailure: { phase: 'shutdown-failed', reason: 'EACCES' },
      });
      expect(contents).not.toContain('PRIVATE_SHUTDOWN_PATH');
      expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
      expect(fs.existsSync(path.join(resolveEnclavePaths(workDir).hostExecutorJournalDir, `${runId}.journal`))).toBe(true);
      expect(storage.close).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });

  it('preserves recovery records even when backend close resolves with pending resources', async () => {
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(paths.hostExecutorJournalDir, { mode: 0o700 });
    fs.writeFileSync(path.join(paths.hostExecutorJournalDir, `${runId}-${'b'.repeat(32)}.resources.json`),
      JSON.stringify({ runId, state: 'pending' }), { mode: 0o600 });
    await expect(stopCloudHypervisorEnclaveLifecycle(config)).rejects.toThrow(/cleanup is uncertain/);
    expect(storage.close).not.toHaveBeenCalled();
  });

  it('preserves cleanup-pending invocation tombstones even if the listener closes normally', async () => {
    await startCloudHypervisorEnclaveLifecycle(config, provider, {});
    const paths = resolveEnclavePaths(workDir);
    fs.mkdirSync(paths.hostExecutorJournalDir, { mode: 0o700 });
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
    fs.mkdirSync(paths.hostExecutorJournalDir, { mode: 0o700 });
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
    expect(storage.close).toHaveBeenCalledTimes(1);
    const other = { ...config, workDir: path.join(workDir, 'restarted') };
    const paths = resolveEnclavePaths(other.workDir);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.runIdPath, 'c'.repeat(32));
    fs.mkdirSync(paths.hostExecutorJournalDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(paths.hostExecutorJournalDir, `${'c'.repeat(32)}.journal`),
      '{"state":"open"}\n', { mode: 0o600 });
    await expect(stopCloudHypervisorEnclaveLifecycle(other)).rejects.toThrow(/trusted reconciliation/);
  });
});
