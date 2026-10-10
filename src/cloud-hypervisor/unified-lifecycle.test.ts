import * as fs from 'fs';
import * as os from 'os';
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

jest.mock('../enclave/cloud-hypervisor-host-service');

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
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-unified-')));
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
      tag: 'workspace', source: '/var/tmp', target: '/workspace', mode: 'rw' as const,
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
