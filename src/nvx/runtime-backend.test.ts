import type { WrapperConfig } from '../types';
import type { MicrovmInfrastructureSnapshot } from '../microvm/infrastructure';
import type { NvxOneShotExecutionResult } from './one-shot-adapter';
import {
  nvxRuntimeTestHelpers,
  type NvxRuntimeBackendDependencies,
} from './runtime-backend';

function nvxConfig(): WrapperConfig {
  return {
    containerRuntime: 'nvx',
    workDir: '/tmp/awf-work',
    agentCommand: 'echo hello',
    networkIsolation: true,
    legacySecurity: false,
    enableApiProxy: true,
    enableDind: false,
    enableHostAccess: false,
    tty: false,
    nvx: {
      previewEnabled: true,
      layerPath: '/opt/nvx/distro.layer',
      artifactManifestPath: '/opt/nvx/manifest.json',
      artifactManifestBundlePath: '/opt/nvx/manifest.sigstore.jsonl',
      openvmmPath: '/opt/nvx/openvmm',
      kernelPath: '/opt/nvx/kernel',
      initramfsPath: '/opt/nvx/initramfs',
      memoryMib: 512,
      memoryMaxBytes: 512 * 1024 * 1024,
      pidsMax: 128,
    },
  } as WrapperConfig;
}

function infrastructureSnapshot(): MicrovmInfrastructureSnapshot {
  return {
    networkId: 'awf-nvx-net',
    bridgeName: 'awf-nvx0',
    subnet: '172.31.0.0/24',
    gateway: '172.31.0.1',
    squidIp: '172.31.0.10',
    apiProxyIp: '172.31.0.30',
    topologyPeerIps: {},
    revalidate: jest.fn().mockResolvedValue(undefined),
  };
}

function harness(overrides: Partial<NvxRuntimeBackendDependencies> = {}) {
  const executeMock = jest.fn<Promise<NvxOneShotExecutionResult>, []>().mockResolvedValue({
    exitCode: 0,
    category: 'success',
    signal: null,
    timedOut: false,
    rawStdoutTail: Buffer.alloc(0),
    rawStderrTail: Buffer.alloc(0),
  } as NvxOneShotExecutionResult);
  const manager = { execute: executeMock };
  const createManager = jest.fn().mockReturnValue(manager) as unknown as
    NvxRuntimeBackendDependencies['createManager'];

  const dependencies: NvxRuntimeBackendDependencies = {
    startInfrastructure: jest.fn().mockResolvedValue(undefined),
    resolveTrustedIpTool: jest.fn().mockResolvedValue('/usr/sbin/ip'),
    resolveInfrastructure: jest.fn().mockResolvedValue(infrastructureSnapshot()),
    createManager,
    identity: jest.fn().mockReturnValue({ uid: 1000, gid: 1000 }),
    randomRunId: jest.fn().mockReturnValue('a'.repeat(32)),
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
    ...overrides,
  };

  return { dependencies, executeMock, createManager, manager };
}

describe('NvxRuntimeBackend', () => {
  it('starts host infrastructure and resolves microVM infrastructure using a trusted ip tool before executing', async () => {
    const { dependencies } = harness();
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(nvxConfig(), dependencies);

    const onNetworkReady = jest.fn();
    const onInfrastructureReady = jest.fn();
    await backend.start(
      '/tmp/awf-work',
      ['example.com'],
      '/tmp/awf-work/logs',
      false,
      onNetworkReady,
      onInfrastructureReady,
    );

    expect(dependencies.startInfrastructure).toHaveBeenCalledWith(
      '/tmp/awf-work',
      ['example.com'],
      '/tmp/awf-work/logs',
      false,
      onNetworkReady,
      onInfrastructureReady,
    );
    expect(dependencies.resolveTrustedIpTool).toHaveBeenCalled();
    expect(dependencies.resolveInfrastructure).toHaveBeenCalledWith(true, '/usr/sbin/ip', undefined);
  });


  it('rejects preflight when the preview flag is not set, without falling back', async () => {
    const { dependencies } = harness();
    const config = nvxConfig();
    config.nvx = { ...config.nvx!, previewEnabled: false };
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);

    await expect(backend.preflight()).rejects.toThrow(/explicit --nvx-preview opt-in/);
    expect(dependencies.startInfrastructure).not.toHaveBeenCalled();
  });

  it('rejects an agent timeout beyond the supported maximum', async () => {
    const { dependencies } = harness();
    const config = nvxConfig();
    config.agentTimeout = 60 * 24 * 2; // two days, in minutes
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);

    await expect(backend.preflight()).rejects.toThrow(/--agent-timeout values up to/);
  });

  it('constructs the NvxManager with preserved command, identity, and limits, and returns the exit code unchanged', async () => {
    const { dependencies, createManager, executeMock } = harness();
    const snapshot = infrastructureSnapshot();
    (snapshot as { topologyPeerIps: Record<string, string> }).topologyPeerIps = {
      gateway: '172.31.0.40',
    };
    (dependencies.resolveInfrastructure as jest.Mock).mockResolvedValue(snapshot);
    executeMock.mockResolvedValue({
      exitCode: 42,
      category: 'success',
      signal: null,
      timedOut: false,
      rawStdoutTail: Buffer.alloc(0),
      rawStderrTail: Buffer.alloc(0),
    } as NvxOneShotExecutionResult);
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(nvxConfig(), dependencies);

    await backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn());
    const result = await backend.exec('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', 10);

    expect(result).toEqual({ exitCode: 42 });
    expect(snapshot.revalidate).toHaveBeenCalled();
    expect(createManager).toHaveBeenCalledTimes(1);
    const [managerConfig] = (createManager as unknown as jest.Mock).mock.calls[0];
    expect(managerConfig.execution.entrypoint).toBe('/bin/sh');
    expect(managerConfig.execution.args).toEqual(['-lc', 'echo hello']);
    expect(managerConfig.execution.workloadUid).toBe(1000);
    expect(managerConfig.execution.workloadGid).toBe(1000);
    expect(managerConfig.execution.memoryMib).toBe(512);
    expect(managerConfig.execution.memoryMaxBytes).toBe(512 * 1024 * 1024);
    expect(managerConfig.execution.pidsMax).toBe(128);
    expect(managerConfig.execution.timeoutMs).toBe(10 * 60_000);
    expect(managerConfig.filesystem.layers).toEqual([
      { role: 'distro', sourcePath: '/opt/nvx/distro.layer' },
    ]);
    expect(managerConfig.filesystem.scratchUid).toBe(1000);
    expect(managerConfig.filesystem.scratchGid).toBe(1000);
    expect(managerConfig.filesystem.maxScratchBytes).toBeUndefined();
    expect(managerConfig.preflight.manifestPath).toBe('/opt/nvx/manifest.json');
    expect(managerConfig.network.infrastructureBridge).toBe('awf-nvx0');
    expect(managerConfig.network.controlPeers).toEqual([
      { ip: '172.31.0.40', ports: [8080] },
    ]);
  });

  it('rejects TTY execution before touching any resources', async () => {
    const { dependencies } = harness();
    const config = nvxConfig();
    config.tty = true;
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);

    await expect(
      backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn()),
    ).rejects.toThrow(/does not support --tty/);
    expect(dependencies.startInfrastructure).not.toHaveBeenCalled();
  });

  it('aborts an in-flight execution on stop() and does not throw', async () => {
    const { dependencies, executeMock } = harness();
    let capturedSignal: AbortSignal | undefined;
    executeMock.mockImplementation(() => new Promise((resolve, reject) => {
      // Simulate the manager reacting to abort by rejecting.
      const check = () => {
        if (capturedSignal?.aborted) {
          reject(new Error('aborted'));
        }
      };
      capturedSignal?.addEventListener('abort', check);
    }));
    const createManager = jest.fn((cfg: { execution: { abortSignal?: AbortSignal } }) => {
      capturedSignal = cfg.execution.abortSignal;
      return { execute: executeMock };
    }) as unknown as NvxRuntimeBackendDependencies['createManager'];
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(
      nvxConfig(),
      { ...dependencies, createManager },
    );

    await backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn());
    const execPromise = backend.exec('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', undefined);
    await Promise.resolve();
    await expect(backend.stop()).resolves.toBeUndefined();
    await expect(execPromise).rejects.toThrow('aborted');
  });

  it('is a no-op diagnostics collector since NvxManager owns durable cleanup', async () => {
    const { dependencies } = harness();
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(nvxConfig(), dependencies);
    await expect(backend.collectDiagnostics()).resolves.toBeUndefined();
  });

  it('refuses to launch a new microVM if stop() was already called', async () => {
    const { dependencies, createManager } = harness();
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(nvxConfig(), dependencies);

    await backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn());
    await backend.stop();

    await expect(backend.exec('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', undefined))
      .rejects.toThrow(/aborted by shutdown/);
    expect(createManager).not.toHaveBeenCalled();
  });

  it('threads configured topology peers into infrastructure discovery', async () => {
    const { dependencies } = harness();
    const config = nvxConfig();
    config.topologyAttach = ['awf-enclave-github-mcp'];
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);

    await backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn());

    expect(dependencies.resolveInfrastructure).toHaveBeenCalledWith(
      true,
      '/usr/sbin/ip',
      ['awf-enclave-github-mcp'],
    );
  });
});
