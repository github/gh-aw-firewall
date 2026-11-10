import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import type { WrapperConfig } from '../types';
import { runMainWorkflow } from '../cli-workflow';
import {
  cloudHypervisorRuntimeTestHelpers,
  type CloudHypervisorRuntimeBackendDependencies,
} from '../cloud-hypervisor-runtime-backend';
import {
  cloudHypervisorHostTools,
  createCloudHypervisorInfrastructureSnapshot,
  createCloudHypervisorTestConfig,
} from '../cloud-hypervisor/test-fixtures.test-utils';
import {
  cleanupRoutingState,
  RoutingFailureExitError,
  stageRoutingConversation,
  verifyRoutingCompletion,
  waitForRoutingSelection,
} from './bootstrap';

jest.mock('../harness-observation', () => ({ observeHarness: jest.fn().mockResolvedValue(undefined) }));

/*
 * Deterministic Cloud Hypervisor primary-agent model-routing fixtures
 * (github/gh-aw-firewall#10335). The real host staging, selection wait and
 * completion verification run against the real Cloud Hypervisor backend
 * facade and boot loop; only the Compose infrastructure, the VMM manager and
 * the API proxy's selection/completion writes are simulated. These tests do
 * not boot a microVM and are not real-backend acceptance evidence.
 */

const digest = 'a'.repeat(64);
const originalPlatform = process.platform;

const preflightResult = {
  version: '53.0',
  cloudHypervisorBinary: '/snapshot/cloud-hypervisor',
  virtiofsdBinary: '/snapshot/virtiofsd',
  kernelPath: '/snapshot/vmlinux.bin',
  rootfsPath: '/snapshot/rootfs.ext4',
  supervisorPath: '/snapshot/awf-supervisor',
  artifactSnapshotDirectory: '/snapshot',
  artifactDigests: {
    cloudHypervisor: digest,
    virtiofsd: digest,
    kernel: digest,
    rootfs: digest,
    supervisor: digest,
  },
  cgroupVersion: 2 as const,
  kvmGid: 978,
  tools: cloudHypervisorHostTools,
};

const selectionRecord = {
  schema: 'awf-routing-selection/v1',
  engine: 'copilot',
  provider: 'copilot',
  choice: { id: 'economy', model: 'copilot/gpt-5-mini', effort: 'low' },
  wire_model: 'gpt-5-mini',
};

type ProxyBehavior = 'select' | 'fail' | 'silent';
type ShutdownBehavior = 'complete' | 'runtime-failure' | 'missing-completion';

function writeRecord(config: WrapperConfig, name: string, value: unknown): void {
  fs.writeFileSync(path.join(config.modelRoutingBootstrap!.outputDir, name), JSON.stringify(value));
}

function fixture(tempDir: string, options: {
  proxy?: ProxyBehavior;
  shutdown?: ShutdownBehavior;
  exportSource?: (config: WrapperConfig) => string;
} = {}) {
  const proxy = options.proxy ?? 'select';
  const shutdown = options.shutdown ?? 'complete';
  const order: string[] = [];
  const conversationFile = path.join(tempDir, 'conversation.json');
  fs.writeFileSync(conversationFile, JSON.stringify([
    { role: 'user', parts: [{ text: 'please fix the tests' }] },
  ]));
  const workspace = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspace);
  const config = createCloudHypervisorTestConfig({
    workDir: path.join(tempDir, 'work'),
    experimentalModelRouting: true,
    images: { router: `ghcr.io/example/router:test@sha256:${digest}` },
    modelRouting: {
      objective: { goal: 'cost', mode: 'balanced' },
      task: { conversationFile },
    },
  });

  const manager = {
    paths: { runDirectory: path.join(tempDir, 'run') },
    guestIp: '100.64.0.2',
    guestGatewayIp: '100.64.0.1',
    guestPrefixLength: 30,
    guestInterfaceName: 'eth0',
    networkNamespace: 'awfvm-test',
    start: jest.fn(async () => { order.push('vm-config'); }),
    startInstance: jest.fn(async () => { order.push('vm-boot'); }),
    execute: jest.fn()
      .mockImplementationOnce(async () => ({ requestId: 'network-ready', exitCode: 0, signal: null, timedOut: false }))
      .mockImplementationOnce(async () => ({ requestId: 'probe', exitCode: 0, signal: null, timedOut: false }))
      .mockImplementationOnce(async () => {
        order.push('workload');
        return { requestId: 'agent', exitCode: 0, signal: null, timedOut: false };
      }),
    cancel: jest.fn().mockResolvedValue(undefined),
    writeStdin: jest.fn().mockResolvedValue(undefined),
    endStdin: jest.fn().mockResolvedValue(undefined),
    collectDiagnostics: jest.fn().mockResolvedValue(undefined),
    collectGuestOutputAudit: jest.fn().mockResolvedValue(undefined),
    completeCleanupRecord: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(async (stopOptions?: { beforeCleanup?: () => Promise<void> }) => {
      order.push('vm-stop');
      await stopOptions?.beforeCleanup?.();
    }),
  };

  const startInfrastructure: CloudHypervisorRuntimeBackendDependencies['startInfrastructure'] = jest.fn(
    async (_workDir, _domains, _logs, _skipPull, _onNetworkReady, onInfrastructureReady) => {
      order.push('infrastructure');
      // The API proxy produces selection.json (or failure.json) after
      // infrastructure startup; the host gate then reads it.
      if (proxy === 'select') writeRecord(config, 'selection.json', selectionRecord);
      if (proxy === 'fail') {
        writeRecord(config, 'failure.json', {
          schema: 'awf-routing-failure/v1', code: 'no_route', detail: 'No eligible route', retryable: false,
        });
      }
      await onInfrastructureReady?.();
      order.push('selection-ready');
    },
  );

  const stdin = new PassThrough();
  stdin.end();
  const deps: CloudHypervisorRuntimeBackendDependencies = {
    startInfrastructure,
    preflight: jest.fn().mockResolvedValue(preflightResult),
    resolveInfrastructure: jest.fn(async () => createCloudHypervisorInfrastructureSnapshot()),
    createManager: jest.fn(() => {
      order.push('create-vm');
      return manager;
    }),
    resolveExports: jest.fn(async () => [
      {
        tag: 'workspace',
        source: options.exportSource ? options.exportSource(config) : workspace,
        target: '/workspace',
        mode: 'rw' as const,
      },
    ]),
    identity: () => ({ uid: 1000, gid: 1000 }),
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
    sleep: jest.fn().mockResolvedValue(undefined),
    removeArtifactSnapshot: jest.fn().mockResolvedValue(undefined),
  };
  const backend = cloudHypervisorRuntimeTestHelpers.createBackendWithDependencies(config, deps);

  const run = (selectionTimeoutMs = 1_000) => runMainWorkflow(
    config,
    {
      ensureFirewallNetwork: jest.fn(),
      setupHostIptables: jest.fn(),
      writeConfigs: jest.fn(async () => { order.push('write-configs'); }),
      startContainers: backend.start,
      runAgentCommand: backend.exec,
      prepareRouting: async (routingConfig) => {
        const state = stageRoutingConversation(routingConfig);
        order.push('stage');
        return state;
      },
      waitForRoutingSelection: (state) => waitForRoutingSelection(state, selectionTimeoutMs),
      verifyRoutingCompletion: async (state) => {
        order.push('verify');
        verifyRoutingCompletion(state);
      },
      cleanupRouting: async (routingConfig) => cleanupRoutingState(routingConfig),
    },
    {
      logger: { info: jest.fn(), success: jest.fn(), warn: jest.fn() },
      performCleanup: async () => {
        await backend.stop();
        // Compose teardown stops the API proxy after the VM, which drains
        // routing observations and publishes its shutdown record.
        order.push('proxy-shutdown');
        if (shutdown === 'complete') writeRecord(config, 'complete.json', { schema: 'awf-routing-complete/v1' });
        if (shutdown === 'runtime-failure') {
          writeRecord(config, 'runtime-failure.json', {
            schema: 'awf-routing-failure/v1',
            code: 'selected_model_failed',
            detail: 'The selected model request failed',
            retryable: false,
          });
        }
      },
    },
  );

  return { config, deps, manager, order, run };
}

describe('Cloud Hypervisor primary-agent model routing (fixture)', () => {
  let tempDir: string;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ch-routing-test-')));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('obtains a valid selection before the microVM is created and verifies completion after shutdown', async () => {
    const { config, manager, order, run } = fixture(tempDir);

    await expect(run()).resolves.toBe(0);

    expect(order).toEqual([
      'stage',
      'write-configs',
      'infrastructure',
      'selection-ready',
      'create-vm',
      'vm-config',
      'vm-boot',
      'workload',
      'vm-stop',
      'proxy-shutdown',
      'verify',
    ]);
    // The proxy (not the guest) holds the private routing state; the guest
    // environment never receives routing configuration or private paths.
    const routingRoot = config.modelRoutingBootstrap!.root;
    for (const [request] of manager.execute.mock.calls) {
      for (const [name, value] of Object.entries(request.env as Record<string, string>)) {
        expect(name).not.toBe('AWF_ROUTING_CONFIG');
        expect(value).not.toContain(routingRoot);
        expect(value).not.toContain('.awf-routing-');
      }
    }
    expect(fs.existsSync(routingRoot)).toBe(false);
  });

  it('fails a proxy routing failure with exit 78 before any microVM or workload starts', async () => {
    const { config, deps, manager, order, run } = fixture(tempDir, { proxy: 'fail' });

    const failure = await run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RoutingFailureExitError);
    expect(failure).toMatchObject({
      exitCode: 78,
      message: 'Model routing failed (no_route): No eligible route',
    });
    expect(deps.createManager).not.toHaveBeenCalled();
    expect(manager.execute).not.toHaveBeenCalled();
    expect(order).not.toContain('workload');
    cleanupRoutingState(config);
  });

  it('fails a selection timeout with exit 78 before any microVM or workload starts', async () => {
    const { config, deps, manager, run } = fixture(tempDir, { proxy: 'silent' });

    await expect(run(1)).rejects.toMatchObject({
      exitCode: 78,
      message: 'Model routing selection timed out',
    });
    expect(deps.createManager).not.toHaveBeenCalled();
    expect(manager.execute).not.toHaveBeenCalled();
    cleanupRoutingState(config);
  });

  it('surfaces a proxy runtime failure published at shutdown as exit 78 and removes private state', async () => {
    const { config, order, run } = fixture(tempDir, { shutdown: 'runtime-failure' });

    await expect(run()).rejects.toMatchObject({
      exitCode: 78,
      message: 'Model routing failed (selected_model_failed): The selected model request failed',
    });
    expect(order).toContain('workload');
    expect(order.indexOf('verify')).toBeGreaterThan(order.indexOf('proxy-shutdown'));
    expect(fs.existsSync(config.modelRoutingBootstrap!.root)).toBe(false);
  });

  it('rejects a run whose proxy shutdown did not publish a completion record', async () => {
    const { config, run } = fixture(tempDir, { shutdown: 'missing-completion' });

    await expect(run()).rejects.toMatchObject({
      exitCode: 78,
      message: 'Model routing completion result is invalid',
    });
    expect(fs.existsSync(config.modelRoutingBootstrap!.root)).toBe(false);
  });

  it('refuses to boot a guest whose resolved exports would expose private routing state', async () => {
    const { config, deps, manager, run } = fixture(tempDir, {
      exportSource: (routingConfig) => routingConfig.modelRoutingBootstrap!.outputDir,
    });

    await expect(run()).rejects.toThrow('Model routing private state overlaps guest export "workspace"');
    expect(deps.createManager).not.toHaveBeenCalled();
    expect(manager.execute).not.toHaveBeenCalled();
    cleanupRoutingState(config);
  });

  it('rejects NVX routing before staging with an actionable backend-parity error', async () => {
    const { config, deps, run } = fixture(tempDir);
    config.containerRuntime = 'nvx';

    await expect(run()).rejects.toThrow(
      'Model routing is not supported with the "nvx" container runtime; primary-agent model routing ' +
      'supports the default runc Docker runtime and cloud-hypervisor. ' +
      'See https://github.com/github/gh-aw-firewall/issues/10335',
    );
    expect(config.modelRoutingBootstrap).toBeUndefined();
    expect(deps.startInfrastructure).not.toHaveBeenCalled();
  });
});
