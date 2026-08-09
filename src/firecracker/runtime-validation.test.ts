import type { WrapperConfig } from '../types';
import {
  assertFirecrackerPreSecurityCompatibility,
  assertFirecrackerRuntimeCompatibility,
  assertFirecrackerSelection,
  requireFirecrackerConfig,
} from './runtime-validation';

const digest = 'a'.repeat(64);

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: 'firecracker',
    networkIsolation: true,
    legacySecurity: false,
    enableApiProxy: true,
    enableDind: false,
    enableHostAccess: false,
    tty: false,
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
    ...overrides,
  } as WrapperConfig;
}

describe('Firecracker runtime validation', () => {
  it('accepts only a complete explicitly selected preview', () => {
    const valid = config();
    expect(() => assertFirecrackerSelection(valid)).not.toThrow();
    expect(() => assertFirecrackerRuntimeCompatibility(valid)).not.toThrow();
    expect(requireFirecrackerConfig(valid)).toBe(valid.firecracker);

    expect(() => assertFirecrackerSelection(config({
      containerRuntime: 'gvisor',
    }))).toThrow(/require --container-runtime firecracker/);
    expect(() => requireFirecrackerConfig(config({
      containerRuntime: 'gvisor',
    }))).toThrow(/resolved without Firecracker runtime configuration/);
  });

  it.each([
    [{ firecracker: { ...config().firecracker!, previewEnabled: false } }, /explicit --firecracker-preview/],
    [{ networkIsolation: false }, /strict --network-isolation/],
    [{ legacySecurity: true }, /strict --network-isolation/],
    [{ enableApiProxy: false }, /API proxy credential isolation/],
    [{
      firecracker: {
        ...config().firecracker!,
        supervisorPath: undefined,
      },
    }, /explicit kernel, rootfs, and guest supervisor/],
    [{
      firecracker: {
        ...config().firecracker!,
        sha256: { ...config().firecracker!.sha256, supervisor: undefined },
      },
    }, /requires SHA-256 digests/],
  ] as const)('rejects incomplete runtime configuration %#', (overrides, error) => {
    expect(() => assertFirecrackerRuntimeCompatibility(
      config(overrides as Partial<WrapperConfig>),
    )).toThrow(error);
  });

  it.each([
    [{ networkIsolation: false }, /cannot disable --network-isolation/],
    [{ enableDind: true }, /Docker-in-Docker/],
    [{ dockerHostPathPrefix: '/host' }, /split filesystems/],
    [{ runnerTopology: 'arc-dind' }, /split filesystems/],
    [{ enableHostAccess: true }, /host access/],
    [{ allowHostPorts: ['8080'] }, /host access/],
    [{ allowHostServicePorts: ['5432'] }, /host access/],
    [{ volumeMounts: ['/tmp:/tmp'] }, /additional host volume mounts/],
    [{ topologyAttach: ['gateway'] }, /MCP gateway path/],
    [{ difcProxyHost: 'proxy:443' }, /MCP gateway path/],
    [{ enclaves: { enabled: true } }, /MCP gateway path/],
    [{ dnsOverHttps: 'https://dns.example/dns-query' }, /DNS-over-HTTPS/],
    [{ tty: true }, /does not support --tty/],
    [{ awfDockerHost: 'tcp://localhost:2375' }, /local Unix-socket Docker daemon/],
  ] as const)('rejects unsupported preview policy %#', (overrides, error) => {
    expect(() => assertFirecrackerPreSecurityCompatibility(
      config(overrides as Partial<WrapperConfig>),
    )).toThrow(error);
  });

  it('accepts a local Unix Docker socket', () => {
    expect(() => assertFirecrackerPreSecurityCompatibility(config({
      awfDockerHost: 'unix:///var/run/docker.sock',
    }))).not.toThrow();
  });
});
