import { buildConfig } from '../commands/build-config';
import { mapAwfFileConfigToCliOptions } from '../config-mapper';
import { validateAwfFileConfig } from '../config-file';
import {
  FIRECRACKER_DEFAULT_API_TIMEOUT_MS,
  FIRECRACKER_DEFAULT_BINARY,
  FIRECRACKER_DEFAULT_JAILER_BINARY,
  FIRECRACKER_DEFAULT_MEMORY_MIB,
  FIRECRACKER_DEFAULT_VCPU_COUNT,
} from '../types/runtime-options';

function buildFirecrackerConfig(options: Record<string, unknown>) {
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
  }).firecracker;
}

describe('Firecracker configuration', () => {
  it('maps the cohesive config-file surface to CLI option semantics', () => {
    const digest = 'a'.repeat(64);
    const mapped = mapAwfFileConfigToCliOptions({
      firecracker: {
        previewEnabled: true,
        firecrackerBinary: '/opt/firecracker',
        jailerBinary: '/opt/jailer',
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
      firecrackerPreview: true,
      firecrackerBinary: '/opt/firecracker',
      firecrackerJailerBinary: '/opt/jailer',
      firecrackerKernel: '/opt/vmlinux',
      firecrackerRootfs: '/opt/rootfs.ext4',
      firecrackerSupervisor: '/opt/awf-supervisor',
      firecrackerVcpus: 4,
      firecrackerMemoryMib: 1024,
      firecrackerApiTimeoutMs: 8000,
      firecrackerKernelSha256: digest,
      firecrackerSupervisorSha256: digest,
    }));
  });

  it('applies explicit safe defaults when Firecracker is selected', () => {
    expect(buildFirecrackerConfig({ containerRuntime: 'firecracker' })).toEqual({
      previewEnabled: false,
      firecrackerBinary: FIRECRACKER_DEFAULT_BINARY,
      jailerBinary: FIRECRACKER_DEFAULT_JAILER_BINARY,
      kernelPath: undefined,
      rootfsPath: undefined,
      supervisorPath: undefined,
      vcpuCount: FIRECRACKER_DEFAULT_VCPU_COUNT,
      memoryMib: FIRECRACKER_DEFAULT_MEMORY_MIB,
      apiTimeoutMs: FIRECRACKER_DEFAULT_API_TIMEOUT_MS,
      sha256: undefined,
    });
  });

  it('does not populate Firecracker defaults for unrelated runtimes', () => {
    expect(buildFirecrackerConfig({
      containerRuntime: 'gvisor',
      firecrackerPreview: false,
    })).toBeUndefined();
  });

  it('validates runtime names, positive resources, digests, and unknown keys', () => {
    expect(validateAwfFileConfig({
      container: { containerRuntime: 'firecracker' },
      firecracker: {
        vcpuCount: 2,
        memoryMib: 512,
        sha256: { rootfs: '0'.repeat(64) },
      },
    })).toEqual([]);
    expect(validateAwfFileConfig({ firecracker: { vcpuCount: 0 } }))
      .toContain('config.firecracker.vcpuCount must be a positive integer');
    expect(validateAwfFileConfig({ firecracker: { sha256: { kernel: 'bad' } } }))
      .toContain('config.firecracker.sha256.kernel must match pattern "^[A-Fa-f0-9]{64}$"');
    expect(validateAwfFileConfig({ firecracker: { unsupported: true } }))
      .toContain('config.firecracker.unsupported is not supported');
  });
});
