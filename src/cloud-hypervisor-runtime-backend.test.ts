import { PassThrough } from 'stream';
import type { WrapperConfig } from './types';
import * as hostEligibility from './cloud-hypervisor/host-eligibility';
import {
  CloudHypervisorRuntimeBackend,
  assertCloudHypervisorPreSecurityCompatibility,
  buildCloudHypervisorGuestEnvironment,
  cloudHypervisorRuntimeTestHelpers,
  createCloudHypervisorRuntimeBackend,
  type CloudHypervisorRuntimeBackendDependencies,
} from './cloud-hypervisor-runtime-backend';
import { assertCloudHypervisorSelection } from './cloud-hypervisor/runtime-validation';
import type { MicrovmInfrastructureSnapshot } from './microvm/infrastructure';

const digest = 'a'.repeat(64);

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: 'cloud-hypervisor',
    cloudHypervisor: {
      previewEnabled: true,
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      kernelPath: '/opt/kernel',
      rootfsPath: '/opt/rootfs',
      supervisorPath: '/opt/supervisor',
      vcpuCount: 2,
      memoryMib: 512,
      apiTimeoutMs: 5000,
      sha256: {
        cloudHypervisor: digest,
        kernel: digest,
        rootfs: digest,
        supervisor: digest,
      },
    },
    agentCommand: 'printf hello',
    allowedDomains: ['github.com'],
    workDir: '/tmp/awf',
    keepContainers: false,
    networkIsolation: true,
    legacySecurity: false,
    enableApiProxy: true,
    enableDind: false,
    enableHostAccess: false,
    tty: false,
    logLevel: 'info',
    buildLocal: false,
    skipPull: true,
    imageRegistry: 'registry',
    imageTag: 'tag',
    envAll: false,
    sslBump: false,
    enableDlp: false,
    ...overrides,
  } as WrapperConfig;
}

function infrastructure(): MicrovmInfrastructureSnapshot {
  return {
    networkId: 'a'.repeat(64),
    bridgeName: 'br-aaaaaaaaaaaa',
    subnet: '172.30.0.0/24',
    gateway: '172.30.0.1',
    squidIp: '172.30.0.10',
    apiProxyIp: '172.30.0.30',
    revalidate: jest.fn().mockResolvedValue(undefined),
  };
}

const preflightResult = {
  version: '53.0',
  cloudHypervisorBinary: '/opt/cloud-hypervisor',
  kernelPath: '/opt/kernel',
  rootfsPath: '/opt/rootfs',
  supervisorPath: '/opt/supervisor',
  cgroupVersion: 2 as const,
  kvmGid: 978,
  tools: {
    ip: '/usr/bin/ip',
    nft: '/usr/sbin/nft',
    sysctl: '/usr/sbin/sysctl',
    mke2fs: '/usr/sbin/mke2fs',
    debugfs: '/usr/sbin/debugfs',
    e2fsck: '/usr/sbin/e2fsck',
    rsync: '/usr/bin/rsync',
    setpriv: '/usr/bin/setpriv',
  },
};

function harness(overrides: Partial<CloudHypervisorRuntimeBackendDependencies> = {}) {
  const order: string[] = [];
  const stdin = new PassThrough();
  const manager = {
    paths: { runDirectory: '/tmp/awf/cloud-hypervisor-run/cloud-hypervisor/test' },
    guestIp: '100.64.0.2',
    networkNamespace: 'awffc-test',
    start: jest.fn(async () => { order.push('vm-config'); }),
    startInstance: jest.fn(async () => { order.push('vm-start'); }),
    execute: jest.fn()
      .mockImplementationOnce(async () => {
        order.push('probe');
        return { requestId: 'probe', exitCode: 0, signal: null, timedOut: false };
      })
      .mockImplementationOnce(async () => ({
        requestId: 'agent',
        exitCode: 23,
        signal: null,
        timedOut: false,
      })),
    cancel: jest.fn().mockResolvedValue(undefined),
    writeStdin: jest.fn().mockResolvedValue(undefined),
    endStdin: jest.fn().mockResolvedValue(undefined),
    collectDiagnostics: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(async () => { order.push('vm-stop'); }),
  };
  const infra = infrastructure();
  (infra.revalidate as jest.Mock).mockImplementation(async () => {
    order.push('revalidate');
  });
  const deps: CloudHypervisorRuntimeBackendDependencies = {
    startInfrastructure: jest.fn(async () => { order.push('compose'); }),
    preflight: jest.fn(async () => { order.push('preflight'); return preflightResult; }),
    resolveInfrastructure: jest.fn(async () => infra),
    createManager: jest.fn(() => manager),
    workspacePath: () => '/workspace-host',
    homePath: () => '/home/runner',
    identity: () => ({ uid: 1000, gid: 1000 }),
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
    ...overrides,
  };
  return { order, manager, infra, deps, stdin };
}

describe('Cloud Hypervisor runtime backend', () => {
  let eligibilitySpy: jest.SpyInstance;

  beforeEach(() => {
    eligibilitySpy = jest.spyOn(hostEligibility, 'assertGithubHostedRunnerEligibility')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    eligibilitySpy.mockRestore();
  });

  it('constructs default backend dependencies and manager policy', () => {
    const startInfrastructure = jest.fn();
    const defaults = cloudHypervisorRuntimeTestHelpers.defaultDependencies(startInfrastructure);
    const previousWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = '/github/workspace';
    try {
      expect(defaults.workspacePath()).toBe('/github/workspace');
      delete process.env.GITHUB_WORKSPACE;
      expect(defaults.workspacePath()).toBe(process.cwd());
      expect(defaults.homePath()).toBeTruthy();
      expect(defaults.identity()).toEqual({
        uid: expect.any(Number),
        gid: expect.any(Number),
      });
      expect(defaults.createManager(
        config().cloudHypervisor!,
        '/tmp/awf',
        infrastructure(),
        '/workspace',
        '/home/runner',
        { uid: 1000, gid: 1000 },
      )).toBeDefined();
      expect(createCloudHypervisorRuntimeBackend(config(), startInfrastructure))
        .toBeInstanceOf(CloudHypervisorRuntimeBackend);
    } finally {
      if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
      else process.env.GITHUB_WORKSPACE = previousWorkspace;
    }
  });

  it('starts infrastructure, revalidates it, boots and probes before execution', async () => {
    const { order, manager, deps, stdin } = harness();
    const backend = new CloudHypervisorRuntimeBackend(config(), deps);

    await backend.start('/tmp/awf', ['github.com']);
    const execution = backend.exec('/tmp/awf', ['github.com'], undefined, 1);
    stdin.end('input');
    await expect(execution).resolves.toEqual({ exitCode: 23 });
    await backend.stop();

    expect(order).toEqual([
      'preflight',
      'compose',
      'revalidate',
      'vm-config',
      'vm-start',
      'probe',
      'vm-stop',
    ]);
    expect(eligibilitySpy).toHaveBeenCalled();
    expect(manager.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      argv: ['/bin/sh', '-lc', 'printf hello'],
      cwd: '/workspace',
      uid: 1000,
      gid: 1000,
      timeoutMs: 60_000,
    }));
    expect(manager.writeStdin).toHaveBeenCalledWith(
      Buffer.from('input'),
      expect.stringMatching(/^agent-/),
    );
  });

  it('rejects an ineligible host before infrastructure startup', async () => {
    eligibilitySpy.mockImplementation(() => {
      throw new Error('Cloud Hypervisor is supported only inside GitHub Actions runs');
    });
    const { deps } = harness();
    const backend = new CloudHypervisorRuntimeBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/supported only inside GitHub Actions runs/);
    expect(deps.startInfrastructure).not.toHaveBeenCalled();
  });

  it('rejects timeouts beyond the guest supervisor limit before infrastructure startup', async () => {
    const { deps } = harness();
    const backend = new CloudHypervisorRuntimeBackend(config({ agentTimeout: 1441 }), deps);

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/up to 1440 minutes/);
    expect(deps.startInfrastructure).not.toHaveBeenCalled();
  });

  it('serializes stdin chunks before sending EOF', async () => {
    const { manager, deps, stdin } = harness();
    let releaseFirstWrite!: () => void;
    let resolveExecution!: (value: {
      requestId: string;
      exitCode: number;
      signal: null;
      timedOut: boolean;
    }) => void;
    manager.execute
      .mockReset()
      .mockResolvedValueOnce({
        requestId: 'probe',
        exitCode: 0,
        signal: null,
        timedOut: false,
      })
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveExecution = resolve;
      }));
    manager.writeStdin.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    }));
    const backend = new CloudHypervisorRuntimeBackend(config(), deps);
    await backend.start('/tmp/awf', ['github.com']);
    const execution = backend.exec('/tmp/awf', ['github.com']);
    stdin.write(Buffer.alloc(70_000, 1));
    stdin.end('second');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(manager.endStdin).not.toHaveBeenCalled();
    releaseFirstWrite();
    await new Promise<void>((resolve) => setImmediate(resolve));
    resolveExecution({
      requestId: 'agent',
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    await execution;
    expect(manager.writeStdin.mock.invocationCallOrder[0])
      .toBeLessThan(manager.writeStdin.mock.invocationCallOrder[1]);
    expect(manager.writeStdin.mock.invocationCallOrder[1])
      .toBeLessThan(manager.endStdin.mock.invocationCallOrder[0]);
  });

  it('stops the partial VM when readiness probing fails', async () => {
    const { manager, deps } = harness();
    manager.execute.mockReset().mockResolvedValue({
      requestId: 'probe',
      exitCode: 41,
      signal: null,
      timedOut: false,
    });
    const backend = new CloudHypervisorRuntimeBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/connectivity probe failed/);
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it('fails closed when manager readiness or startup cleanup is unavailable', async () => {
    const missingIp = harness();
    Reflect.set(missingIp.manager, 'guestIp', undefined);
    const backend = new CloudHypervisorRuntimeBackend(config(), missingIp.deps);
    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/did not expose the configured guest IP/);
    expect(missingIp.manager.stop).toHaveBeenCalledTimes(1);

    const dualFailure = harness();
    (dualFailure.infra.revalidate as jest.Mock).mockRejectedValue('topology moved');
    dualFailure.manager.stop.mockRejectedValue('cleanup failed');
    const failing = new CloudHypervisorRuntimeBackend(config(), dualFailure.deps);
    await expect(failing.start('/tmp/awf', ['github.com'])).rejects.toMatchObject({
      message: expect.stringContaining('topology moved'),
      cause: 'topology moved',
      cleanupCause: 'cleanup failed',
    });
  });

  it('rejects execution before readiness and unsupported TTY execution', async () => {
    const cold = harness();
    await expect(new CloudHypervisorRuntimeBackend(config(), cold.deps).exec(
      '/tmp/awf',
      ['github.com'],
    )).rejects.toThrow(/microVM is not ready/);

    const ttyHarness = harness();
    const ttyConfig = config();
    const ttyBackend = new CloudHypervisorRuntimeBackend(ttyConfig, ttyHarness.deps);
    await ttyBackend.start('/tmp/awf', ['github.com']);
    ttyConfig.tty = true;
    await expect(ttyBackend.exec('/tmp/awf', ['github.com']))
      .rejects.toThrow(/does not support TTY execution/);
    await ttyBackend.stop();
  });

  it('preserves a stopped VM once and logs retained artifacts', async () => {
    const { manager, deps } = harness();
    const backend = new CloudHypervisorRuntimeBackend(config(), deps);
    await backend.start('/tmp/awf', ['github.com']);

    await backend.preserve();
    await backend.preserve();
    await backend.collectDiagnostics();

    expect(manager.stop).toHaveBeenCalledWith({ preserve: true });
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(deps.logger.info).toHaveBeenCalledWith(
      '[cloud-hypervisor] Preserved network namespace: awffc-test',
    );
  });

  it('cancels an active guest command before stopping', async () => {
    const { manager, deps } = harness();
    let resolveExecution!: (value: {
      requestId: string;
      exitCode: number;
      signal: null;
      timedOut: boolean;
    }) => void;
    manager.execute
      .mockReset()
      .mockResolvedValueOnce({
        requestId: 'probe',
        exitCode: 0,
        signal: null,
        timedOut: false,
      })
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveExecution = resolve;
      }));
    manager.cancel.mockImplementationOnce(async () => {
      resolveExecution({
        requestId: 'agent',
        exitCode: 130,
        signal: null,
        timedOut: false,
      });
    });
    const backend = new CloudHypervisorRuntimeBackend(config(), deps);
    await backend.start('/tmp/awf', ['github.com']);
    const execution = backend.exec('/tmp/awf', ['github.com']);

    await backend.stop();
    await expect(execution).resolves.toEqual({ exitCode: 130 });
    await backend.stop();
    expect(manager.cancel).toHaveBeenCalledWith(
      'AWF cleanup',
      expect.stringMatching(/^agent-/),
    );
    expect(manager.stop).toHaveBeenCalledWith({ preserve: false });
  });

  it('cancels after stdin forwarding failure without changing command output', async () => {
    const { manager, deps, stdin } = harness();
    manager.writeStdin.mockRejectedValueOnce(new Error('closed stdin'));
    const backend = new CloudHypervisorRuntimeBackend(config(), deps);
    await backend.start('/tmp/awf', ['github.com']);
    const execution = backend.exec('/tmp/awf', ['github.com']);
    stdin.write('input');
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(execution).resolves.toEqual({ exitCode: 23 });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stdin forwarding failed'),
    );
    expect(manager.cancel).toHaveBeenCalledWith(
      'stdin forwarding failure',
      expect.stringMatching(/^agent-/),
    );
    await backend.stop();
  });

  it('preserves sanitized env values without leaking real provider secrets', () => {
    const secret = 'sk-real-provider-secret';
    const environment = buildCloudHypervisorGuestEnvironment(
      config({
        openaiApiKey: secret,
        additionalEnv: {
          SAFE_SETTING: 'enabled',
          OPENAI_API_KEY: secret,
        },
      }),
      infrastructure(),
    );

    expect(environment.SAFE_SETTING).toBe('enabled');
    expect(environment.OPENAI_API_KEY).not.toBe(secret);
    expect(Object.values(environment)).not.toContain(secret);
    expect(environment.HTTP_PROXY).toBe('http://172.30.0.10:3128');
    expect(environment.HOME).toBe('/workspace/.awf-home');

    expect(() => buildCloudHypervisorGuestEnvironment(
      config({
        openaiApiKey: 'enabled',
        additionalEnv: { SAFE_SETTING: 'enabled' },
      }),
      infrastructure(),
    )).toThrow(/Refusing to pass a real provider credential/);
  });

  it('rejects unsupported strict-security and topology combinations', () => {
    expect(() => assertCloudHypervisorPreSecurityCompatibility(
      config({ enableDind: true }),
    )).toThrow(/Docker-in-Docker/);
    expect(() => assertCloudHypervisorPreSecurityCompatibility(
      config({ enableHostAccess: true }),
    )).toThrow(/host access/);
    expect(() => assertCloudHypervisorPreSecurityCompatibility(
      config({ enclaves: { enabled: true } } as Partial<WrapperConfig>),
    )).toThrow(/MCP gateway path/);
    expect(() => assertCloudHypervisorSelection(
      config({ containerRuntime: 'gvisor' }),
    )).toThrow(/require --container-runtime cloud-hypervisor/);
  });
});
