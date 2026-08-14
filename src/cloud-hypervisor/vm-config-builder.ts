import type { MicrovmNetworkPlan } from '../microvm/network';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import {
  validateCloudHypervisorExports,
  type CloudHypervisorDirectoryExport,
} from './exports';
import {
  CLOUD_HYPERVISOR_GUEST_CID,
  computeCloudHypervisorLandlockRules,
} from './launcher';
import {
  CLOUD_HYPERVISOR_GUEST_VSOCK_PORT,
  type CloudHypervisorManagerGuestConfig,
  type CloudHypervisorRunPaths,
} from './manager-types';
import type { VirtiofsdDevice } from './virtiofsd';

const CLOUD_HYPERVISOR_GUEST_SUPERVISOR = '/usr/sbin/awf-supervisor';

export interface CloudHypervisorVmConfigInput {
  config: CloudHypervisorOptions;
  paths: CloudHypervisorRunPaths;
  networkPlan: MicrovmNetworkPlan;
  guestConfig?: CloudHypervisorManagerGuestConfig;
  fsDevices?: readonly VirtiofsdDevice[];
}

/**
 * Builds the Cloud Hypervisor `vm.create` payload (CPU/memory sizing, boot
 * payload, disks, tap-backed NIC, vsock and Landlock rules) for one run.
 */
export function buildCloudHypervisorVmConfig({
  config,
  paths,
  networkPlan,
  guestConfig,
  fsDevices = [],
}: CloudHypervisorVmConfigInput) {
  const landlockRules = computeCloudHypervisorLandlockRules({
    kernelPath: paths.kernelPath,
    rootfsPath: paths.rootfsPath,
    runDirectory: paths.runDirectory,
    apiSocketPath: paths.apiSocketPath,
    vsockSocketPath: paths.vsockSocketPath,
    tapName: networkPlan.tapName,
  });
  return {
    cpus: {
      boot_vcpus: config.vcpuCount,
      max_vcpus: config.vcpuCount,
    },
    memory: {
      size: config.memoryMib * 1024 * 1024,
      ...(fsDevices.length > 0 ? { shared: true } : {}),
    },
    payload: {
      kernel: paths.kernelPath,
      ...(guestConfig
        ? { cmdline: buildSupervisorBootArgs(networkPlan, guestConfig) }
        : {}),
    },
    disks: [{
      id: 'rootfs',
      path: paths.rootfsPath,
      readonly: false,
      image_type: 'Raw' as const,
    }],
    ...(fsDevices.length > 0
      ? {
          fs: fsDevices.map((device) => ({
            tag: device.export.tag,
            socket: device.socketPath,
            num_queues: 1,
            queue_size: 1024,
          })),
        }
      : {}),
    net: [{
      id: 'net0',
      tap: networkPlan.networkInterface.host_dev_name,
      mac: networkPlan.networkInterface.guest_mac ?? '',
      // Cloud Hypervisor defaults all three offloads to enabled. This
      // entire network path is a fully-software bridge/veth/tap chain
      // with no real NIC downstream to finish partially-offloaded
      // (unchecksummed / not-yet-segmented) frames; live-KVM validation
      // showed guest-to-Squid traffic being forwarded (visible in nft
      // counters) but the return path never matching the
      // established/related accept rule, with zero visibility into
      // whether nftables' conntrack was marking replies as invalid.
      // Disable all three explicitly rather than rely on Cloud
      // Hypervisor's own defaults, removing offload-related packet
      // malformation as a possible cause.
      offload_tso: false,
      offload_ufo: false,
      offload_csum: false,
    }],
    rng: { src: '/dev/urandom' },
    serial: { mode: 'File' as const, file: paths.serialLogPath },
    console: { mode: 'Off' as const },
    ...(guestConfig
      ? { vsock: { cid: CLOUD_HYPERVISOR_GUEST_CID, socket: paths.vsockSocketPath } }
      : {}),
    watchdog: false,
    landlock_enable: true,
    landlock_rules: landlockRules,
  };
}

export function buildSupervisorBootArgs(
  networkPlan: MicrovmNetworkPlan,
  guestConfig: CloudHypervisorManagerGuestConfig,
): string {
  const port = guestConfig.vsockPort ?? CLOUD_HYPERVISOR_GUEST_VSOCK_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Cloud Hypervisor guest vsock port must be in 1-65535: ${port}`);
  }
  return [
    'console=ttyS0',
    'reboot=k',
    'panic=0',
    'root=/dev/vda',
    'rootfstype=ext4',
    'rootflags=data=ordered',
    'rw',
    // Cloud Hypervisor requires PCI (no `pci=off` MMIO-only mode like
    // Firecracker); pin legacy `ethN` interface naming so the guest's
    // single virtio-pci NIC has a deterministic name across boots.
    'net.ifnames=0',
    'biosdevname=0',
    `init=${CLOUD_HYPERVISOR_GUEST_SUPERVISOR}`,
    'awf.workspace-mount=/workspace',
    `awf.virtiofs=${encodeVirtiofsBootArg(guestConfig.exports)}`,
    `awf.vsock-port=${port}`,
    `awf.guest-ip=${networkPlan.guestIp}`,
    `awf.guest-prefix=${networkPlan.guestPrefixLength}`,
    `awf.guest-gateway=${networkPlan.guestGatewayIp}`,
    'awf.guest-interface=eth0',
  ].join(' ');
}

export function encodeVirtiofsBootArg(
  exports: readonly CloudHypervisorDirectoryExport[],
): string {
  const encoded = validateCloudHypervisorExports(exports)
    .map((entry) => (
      `${entry.tag}:${Buffer.from(entry.target).toString('base64url')}:${entry.mode}`
    ))
    .join(';');
  if (Buffer.byteLength(encoded) > 4096) {
    throw new Error('Cloud Hypervisor virtio-fs boot argument exceeds 4096 bytes');
  }
  return encoded;
}
