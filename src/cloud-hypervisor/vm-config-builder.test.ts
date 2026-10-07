import type { MicrovmNetworkPlan } from '../microvm/network';
import { createCloudHypervisorRunPaths } from './manager-types';
import { buildCloudHypervisorVmConfig } from './vm-config-builder';
import { createCloudHypervisorOptions as config } from './test-fixtures.test-utils';
import { createTestNetworkPlan } from './manager.test-utils';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES } from './workload-profile';

function networkPlan(): MicrovmNetworkPlan {
  return createTestNetworkPlan();
}

describe('buildCloudHypervisorVmConfig', () => {
  const paths = createCloudHypervisorRunPaths('/opt/cloud-hypervisor', 'awf-run');

  it('omits virtio-fs, vsock and cmdline without a guest config', () => {
    const vmConfig = buildCloudHypervisorVmConfig({
      config: config(),
      paths,
      networkPlan: networkPlan(),
    });

    expect(vmConfig.disks).toHaveLength(1);
    expect(vmConfig).not.toHaveProperty('vsock');
    expect(vmConfig.payload).not.toHaveProperty('cmdline');
    expect(vmConfig.landlock_enable).toBe(true);
  });

  it('plans a NIC-less, workspace-less script guest without primary network assumptions', () => {
    const vmConfig = buildCloudHypervisorVmConfig({
      config: config(),
      paths,
      guestConfig: {
        exports: [{
          tag: 'seed',
          source: '/seed',
          target: '/seed',
          mode: 'ro',
        }],
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
        workspaceMount: null,
      },
    });

    expect(vmConfig).not.toHaveProperty('net');
    expect(vmConfig.payload.cmdline).not.toContain('awf.workspace-mount=');
    expect(vmConfig.payload.cmdline).not.toContain('awf.guest-ip=');
    expect(vmConfig.payload.cmdline).toContain('awf.network-mode=none');
    expect(vmConfig.landlock_rules).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/dev/net/tun' }),
    ]));
  });

  it('applies only the closed enclave VM budget and boots its rootfs read-only', () => {
    const resources = CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script;
    const vmConfig = buildCloudHypervisorVmConfig({
      config: config({ vcpuCount: 8, memoryMib: 4096 }),
      paths,
      guestConfig: {
        exports: [{
          tag: 'enclave-seed',
          source: '/seed',
          target: '/input-seed',
          mode: 'ro',
        }],
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
        workspaceMount: null,
        enclaveResources: resources,
      },
      enclaveResources: resources,
    });

    expect(vmConfig.cpus).toEqual({ boot_vcpus: 1, max_vcpus: 1 });
    expect(vmConfig.memory.size).toBe(768 * 1024 * 1024);
    expect(vmConfig.disks[0].readonly).toBe(true);
    expect(vmConfig.payload.cmdline).toContain('awf.enclave-role=script');
    expect(vmConfig.payload.cmdline).toContain(' ro ');
    expect(vmConfig.payload.cmdline).not.toContain(' rw ');
  });

  it('rejects a caller-increased enclave VM budget', () => {
    const trusted = CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES.script;
    const resources = { ...trusted, memoryMiB: trusted.memoryMiB + 1 };
    expect(() => buildCloudHypervisorVmConfig({
      config: config(),
      paths,
      guestConfig: {
        exports: [{
          tag: 'enclave-seed',
          source: '/seed',
          target: '/input-seed',
          mode: 'ro',
        }],
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
        workspaceMount: null,
        enclaveResources: resources,
      },
      enclaveResources: resources,
    })).toThrow(/closed guest resource profile/);
  });

  it('adds virtio-fs, vsock and supervisor cmdline with a guest config', () => {
    const vmConfig = buildCloudHypervisorVmConfig({
      config: config(),
      paths,
      networkPlan: networkPlan(),
      guestConfig: {
        exports: [{
          tag: 'workspace',
          source: '/workspace',
          target: '/workspace',
          mode: 'rw',
        }],
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
      },
      fsDevices: [{
        export: {
          tag: 'workspace',
          source: '/workspace',
          target: '/workspace',
          mode: 'rw',
        },
        socketPath: '/run/virtiofs.sock',
        logPath: '/run/virtiofs.log',
        evidencePath: '/run/virtiofs-confinement.json',
      }],
    });

    expect(vmConfig.disks.map((disk) => disk.id)).toEqual(['rootfs']);
    expect(vmConfig.fs).toEqual([expect.objectContaining({
      tag: 'workspace',
      socket: '/run/virtiofs.sock',
    })]);
    expect(vmConfig.memory.shared).toBe(true);
    expect(vmConfig).toHaveProperty('vsock');
    expect(vmConfig.payload).toHaveProperty(
      'cmdline',
      expect.stringContaining('awf.virtiofs=workspace:L3dvcmtzcGFjZQ:rw'),
    );
    expect(vmConfig.payload.cmdline).not.toContain('awf.network-mode=none');
  });

  it('encodes a policy-narrowed workspace mode only alongside its host mount plan', () => {
    const exports = [{
      tag: 'workspace',
      source: '/workspace',
      target: '/workspace',
      mode: 'ro' as const,
    }];

    expect(buildCloudHypervisorVmConfig({
      config: config(),
      paths,
      networkPlan: networkPlan(),
      guestConfig: {
        exports,
        mountEnforcement: { plans: [{ tag: 'workspace', writableOverlays: [] }] },
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
      },
    }).payload).toHaveProperty(
      'cmdline',
      expect.stringContaining('awf.virtiofs=workspace:L3dvcmtzcGFjZQ:ro'),
    );

    expect(() => buildCloudHypervisorVmConfig({
      config: config(),
      paths,
      networkPlan: networkPlan(),
      guestConfig: {
        exports,
        supervisorBinaryPath: '/opt/awf-supervisor',
        supervisorSha256: 'a'.repeat(64),
      },
    })).toThrow('Cloud Hypervisor requires read-write tag "workspace" at /workspace');
  });

  it('sizes cpus/memory from the runtime options and disables NIC offloads', () => {    const vmConfig = buildCloudHypervisorVmConfig({
      config: config({ vcpuCount: 4, memoryMib: 1024 }),
      paths,
      networkPlan: networkPlan(),
    });

    expect(vmConfig.cpus).toEqual({ boot_vcpus: 4, max_vcpus: 4 });
    expect(vmConfig.memory.size).toBe(1024 * 1024 * 1024);
    expect(vmConfig.net?.[0]).toMatchObject({
      offload_tso: false,
      offload_ufo: false,
      offload_csum: false,
    });
  });
});
