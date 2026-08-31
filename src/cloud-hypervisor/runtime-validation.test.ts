import type { WrapperConfig } from '../types';
import * as hostEligibility from './host-eligibility';
import {
  assertCloudHypervisorPreSecurityCompatibility,
  assertCloudHypervisorRuntimeCompatibility,
  assertCloudHypervisorSelection,
  requireCloudHypervisorConfig,
} from './runtime-validation';

const digest = 'a'.repeat(64);

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: 'cloud-hypervisor',
    networkIsolation: true,
    legacySecurity: false,
    enableApiProxy: true,
    enableDind: false,
    enableHostAccess: false,
    tty: false,
    cloudHypervisor: {
      previewEnabled: true,
      mountPolicy: 'workspace-only',
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      kernelPath: '/opt/kernel',
      rootfsPath: '/opt/rootfs',
      supervisorPath: '/opt/supervisor',
      artifactManifestPath: '/opt/manifest.json',
      artifactManifestBundlePath: '/opt/manifest.sigstore.jsonl',
      artifactReleaseTag: 'v0.23.1',
      vcpuCount: 2,
      memoryMib: 512,
      apiTimeoutMs: 5000,
    },
    ...overrides,
  } as WrapperConfig;
}

describe('Cloud Hypervisor runtime validation', () => {
  let eligibilitySpy: jest.SpyInstance;

  beforeEach(() => {
    eligibilitySpy = jest.spyOn(hostEligibility, 'assertGithubHostedRunnerEligibility')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    eligibilitySpy.mockRestore();
  });

  it('accepts only a complete explicitly selected preview on an eligible host', () => {
    const valid = config();
    expect(() => assertCloudHypervisorSelection(valid)).not.toThrow();
    expect(() => assertCloudHypervisorRuntimeCompatibility(valid)).not.toThrow();
    expect(eligibilitySpy).toHaveBeenCalled();
    expect(requireCloudHypervisorConfig(valid)).toBe(valid.cloudHypervisor);

    expect(() => assertCloudHypervisorSelection(config({
      containerRuntime: 'gvisor',
    }))).toThrow(/require --container-runtime cloud-hypervisor/);
    expect(() => requireCloudHypervisorConfig(config({
      containerRuntime: 'gvisor',
    }))).toThrow(/resolved without Cloud Hypervisor runtime configuration/);
  });

  it('rejects an ineligible host even with otherwise-complete configuration', () => {
    eligibilitySpy.mockImplementation(() => {
      throw new Error('Cloud Hypervisor is supported only inside GitHub Actions runs');
    });
    expect(() => assertCloudHypervisorRuntimeCompatibility(config()))
      .toThrow(/supported only inside GitHub Actions runs/);
  });

  it.each([
    [{ cloudHypervisor: { ...config().cloudHypervisor!, previewEnabled: false } }, /explicit --cloud-hypervisor-preview/],
    [{ networkIsolation: false }, /strict --network-isolation/],
    [{ legacySecurity: true }, /strict --network-isolation/],
    [{ enableApiProxy: false }, /API proxy credential isolation/],
    [{
      cloudHypervisor: {
        ...config().cloudHypervisor!,
        supervisorPath: undefined,
      },
    }, /explicit kernel, rootfs, and guest supervisor/],
    [{
      cloudHypervisor: {
        ...config().cloudHypervisor!,
        artifactManifestBundlePath: undefined,
      },
    }, /requires an artifact manifest/],
    [{
      cloudHypervisor: {
        ...config().cloudHypervisor!,
        artifactReleaseTag: undefined,
      },
    }, /requires an artifact manifest/],
  ] as const)('rejects incomplete runtime configuration %#', (overrides, error) => {
    expect(() => assertCloudHypervisorRuntimeCompatibility(
      config(overrides as Partial<WrapperConfig>),
    )).toThrow(error);
  });

  it('allows legacy hashes only with both explicit development opt-ins', () => {
    const legacy = config({
      cloudHypervisor: {
        ...config().cloudHypervisor!,
        artifactManifestPath: undefined,
        artifactManifestBundlePath: undefined,
        artifactReleaseTag: undefined,
        developmentAllowUnattestedArtifacts: true,
        sha256: {
          cloudHypervisor: digest,
          virtiofsd: digest,
          kernel: digest,
          rootfs: digest,
          supervisor: digest,
        },
      },
    });
    expect(() => assertCloudHypervisorRuntimeCompatibility(legacy))
      .toThrow(/AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS=1/);
    process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS = '1';
    expect(() => assertCloudHypervisorRuntimeCompatibility(legacy)).not.toThrow();
    delete process.env.AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS;
  });

  it('fails closed on a mistyped mount policy', () => {
    expect(() => assertCloudHypervisorRuntimeCompatibility(config({
      cloudHypervisor: {
        ...config().cloudHypervisor!,
        mountPolicy: 'automatic' as 'workspace-only',
      },
    }))).toThrow(
      'Cloud Hypervisor mount policy must be "workspace-only" or "workspace-and-tool-cache"',
    );
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
    [{ difcProxyHost: 'proxy:443' }, /DIFC proxies or enclaves/],
    [{ enclaves: { enabled: true } }, /DIFC proxies or enclaves/],
    [{ dnsOverHttps: 'https://dns.example/dns-query' }, /DNS-over-HTTPS/],
    [{ tty: true }, /does not support --tty/],
    [{ awfDockerHost: 'tcp://localhost:2375' }, /local Unix-socket Docker daemon/],
  ] as const)('rejects unsupported preview policy %#', (overrides, error) => {
    expect(() => assertCloudHypervisorPreSecurityCompatibility(
      config(overrides as Partial<WrapperConfig>),
    )).toThrow(error);
  });

  it('accepts a local Unix Docker socket', () => {
    expect(() => assertCloudHypervisorPreSecurityCompatibility(config({
      awfDockerHost: 'unix:///var/run/docker.sock',
    }))).not.toThrow();
  });

  it('rejects Cloud Hypervisor options paired with another --container-runtime', () => {
    const invalid = config({ containerRuntime: 'gvisor' });
    expect(() => assertCloudHypervisorSelection(invalid)).toThrow(
      /Cloud Hypervisor options require --container-runtime cloud-hypervisor/,
    );
  });

  it('rejects cloudHypervisor options with no --container-runtime selected at all', () => {
    const invalid = config({ containerRuntime: undefined });
    expect(() => assertCloudHypervisorSelection(invalid)).toThrow(
      /Cloud Hypervisor options require --container-runtime cloud-hypervisor/,
    );
  });
});
