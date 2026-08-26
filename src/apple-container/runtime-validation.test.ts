import {
  APPLE_CONTAINER_MAX_TIMEOUT_MS,
  APPLE_CONTAINER_RUNTIME,
  assertAppleContainerPreSecurityCompatibility,
  assertAppleContainerRuntimeCompatibility,
  assertAppleContainerSelection,
  requireAppleContainerConfig,
} from './runtime-validation';
import type { AppleContainerOptions, WrapperConfig } from '../types';

import { getLocalDockerEnv } from '../docker-host';

jest.mock('../docker-host', () => ({
  getLocalDockerEnv: jest.fn(() => ({})),
}));

const mockedGetLocalDockerEnv = getLocalDockerEnv as jest.MockedFunction<
  typeof getLocalDockerEnv
>;

const appleContainer: AppleContainerOptions = {
  previewEnabled: true,
  cpus: 4,
  memory: '8G',
};

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: ['github.com'],
    agentCommand: 'true',
    logLevel: 'info',
    workDir: '/tmp/awf-test',
    containerRuntime: APPLE_CONTAINER_RUNTIME,
    networkIsolation: true,
    enableApiProxy: true,
    appleContainer,
    ...overrides,
  } as unknown as WrapperConfig;
}

beforeEach(() => {
  mockedGetLocalDockerEnv.mockReturnValue({});
});

describe('assertAppleContainerSelection', () => {
  it('rejects Apple Container options on another runtime', () => {
    expect(() => assertAppleContainerSelection(config({ containerRuntime: 'gvisor' })))
      .toThrow('require --container-runtime apple-container');
  });

  it('accepts a config with no Apple Container options at all', () => {
    expect(() => assertAppleContainerSelection(
      config({ containerRuntime: 'gvisor', appleContainer: undefined }),
    )).not.toThrow();
  });

  it('accepts Apple Container options on the Apple Container runtime', () => {
    expect(() => assertAppleContainerSelection(config())).not.toThrow();
  });
});

describe('assertAppleContainerPreSecurityCompatibility', () => {
  it('accepts the supported baseline', () => {
    expect(() => assertAppleContainerPreSecurityCompatibility(config())).not.toThrow();
  });

  it.each([
    ['networkIsolation disabled', { networkIsolation: false }, 'cannot disable --network-isolation'],
    ['legacy security', { legacySecurity: true }, 'does not support --legacy-security'],
    ['Docker-in-Docker', { enableDind: true }, 'Docker-in-Docker'],
    ['split filesystem prefix', { dockerHostPathPrefix: '/host' }, 'split runner/daemon'],
    ['ARC DinD topology', { runnerTopology: 'arc-dind' }, 'Docker-in-Docker'],
    ['host access', { enableHostAccess: true }, 'does not support host access'],
    ['host ports', { allowHostPorts: '8080' }, 'does not support host access'],
    ['host service ports', { allowHostServicePorts: '9000' }, 'does not support host access'],
    ['DNS-over-HTTPS', { dnsOverHttps: true }, 'DNS-over-HTTPS'],
    ['topology peers', { topologyAttach: ['awmg-mcpg'] }, '--topology-attach'],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => assertAppleContainerPreSecurityCompatibility(
      config(overrides as Partial<WrapperConfig>),
    )).toThrow(message);
  });

  it('rejects enclaves until the MCP gateway is proven reachable from a NIC-less guest', () => {
    expect(() => assertAppleContainerPreSecurityCompatibility(
      config({ enclaves: { enabled: true } as WrapperConfig['enclaves'] }),
    )).toThrow('does not yet support enclaves');
  });

  it('rejects a non-Unix Docker host', () => {
    expect(() => assertAppleContainerPreSecurityCompatibility(
      config({ awfDockerHost: 'tcp://127.0.0.1:2375' }),
    )).toThrow('local Unix-socket Docker daemon');
  });

  it('rejects a non-Unix DOCKER_HOST inherited from the environment', () => {
    mockedGetLocalDockerEnv.mockReturnValue({ DOCKER_HOST: 'tcp://localhost:2375' });
    expect(() => assertAppleContainerPreSecurityCompatibility(config()))
      .toThrow('local Unix-socket Docker daemon');
  });

  it('accepts a Unix-socket Docker host', () => {
    expect(() => assertAppleContainerPreSecurityCompatibility(
      config({ awfDockerHost: 'unix:///var/run/docker.sock' }),
    )).not.toThrow();
  });
});

describe('assertAppleContainerRuntimeCompatibility', () => {
  it('accepts the supported baseline', () => {
    expect(() => assertAppleContainerRuntimeCompatibility(config())).not.toThrow();
  });

  it('requires the explicit preview opt-in', () => {
    expect(() => assertAppleContainerRuntimeCompatibility(config({
      appleContainer: { ...appleContainer, previewEnabled: false },
    }))).toThrow('--apple-container-preview');
  });

  it('requires strict network isolation', () => {
    expect(() => assertAppleContainerRuntimeCompatibility(config({ networkIsolation: undefined })))
      .toThrow('requires strict --network-isolation');
  });

  it.each([
    ['the act agent image preset', { agentImage: 'act' }, 'only the default agent image'],
    ['a custom agent base image', { agentImage: 'ubuntu:24.04' }, 'only the default agent image'],
    ['--build-local', { buildLocal: true }, '--build-local'],
    ['filesystem.allowWrite', { filesystemAllowWrite: ['/opt'] }, 'filesystem.allowWrite'],
    ['extra volume mounts', { volumeMounts: ['/a:/a'] }, 'does not support --volume'],
    ['tty', { tty: true }, 'does not support --tty'],
    ['ssl bump', { sslBump: true }, '--ssl-bump'],
    ['a sysroot image', { sysrootImage: 'ghcr.io/x/y:1' }, 'chroot sysroot'],
    ['chroot binaries', { chrootBinariesSourcePath: '/opt/bin' }, 'chroot sysroot'],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => assertAppleContainerRuntimeCompatibility(
      config(overrides as Partial<WrapperConfig>),
    )).toThrow(message);
  });

  it('rejects Vertex because its provider port is outside the capability allowlist', () => {
    expect(() => assertAppleContainerRuntimeCompatibility(config({ googleApiKey: 'k' })))
      .toThrow('Vertex');
  });

  it('rejects an agent timeout beyond the supported bound', () => {
    const overLimit = APPLE_CONTAINER_MAX_TIMEOUT_MS / 60_000 + 1;
    expect(() => assertAppleContainerRuntimeCompatibility(config({ agentTimeout: overLimit })))
      .toThrow('--agent-timeout values up to');
  });

  it('accepts an agent timeout at the supported bound', () => {
    const atLimit = APPLE_CONTAINER_MAX_TIMEOUT_MS / 60_000;
    expect(() => assertAppleContainerRuntimeCompatibility(config({ agentTimeout: atLimit })))
      .not.toThrow();
  });

  it('still applies the pre-security guards', () => {
    expect(() => assertAppleContainerRuntimeCompatibility(config({ enableDind: true })))
      .toThrow('Docker-in-Docker');
  });
});

describe('requireAppleContainerConfig', () => {
  it('returns the runtime options when the runtime is selected', () => {
    expect(requireAppleContainerConfig(config())).toBe(appleContainer);
  });

  it('throws when the backend is reached without Apple Container configuration', () => {
    expect(() => requireAppleContainerConfig(config({ appleContainer: undefined })))
      .toThrow('resolved without Apple Container runtime configuration');
    expect(() => requireAppleContainerConfig(config({ containerRuntime: 'sbx' })))
      .toThrow('resolved without Apple Container runtime configuration');
  });
});
