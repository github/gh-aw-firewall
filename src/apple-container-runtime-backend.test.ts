import {
  APPLE_CONTAINER_TIMEOUT_EXIT_CODE,
  AppleContainerRuntimeBackend,
  appleContainerRuntimeTestHelpers,
  type AppleContainerRuntimeBackendDependencies,
} from './apple-container-runtime-backend';
import type { AppleContainerCliResult } from './apple-container/cli';
import type { AppleContainerDiagnostics } from './apple-container/diagnostics';
import type { AppleContainerRunSpec } from './apple-container/run-args';
import type { WrapperConfig } from './types';

const WORK_DIR = '/tmp/awf-apple-backend-test';
const WORKSPACE = '/Users/runner/work/repo/repo';
const AGENT_IMAGE = 'ghcr.io/github/gh-aw-firewall/agent:1.0.0@sha256:' + 'a'.repeat(64);
const INIT_IMAGE = 'ghcr.io/github/gh-aw-firewall/apple-init:1.0.0@sha256:' + 'b'.repeat(64);

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: ['github.com'],
    agentCommand: 'true',
    logLevel: 'info',
    workDir: WORK_DIR,
    containerRuntime: 'apple-container',
    networkIsolation: true,
    enableApiProxy: true,
    appleContainer: { previewEnabled: true, cpus: 4, memory: '8G' },
    ...overrides,
  } as unknown as WrapperConfig;
}

function cliResult(overrides: Partial<AppleContainerCliResult> = {}): AppleContainerCliResult {
  return {
    argv: ['container', 'start'],
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

interface Harness {
  backend: AppleContainerRuntimeBackend;
  dependencies: AppleContainerRuntimeBackendDependencies;
  order: string[];
  lifecycle: {
    create: jest.Mock;
    startAttached: jest.Mock;
    stop: jest.Mock;
    kill: jest.Mock;
    remove: jest.Mock;
    pullImage: jest.Mock;
    cli: { run: jest.Mock; binary: string };
  };
  transport: {
    applyTo: jest.Mock;
    stop: jest.Mock;
    stats: jest.Mock;
    verify: jest.Mock;
  };
}

function harness(
  wrapper: WrapperConfig = config(),
  overrides: Partial<AppleContainerRuntimeBackendDependencies> = {},
): Harness {
  const order: string[] = [];
  const lifecycle = {
    create: jest.fn(async () => {
      order.push('container-create');
      return 'container-abc';
    }),
    startAttached: jest.fn(async () => cliResult()),
    stop: jest.fn(async () => cliResult()),
    kill: jest.fn(async () => cliResult()),
    remove: jest.fn(async () => {
      order.push('container-remove');
      return cliResult();
    }),
    pullImage: jest.fn(async () => {
      order.push('image-pull');
      return cliResult();
    }),
    cli: { run: jest.fn(async () => cliResult()), binary: 'container' },
  };
  const transport = {
    directory: { path: '/tmp/awf-apple-abcdef0123456789', runId: 'abcdef0123456789' },
    applyTo: jest.fn((spec: AppleContainerRunSpec) => ({
      ...spec,
      network: { kind: 'none' as const },
      capDrop: ['NET_RAW'],
      initImage: INIT_IMAGE,
      socketMounts: [{ hostPath: '/tmp/s/squid.sock', containerPath: '/run/awf/x/squid.sock' }],
    })),
    stop: jest.fn(async () => {
      order.push('transport-stop');
    }),
    stats: jest.fn(() => ({ squid: { connections: 1 } })),
    verify: jest.fn(async () => undefined),
  };

  const dependencies: AppleContainerRuntimeBackendDependencies = {
    startInfrastructure: jest.fn(async () => {
      order.push('compose-infrastructure');
    }),
    preflight: jest.fn(async () => {
      order.push('preflight');
      return {
        facts: {
          platform: 'darwin' as NodeJS.Platform,
          arch: 'arm64',
          macosProductVersion: '26.1.0',
          hypervisorSupported: true,
        },
        cliBinary: 'container',
        cliVersion: '0.4.2',
      };
    }),
    createLifecycle: jest.fn(() => lifecycle as never),
    startTransport: jest.fn(async () => {
      order.push('transport-start');
      return transport as never;
    }),
    collectDiagnostics: jest.fn(async (): Promise<AppleContainerDiagnostics> => ({
      captures: [{ name: 'system.log', argv: ['container'], ok: true, content: 'ok' }],
    })),
    findPortConflicts: jest.fn(async () => {
      order.push('port-probe');
      return [];
    }),
    imagePresent: jest.fn(async () => true),
    ensureDirectory: jest.fn(async () => {
      order.push('run-directories');
    }),
    writeDiagnostics: jest.fn(async () => undefined),
    identity: () => ({ uid: '501', gid: '20' }),
    workspaceDir: () => WORKSPACE,
    ghAwStateDir: () => undefined,
    resolveImages: jest.fn(() => ({ agent: AGENT_IMAGE, init: INIT_IMAGE })),
    transportBaseDirectory: () => '/tmp',
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
    ...overrides,
  };

  return {
    backend: new AppleContainerRuntimeBackend(wrapper, dependencies),
    dependencies,
    order,
    lifecycle,
    transport,
  };
}

async function start(h: Harness): Promise<void> {
  await h.backend.start(WORK_DIR, ['github.com'], undefined, false);
}

describe('preflight', () => {
  it('rejects an unsupported container CLI version before anything is created', async () => {
    const h = harness(config(), {
      preflight: jest.fn(async () => ({
        facts: {
          platform: 'darwin' as NodeJS.Platform,
          arch: 'arm64',
          macosProductVersion: '26.1.0',
          hypervisorSupported: true,
        },
        cliBinary: 'container',
        cliVersion: '1.2.0',
      })),
    });
    await expect(h.backend.preflight()).rejects.toThrow('has not been validated against');
    expect(h.dependencies.startInfrastructure).not.toHaveBeenCalled();
  });

  it('rejects an occupied loopback port and names every conflict', async () => {
    const h = harness(config(), {
      findPortConflicts: jest.fn(async () => [
        { service: 'squid-proxy' as const, containerPort: 3128, hostPort: 3128, capability: 'squid' as const },
        { service: 'api-proxy' as const, containerPort: 10001, hostPort: 10001, capability: 'api-proxy-anthropic' as const },
      ]),
    });
    await expect(h.backend.preflight()).rejects.toThrow(/3128 \(squid\).*10001 \(api-proxy-anthropic\)/s);
  });

  it('rejects an unsupported configuration before probing the host', async () => {
    const h = harness(config({ enableDind: true }));
    await expect(h.backend.preflight()).rejects.toThrow('Docker-in-Docker');
    expect(h.dependencies.preflight).not.toHaveBeenCalled();
  });
});

describe('start', () => {
  it('runs the lifecycle in the fail-closed order', async () => {
    const h = harness();
    await start(h);
    expect(h.order).toEqual([
      'preflight',
      'port-probe',
      'compose-infrastructure',
      'run-directories',
      'run-directories',
      'run-directories',
      'run-directories',
      'run-directories',
      'run-directories',
      'run-directories',
      'image-pull',
      'image-pull',
      'transport-start',
      'container-create',
    ]);
  });

  it('starts the transport before the container is ever created', async () => {
    const h = harness();
    await start(h);
    expect(h.order.indexOf('transport-start')).toBeLessThan(h.order.indexOf('container-create'));
  });

  it('requests every capability the configuration implies', async () => {
    const h = harness(config({ enableApiProxy: true, difcProxyHost: 'https://difc:18443' }));
    await start(h);
    const options = (h.dependencies.startTransport as jest.Mock).mock.calls[0][0];
    expect(options.capabilities.map((entry: { id: string }) => entry.id)).toEqual([
      'squid',
      'api-proxy-openai',
      'api-proxy-anthropic',
      'api-proxy-copilot',
      'api-proxy-gemini',
      'cli-proxy',
    ]);
    expect(options.initImage).toBe(INIT_IMAGE);
  });

  it('merges the transport plan into the run spec before creating the container', async () => {
    const h = harness();
    await start(h);
    expect(h.transport.applyTo).toHaveBeenCalledTimes(1);
    const created = h.lifecycle.create.mock.calls[0][0] as AppleContainerRunSpec;
    expect(created.network).toEqual({ kind: 'none' });
    expect(created.initImage).toBe(INIT_IMAGE);
  });

  it('pulls both images for native arm64', async () => {
    const h = harness();
    await start(h);
    expect(h.lifecycle.pullImage).toHaveBeenCalledWith(AGENT_IMAGE, { platform: 'linux/arm64' });
    expect(h.lifecycle.pullImage).toHaveBeenCalledWith(INIT_IMAGE, { platform: 'linux/arm64' });
  });

  it('verifies image presence rather than assuming a Docker pre-pull under --skip-pull', async () => {
    const h = harness();
    await h.backend.start(WORK_DIR, ['github.com'], undefined, true);
    expect(h.lifecycle.pullImage).not.toHaveBeenCalled();
    expect(h.dependencies.imagePresent).toHaveBeenCalledTimes(2);
  });

  it('fails closed when --skip-pull is used and the image store is empty', async () => {
    const h = harness(config(), { imagePresent: jest.fn(async () => false) });
    await expect(h.backend.start(WORK_DIR, ['github.com'], undefined, true))
      .rejects.toThrow("independent of Docker's");
  });

  it('keeps every capability socket path inside the macOS sun_path budget', async () => {
    // A run work directory on a real runner is long enough that rooting the
    // socket directory there would exceed the 104-byte sun_path cap and make
    // the relay unbindable, so the base is deliberately short and independent
    // of workDir.
    const h = harness();
    await start(h);
    const { baseDirectory } = (h.dependencies.startTransport as jest.Mock).mock.calls[0][0];
    const longestSocket = `${baseDirectory}/awf-apple-${'a'.repeat(16)}/api-proxy-anthropic.sock`;
    expect(Buffer.byteLength(longestSocket)).toBeLessThanOrEqual(103);
    expect(baseDirectory.startsWith(WORK_DIR)).toBe(false);
  });

  it('rolls the transport back when container creation fails', async () => {
    const h = harness();
    h.lifecycle.create.mockRejectedValueOnce(new Error('create exploded'));
    await expect(start(h)).rejects.toThrow('create exploded');
    expect(h.transport.stop).toHaveBeenCalledWith({ preserveDiagnostics: false });
  });

  it('does not create a container when the transport cannot start', async () => {
    const h = harness(config(), {
      startTransport: jest.fn(async () => {
        throw new Error('relay bind failed');
      }),
    });
    await expect(start(h)).rejects.toThrow('relay bind failed');
    expect(h.lifecycle.create).not.toHaveBeenCalled();
  });

  it('refuses a run spec that lost its isolated network', async () => {
    const h = harness();
    h.transport.applyTo.mockImplementationOnce((spec: AppleContainerRunSpec) => ({
      ...spec,
      network: { kind: 'attach' as const, networks: ['bridge'] },
    }));
    await expect(start(h)).rejects.toThrow('--network none');
    expect(h.lifecycle.create).not.toHaveBeenCalled();
  });

  it('refuses a run spec that regained a capability', async () => {
    const h = harness();
    h.transport.applyTo.mockImplementationOnce((spec: AppleContainerRunSpec) => ({
      ...spec,
      network: { kind: 'none' as const },
      capAdd: ['NET_RAW'],
    }));
    await expect(start(h)).rejects.toThrow('added capabilities: NET_RAW');
  });
});

describe('exec', () => {
  it('refuses to run before start completed', async () => {
    const h = harness();
    await expect(h.backend.exec(WORK_DIR, [], undefined, undefined))
      .rejects.toThrow('is not ready');
  });

  it('propagates the guest exit code verbatim', async () => {
    const h = harness();
    await start(h);
    h.lifecycle.startAttached.mockResolvedValueOnce(cliResult({ exitCode: 42 }));
    await expect(h.backend.exec(WORK_DIR, [], undefined, undefined))
      .resolves.toEqual({ exitCode: 42 });
  });

  it('propagates a fatal-signal exit code verbatim', async () => {
    const h = harness();
    await start(h);
    h.lifecycle.startAttached.mockResolvedValueOnce(cliResult({ exitCode: 143, signal: 'SIGTERM' }));
    await expect(h.backend.exec(WORK_DIR, [], undefined, undefined))
      .resolves.toEqual({ exitCode: 143 });
  });

  it('passes the agent timeout through to the attached start', async () => {
    const h = harness();
    await start(h);
    await h.backend.exec(WORK_DIR, [], undefined, 5);
    expect(h.lifecycle.startAttached).toHaveBeenCalledWith('container-abc', {
      interactive: true,
      timeoutMs: 300_000,
    });
  });

  it('kills the VM and reports 124 when the timeout fires', async () => {
    const h = harness();
    await start(h);
    h.lifecycle.startAttached.mockResolvedValueOnce(cliResult({ exitCode: 143, timedOut: true }));
    await expect(h.backend.exec(WORK_DIR, [], undefined, 1))
      .resolves.toEqual({ exitCode: APPLE_CONTAINER_TIMEOUT_EXIT_CODE });
    expect(h.lifecycle.kill).toHaveBeenCalledWith('container-abc');
  });

  it('still reports the timeout exit code when the kill itself fails', async () => {
    const h = harness();
    await start(h);
    h.lifecycle.startAttached.mockResolvedValueOnce(cliResult({ exitCode: 143, timedOut: true }));
    h.lifecycle.kill.mockRejectedValueOnce(new Error('already gone'));
    await expect(h.backend.exec(WORK_DIR, [], undefined, 1))
      .resolves.toEqual({ exitCode: APPLE_CONTAINER_TIMEOUT_EXIT_CODE });
  });
});

describe('stop and preserve', () => {
  it('quiesces the guest before tearing the transport down', async () => {
    const h = harness();
    await start(h);
    await h.backend.stop();
    expect(h.lifecycle.stop).toHaveBeenCalledWith('container-abc', { timeoutSeconds: 10 });
    expect(h.order.indexOf('container-remove')).toBeLessThan(h.order.indexOf('transport-stop'));
  });

  it('is idempotent', async () => {
    const h = harness();
    await start(h);
    await h.backend.stop();
    await h.backend.stop();
    expect(h.lifecycle.remove).toHaveBeenCalledTimes(1);
  });

  it('escalates to a kill when a stop fails', async () => {
    const h = harness();
    await start(h);
    h.lifecycle.stop.mockRejectedValueOnce(new Error('stuck'));
    await h.backend.stop();
    expect(h.lifecycle.kill).toHaveBeenCalledWith('container-abc');
  });

  it('keeps the container but still unlinks every capability socket on preserve', async () => {
    const h = harness();
    await start(h);
    await h.backend.preserve();
    expect(h.lifecycle.remove).not.toHaveBeenCalled();
    expect(h.transport.stop).toHaveBeenCalledWith({ preserveDiagnostics: true });
  });

  it('surfaces a teardown failure rather than swallowing it', async () => {
    const h = harness();
    await start(h);
    h.transport.stop.mockRejectedValueOnce(new Error('socket busy'));
    await expect(h.backend.stop()).rejects.toThrow('transport shutdown: socket busy');
  });
});

describe('collectDiagnostics', () => {
  it('captures Apple boot/stdio/system logs plus transport counters exactly once', async () => {
    const h = harness();
    await start(h);
    await h.backend.collectDiagnostics();
    await h.backend.collectDiagnostics();
    expect(h.dependencies.collectDiagnostics).toHaveBeenCalledTimes(1);
    expect(h.dependencies.collectDiagnostics)
      .toHaveBeenCalledWith(h.lifecycle.cli, { containerId: 'container-abc' });
    expect(h.transport.stats).toHaveBeenCalled();
    const [, written] = (h.dependencies.writeDiagnostics as jest.Mock).mock.calls[0];
    expect(written.captures.map((capture: { name: string }) => capture.name))
      .toEqual(['system.log', 'transport-stats.json']);
  });

  it('never persists the guest environment from container inspect', async () => {
    const h = harness(config(), {
      collectDiagnostics: jest.fn(async () => ({
        captures: [{
          name: 'container-inspect.json',
          argv: ['container', 'inspect', 'container-abc'],
          ok: true,
          content: JSON.stringify({
            configuration: { initProcess: { environment: ['SECRET=sk-real-secret'] } },
          }),
        }],
      })),
    });
    await start(h);
    await h.backend.collectDiagnostics();
    const [, written] = (h.dependencies.writeDiagnostics as jest.Mock).mock.calls[0];
    expect(JSON.stringify(written)).not.toContain('sk-real-secret');
    expect(JSON.stringify(written)).toContain('SECRET');
  });

  it('does nothing when no CLI was ever created', async () => {
    const h = harness();
    await h.backend.collectDiagnostics();
    expect(h.dependencies.collectDiagnostics).not.toHaveBeenCalled();
  });
});

describe('diagnostics redaction', () => {
  const { redactAppleContainerCapture } = appleContainerRuntimeTestHelpers;

  const inspect = (content: string) => redactAppleContainerCapture({
    name: 'container-inspect.json',
    argv: ['container', 'inspect', 'x'],
    ok: true,
    content,
  });

  it('replaces the guest environment with variable names only', () => {
    const result = inspect(JSON.stringify([{
      configuration: {
        initProcess: {
          environment: ['ANTHROPIC_API_KEY=sk-real-secret', 'HOME=/awf/home'],
          executable: '/bin/bash',
        },
      },
    }]));
    expect(result.content).not.toContain('sk-real-secret');
    expect(result.content).toContain('ANTHROPIC_API_KEY');
    expect(result.content).toContain('HOME');
    expect(result.content).toContain('/bin/bash');
  });

  it('redacts an object-shaped environment too', () => {
    const result = inspect(JSON.stringify({ env: { GITHUB_TOKEN: 'ghp_real' } }));
    expect(result.content).not.toContain('ghp_real');
    expect(result.content).toContain('GITHUB_TOKEN');
  });

  it('redacts an environment block at any nesting depth', () => {
    const result = inspect(JSON.stringify({ a: { b: [{ Environment: ['X=secret'] }] } }));
    expect(result.content).not.toContain('secret');
  });

  it('drops an unparseable inspect capture rather than persisting it', () => {
    const result = inspect('not json ANTHROPIC_API_KEY=sk-real-secret');
    expect(result.ok).toBe(false);
    expect(result.content).not.toContain('sk-real-secret');
    expect(result.content).toContain('withheld');
  });

  it('leaves other captures untouched', () => {
    const capture = {
      name: 'container-boot.log',
      argv: ['container', 'logs'],
      ok: true,
      content: 'boot output',
    };
    expect(redactAppleContainerCapture(capture)).toBe(capture);
  });
});

describe('defaultResolveImages', () => {
  const { defaultResolveImages } = appleContainerRuntimeTestHelpers;
  const options = { previewEnabled: true, cpus: 4, memory: '8G' };

  it('refuses a floating agent tag', () => {
    expect(() => defaultResolveImages(
      config({ imageTag: '1.0.0' }) as never,
      options,
    )).toThrow('digest-pinned agent image');
  });

  it('accepts a digest-pinned manifest', () => {
    const resolved = defaultResolveImages(
      config({
        images: { agent: AGENT_IMAGE, appleInit: INIT_IMAGE } as WrapperConfig['images'],
      }) as never,
      options,
    );
    expect(resolved).toEqual({ agent: AGENT_IMAGE, init: INIT_IMAGE });
  });

  it('refuses a floating explicit init image', () => {
    expect(() => defaultResolveImages(
      config({ images: { agent: AGENT_IMAGE } as WrapperConfig['images'] }) as never,
      { ...options, initImage: 'ghcr.io/github/gh-aw-firewall/apple-init:latest' },
    )).toThrow('digest-pinned apple-init image');
  });
});

describe('appleContainerName', () => {
  it('is unique per run so a leftover VM cannot be adopted', () => {
    const { appleContainerName } = appleContainerRuntimeTestHelpers;
    const first = appleContainerName();
    expect(first).toMatch(/^awf-agent-\d+-\d+$/);
  });
});
