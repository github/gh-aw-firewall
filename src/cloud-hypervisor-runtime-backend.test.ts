import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import type { WrapperConfig } from './types';
import * as hostEligibility from './cloud-hypervisor/host-eligibility';
import {
  assertCloudHypervisorPreSecurityCompatibility,
  cloudHypervisorRuntimeTestHelpers,
  createCloudHypervisorRuntimeBackend,
  type CloudHypervisorRuntimeBackendDependencies,
} from './cloud-hypervisor-runtime-backend';
import { buildCloudHypervisorGuestEnvironment } from './cloud-hypervisor/guest-environment-builder';
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
        virtiofsd: digest,
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

type TestCloudHypervisorRuntimeBackend = ReturnType<typeof createCloudHypervisorRuntimeBackend> & {
  preserve(): Promise<void>;
};

function createBackend(
  backendConfig: WrapperConfig,
  deps: CloudHypervisorRuntimeBackendDependencies,
): TestCloudHypervisorRuntimeBackend {
  return cloudHypervisorRuntimeTestHelpers.createBackendWithDependencies(
    backendConfig,
    deps,
  ) as TestCloudHypervisorRuntimeBackend;
}

function infrastructure(): MicrovmInfrastructureSnapshot {
  return {
    networkId: 'a'.repeat(64),
    bridgeName: 'br-aaaaaaaaaaaa',
    subnet: '172.30.0.0/24',
    gateway: '172.30.0.1',
    squidIp: '172.30.0.10',
    apiProxyIp: '172.30.0.30',
    topologyPeerIps: {},
    revalidate: jest.fn().mockResolvedValue(undefined),
  };
}

const preflightResult = {
  version: '53.0',
  cloudHypervisorBinary: '/opt/cloud-hypervisor',
  virtiofsdBinary: '/opt/virtiofsd',
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
    mount: '/usr/bin/mount',
    umount: '/usr/bin/umount',
    setpriv: '/usr/bin/setpriv',
  },
};

function harness(overrides: Partial<CloudHypervisorRuntimeBackendDependencies> = {}) {
  const order: string[] = [];
  const stdin = new PassThrough();
  const manager = {
    paths: { runDirectory: '/tmp/awf/cloud-hypervisor-run/cloud-hypervisor/test' },
    guestIp: '100.64.0.2',
    guestGatewayIp: '100.64.0.1',
    guestPrefixLength: 30,
    guestInterfaceName: 'eth0',
    networkNamespace: 'awfvm-test',
    start: jest.fn(async () => { order.push('vm-config'); }),
    startInstance: jest.fn(async () => { order.push('vm-start'); }),
    execute: jest.fn()
      .mockImplementationOnce(async () => {
        order.push('network-ready');
        return { requestId: 'network-ready', exitCode: 0, signal: null, timedOut: false };
      })
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
    stop: jest.fn(async (options?: { beforeCleanup?: () => Promise<void> }) => {
      order.push('vm-stop');
      await options?.beforeCleanup?.();
    }),
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
    resolveExports: jest.fn().mockResolvedValue([
      { tag: 'workspace', source: '/workspace-host', target: '/workspace', mode: 'rw' },
    ]),
    identity: () => ({ uid: 1000, gid: 1000 }),
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
    sleep: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { order, manager, infra, deps, stdin };
}

type ExecutionResult = {
  requestId: string;
  exitCode: number;
  signal: null;
  timedOut: boolean;
};

function mockNetworkReadyProbeSequence(
  manager: ReturnType<typeof harness>['manager'],
): (value: ExecutionResult) => void {
  let resolveExecution!: (value: ExecutionResult) => void;
  manager.execute
    .mockReset()
    .mockResolvedValueOnce({
      requestId: 'network-ready',
      exitCode: 0,
      signal: null,
      timedOut: false,
    })
    .mockResolvedValueOnce({
      requestId: 'probe',
      exitCode: 0,
      signal: null,
      timedOut: false,
    })
    .mockReturnValueOnce(new Promise((resolve) => {
      resolveExecution = resolve;
    }));
  return resolveExecution;
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

  it('constructs default backend dependencies and manager policy', async () => {
    const startInfrastructure = jest.fn();
    const defaults = cloudHypervisorRuntimeTestHelpers.defaultDependencies(startInfrastructure);
    const previousWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = process.cwd();
    try {
      await expect(defaults.resolveExports()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ tag: 'workspace', target: '/workspace', mode: 'rw' }),
      ]));
      expect(defaults.identity()).toEqual({
        uid: expect.any(Number),
        gid: expect.any(Number),
      });
      expect(defaults.createManager(
        config().cloudHypervisor!,
        '/tmp/awf',
        infrastructure(),
        [{ tag: 'workspace', source: '/workspace', target: '/workspace', mode: 'rw' }],
        { uid: 1000, gid: 1000 },
      )).toBeDefined();
      expect(createCloudHypervisorRuntimeBackend(config(), startInfrastructure))
        .toEqual(expect.objectContaining({ runtime: 'cloud-hypervisor' }));
    } finally {
      if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
      else process.env.GITHUB_WORKSPACE = previousWorkspace;
    }
  });

  it('plans filesystem.allowWrite before any boot attempt and passes it to the manager', async () => {
    const directory = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ch-backend-write-')),
    );
    try {
      const workspaceSource = path.join(directory, 'workspace');
      const ghAwSource = path.join(directory, 'gh-aw');
      await fsPromises.mkdir(path.join(ghAwSource, 'agent'), { recursive: true });
      await fsPromises.mkdir(workspaceSource, { recursive: true });
      const resolved = [
        { tag: 'workspace', source: workspaceSource, target: '/workspace', mode: 'rw' as const },
        { tag: 'tmp-gh-aw', source: ghAwSource, target: '/tmp/gh-aw', mode: 'rw' as const },
      ];
      const { deps } = harness({ resolveExports: jest.fn().mockResolvedValue(resolved) });
      const backend = createBackend(
        config({ filesystemAllowWrite: ['/tmp/gh-aw/agent'] }),
        deps,
      );

      await backend.start('/tmp/awf', ['github.com']);

      expect(deps.createManager).toHaveBeenCalledWith(
        expect.anything(),
        '/tmp/awf',
        expect.anything(),
        [
          { ...resolved[0], mode: 'ro' },
          { ...resolved[1], mode: 'rw' },
        ],
        { uid: 1000, gid: 1000 },
        {
          plans: [
            { tag: 'workspace', writableOverlays: [] },
            {
              tag: 'tmp-gh-aw',
              writableOverlays: [{
                source: path.join(ghAwSource, 'agent'),
                destination: path.join(ghAwSource, 'agent'),
                kind: 'directory',
              }],
            },
          ],
        },
      );
    } finally {
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });

  it('passes no enforcement argument when filesystem.allowWrite is undefined', async () => {
    const { deps } = harness();
    const backend = createBackend(config(), deps);

    await backend.start('/tmp/awf', ['github.com']);

    const call = (deps.createManager as jest.Mock).mock.calls[0];
    expect(call[3]).toEqual([
      { tag: 'workspace', source: '/workspace-host', target: '/workspace', mode: 'rw' },
    ]);
    expect(call[5]).toBeUndefined();
    expect(call).toHaveLength(6);
  });

  it('fails closed on an unmatched allowlist path before creating a manager', async () => {
    const { deps } = harness();
    const backend = createBackend(
      config({ filesystemAllowWrite: ['/workspace/does-not-exist'] }),
      deps,
    );

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow('filesystem.allowWrite path is not an existing path within a writable');
    expect(deps.createManager).not.toHaveBeenCalled();
  });

  it('starts infrastructure, revalidates it, boots and probes before execution', async () => {
    const { order, manager, deps, stdin } = harness();
    const backend = createBackend(config(), deps);

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
      'network-ready',
      'probe',
      'vm-stop',
    ]);
    expect(eligibilitySpy).toHaveBeenCalled();
    expect(manager.execute).toHaveBeenNthCalledWith(3, expect.objectContaining({
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

  it('discovers and probes trusted topology peers before agent execution', async () => {
    const { manager, deps } = harness();
    const peerInfrastructure = {
      ...infrastructure(),
      topologyPeerIps: { 'awmg-mcpg': '172.30.0.60' },
    };
    (deps.resolveInfrastructure as jest.Mock).mockResolvedValue(peerInfrastructure);
    const backend = createBackend(
      config({ topologyAttach: ['awmg-mcpg'] }),
      deps,
    );

    await backend.start('/tmp/awf', ['github.com']);
    await backend.stop();

    expect(deps.resolveInfrastructure).toHaveBeenCalledWith(
      true,
      '/usr/bin/ip',
      ['awmg-mcpg'],
    );
    expect(manager.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        argv: expect.arrayContaining([
          expect.stringContaining('nc -v -z -w 60 172.30.0.60 8080'),
        ]),
        env: expect.objectContaining({
          NO_PROXY: expect.stringContaining('awmg-mcpg'),
          no_proxy: expect.stringContaining('172.30.0.60'),
        }),
        timeoutMs: 468_000,
      }),
    );
  });

  it('rejects an ineligible host before infrastructure startup', async () => {
    eligibilitySpy.mockImplementation(() => {
      throw new Error('Cloud Hypervisor is supported only inside GitHub Actions runs');
    });
    const { deps } = harness();
    const backend = createBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/supported only inside GitHub Actions runs/);
    expect(deps.startInfrastructure).not.toHaveBeenCalled();
  });

  it('rejects timeouts beyond the guest supervisor limit before infrastructure startup', async () => {
    const { deps } = harness();
    const backend = createBackend(config({ agentTimeout: 1441 }), deps);

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/up to 1440 minutes/);
    expect(deps.startInfrastructure).not.toHaveBeenCalled();
  });

  it('serializes stdin chunks before sending EOF', async () => {
    const { manager, deps, stdin } = harness();
    let releaseFirstWrite!: () => void;
    const resolveExecution = mockNetworkReadyProbeSequence(manager);
    manager.writeStdin.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    }));
    const backend = createBackend(config(), deps);
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
    manager.execute.mockReset().mockImplementation(async (request) => ({
      requestId: request.requestId,
      exitCode: request.requestId.startsWith('probe-network-ready-') ? 0 : 41,
      signal: null,
      timedOut: false,
    }));
    const backend = createBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/connectivity probe failed/);
    expect(manager.stop).toHaveBeenCalledTimes(3);
    expect(deps.createManager).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(deps.sleep).toHaveBeenNthCalledWith(2, 10_000);
  });

  it('waits with bounded backoff for the complete guest data plane before probing connectivity', async () => {
    const { manager, deps } = harness();
    const backend = createBackend(config(), deps);

    await backend.start('/tmp/awf', ['github.com']);

    const networkReadyCall = manager.execute.mock.calls[0][0];
    expect(networkReadyCall.argv.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(networkReadyCall.argv[2]).toContain('ip link show dev lo');
    expect(networkReadyCall.argv[2]).toContain("ip -4 addr show dev lo");
    expect(networkReadyCall.argv[2]).toContain("127.0.0.1/8");
    expect(networkReadyCall.argv[2]).toContain("interface='eth0'");
    expect(networkReadyCall.argv[2]).toContain("address='100.64.0.2/30'");
    expect(networkReadyCall.argv[2]).toContain("gateway='100.64.0.1'");
    expect(networkReadyCall.argv[2]).toContain('state UP');
    expect(networkReadyCall.argv[2]).toContain('ip route show default');
    expect(networkReadyCall.argv[2]).toContain('while [ "$attempt" -le 10 ]');
    expect(networkReadyCall.argv[2]).toContain('delay=$((delay * 2))');
    expect(networkReadyCall.timeoutMs).toBe(90_000);
    expect(manager.execute.mock.calls[1][0].argv[2]).toContain('nc -v -z');
    expect(manager.execute.mock.invocationCallOrder[0])
      .toBeLessThan(manager.execute.mock.invocationCallOrder[1]);
  });

  it('retries the boot and fails with structured diagnostics when the data plane stays down', async () => {
    const { manager, deps } = harness();
    manager.execute.mockReset().mockResolvedValue({
      requestId: 'network-ready',
      exitCode: 1,
      signal: null,
      timedOut: false,
    });
    const backend = createBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com'])).rejects.toMatchObject({
      code: 'CLOUD_HYPERVISOR_RETRYABLE_READINESS',
      stage: 'guest-network-readiness',
      bootAttempt: 3,
      diagnosticDirectories: [
        '/tmp/awf/diagnostics/cloud-hypervisor/boot-attempt-1',
        '/tmp/awf/diagnostics/cloud-hypervisor/boot-attempt-2',
        '/tmp/awf/diagnostics/cloud-hypervisor/boot-attempt-3',
      ],
    });
    expect(manager.execute).toHaveBeenCalledTimes(3);
    expect(manager.stop).toHaveBeenCalledTimes(3);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('stage=guest-network-readiness status=failed boot-attempt=3/3'),
    );
  });

  it('marks itself stopped after a successful internal cleanup on startup failure, so a later stop() call is a no-op', async () => {
    // Regression test: main-action.ts's cleanup handler unconditionally
    // calls backend.stop() again after any startup failure. Without
    // marking `stopped` after the internal cleanup here already
    // succeeded, that second call re-invoked manager.stop() a second
    // time -- harmless on its own (network/cgroup are already cleared),
    // but wasteful and a source of confusion when diagnosing failures.
    const { manager, deps } = harness();
    manager.execute.mockReset().mockImplementation(async (request) => ({
      requestId: request.requestId,
      exitCode: request.requestId.startsWith('probe-network-ready-') ? 0 : 41,
      signal: null,
      timedOut: false,
    }));
    const backend = createBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/connectivity probe failed/);
    expect(manager.stop).toHaveBeenCalledTimes(3);

    await backend.stop();
    expect(manager.stop).toHaveBeenCalledTimes(3);
  });

  it('collects diagnostics at most once even if called again after teardown, avoiding a clobbered snapshot', async () => {
    // Regression test: main-action.ts's cleanup handler unconditionally
    // calls backend.collectDiagnostics() during shutdown, regardless of
    // whether start()'s own failure path already collected diagnostics
    // via the beforeCleanup hook (before stop() tore down the
    // network/cgroup/run directory). A second, post-teardown call would
    // overwrite that earlier, more useful snapshot with an
    // empty/unavailable one -- discovered via live-KVM validation
    // (network-diagnostics.txt regressed to "network namespace not set
    // up" after a redundant second collectDiagnostics() call).
    const { manager, deps } = harness();
    manager.execute.mockReset().mockImplementation(async (request) => ({
      requestId: request.requestId,
      exitCode: request.requestId.startsWith('probe-network-ready-') ? 0 : 41,
      signal: null,
      timedOut: false,
    }));
    manager.stop.mockImplementation(async (options?: { beforeCleanup?: () => Promise<void> }) => {
      await options?.beforeCleanup?.();
    });
    const backend = createBackend(
      config({ diagnosticLogs: true } as Partial<WrapperConfig>),
      deps,
    );

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/connectivity probe failed/);
    expect(manager.collectDiagnostics).toHaveBeenCalledTimes(3);

    // Simulates main-action.ts's cleanup handler calling this again.
    await backend.collectDiagnostics();
    expect(manager.collectDiagnostics).toHaveBeenCalledTimes(3);
  });

  it('includes captured guest stdout/stderr in the readiness probe failure message', async () => {
    // Regression test: a bare exit code alone doesn't say which leg of the
    // compound nc-then-wget probe command failed or why. Capture (bounded)
    // stdout/stderr from the probe execution and surface it in the thrown
    // error for faster live-KVM triage.
    const { manager, deps } = harness();
    manager.execute.mockReset().mockImplementation(async (request) => {
      if (request.requestId.startsWith('probe-network-ready-')) {
        return { requestId: request.requestId, exitCode: 0, signal: null, timedOut: false };
      }
      if (request.requestId.startsWith('probe-netdiag-')) {
        return { requestId: request.requestId, exitCode: 0, signal: null, timedOut: false };
      }
      if (request.requestId.startsWith('probe-')) {
        request.stderr?.write('wget: can\'t connect to remote host: Connection refused\n');
        return { requestId: request.requestId, exitCode: 1, signal: null, timedOut: false };
      }
      throw new Error(`unexpected request ${request.requestId}`);
    });
    const backend = createBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com'])).rejects.toThrow(
      /connectivity probe failed with exit code 1 \(stderr: wget: can't connect to remote host: Connection refused\)/,
    );
  });

  it('includes captured guest network state (ip addr/route) in the readiness probe failure message', async () => {
    // Regression test: a probe failure with empty stdout/stderr (BusyBox
    // nc/wget are often silent on connection failure) still needs enough
    // context to diagnose live-KVM guest networking issues. A best-effort
    // follow-up `ip addr show; ip route show` call is issued only after
    // the main probe fails, and its output is folded into the error.
    const { manager, deps } = harness();
    manager.execute.mockReset().mockImplementation(async (request) => {
      if (request.requestId.startsWith('probe-network-ready-')) {
        return { requestId: request.requestId, exitCode: 0, signal: null, timedOut: false };
      }
      if (request.requestId.startsWith('probe-netdiag-')) {
        request.stdout?.write('1: lo: <LOOPBACK,UP>\n---\ndefault via 100.115.75.109 dev eth0\n');
        return { requestId: request.requestId, exitCode: 0, signal: null, timedOut: false };
      }
      return { requestId: request.requestId, exitCode: 1, signal: null, timedOut: false };
    });
    const backend = createBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com'])).rejects.toThrow(
      /guest network state: 1: lo: <LOOPBACK,UP>/,
    );
    expect(manager.execute).toHaveBeenCalledTimes(9);
    const netDiagCall = manager.execute.mock.calls[2][0];
    expect(netDiagCall.argv).toEqual(['/bin/sh', '-c', 'ip addr show; echo ---; ip route show; echo ---; ip neigh show']);
  });

  it('probes guest connectivity with the ARC build-tools baseline nc/wget commands', async () => {
    // Keep this regression coverage independent of curl-specific HTTP
    // behavior. The original BusyBox guest exposed the issue after every
    // boot reached vsock readiness but the connectivity probe exited 127.
    const { manager, deps } = harness();
    manager.execute.mockReset().mockResolvedValueOnce({
      requestId: 'network-ready', exitCode: 0, signal: null, timedOut: false,
    }).mockResolvedValueOnce({
      requestId: 'probe', exitCode: 0, signal: null, timedOut: false,
    }).mockResolvedValueOnce({
      requestId: 'agent', exitCode: 0, signal: null, timedOut: false,
    });
    const backend = createBackend(
      config({ enableApiProxy: true } as Partial<WrapperConfig>),
      deps,
    );

    await backend.start('/tmp/awf', ['github.com']);

    const probeCall = manager.execute.mock.calls[1][0];
    expect(probeCall.argv[0]).toBe('/bin/sh');
    expect(probeCall.argv[1]).toBe('-c');
    const script = probeCall.argv[2] as string;
    expect(script).not.toContain('curl');
    expect(script).toContain('nc -v -z');
    expect(script).toContain('wget');
    // The API proxy request must bypass the guest's HTTP(S)_PROXY env vars
    // (it targets the sidecar directly, not through Squid) and must only
    // run if the Squid reachability check already succeeded.
    expect(script).toContain("probe_leg 'squid' 'nc -v -z");
    expect(script).toContain("probe_leg 'api-proxy' 'unset HTTP_PROXY");
    expect(script).toContain("|| exit $?");
    expect(script).toContain('wget -q -T 20');
    expect(script).toContain('if [ "$attempt" -ge 3 ]');
    expect(script).toContain('connectivity leg=$leg exhausted attempts=$attempt');
    expect(script).toContain('permanent-command-failure');
    expect(script).toContain('sleep "$delay"');
    expect(script).toContain('delay=$((delay * 2))');
  });

  it('uses bounded API proxy retries and an overall probe budget tolerant of nested-KVM scheduling delays', async () => {
    // Regression test: live-KVM validation confirmed (via captured host
    // network diagnostics) that the tap/nftables/vnet_hdr path was fully
    // correct -- Squid's response packets reached the host-side veth --
    // yet the probe still timed out, because the guest's own vCPU was
    // scheduled so rarely under nested virtualization on GitHub-hosted
    // runners that a short-lived `nc -z -w 5` couldn't get enough real
    // CPU time to complete its connect() within that 5-second budget.
    // Raised both the per-command timeouts and the overall exec budget
    // to match the same generous, nested-KVM-tolerant convention used for
    // guest boot readiness (see CLOUD_HYPERVISOR_GUEST_READY_MAX_WAIT_MS).
    const { manager, deps } = harness();
    manager.execute.mockReset().mockResolvedValueOnce({
      requestId: 'network-ready', exitCode: 0, signal: null, timedOut: false,
    }).mockResolvedValueOnce({
      requestId: 'probe', exitCode: 0, signal: null, timedOut: false,
    }).mockResolvedValueOnce({
      requestId: 'agent', exitCode: 0, signal: null, timedOut: false,
    });
    const backend = createBackend(
      config({ enableApiProxy: true } as Partial<WrapperConfig>),
      deps,
    );

    await backend.start('/tmp/awf', ['github.com']);

    const probeCall = manager.execute.mock.calls[1][0];
    const script = probeCall.argv[2] as string;
    expect(script).toContain('nc -v -z -w 60');
    expect(script).toContain('wget -q -T 20');
    expect(script).toContain('attempt=1');
    expect(script).toContain('delay=2');
    expect(script).toContain('if [ "$attempt" -ge 3 ]');
    expect(probeCall.timeoutMs).toBe(282_000);
  });

  it('passes a beforeCleanup diagnostics hook to stop() on a startup failure, when --diagnostic-logs is set', async () => {
    // Regression test: manager.stop() deletes the private run directory
    // (including the guest serial console log) as its final step, but
    // Cloud Hypervisor also does not flush buffered guest serial console
    // output until its process actually exits. So collectDiagnostics()
    // must run as a hook *inside* stop() — after process termination is
    // confirmed (flushing buffers) but before the run directory is
    // removed — rather than either before or after stop() entirely.
    // Discovered via live-KVM validation: a guest boot failure produced
    // completely empty diagnostics artifacts when collected too early.
    const { manager, deps } = harness();
    const order: string[] = [];
    manager.collectDiagnostics.mockImplementation(async () => {
      order.push('collect-diagnostics');
    });
    manager.stop.mockImplementation(async (options?: { beforeCleanup?: () => Promise<void> }) => {
      order.push('stop-process-terminated');
      await options?.beforeCleanup?.();
      order.push('stop-directory-removed');
    });
    manager.startInstance.mockRejectedValue(new Error('guest disconnected before readiness'));
    const backend = createBackend(
      config({ diagnosticLogs: true } as Partial<WrapperConfig>),
      deps,
    );

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow('guest disconnected before readiness');
    expect(manager.collectDiagnostics).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledWith(
      expect.objectContaining({ beforeCleanup: expect.any(Function) }),
    );
    expect(order).toEqual(['stop-process-terminated', 'collect-diagnostics', 'stop-directory-removed']);
  });

  it('preserves boot-attempt diagnostics even when --diagnostic-logs is unset', async () => {
    const { manager, deps } = harness();
    manager.startInstance.mockRejectedValue(new Error('guest disconnected before readiness'));
    const backend = createBackend(
      config({ diagnosticLogs: false } as Partial<WrapperConfig>),
      deps,
    );

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow('guest disconnected before readiness');
    expect(manager.collectDiagnostics).toHaveBeenCalledWith(
      '/tmp/awf/diagnostics/cloud-hypervisor/boot-attempt-1',
    );
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(manager.stop).toHaveBeenCalledWith(
      expect.objectContaining({ beforeCleanup: expect.any(Function) }),
    );
  });

  it('surfaces the original startup error even if pre-cleanup diagnostics collection itself fails', async () => {
    const { manager, deps } = harness();
    manager.collectDiagnostics.mockRejectedValue(new Error('diagnostics write failed'));
    manager.stop.mockImplementation(async (options?: { beforeCleanup?: () => Promise<void> }) => {
      await options?.beforeCleanup?.();
    });
    manager.startInstance.mockRejectedValue(new Error('guest disconnected before readiness'));
    const backend = createBackend(
      config({ diagnosticLogs: true } as Partial<WrapperConfig>),
      deps,
    );

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow('guest disconnected before readiness');
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it('fails closed when manager readiness or startup cleanup is unavailable', async () => {
    const missingIp = harness();
    Reflect.set(missingIp.manager, 'guestIp', undefined);
    const backend = createBackend(config(), missingIp.deps);
    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/did not expose the configured guest network plan/);
    expect(missingIp.manager.stop).toHaveBeenCalledTimes(1);

    const dualFailure = harness();
    dualFailure.manager.start.mockRejectedValue('VMM configuration failed');
    dualFailure.manager.stop.mockRejectedValue('cleanup failed');
    const failing = createBackend(config(), dualFailure.deps);
    await expect(failing.start('/tmp/awf', ['github.com'])).rejects.toMatchObject({
      message: expect.stringContaining('VMM configuration failed'),
      cause: 'VMM configuration failed',
      cleanupCause: 'cleanup failed',
    });
  });

  it('recovers in the same invocation by recreating a VM after a classified readiness failure', async () => {
    const { manager, deps } = harness();
    let readinessCalls = 0;
    manager.execute.mockReset().mockImplementation(async (request) => {
      if (request.requestId.startsWith('probe-network-ready-')) {
        readinessCalls += 1;
        return {
          requestId: request.requestId,
          exitCode: readinessCalls === 1 ? 1 : 0,
          signal: null,
          timedOut: false,
        };
      }
      return { requestId: request.requestId, exitCode: 0, signal: null, timedOut: false };
    });
    const backend = createBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com'])).resolves.toBeUndefined();

    expect(deps.createManager).toHaveBeenCalledTimes(2);
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(deps.sleep).toHaveBeenCalledWith(5_000);
    expect(manager.collectDiagnostics).toHaveBeenCalledWith(
      '/tmp/awf/diagnostics/cloud-hypervisor/boot-attempt-1',
    );
  });

  it('fails fast without boot recovery for a permanent connectivity configuration error', async () => {
    const { manager, deps } = harness();
    manager.execute.mockReset().mockImplementation(async (request) => ({
      requestId: request.requestId,
      exitCode: request.requestId.startsWith('probe-network-ready-') ? 0 : 127,
      signal: null,
      timedOut: false,
    }));
    const backend = createBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/connectivity configuration is invalid/);
    expect(deps.createManager).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed wrapped command after execution starts', async () => {
    const { deps, stdin } = harness();
    const backend = createBackend(config(), deps);
    await backend.start('/tmp/awf', ['github.com']);

    const execution = backend.exec('/tmp/awf', ['github.com']);
    stdin.end();

    await expect(execution).resolves.toEqual({ exitCode: 23 });
    expect(deps.createManager).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('rejects execution before readiness and unsupported TTY execution', async () => {
    const cold = harness();
    await expect(createBackend(config(), cold.deps).exec(
      '/tmp/awf',
      ['github.com'],
    )).rejects.toThrow(/microVM is not ready/);

    const ttyHarness = harness();
    const ttyConfig = config();
    const ttyBackend = createBackend(ttyConfig, ttyHarness.deps);
    await ttyBackend.start('/tmp/awf', ['github.com']);
    ttyConfig.tty = true;
    await expect(ttyBackend.exec('/tmp/awf', ['github.com']))
      .rejects.toThrow(/does not support TTY execution/);
    await ttyBackend.stop();
  });

  it('preserves a stopped VM once and logs retained artifacts', async () => {
    const { manager, deps } = harness();
    const backend = createBackend(config(), deps);
    await backend.start('/tmp/awf', ['github.com']);

    await backend.preserve();
    await backend.preserve();
    await backend.collectDiagnostics();

    expect(manager.stop).toHaveBeenCalledWith({ preserve: true });
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(deps.logger.info).toHaveBeenCalledWith(
      '[cloud-hypervisor] Preserved network namespace: awfvm-test',
    );
  });

  it('cancels an active guest command before stopping', async () => {
    const { manager, deps } = harness();
    const resolveExecution = mockNetworkReadyProbeSequence(manager);
    manager.cancel.mockImplementationOnce(async () => {
      resolveExecution({
        requestId: 'agent',
        exitCode: 130,
        signal: null,
        timedOut: false,
      });
    });
    const backend = createBackend(config(), deps);
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
    const backend = createBackend(config(), deps);
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

  it('sets lowercase http_proxy so BusyBox wget honors the proxy for https:// too', () => {
    // Regression coverage: a live-KVM connectivity investigation found
    // BusyBox wget reads only the lowercase "http_proxy" env var for
    // every protocol it supports, including https -- there is no
    // https_proxy check anywhere in its proxy-detection logic. Without
    // this (the shared container-runtime environment intentionally
    // omits it, for curl/Ubuntu-specific reasons that don't apply to
    // this guest's BusyBox wget), wget silently falls back to a direct,
    // unproxied connection attempt, which fails outright since guest DNS
    // is unconditionally blocked by network policy.
    const environment = buildCloudHypervisorGuestEnvironment(config(), infrastructure());

    expect(environment.http_proxy).toBe('http://172.30.0.10:3128');
  });

  it('maps only exported runner paths and keeps the guest home in the writable workspace', () => {
    const previousToolCache = process.env.RUNNER_TOOL_CACHE;
    const previousRunnerTemp = process.env.RUNNER_TEMP;
    try {
      process.env.RUNNER_TOOL_CACHE = '/opt/hostedtoolcache';
      process.env.RUNNER_TEMP = '/home/runner/work/_temp';
      const environment = buildCloudHypervisorGuestEnvironment(
        config(),
        infrastructure(),
        '100.64.0.2',
        [
          {
            tag: 'workspace',
            source: '/host/workspace',
            target: '/workspace',
            mode: 'rw',
          },
          {
            tag: 'runner-tool-cache',
            source: '/opt/hostedtoolcache',
            target: '/opt/hostedtoolcache',
            mode: 'ro',
          },
          {
            tag: 'runner-temp-gh-aw',
            source: '/home/runner/work/_temp/gh-aw',
            target: '/home/runner/work/_temp/gh-aw',
            mode: 'ro',
          },
        ],
      );
      expect(environment).toMatchObject({
        HOME: '/workspace/.awf-home',
        GITHUB_WORKSPACE: '/workspace',
        RUNNER_TOOL_CACHE: '/opt/hostedtoolcache',
        RUNNER_TEMP: '/home/runner/work/_temp',
      });
    } finally {
      if (previousToolCache === undefined) delete process.env.RUNNER_TOOL_CACHE;
      else process.env.RUNNER_TOOL_CACHE = previousToolCache;
      if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousRunnerTemp;
    }
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
    )).toThrow(/DIFC proxies or enclaves/);
    expect(() => assertCloudHypervisorSelection(
      config({ containerRuntime: 'gvisor' }),
    )).toThrow(/require --container-runtime cloud-hypervisor/);
  });
});
