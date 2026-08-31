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
        mountPolicy: 'workspace-and-tool-cache',
        cloudHypervisorBinary: '/opt/cloud-hypervisor',
        kernelPath: '/opt/vmlinux',
        rootfsPath: '/opt/rootfs.ext4',
        supervisorPath: '/opt/awf-supervisor',
        artifactManifestPath: '/opt/manifest.json',
        artifactManifestBundlePath: '/opt/manifest.sigstore.jsonl',
        artifactReleaseTag: 'v0.23.1',
        vcpuCount: 4,
        memoryMib: 1024,
        apiTimeoutMs: 8000,
        sha256: { virtiofsd: digest, kernel: digest, supervisor: digest },
      },
    });

    expect(mapped).toEqual(expect.objectContaining({
      cloudHypervisorPreview: true,
      cloudHypervisorMountPolicy: 'workspace-and-tool-cache',
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      cloudHypervisorKernel: '/opt/vmlinux',
      cloudHypervisorRootfs: '/opt/rootfs.ext4',
      cloudHypervisorSupervisor: '/opt/awf-supervisor',
      cloudHypervisorArtifactManifest: '/opt/manifest.json',
      cloudHypervisorArtifactManifestBundle: '/opt/manifest.sigstore.jsonl',
      cloudHypervisorArtifactReleaseTag: 'v0.23.1',
      cloudHypervisorVcpus: 4,
      cloudHypervisorMemoryMib: 1024,
      cloudHypervisorApiTimeoutMs: 8000,
      cloudHypervisorVirtiofsdSha256: digest,
      cloudHypervisorKernelSha256: digest,
      cloudHypervisorSupervisorSha256: digest,
    }));
  });

  it('applies explicit safe defaults when Cloud Hypervisor is configured', () => {
    expect(buildCloudHypervisorConfig({ cloudHypervisorPreview: true })).toEqual({
      previewEnabled: true,
      mountPolicy: 'workspace-only',
      cloudHypervisorBinary: CLOUD_HYPERVISOR_DEFAULT_BINARY,
      kernelPath: undefined,
      rootfsPath: undefined,
      supervisorPath: undefined,
      artifactManifestPath: undefined,
      artifactManifestBundlePath: undefined,
      artifactReleaseTag: undefined,
      developmentAllowUnattestedArtifacts: false,
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

  it('treats an explicitly configured secure mount policy as Cloud Hypervisor configuration', () => {
    expect(buildCloudHypervisorConfig({
      cloudHypervisorMountPolicy: 'workspace-only',
    })).toEqual(expect.objectContaining({
      mountPolicy: 'workspace-only',
    }));
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
    expect(validateAwfFileConfig({ cloudHypervisor: { mountPolicy: 'automatic' } }))
      .toContain('config.cloudHypervisor.mountPolicy must be one of: workspace-only, workspace-and-tool-cache');
  });

  it('rejects unknown CLI mount policies', () => {
    expect(() => buildCloudHypervisorConfig({
      containerRuntime: 'cloud-hypervisor',
      cloudHypervisorMountPolicy: 'automatic',
    })).toThrow(
      '--cloud-hypervisor-mount-policy must be "workspace-only" or "workspace-and-tool-cache"',
    );
  });

  it('accepts "cloud-hypervisor" as a container runtime', () => {
    expect(validateAwfFileConfig({
      container: { containerRuntime: 'cloud-hypervisor' },
    })).toEqual([]);
  });
});
