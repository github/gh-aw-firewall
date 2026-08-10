import { buildConfig } from '../commands/build-config';
import { mapAwfFileConfigToCliOptions } from '../config-mapper';
import { validateAwfFileConfig } from '../config-file';
import {
  CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS,
  CLOUD_HYPERVISOR_DEFAULT_BINARY,
  CLOUD_HYPERVISOR_DEFAULT_MEMORY_MIB,
  CLOUD_HYPERVISOR_DEFAULT_VCPU_COUNT,
} from '../types/runtime-options';

function buildCloudHypervisorConfig(options: Record<string, unknown>) {
  return buildConfig({
    options: {
      keepContainers: false,
      buildLocal: false,
      skipPull: false,
      imageRegistry: 'registry',
      imageTag: 'latest',
      envAll: false,
      sslBump: false,
      enableDind: false,
      enableDlp: false,
      ...options,
    },
    agentCommand: 'echo test',
    logLevel: 'info',
    allowedDomains: [],
    blockedDomains: [],
    localhostDetected: false,
    additionalEnv: {},
    volumeMounts: undefined,
    upstreamProxy: undefined,
    dnsServers: [],
    dnsOverHttps: undefined,
    allowedUrls: undefined,
    memoryLimit: undefined,
    pidsLimit: undefined,
    agentImage: undefined,
    modelAliases: undefined,
    allowedModels: undefined,
    disallowedModels: undefined,
    maxEffectiveTokens: undefined,
    maxAiCredits: undefined,
    effectiveTokenModelMultipliers: undefined,
    effectiveTokenDefaultModelMultiplier: undefined,
    maxRuns: undefined,
    maxPermissionDenied: undefined,
    maxCacheMisses: undefined,
    resolvedCopilotApiTarget: undefined,
    resolvedCopilotApiBasePath: undefined,
    dockerHostPathPrefix: undefined,
  }).cloudHypervisor;
}

describe('Cloud Hypervisor configuration (foundation only)', () => {
  it('maps the cohesive config-file surface to CLI option semantics', () => {
    const digest = 'a'.repeat(64);
    const mapped = mapAwfFileConfigToCliOptions({
      cloudHypervisor: {
        previewEnabled: true,
        cloudHypervisorBinary: '/opt/cloud-hypervisor',
        kernelPath: '/opt/vmlinux',
        rootfsPath: '/opt/rootfs.ext4',
        supervisorPath: '/opt/awf-supervisor',
        vcpuCount: 4,
        memoryMib: 1024,
        apiTimeoutMs: 8000,
        sha256: { kernel: digest, supervisor: digest },
      },
    });

    expect(mapped).toEqual(expect.objectContaining({
      cloudHypervisorPreview: true,
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      cloudHypervisorKernel: '/opt/vmlinux',
      cloudHypervisorRootfs: '/opt/rootfs.ext4',
      cloudHypervisorSupervisor: '/opt/awf-supervisor',
      cloudHypervisorVcpus: 4,
      cloudHypervisorMemoryMib: 1024,
      cloudHypervisorApiTimeoutMs: 8000,
      cloudHypervisorKernelSha256: digest,
      cloudHypervisorSupervisorSha256: digest,
    }));
  });

  it('applies explicit safe defaults when Cloud Hypervisor is configured', () => {
    expect(buildCloudHypervisorConfig({ cloudHypervisorPreview: true })).toEqual({
      previewEnabled: true,
      cloudHypervisorBinary: CLOUD_HYPERVISOR_DEFAULT_BINARY,
      kernelPath: undefined,
      rootfsPath: undefined,
      supervisorPath: undefined,
      vcpuCount: CLOUD_HYPERVISOR_DEFAULT_VCPU_COUNT,
      memoryMib: CLOUD_HYPERVISOR_DEFAULT_MEMORY_MIB,
      apiTimeoutMs: CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS,
      sha256: undefined,
    });
  });

  it('does not populate Cloud Hypervisor defaults for unrelated runtimes', () => {
    expect(buildCloudHypervisorConfig({
      containerRuntime: 'gvisor',
      cloudHypervisorPreview: false,
    })).toBeUndefined();
  });

  it('validates positive resources, digests, and unknown keys', () => {
    expect(validateAwfFileConfig({
      cloudHypervisor: {
        vcpuCount: 2,
        memoryMib: 512,
        sha256: { rootfs: '0'.repeat(64) },
      },
    })).toEqual([]);
    expect(validateAwfFileConfig({ cloudHypervisor: { vcpuCount: 0 } }))
      .toContain('config.cloudHypervisor.vcpuCount must be a positive integer');
    expect(validateAwfFileConfig({ cloudHypervisor: { sha256: { kernel: 'bad' } } }))
      .toContain('config.cloudHypervisor.sha256.kernel must match pattern "^[A-Fa-f0-9]{64}$"');
    expect(validateAwfFileConfig({ cloudHypervisor: { unsupported: true } }))
      .toContain('config.cloudHypervisor.unsupported is not supported');
  });

  it('rejects "cloud-hypervisor" as a --container-runtime value (not yet an available runtime)', () => {
    expect(validateAwfFileConfig({
      container: { containerRuntime: 'cloud-hypervisor' },
    }).some((error) => error.includes('container.containerRuntime'))).toBe(true);
  });
});
