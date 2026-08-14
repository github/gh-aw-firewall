import type { MicrovmNetworkPlan } from '../microvm/network';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import { createCloudHypervisorRunPaths } from './manager-types';
import { buildCloudHypervisorVmConfig } from './vm-config-builder';

function config(overrides: Partial<CloudHypervisorOptions> = {}): CloudHypervisorOptions {
  return {
    previewEnabled: true,
    cloudHypervisorBinary: '/opt/cloud-hypervisor',
    kernelPath: '/opt/vmlinux',
    rootfsPath: '/opt/rootfs.ext4',
    supervisorPath: '/opt/awf-supervisor',
    vcpuCount: 2,
    memoryMib: 512,
    apiTimeoutMs: 1,
    ...overrides,
  };
}

function networkPlan(): MicrovmNetworkPlan {
  return {
    runId: 'run',
    namespaceName: 'ns',
    netnsPath: '/var/run/netns/ns',
    nftTableName: 'table',
    infrastructureBridge: 'awfbr0',
    hostVethName: 'host',
    namespaceVethName: 'namespace',
    tapName: 'tap',
    infrastructureIp: '172.30.0.20',
    infrastructureCidr: '172.30.0.0/24',
    hostGatewayIp: '172.30.0.1',
    guestSubnet: '100.64.0.0/30',
    guestIp: '100.64.0.2',
    guestGatewayIp: '100.64.0.1',
    guestPrefixLength: 30,
    guestMac: '02:00:00:00:00:01',
    tapOwnerUid: 1000,
    tapOwnerGid: 1000,
    tapVnetHdr: true,
    allowedEndpoints: [],
    networkInterface: { iface_id: 'eth0', host_dev_name: 'tap', guest_mac: '02:00:00:00:00:01' },
  };
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
  });

  it('sizes cpus/memory from the runtime options and disables NIC offloads', () => {
    const vmConfig = buildCloudHypervisorVmConfig({
      config: config({ vcpuCount: 4, memoryMib: 1024 }),
      paths,
      networkPlan: networkPlan(),
    });

    expect(vmConfig.cpus).toEqual({ boot_vcpus: 4, max_vcpus: 4 });
    expect(vmConfig.memory.size).toBe(1024 * 1024 * 1024);
    expect(vmConfig.net[0]).toMatchObject({
      offload_tso: false,
      offload_ufo: false,
      offload_csum: false,
    });
  });
});
