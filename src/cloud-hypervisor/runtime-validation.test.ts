import type { WrapperConfig } from '../types';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import * as hostEligibility from './host-eligibility';
import {
  assertCloudHypervisorPreSecurityCompatibility,
  assertCloudHypervisorRuntimeCompatibility,
  assertCloudHypervisorSelection,
  isPrimaryCloudHypervisorRuntime,
  requiresCloudHypervisorInfrastructure,
  requireCloudHypervisorConfig,
  usesCloudHypervisorEnclaveRuntime,
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
    }))).toThrow(/require either --container-runtime cloud-hypervisor/);
    expect(() => requireCloudHypervisorConfig(config({
      containerRuntime: 'gvisor',
    }))).toThrow(/resolved without Cloud Hypervisor runtime configuration/);
  });

  it('supports a Cloud Hypervisor script executor alongside a Docker agent executor', () => {
    const chScriptWithDockerAgent = config({
      containerRuntime: 'docker',
      enableApiProxy: false,
      tty: true,
      volumeMounts: ['/tmp:/tmp'],
      enclaves: normalizeEnclavesConfig([{
        script: {},
        runtime: 'cloud-hypervisor',
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      }, {
        agent: { model: 'gpt-5.3-codex' },
        runtime: 'docker',
      }]),
    });

    expect(isPrimaryCloudHypervisorRuntime(chScriptWithDockerAgent)).toBe(false);
    expect(usesCloudHypervisorEnclaveRuntime(chScriptWithDockerAgent)).toBe(true);
    expect(requiresCloudHypervisorInfrastructure(chScriptWithDockerAgent)).toBe(true);
    expect(() => assertCloudHypervisorSelection(chScriptWithDockerAgent)).not.toThrow();
    expect(() => assertCloudHypervisorPreSecurityCompatibility(chScriptWithDockerAgent)).not.toThrow();
    expect(() => assertCloudHypervisorRuntimeCompatibility(chScriptWithDockerAgent)).not.toThrow();
    expect(requireCloudHypervisorConfig(chScriptWithDockerAgent))
      .toBe(chScriptWithDockerAgent.cloudHypervisor);
  });

  it('requires API-proxy isolation for a Cloud Hypervisor agent executor alongside Docker scripts', () => {
    const chAgentWithDockerScript = config({
      containerRuntime: 'docker',
      enableApiProxy: false,
      enclaves: normalizeEnclavesConfig([{
        script: {},
        runtime: 'docker',
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      }, {
        agent: { model: 'gpt-5.3-codex' },
        runtime: 'cloud-hypervisor',
      }]),
    });

    expect(isPrimaryCloudHypervisorRuntime(chAgentWithDockerScript)).toBe(false);
    expect(usesCloudHypervisorEnclaveRuntime(chAgentWithDockerScript)).toBe(true);
    expect(requiresCloudHypervisorInfrastructure(chAgentWithDockerScript)).toBe(true);
    expect(() => assertCloudHypervisorSelection(chAgentWithDockerScript)).not.toThrow();
    expect(() => assertCloudHypervisorPreSecurityCompatibility(chAgentWithDockerScript)).not.toThrow();
    expect(() => assertCloudHypervisorRuntimeCompatibility(chAgentWithDockerScript))
      .toThrow(/API proxy credential isolation/);
    expect(() => assertCloudHypervisorRuntimeCompatibility({
      ...chAgentWithDockerScript,
      enableApiProxy: true,
    })).not.toThrow();
  });

  it('requires top-level configuration for an enclave-only selection', () => {
    const enclaveOnly = config({
      containerRuntime: 'docker',
      cloudHypervisor: undefined,
      enclaves: normalizeEnclavesConfig([{
        script: {},
        runtime: 'cloud-hypervisor',
        repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
      }]),
    });

    expect(() => assertCloudHypervisorSelection(enclaveOnly))
      .toThrow(/requires top-level cloudHypervisor runtime configuration/);
  });

  it('rejects an ineligible host even with otherwise-complete configuration', () => {
    eligibilitySpy.mockImplementation(() => {
      throw new Error('Cloud Hypervisor is supported only inside GitHub Actions runs');
    });
    expect(() => assertCloudHypervisorRuntimeCompatibility(config()))
      .toThrow(/supported only inside GitHub Actions runs/);
  });

  it('validates artifact configuration before runner eligibility', () => {
    eligibilitySpy.mockImplementation(() => {
      throw new Error('Cloud Hypervisor is supported only inside GitHub Actions runs');
    });
    expect(() => assertCloudHypervisorRuntimeCompatibility(config({
      cloudHypervisor: {
        ...config().cloudHypervisor!,
        artifactManifestPath: undefined,
      },
    }))).toThrow(/requires an artifact manifest/);
    expect(() => assertCloudHypervisorRuntimeCompatibility(config({
      cloudHypervisor: {
        ...config().cloudHypervisor!,
        sha256: { cloudHypervisor: digest },
      },
    }))).toThrow(/Caller-supplied Cloud Hypervisor SHA-256 values/);
    expect(eligibilitySpy).not.toHaveBeenCalled();
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
    [{ difcProxyHost: 'proxy:443' }, /DIFC proxies/],
    [{ enclaves: { enabled: true } }, /runtime-neutral enclave lifecycle integration/],
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
      /require either --container-runtime cloud-hypervisor or an enclaves\[\]\.runtime/,
    );
  });

  it('rejects cloudHypervisor options with no --container-runtime selected at all', () => {
    const invalid = config({ containerRuntime: undefined });
    expect(() => assertCloudHypervisorSelection(invalid)).toThrow(
      /require either --container-runtime cloud-hypervisor or an enclaves\[\]\.runtime/,
    );
  });
});
