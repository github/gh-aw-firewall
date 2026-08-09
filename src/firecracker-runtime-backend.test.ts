import { PassThrough } from 'stream';
import type { WrapperConfig } from './types';
import {
  FirecrackerRuntimeBackend,
  assertFirecrackerPreSecurityCompatibility,
  buildFirecrackerGuestEnvironment,
  type FirecrackerRuntimeBackendDependencies,
} from './firecracker-runtime-backend';
import { assertFirecrackerSelection } from './firecracker/runtime-validation';
import type { FirecrackerInfrastructureSnapshot } from './firecracker/infrastructure';

const digest = 'a'.repeat(64);

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: 'firecracker',
    firecracker: {
      previewEnabled: true,
      firecrackerBinary: '/opt/firecracker',
      jailerBinary: '/opt/jailer',
      kernelPath: '/opt/kernel',
      rootfsPath: '/opt/rootfs',
      supervisorPath: '/opt/supervisor',
      vcpuCount: 2,
      memoryMib: 512,
      apiTimeoutMs: 5000,
      sha256: {
        firecracker: digest,
        jailer: digest,
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

function infrastructure(): FirecrackerInfrastructureSnapshot {
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

function harness(overrides: Partial<FirecrackerRuntimeBackendDependencies> = {}) {
  const order: string[] = [];
  const stdin = new PassThrough();
  const manager = {
    paths: { jailRoot: '/tmp/awf/jail' },
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
    stop: jest.fn(async () => { order.push('vm-stop'); }),
  };
  const infra = infrastructure();
  (infra.revalidate as jest.Mock).mockImplementation(async () => {
    order.push('revalidate');
  });
  const deps: FirecrackerRuntimeBackendDependencies = {
    startInfrastructure: jest.fn(async () => { order.push('compose'); }),
    preflight: jest.fn(async () => { order.push('preflight'); }),
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

describe('Firecracker runtime backend', () => {
  it('starts infrastructure, revalidates it, boots and probes before execution', async () => {
    const { order, manager, deps, stdin } = harness();
    const backend = new FirecrackerRuntimeBackend(config(), deps);

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
    expect(manager.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      argv: ['/bin/bash', '-lc', 'printf hello'],
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

  it('stops the partial VM when readiness probing fails', async () => {
    const { manager, deps } = harness();
    manager.execute.mockReset().mockResolvedValue({
      requestId: 'probe',
      exitCode: 41,
      signal: null,
      timedOut: false,
    });
    const backend = new FirecrackerRuntimeBackend(config(), deps);

    await expect(backend.start('/tmp/awf', ['github.com']))
      .rejects.toThrow(/connectivity probe failed/);
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it('preserves sanitized env values without leaking real provider secrets', () => {
    const secret = 'sk-real-provider-secret';
    const environment = buildFirecrackerGuestEnvironment(
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
  });

  it('rejects unsupported strict-security and topology combinations', () => {
    expect(() => assertFirecrackerPreSecurityCompatibility(
      config({ enableDind: true }),
    )).toThrow(/Docker-in-Docker/);
    expect(() => assertFirecrackerPreSecurityCompatibility(
      config({ enableHostAccess: true }),
    )).toThrow(/host access/);
    expect(() => assertFirecrackerPreSecurityCompatibility(
      config({ enclaves: { enabled: true } } as Partial<WrapperConfig>),
    )).toThrow(/MCP gateway path/);
    expect(() => assertFirecrackerSelection(
      config({ containerRuntime: 'gvisor' }),
    )).toThrow(/require --container-runtime firecracker/);
  });
});
