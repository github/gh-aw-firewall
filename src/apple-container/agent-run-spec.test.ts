import * as path from 'path';

import {
  APPLE_CONTAINER_ENTRYPOINT,
  APPLE_CONTAINER_GUEST_HOME,
  APPLE_CONTAINER_GUEST_TMP,
  appleContainerRunDirectories,
  buildAppleContainerAgentSpec,
  buildAppleContainerGuestEnvironment,
  buildAppleContainerMounts,
} from './agent-run-spec';
import { apiProxyPorts, SQUID_PORT } from '../config/network-policy';
import { buildAppleContainerRunArgs } from './run-args';
import {
  applyAppleContainerTransportToRunSpec,
  planAppleContainerTransport,
} from './transport-plan';
import type { AppleContainerSocketDirectoryHandle } from './transport-socket-dir';
import { planAppleContainerInfrastructure } from './infrastructure-endpoints';
import type { WrapperConfig } from '../types';

const WORK_DIR = '/tmp/awf-apple-test';
const WORKSPACE = '/Users/runner/work/repo/repo';
const IMAGE = 'ghcr.io/github/gh-aw-firewall/agent:1.0.0@sha256:' + 'a'.repeat(64);
const INIT_IMAGE = 'ghcr.io/github/gh-aw-firewall/apple-init:1.0.0@sha256:' + 'b'.repeat(64);

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: ['github.com'],
    agentCommand: 'npx @github/copilot --prompt "hi"',
    logLevel: 'info',
    workDir: WORK_DIR,
    containerRuntime: 'apple-container',
    networkIsolation: true,
    appleContainer: { previewEnabled: true, cpus: 4, memory: '8G' },
    ...overrides,
  } as unknown as WrapperConfig;
}

const directories = appleContainerRunDirectories(WORK_DIR);

describe('appleContainerRunDirectories', () => {
  it('keeps every writable host directory inside the run work directory', () => {
    expect(directories.root).toBe(path.join(WORK_DIR, 'apple-container'));
    expect(directories.home).toBe(path.join(directories.root, 'home'));
    expect(directories.tmp).toBe(path.join(directories.root, 'tmp'));
    expect(directories.homeCopilotLogs).toBe(path.join(directories.home, '.copilot', 'logs'));
    expect(directories.homeCopilotSessionState)
      .toBe(path.join(directories.home, '.copilot', 'session-state'));
  });
});

describe('buildAppleContainerMounts', () => {
  it('exposes only the workspace and AWF-owned run directories', () => {
    const mounts = buildAppleContainerMounts({
      config: config(),
      directories,
      workspaceDir: WORKSPACE,
    });
    expect(mounts.map((mount) => mount.target)).toEqual([
      APPLE_CONTAINER_GUEST_TMP,
      APPLE_CONTAINER_GUEST_HOME,
      WORKSPACE,
      `${APPLE_CONTAINER_GUEST_HOME}/.copilot/logs`,
      `${APPLE_CONTAINER_GUEST_HOME}/.copilot/session-state`,
    ]);
  });

  it('never mounts host credential stores, the home directory, or a Docker socket', () => {
    const mounts = buildAppleContainerMounts({
      config: config(),
      directories,
      workspaceDir: WORKSPACE,
      ghAwStateDir: '/Users/runner/work/_temp/gh-aw',
    });
    const sources = mounts.map((mount) => mount.source);
    for (const forbidden of [
      '/',
      '/etc',
      '/usr',
      '/var/run/docker.sock',
      '/Users/runner/.ssh',
      '/Users/runner/.aws',
      '/Users/runner/.docker',
      '/Users/runner',
    ]) {
      expect(sources).not.toContain(forbidden);
    }
  });

  it('mounts the gh-aw state directory at its own host path', () => {
    const ghAwStateDir = '/Users/runner/work/_temp/gh-aw';
    const mounts = buildAppleContainerMounts({
      config: config(),
      directories,
      workspaceDir: WORKSPACE,
      ghAwStateDir,
    });
    expect(mounts).toContainEqual({ source: ghAwStateDir, target: ghAwStateDir, readOnly: false });
  });

  it('does not double-mount a gh-aw directory nested inside the workspace', () => {
    const nested = path.join(WORKSPACE, 'gh-aw');
    const mounts = buildAppleContainerMounts({
      config: config(),
      directories,
      workspaceDir: WORKSPACE,
      ghAwStateDir: nested,
    });
    expect(mounts.filter((mount) => mount.target === nested)).toHaveLength(0);
  });
});

describe('buildAppleContainerGuestEnvironment', () => {
  it('points every endpoint at guest loopback', () => {
    const environment = buildAppleContainerGuestEnvironment({
      config: config({ enableApiProxy: true, anthropicApiKey: 'sk-secret-value' }),
      workspaceDir: WORKSPACE,
    });
    expect(environment.HTTPS_PROXY).toBe(`http://127.0.0.1:${SQUID_PORT}`);
    expect(environment.SQUID_PROXY_HOST).toBe('127.0.0.1');
    expect(environment.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${apiProxyPorts().anthropic}`);
  });

  it('never carries a real provider credential into the guest', () => {
    expect(() => buildAppleContainerGuestEnvironment({
      config: config({
        enableApiProxy: true,
        additionalEnv: { LEAKED: 'sk-secret-value' },
        anthropicApiKey: 'sk-secret-value',
      }),
      workspaceDir: WORKSPACE,
    })).toThrow('Refusing to pass a real provider credential');
  });

  it('sets HOME and the XDG paths to the writable run-scoped mount', () => {
    const environment = buildAppleContainerGuestEnvironment({
      config: config(),
      workspaceDir: WORKSPACE,
    });
    expect(environment.HOME).toBe(APPLE_CONTAINER_GUEST_HOME);
    expect(environment.XDG_CACHE_HOME).toBe(`${APPLE_CONTAINER_GUEST_HOME}/.cache`);
    expect(environment.TMPDIR).toBe(APPLE_CONTAINER_GUEST_TMP);
  });

  it('leaves NO_PROXY to the transport plan instead of asserting a Docker-shaped one', () => {
    const environment = buildAppleContainerGuestEnvironment({
      config: config({ enableApiProxy: true }),
      workspaceDir: WORKSPACE,
    });
    expect(environment.NO_PROXY).toBeUndefined();
    expect(environment.no_proxy).toBeUndefined();
    expect(environment.AWF_INIT_SIGNAL_DIR).toBeUndefined();
  });

  it('fails closed on a value that cannot survive a single argv token', () => {
    expect(() => buildAppleContainerGuestEnvironment({
      config: config({ additionalEnv: { MULTILINE: 'one\ntwo' } }),
      workspaceDir: WORKSPACE,
    })).toThrow('MULTILINE');
  });
});

describe('buildAppleContainerAgentSpec', () => {
  const spec = () => buildAppleContainerAgentSpec({
    config: config({ enableApiProxy: true }),
    directories,
    workspaceDir: WORKSPACE,
    image: IMAGE,
    name: 'awf-agent-1-2',
    cpus: 4,
    memory: '8G',
    identity: { uid: '501', gid: '20' },
  });

  it('runs as the host identity so workspace writes are owned by the runner user', () => {
    expect(spec().user).toBe('501:20');
  });

  it('bypasses the Docker-specific agent entrypoint', () => {
    const built = spec();
    expect(built.entrypoint).toBe(APPLE_CONTAINER_ENTRYPOINT);
    expect(built.args).toEqual(['-lc', 'npx @github/copilot --prompt "hi"']);
  });

  it('mounts the guest root filesystem read-only and requests no TTY', () => {
    expect(spec().readOnlyRootfs).toBe(true);
    expect(spec().tty).toBe(false);
  });

  it('adds no capability and no network of its own', () => {
    expect(spec().capAdd).toBeUndefined();
    expect(spec().network).toBeUndefined();
  });

  it('honours an explicit container working directory', () => {
    const built = buildAppleContainerAgentSpec({
      config: config({ containerWorkDir: '/workspace/sub' }),
      directories,
      workspaceDir: WORKSPACE,
      image: IMAGE,
      name: 'awf-agent-1-2',
      cpus: 2,
      memory: '4G',
      identity: { uid: '501', gid: '20' },
    });
    expect(built.workdir).toBe('/workspace/sub');
  });
});

describe('integration with the layer-2 transport plan', () => {
  const directoryHandle: AppleContainerSocketDirectoryHandle = {
    path: '/tmp/awf-apple/t',
    runId: 'abcdef01',
  };

  function merged(overrides: Partial<WrapperConfig> = {}) {
    const wrapper = config({ enableApiProxy: true, ...overrides });
    const plan = planAppleContainerTransport({
      directory: directoryHandle,
      capabilities: planAppleContainerInfrastructure(wrapper).capabilities,
      initImage: INIT_IMAGE,
    });
    return applyAppleContainerTransportToRunSpec(
      buildAppleContainerAgentSpec({
        config: wrapper,
        directories,
        workspaceDir: WORKSPACE,
        image: IMAGE,
        name: 'awf-agent-1-2',
        cpus: 4,
        memory: '8G',
        identity: { uid: '501', gid: '20' },
      }),
      plan,
    );
  }

  it('produces a spec the transport accepts without an endpoint conflict', () => {
    expect(() => merged()).not.toThrow();
  });

  it('always emits --network none in the final argv', () => {
    const argv = buildAppleContainerRunArgs(merged(), 'create');
    const index = argv.indexOf('--network');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(argv[index + 1]).toBe('none');
  });

  it('emits native arm64 and never requests a translated architecture', () => {
    const argv = buildAppleContainerRunArgs(merged(), 'create');
    expect(argv[argv.indexOf('--arch') + 1]).toBe('arm64');
  });

  it('drops NET_RAW and the other escape-primitive capabilities', () => {
    const spec = merged();
    expect(spec.capDrop).toEqual(
      expect.arrayContaining(['NET_ADMIN', 'NET_RAW', 'SYS_ADMIN', 'SYS_MODULE', 'SYS_RAWIO']),
    );
    expect(spec.capAdd ?? []).toEqual([]);
  });

  it('publishes only allowlisted capability sockets', () => {
    const spec = merged();
    for (const mount of spec.socketMounts ?? []) {
      expect(mount.containerPath.startsWith('/run/awf/transport/v1/')).toBe(true);
      expect(mount.hostPath.startsWith(directoryHandle.path)).toBe(true);
    }
    expect(
      (spec.socketMounts ?? []).some((mount) => mount.hostPath.includes('docker.sock')),
    ).toBe(false);
  });

  it('pins the init image supplied by the plan', () => {
    expect(merged().initImage).toBe(INIT_IMAGE);
  });
});
