import type { WorkflowDependencies } from './cli-workflow';
import { SBX_DEFAULT_NAME } from './sbx-manager';
import {
  SBX_GATEWAY_IP,
  SBX_HOST_DOCKER_INTERNAL,
  SbxRuntimeBackend,
  type SbxRuntimeBackendDependencies,
} from './sbx-runtime-backend';
import type { WrapperConfig } from './types';

function createConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: ['github.com'],
    agentCommand: 'echo hello',
    workDir: '/tmp/awf-test',
    containerWorkDir: '/workspace',
    keepContainers: false,
    enableApiProxy: true,
    dnsServers: ['8.8.8.8'],
    volumeMounts: ['/tmp/tooling:/tmp/tooling:ro'],
    tty: true,
    ...overrides,
  } as WrapperConfig;
}

function createDependencies(
  overrides: Partial<SbxRuntimeBackendDependencies> = {},
): SbxRuntimeBackendDependencies {
  return {
    startInfrastructure: jest.fn().mockResolvedValue(undefined) as jest.MockedFunction<
      WorkflowDependencies['startContainers']
    >,
    isAvailable: jest.fn().mockResolvedValue(true),
    createSandbox: jest.fn().mockResolvedValue('awf-agent-created'),
    execInSandbox: jest.fn().mockResolvedValue({ exitCode: 0 }),
    assertApiProxyReflect: jest.fn().mockResolvedValue(undefined),
    removeSandbox: jest.fn().mockResolvedValue(undefined),
    execHostCommand: jest.fn()
      .mockReturnValueOnce('proxy log\n')
      .mockReturnValueOnce('healthy\n'),
    getWorkspaceDir: jest.fn().mockReturnValue('/github/workspace'),
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
    },
    ...overrides,
  };
}

describe('SbxRuntimeBackend', () => {
  it('owns infrastructure startup, preflight, environment, reflection, exec, diagnostics, and stop', async () => {
    const dependencies = createDependencies();
    const execInSandbox = dependencies.execInSandbox as jest.MockedFunction<
      SbxRuntimeBackendDependencies['execInSandbox']
    >;
    execInSandbox
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 42 });
    const backend = new SbxRuntimeBackend(createConfig(), dependencies);
    const onNetworkReady = jest.fn();
    const onInfrastructureReady = jest.fn();

    await backend.start(
      '/tmp/awf-test',
      ['github.com'],
      '/tmp/proxy-logs',
      true,
      onNetworkReady,
      onInfrastructureReady,
    );
    const result = await backend.exec(
      '/tmp/awf-test',
      ['github.com'],
      '/tmp/proxy-logs',
      7,
    );
    await backend.stop();
    await backend.stop();

    expect(dependencies.startInfrastructure).toHaveBeenCalledWith(
      '/tmp/awf-test',
      ['github.com'],
      '/tmp/proxy-logs',
      true,
      onNetworkReady,
      onInfrastructureReady,
    );
    expect(dependencies.isAvailable).toHaveBeenCalledTimes(1);
    expect(dependencies.createSandbox).toHaveBeenCalledWith({
      workspaceDir: '/github/workspace',
      squidIp: expect.any(String),
      extraMounts: ['/tmp/tooling:/tmp/tooling:ro'],
    });
    expect(dependencies.assertApiProxyReflect).toHaveBeenCalledWith(
      'awf-agent-created',
      expect.objectContaining({
        HTTPS_PROXY: `http://${SBX_GATEWAY_IP}:3128`,
        AWF_API_PROXY_IP: SBX_HOST_DOCKER_INTERNAL,
      }),
      '/workspace',
    );
    expect(execInSandbox).toHaveBeenLastCalledWith(
      'awf-agent-created',
      'echo hello',
      expect.objectContaining({
        timeoutMinutes: 7,
        workDir: '/workspace',
        tty: true,
      }),
    );
    expect(result).toEqual({ exitCode: 42 });
    expect(dependencies.execHostCommand).toHaveBeenNthCalledWith(
      1,
      'docker logs --tail 80 awf-api-proxy 2>&1',
      { encoding: 'utf-8', timeout: 10_000 },
    );
    expect(dependencies.execHostCommand).toHaveBeenNthCalledWith(
      2,
      'docker inspect --format={{.State.Health.Status}} awf-api-proxy 2>&1',
      { encoding: 'utf-8', timeout: 5_000 },
    );
    expect(dependencies.removeSandbox).toHaveBeenCalledTimes(1);
    expect(dependencies.removeSandbox).toHaveBeenCalledWith('awf-agent-created');
  });

  it('preserves startup ordering and fails closed when sbx is unavailable', async () => {
    const callOrder: string[] = [];
    const dependencies = createDependencies({
      startInfrastructure: jest.fn(async () => {
        callOrder.push('infrastructure');
      }),
      isAvailable: jest.fn(async () => {
        callOrder.push('preflight');
        return false;
      }),
    });
    const backend = new SbxRuntimeBackend(createConfig(), dependencies);

    await expect(backend.start('/tmp/awf-test', ['github.com'])).rejects.toThrow(
      'Docker sbx CLI not found',
    );

    expect(callOrder).toEqual(['infrastructure', 'preflight']);
    expect(dependencies.createSandbox).not.toHaveBeenCalled();
  });

  it('rejects execution before the sandbox is created', async () => {
    const backend = new SbxRuntimeBackend(createConfig(), createDependencies());

    await expect(backend.exec('/tmp/awf-test', ['github.com'])).rejects.toThrow(
      'Sandbox not created',
    );
  });

  it('stops the deterministic sandbox name after partial startup', async () => {
    const dependencies = createDependencies();
    const backend = new SbxRuntimeBackend(createConfig(), dependencies);

    await backend.stop();

    expect(dependencies.removeSandbox).toHaveBeenCalledWith(SBX_DEFAULT_NAME);
  });

  it('does not collect API proxy diagnostics when the proxy is disabled', async () => {
    const dependencies = createDependencies();
    const backend = new SbxRuntimeBackend(
      createConfig({ enableApiProxy: false }),
      dependencies,
    );

    await backend.collectDiagnostics();

    expect(dependencies.execHostCommand).not.toHaveBeenCalled();
  });
});
