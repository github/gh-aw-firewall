import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import { PRIVATE_REPOSITORY_SEED_MAP_VERSION } from '../bounded-execution';
import { deriveEnclaveSeedId, resolveEnclavePaths } from '../enclave/paths';
import {
  startCloudHypervisorEnclaveLifecycle,
  stopCloudHypervisorEnclaveLifecycle,
  closeCloudHypervisorEnclaveAdmissions,
  type TrustedCloudHypervisorEnclaveStorageProvider,
} from '../enclave/cloud-hypervisor-lifecycle';
import { startCloudHypervisorEnclaveHostService } from '../enclave/cloud-hypervisor-host-service';
import { validateEnclavesConfig } from '../enclave/preflight';
import { assertCloudHypervisorPreSecurityCompatibility } from './runtime-validation';
import { runCloudHypervisorBootLoop, type CloudHypervisorBootLoopOptions } from './runtime-boot-loop';
import type { CloudHypervisorRuntimeBackendDependencies } from './runtime-backend';
import type { GuestExecutionRequest } from '../microvm/vsock-client';
import {
  cloudHypervisorHostTools,
  createCloudHypervisorTestConfig,
  createCloudHypervisorInfrastructureSnapshot,
} from './test-fixtures.test-utils';
import * as cloudHypervisorManager from './manager';
import { readHostExecutorInvocationDiagnostics } from '../enclave/host-executor-journal';
import { PRIMARY_READINESS_FILENAME } from './primary-readiness';
import { CloudHypervisorRetryableReadinessError } from './preflight';

jest.mock('../enclave/cloud-hypervisor-host-service');
jest.mock('../enclave/paths', () => {
  const actual = jest.requireActual('../enclave/paths');
  return {
    ...actual,
    resolveEnclavePaths: (workDir: string) => {
      const paths = actual.resolveEnclavePaths(workDir, path.dirname(workDir));
      return { ...paths, hostExecutorJournalDir: path.join(paths.root, 'journal') };
    },
  };
});

// Exercises internal composition, not production authorization or live KVM/mcpg.
describe('unified Cloud Hypervisor primary boot and enclave lifecycle', () => {
  let directory: string;
  let options: CloudHypervisorBootLoopOptions;
  let dependencies: CloudHypervisorRuntimeBackendDependencies;
  let order: string[];
  let stopped: boolean;
  let provider: TrustedCloudHypervisorEnclaveStorageProvider;
  let manager: ReturnType<typeof createManager>;
  const runId = 'd'.repeat(32);

  function createManager() {
    return {
      paths: { runDirectory: '/unused/vm' },
      guestIp: '100.64.0.2', guestGatewayIp: '100.64.0.1',
      guestPrefixLength: 30, guestInterfaceName: 'eth0',
      start: jest.fn(async () => { order.push('primary-config'); }),
      startInstance: jest.fn(async () => { order.push('primary-boot'); }),
      execute: jest.fn(async (_request: GuestExecutionRequest) => ({
        requestId: 'probe', exitCode: 0, signal: null, timedOut: false,
      })),
      cancel: jest.fn(), writeStdin: jest.fn(), endStdin: jest.fn(),
      stop: jest.fn(), collectDiagnostics: jest.fn(),
      collectGuestOutputAudit: jest.fn(), completeCleanupRecord: jest.fn(),
    };
  }

  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.ch-unified-')));
    const managerDependencies = cloudHypervisorManager.resolveCloudHypervisorManagerDependencies();
    jest.spyOn(cloudHypervisorManager, 'resolveCloudHypervisorManagerDependencies').mockReturnValue({
      ...managerDependencies, resolveIdentity: () => ({ uid: process.getuid!(), gid: process.getgid!() }),
    });
    order = [];
    stopped = false;
    const config = createCloudHypervisorTestConfig({
      workDir: directory, auditDir: path.join(directory, 'audit'),
      topologyAttach: ['compiler-mcpg'],
      enclaves: normalizeEnclavesConfig([{
        script: {}, runtime: 'cloud-hypervisor', timeout: 30,
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      }]),
    });
    const paths = resolveEnclavePaths(directory);
    const seedId = deriveEnclaveSeedId(runId, 'octo/private');
    fs.mkdirSync(path.join(paths.seedsDir, seedId), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.runIdPath, runId, { mode: 0o600 });
    fs.writeFileSync(paths.seedMapPath, JSON.stringify({
      version: PRIVATE_REPOSITORY_SEED_MAP_VERSION, runId,
      seeds: [{ repo: 'octo/private', sensitivity: 'internal', seedId }],
    }), { mode: 0o600 });
    jest.mocked(startCloudHypervisorEnclaveHostService).mockReset().mockImplementation(async () => {
      order.push('host-listener');
      return {
        socketPath: paths.hostExecutorDir + '/executor.sock',
        capabilityPath: paths.hostExecutorDir + '/capability',
        closeAdmissions: () => { order.push('close-admissions'); },
        close: async () => { order.push('drain-invocations'); },
      };
    });
    provider = {
      assertAvailable: async () => undefined,
      prepareRun: async () => ({
        close: async () => { order.push('release-storage'); },
      }),
    };
    manager = createManager();
    const infrastructure = {
      ...createCloudHypervisorInfrastructureSnapshot(),
      topologyPeerIps: { 'compiler-mcpg': '172.30.0.40' },
    };
    const preflight = {
      version: '53.0', cgroupVersion: 2 as const, kvmGid: 978,
      cloudHypervisorBinary: '/verified/ch', virtiofsdBinary: '/verified/virtiofsd',
      kernelPath: '/verified/kernel', rootfsPath: '/verified/rootfs',
      supervisorPath: '/verified/supervisor', artifactSnapshotDirectory: '/verified',
      artifactDigests: {
        cloudHypervisor: 'a'.repeat(64), virtiofsd: 'a'.repeat(64),
        kernel: 'a'.repeat(64), rootfs: 'a'.repeat(64), supervisor: 'a'.repeat(64),
      },
      tools: cloudHypervisorHostTools,
    };
    dependencies = {
      startInfrastructure: jest.fn(async (_work, _domains, _logs, _pull, network, ready) => {
        order.push('infrastructure');
        await network?.();
        await ready?.();
      }),
      preflight: jest.fn(async () => preflight),
      resolveInfrastructure: jest.fn(async () => infrastructure),
      createManager: jest.fn(() => manager),
      resolveExports: jest.fn(async () => [{
        tag: 'workspace', source: directory, target: '/workspace', mode: 'rw' as const,
      }]),
      identity: () => ({ uid: 1000, gid: 1000 }),
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
      sleep: jest.fn(), removeArtifactSnapshot: jest.fn(),
    };
    options = {
      config, workDir: directory, allowedDomains: ['github.com'], dependencies,
      ensurePreflight: async () => undefined,
      getPreflightResult: () => preflight,
      cleanupArtifactSnapshot: jest.fn(),
      agentExecutionStarted: () => false,
      publishManager: jest.fn(),
      isStopped: () => stopped,
      markStopped: () => { stopped = true; },
      markDiagnosticsCollected: jest.fn(),
      failedBootDiagnostics: [], cleanedManagers: new Set(),
      onNetworkReady: async () => { order.push('public-gateway-attachment'); },
      onInfrastructureReady: async () => { order.push('mcpg-tool-readiness'); },
    };
  });

  afterEach(async () => {
    await stopCloudHypervisorEnclaveLifecycle(options.config);
    const paths = resolveEnclavePaths(directory);
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('requires an authenticated host lifecycle before supporting infrastructure starts', async () => {
    await expect(runCloudHypervisorBootLoop(options)).rejects.toThrow(/full preflight/);
    expect(dependencies.startInfrastructure).not.toHaveBeenCalled();
    expect(dependencies.createManager).not.toHaveBeenCalled();
  });

  it('waits for real gateway contract callback before configuring a separate primary VM', async () => {
    await startCloudHypervisorEnclaveLifecycle(options.config, provider, {});
    const boot = await runCloudHypervisorBootLoop(options);
    expect(order).toEqual([
      'host-listener', 'infrastructure', 'public-gateway-attachment',
      'mcpg-tool-readiness', 'primary-config', 'primary-boot',
    ]);
    expect(boot.environment.NO_PROXY?.split(',')).toEqual(
      expect.arrayContaining(['compiler-mcpg', '172.30.0.40']),
    );
    const probe = manager.execute.mock.calls[1]?.[0];
    expect(probe?.argv[2]).toContain('172.30.0.40 8080');
    expect(dependencies.createManager).toHaveBeenCalledTimes(1);
    expect(startCloudHypervisorEnclaveHostService).toHaveBeenCalledTimes(1);
    closeCloudHypervisorEnclaveAdmissions(options.config);
    await Promise.all([
      stopCloudHypervisorEnclaveLifecycle(options.config),
      stopCloudHypervisorEnclaveLifecycle(options.config),
    ]);
    expect(order.slice(-3)).toEqual(['close-admissions', 'drain-invocations', 'release-storage']);
    const paths = resolveEnclavePaths(directory);
    const [summary] = readHostExecutorInvocationDiagnostics({
      runId, journalDir: paths.hostExecutorJournalDir,
    });
    expect(JSON.parse(summary.contents)).toMatchObject({
      component: 'enclave-proxy-usage',
      usage: {
        scope: 'run-cumulative',
        requests: { status: 'not-applicable' }, tokens: { status: 'not-applicable' },
      },
    });
    expect(fs.readFileSync(path.join(directory,
      'audit/diagnostics/cloud-hypervisor/host-executor', summary.name), 'utf8')).toBe(summary.contents);
  });

  function primaryProgress() {
    const file = path.join(directory, 'proxy-logs', PRIMARY_READINESS_FILENAME);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  it('publishes primary readiness only after boot, guest network, and connectivity checks', async () => {
    await startCloudHypervisorEnclaveLifecycle(options.config, provider, {});
    let finishProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      manager.execute.mockImplementationOnce(async () => {
        expect(primaryProgress()).toMatchObject({ stage: 'guest-network-readiness', state: 'starting' });
        return { requestId: 'probe', exitCode: 0, signal: null, timedOut: false };
      }).mockImplementationOnce(async () => {
        expect(primaryProgress()).toMatchObject({ stage: 'guest-connectivity', state: 'starting' });
        resolve();
        await new Promise<void>((finish) => { finishProbe = finish; });
        return { requestId: 'probe', exitCode: 0, signal: null, timedOut: false };
      });
    });
    options.onInfrastructureReady = async () => {
      expect(primaryProgress()).toMatchObject({
        stage: 'compose-infrastructure', state: 'starting', runId: null, bootAttempt: 0,
      });
    };
    const boot = runCloudHypervisorBootLoop(options);
    await probeStarted;
    expect(primaryProgress().state).toBe('starting');
    finishProbe();
    await boot;
    expect(primaryProgress()).toEqual({
      schemaVersion: 1, ownerPid: process.pid, stage: 'ready', state: 'ready',
      bootAttempt: 1, runId: 'vm',
    });
  });

  it('publishes terminal boot failure before cleanup without including exception or guest output', async () => {
    await startCloudHypervisorEnclaveLifecycle(options.config, provider, {});
    const secret = 'PRIVATE_BOOT_ERROR_SENTINEL';
    manager.startInstance.mockRejectedValue(new Error(secret));
    manager.stop.mockImplementation(async () => {
      expect(primaryProgress()).toMatchObject({ stage: 'guest-boot', state: 'failed' });
    });
    await expect(runCloudHypervisorBootLoop(options)).rejects.toThrow(secret);
    expect(primaryProgress()).toMatchObject({ stage: 'guest-boot', state: 'failed' });
    expect(JSON.stringify(primaryProgress())).not.toContain(secret);
  });

  it('keeps retryable boot failure non-ready and reports readiness only for the successful attempt', async () => {
    await startCloudHypervisorEnclaveLifecycle(options.config, provider, {});
    manager.startInstance.mockRejectedValueOnce(new CloudHypervisorRetryableReadinessError(
      'guest-network-readiness', 1, 'retryable boot failure',
    ));
    dependencies.sleep = jest.fn(async () => {
      expect(primaryProgress()).toMatchObject({ state: 'starting', bootAttempt: 1 });
    });
    await runCloudHypervisorBootLoop(options);
    expect(dependencies.sleep).toHaveBeenCalledTimes(1);
    expect(primaryProgress()).toMatchObject({ state: 'ready', bootAttempt: 2 });
  });

  it('does not publish ready when shutdown races the last guest check', async () => {
    await startCloudHypervisorEnclaveLifecycle(options.config, provider, {});
    manager.execute.mockImplementation(async () => {
      if (manager.execute.mock.calls.length === 2) stopped = true;
      return { requestId: 'probe', exitCode: 0, signal: null, timedOut: false };
    });
    await runCloudHypervisorBootLoop(options);
    expect(primaryProgress()).toMatchObject({ stage: 'guest-connectivity', state: 'failed' });
  });

  it.each(['missing', 'skipped', 'failed'] as const)(
    'never boots a primary VM with %s gateway readiness', async (failure) => {
      await startCloudHypervisorEnclaveLifecycle(options.config, provider, {});
      if (failure === 'missing') options.onInfrastructureReady = undefined;
      if (failure === 'skipped') {
        dependencies.startInfrastructure = jest.fn(async () => undefined);
      }
      if (failure === 'failed') {
        options.onInfrastructureReady = async () => { throw new Error('mcpg backend unavailable'); };
      }
      await expect(runCloudHypervisorBootLoop(options)).rejects.toThrow(
        failure === 'failed' ? /mcpg backend unavailable/ : /gateway readiness/,
      );
      expect(dependencies.createManager).not.toHaveBeenCalled();
    },
  );

  it.each(['shutdown', 'admission-closure'] as const)(
    'rejects %s racing gateway readiness before primary creation', async (failure) => {
      await startCloudHypervisorEnclaveLifecycle(options.config, provider, {});
      options.onInfrastructureReady = async () => {
        if (failure === 'shutdown') stopped = true;
        else closeCloudHypervisorEnclaveAdmissions(options.config);
      };
      await expect(runCloudHypervisorBootLoop(options)).rejects.toThrow(
        failure === 'shutdown' ? /aborted by shutdown/ : /full preflight/,
      );
      expect(dependencies.createManager).not.toHaveBeenCalled();
    },
  );

  it('rejects actual exports containing broker credentials before any primary VM exists', async () => {
    await startCloudHypervisorEnclaveLifecycle(options.config, provider, {});
    dependencies.resolveExports = jest.fn(async () => [{
      tag: 'workspace', source: path.dirname(directory), target: '/workspace', mode: 'rw' as const,
    }]);
    await expect(runCloudHypervisorBootLoop(options)).rejects.toThrow(/private or recovery state/);
    expect(dependencies.createManager).not.toHaveBeenCalled();
  });

  it('rechecks admissions after asynchronous export resolution before primary creation', async () => {
    await startCloudHypervisorEnclaveLifecycle(options.config, provider, {});
    dependencies.resolveExports = jest.fn(async () => {
      closeCloudHypervisorEnclaveAdmissions(options.config);
      return [{ tag: 'workspace', source: directory, target: '/workspace', mode: 'rw' as const }];
    });
    await expect(runCloudHypervisorBootLoop(options)).rejects.toThrow(/full preflight/);
    expect(dependencies.createManager).not.toHaveBeenCalled();
  });

  it('retains both user-facing production gates despite internal lifecycle composition', () => {
    expect(validateEnclavesConfig(options.config)).toContain(
      'The primary-agent cloud-hypervisor runtime cannot be combined with enclaves',
    );
    expect(() => assertCloudHypervisorPreSecurityCompatibility(options.config))
      .toThrow(/primary-agent execution with enclaves is reserved/);
  });
});
