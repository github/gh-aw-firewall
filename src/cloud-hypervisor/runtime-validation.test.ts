import { assertCloudHypervisorNotYetAvailable, assertCloudHypervisorSelection, requireCloudHypervisorConfig } from './runtime-validation';
import type { WrapperConfig } from '../types';

function baseConfig(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    allowedDomains: [],
    agentCommand: 'echo test',
    logLevel: 'info',
    keepContainers: false,
    workDir: '/tmp/awf-test',
    buildLocal: false,
    skipPull: false,
    imageRegistry: 'registry',
    imageTag: 'latest',
    envAll: false,
    dnsServers: [],
    enableHostAccess: false,
    sslBump: false,
    enableDind: false,
    enableDlp: false,
    legacySecurity: undefined,
    ...overrides,
  } as WrapperConfig;
}

describe('Cloud Hypervisor runtime-selection guard (foundation only)', () => {
  it('rejects --container-runtime cloud-hypervisor with an explicit not-yet-available error', () => {
    expect(() => assertCloudHypervisorNotYetAvailable(
      baseConfig({ containerRuntime: 'cloud-hypervisor' }),
    )).toThrow(/not yet an available --container-runtime/);
  });

  it('allows any other runtime, including undefined', () => {
    expect(() => assertCloudHypervisorNotYetAvailable(baseConfig())).not.toThrow();
    expect(() => assertCloudHypervisorNotYetAvailable(
      baseConfig({ containerRuntime: 'gvisor' }),
    )).not.toThrow();
  });

  it('requires --container-runtime cloud-hypervisor when cloudHypervisor options are set', () => {
    const config = baseConfig({
      containerRuntime: 'gvisor',
      cloudHypervisor: {
        previewEnabled: true,
        cloudHypervisorBinary: '/opt/cloud-hypervisor',
        vcpuCount: 2,
        memoryMib: 512,
        apiTimeoutMs: 5000,
      },
    });
    expect(() => assertCloudHypervisorSelection(config)).toThrow(
      /Cloud Hypervisor options require --container-runtime cloud-hypervisor/,
    );
  });

  it('accepts cloudHypervisor options when no other runtime is specified', () => {
    const config = baseConfig({
      cloudHypervisor: {
        previewEnabled: true,
        cloudHypervisorBinary: '/opt/cloud-hypervisor',
        vcpuCount: 2,
        memoryMib: 512,
        apiTimeoutMs: 5000,
      },
    });
    expect(() => assertCloudHypervisorSelection(config)).not.toThrow();
  });

  it('returns the Cloud Hypervisor config when present', () => {
    const cloudHypervisor = {
      previewEnabled: true,
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      vcpuCount: 2,
      memoryMib: 512,
      apiTimeoutMs: 5000,
    };
    expect(requireCloudHypervisorConfig(baseConfig({ cloudHypervisor }))).toBe(cloudHypervisor);
  });

  it('throws when Cloud Hypervisor config is missing', () => {
    expect(() => requireCloudHypervisorConfig(baseConfig())).toThrow(
      /resolved without Cloud Hypervisor runtime configuration/,
    );
  });
});
