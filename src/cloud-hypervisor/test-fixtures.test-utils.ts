import type { WrapperConfig } from '../types';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { MicrovmInfrastructureSnapshot } from '../microvm/infrastructure';
import { CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG } from './artifact-manifest';
import type { CloudHypervisorHostToolPaths } from './preflight';

const cloudHypervisorHostTools: CloudHypervisorHostToolPaths = {
  getfacl: '/usr/bin/getfacl',
  getent: '/usr/bin/getent',
  groupdel: '/usr/sbin/groupdel',
  id: '/usr/bin/id',
  ip: '/usr/bin/ip',
  nft: '/usr/sbin/nft',
  sysctl: '/usr/sbin/sysctl',
  flock: '/usr/bin/flock',
  mke2fs: '/usr/sbin/mke2fs',
  debugfs: '/usr/sbin/debugfs',
  e2fsck: '/usr/sbin/e2fsck',
  rsync: '/usr/bin/rsync',
  mount: '/usr/bin/mount',
  umount: '/usr/bin/umount',
  setpriv: '/usr/bin/setpriv',
  setfacl: '/usr/bin/setfacl',
  useradd: '/usr/sbin/useradd',
  userdel: '/usr/sbin/userdel',
};

function createCloudHypervisorOptions(
  overrides: Partial<CloudHypervisorOptions> = {},
): CloudHypervisorOptions {
  return {
    previewEnabled: true,
    mountPolicy: 'workspace-only',
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

function createCloudHypervisorTestConfig(
  overrides: Partial<WrapperConfig> = {},
): WrapperConfig {
  return {
    containerRuntime: 'cloud-hypervisor',
    cloudHypervisor: {
      previewEnabled: true,
      mountPolicy: 'workspace-only',
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      kernelPath: '/opt/kernel',
      rootfsPath: '/opt/rootfs',
      supervisorPath: '/opt/supervisor',
      artifactManifestPath: '/opt/manifest.json',
      artifactManifestBundlePath: '/opt/manifest.sigstore.jsonl',
      artifactReleaseTag: CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG,
      vcpuCount: 2,
      memoryMib: 512,
      apiTimeoutMs: 5000,
    },
    agentCommand: 'printf hello',
    allowedDomains: ['github.com'],
    workDir: '/tmp/awf',
    keepContainers: false,
    networkIsolation: true,
    legacySecurity: false,
    enableApiProxy: true,
    enableDind: false,
    enableHostAccess: false,
    tty: false,
    logLevel: 'info',
    buildLocal: false,
    skipPull: true,
    imageRegistry: 'registry',
    imageTag: 'tag',
    envAll: false,
    sslBump: false,
    enableDlp: false,
    ...overrides,
  } as WrapperConfig;
}

function createCloudHypervisorInfrastructureSnapshot(): MicrovmInfrastructureSnapshot {
  return {
    networkId: 'a'.repeat(64),
    bridgeName: 'br-aaaaaaaaaaaa',
    subnet: '172.30.0.0/24',
    gateway: '172.30.0.1',
    squidIp: '172.30.0.10',
    apiProxyIp: '172.30.0.30',
    topologyPeerIps: {},
    revalidate: jest.fn().mockResolvedValue(undefined),
  };
}

export {
  cloudHypervisorHostTools,
  createCloudHypervisorOptions,
  createCloudHypervisorTestConfig,
  createCloudHypervisorInfrastructureSnapshot,
};
