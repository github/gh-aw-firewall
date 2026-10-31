import { buildConfig } from '../commands/build-config';
import { mapAwfFileConfigToCliOptions } from '../config-mapper';
import { validateAwfFileConfig } from '../config-file';
import { buildMinimalBuildConfigInput } from '../test-helpers/build-config.test-utils';
import { validatePublicEnclaveDebug, resolvePublicEnclaveDebugConfig } from '../enclave/public-debug';
import type { AwfFileConfig } from '../config-file';
import {
  CLOUD_HYPERVISOR_DEFAULT_API_TIMEOUT_MS,
  CLOUD_HYPERVISOR_DEFAULT_BINARY,
  CLOUD_HYPERVISOR_DEFAULT_MEMORY_MIB,
  CLOUD_HYPERVISOR_DEFAULT_VCPU_COUNT,
} from '../types/runtime-options';

function buildCloudHypervisorConfig(options: Record<string, unknown>) {
  const input = buildMinimalBuildConfigInput({
    options: {
      ...buildMinimalBuildConfigInput().options,
      imageRegistry: 'registry',
      ...options,
    },
    agentCommand: 'echo test',
    allowedDomains: [],
    dnsServers: [],
  });
  return buildConfig(input).cloudHypervisor;
}

describe('Cloud Hypervisor configuration (foundation only)', () => {
  it.each([true, false])('maps and validates runtime-neutral public diagnostics=%s without creating CH config', enabled => {
    const mapped = mapAwfFileConfigToCliOptions({ enclaveDebugPublic: enabled });
    expect(mapped.enclaveDebugPublic).toBe(enabled);
    const config = buildConfig(buildMinimalBuildConfigInput({
      options: { ...buildMinimalBuildConfigInput().options, ...mapped },
    }));
    expect(config.enclaveDebugPublic).toBe(enabled);
    expect(config.cloudHypervisor).toBeUndefined();
    expect(validateAwfFileConfig({ enclaveDebugPublic: enabled })).toEqual([]);
    expect(validateAwfFileConfig({ enclaveDebugPublic: 'true' })).not.toEqual([]);
  });
  it.each([
    ['ghcr.io/github/gh-aw-firewall', false, true],
    ['ghcr.io/github/gh-aw-firewall', true, true],
    ['custom.invalid/awf', false, false],
    ['custom.invalid/awf', true, false],
  ] as const)('enforces default Docker image provenance after complete config mapping (%s, local=%s)', (imageRegistry, buildLocal, eligible) => {
    const file: AwfFileConfig = {
      enclaveDebugPublic: true,
      container: { imageRegistry, buildLocal },
      enclaves: [{
        runtime: 'docker', script: {}, repos: [{ repo: 'octo/public-fixture', sensitivity: 'public' }],
      }],
    };
    expect(validateAwfFileConfig(file)).toEqual([]);
    const mapped = mapAwfFileConfigToCliOptions(file);
    const config = buildConfig(buildMinimalBuildConfigInput({
      options: { ...buildMinimalBuildConfigInput().options, ...mapped },
    }));
    expect(config.imageRegistry).toBe(imageRegistry);
    expect(config.buildLocal).toBe(buildLocal);
    expect(validatePublicEnclaveDebug(config).length === 0).toBe(eligible);
    delete config.enclaveDebugPublic;
    expect(resolvePublicEnclaveDebugConfig(config).enclaveDebugPublic === true).toBe(eligible);
  });
  it.each([true, false])('keeps top-level precedence through config-file mapping and CH build (%s)', enabled => {
    const mapped = mapAwfFileConfigToCliOptions({
      enclaveDebugPublic: enabled,
      cloudHypervisor: { previewEnabled: true, enclaveDebugPublic: !enabled },
      enclaves: [{
        runtime: 'cloud-hypervisor', script: {}, repos: [{ repo: 'octo/public-fixture', sensitivity: 'public' }],
      }],
    });
    const config = buildConfig(buildMinimalBuildConfigInput({
      options: { ...buildMinimalBuildConfigInput().options, ...mapped },
    }));
    expect(config.enclaveDebugPublic).toBe(enabled);
    expect(config.cloudHypervisor!.enclaveDebugPublic).toBe(!enabled);
    expect(resolvePublicEnclaveDebugConfig(config).cloudHypervisor!.enclaveDebugPublic).toBe(enabled);
    expect(config.cloudHypervisor!.enclaveDebugPublic).toBe(!enabled);
  });
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
        scratchMib: 96,
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
      cloudHypervisorScratchMib: 96,
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

  it('accepts an explicit scratch bound without introducing a default', () => {
    expect(buildCloudHypervisorConfig({ cloudHypervisorScratchMib: '96' })?.scratchMib).toBe(96);
    expect(buildCloudHypervisorConfig({ cloudHypervisorPreview: true }))
      .not.toHaveProperty('scratchMib');
    expect(validateAwfFileConfig({ cloudHypervisor: { scratchMib: 96 } })).toEqual([]);
  });

  it('maps and validates host-only public enclave debug opt-in without enabling it by default', () => {
    const options = mapAwfFileConfigToCliOptions({ cloudHypervisor: { enclaveDebugPublic: true } });
    expect(options.cloudHypervisorEnclaveDebugPublic).toBe(true);
    expect(buildCloudHypervisorConfig(options)?.enclaveDebugPublic).toBe(true);
    expect(buildCloudHypervisorConfig({ cloudHypervisorPreview: true }))
      .not.toHaveProperty('enclaveDebugPublic');
    expect(buildCloudHypervisorConfig({ cloudHypervisorEnclaveDebugPublic: false })).toBeUndefined();
    expect(validateAwfFileConfig({ cloudHypervisor: { enclaveDebugPublic: true } })).toEqual([]);
    expect(validateAwfFileConfig({ cloudHypervisor: { enclaveDebugPublic: 'true' } })).not.toEqual([]);
  });

  it.each([0, -1, 1.5, '', 'bad', Infinity, 4294967296])(
    'rejects invalid scratch bound %s from CLI and config file',
    (value) => {
      expect(() => buildCloudHypervisorConfig({ cloudHypervisorScratchMib: value }))
        .toThrow(/--cloud-hypervisor-scratch-mib/);
      expect(validateAwfFileConfig({ cloudHypervisor: { scratchMib: value } }))
        .not.toEqual([]);
    },
  );

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
