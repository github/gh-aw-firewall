import type { ExecaChildProcess } from 'execa';
import type {
  MicrovmNetworkLifecycle,
  MicrovmNetworkPlan,
} from '../microvm/network';
import { createMicrovmNetworkPlan } from '../microvm/network';
import type { MicrovmRootfsPreparer } from '../microvm/rootfs';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { CloudHypervisorApiClient } from './api-client';
import type { CloudHypervisorCgroup } from './launcher';
import type { VirtiofsdManager } from './virtiofsd';
import type { CloudHypervisorDirectoryExport } from './exports';
import {
  type CloudHypervisorManagerDependencies,
  type CloudHypervisorManagerNetworkConfig,
} from './manager';
import type { CloudHypervisorHostToolPaths } from './preflight';
import type {
  CloudHypervisorCleanupHandle,
  CloudHypervisorCleanupRegistry,
} from './cleanup-registry';
import type { CloudHypervisorVmmIdentityManager } from './vmm-identity';

const hostTools: CloudHypervisorHostToolPaths = {
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

const exportsConfig = [
  { tag: 'workspace', source: '/workspace', target: '/workspace', mode: 'rw' as const },
];

function rootfsPreparerMock(): MicrovmRootfsPreparer {
  return {
    rootfsImagePath: '/prepared/rootfs.ext4',
    prepare: jest.fn().mockResolvedValue('/prepared/rootfs.ext4'),
  } as unknown as MicrovmRootfsPreparer;
}

function virtiofsdManagerMock(): VirtiofsdManager {
  const devices = exportsConfig.map((item, index) => ({
    export: item,
    socketPath: `/run/virtiofs-${index}.sock`,
    logPath: `/run/virtiofs-${index}.log`,
    evidencePath: `/run/virtiofs-${index}-confinement.json`,
  }));
  return {
    start: jest.fn(async (exports: readonly CloudHypervisorDirectoryExport[]) => devices.map(
      (device, index) => ({ ...device, export: exports[index] }),
    )),
    stop: jest.fn().mockResolvedValue(undefined),
    getDiagnosticDevices: jest.fn(() => devices),
  } as unknown as VirtiofsdManager;
}

function config(overrides: Partial<CloudHypervisorOptions> = {}): CloudHypervisorOptions {
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

function processMock(): ExecaChildProcess<string> {
  const child = Promise.resolve({ exitCode: 0 }) as unknown as ExecaChildProcess<string>;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 4242,
    kill: jest.fn(() => {
      Object.assign(child, { exitCode: 0, killed: true });
      return true;
    }),
  });
  return child;
}

function networkConfig(
  overrides: Partial<CloudHypervisorManagerNetworkConfig> = {},
): CloudHypervisorManagerNetworkConfig {
  return {
    infrastructureBridge: 'awfbr0',
    enableApiProxy: true,
    apiProxyIp: '172.30.0.30',
    ...overrides,
  };
}

function guestConfig() {
  return {
    exports: exportsConfig,
    supervisorBinaryPath: '/opt/awf-supervisor',
    supervisorSha256: 'a'.repeat(64),
  };
}

function networkLifecycle(plan: MicrovmNetworkPlan): MicrovmNetworkLifecycle {
  return {
    plan,
    setup: jest.fn().mockResolvedValue(plan),
    cleanup: jest.fn().mockResolvedValue(undefined),
  };
}

function cgroupMock(): CloudHypervisorCgroup {
  return {
    cgroupPath: '/sys/fs/cgroup/awf-cloud-hypervisor/run',
    setup: jest.fn().mockResolvedValue(undefined),
    assign: jest.fn().mockResolvedValue(undefined),
    expectedLimits: jest.fn().mockReturnValue({
      memoryMax: String(768 * 1024 * 1024),
      cpuMax: '300000 100000',
      pidsMax: '256',
    }),
    cleanup: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudHypervisorCgroup;
}

function cleanupHandleMock(): CloudHypervisorCleanupHandle {
  return {
    captureNetworkPlan: jest.fn().mockResolvedValue(undefined),
    captureArtifactSnapshot: jest.fn().mockResolvedValue(undefined),
    prepareVmmAccount: jest.fn().mockResolvedValue(undefined),
    captureVmmIdentity: jest.fn().mockResolvedValue(undefined),
    prepareVmmAcl: jest.fn().mockResolvedValue(undefined),
    releaseVmmAcl: jest.fn().mockResolvedValue(undefined),
    captureNetworkResource: jest.fn().mockResolvedValue(undefined),
    captureRunDirectory: jest.fn().mockResolvedValue(undefined),
    captureCgroup: jest.fn().mockResolvedValue(undefined),
    captureVirtiofsdResources: jest.fn().mockResolvedValue(undefined),
    prepareProcess: jest.fn().mockResolvedValue(undefined),
    captureProcess: jest.fn().mockResolvedValue(undefined),
    complete: jest.fn().mockResolvedValue(undefined),
  };
}

function cleanupRegistryMock(): CloudHypervisorCleanupRegistry {
  return {
    reapPending: jest.fn().mockResolvedValue(undefined),
    createPending: jest.fn().mockResolvedValue(cleanupHandleMock()),
    create: jest.fn().mockResolvedValue(cleanupHandleMock()),
  };
}

function vmmIdentityMock(): CloudHypervisorVmmIdentityManager {
  return {
    allocate: jest.fn().mockResolvedValue({ name: 'awfvmm-test', uid: 2001, gid: 2002 }),
    withDeviceAccess: jest.fn(async (operation: () => Promise<unknown>) => operation()),
    validateOwnedPaths: jest.fn().mockResolvedValue(undefined),
    validateTapOwnership: jest.fn().mockResolvedValue(undefined),
    cleanup: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudHypervisorVmmIdentityManager;
}

function dependencies(
  overrides: Partial<CloudHypervisorManagerDependencies> = {},
): CloudHypervisorManagerDependencies {
  const client = {
    ping: jest.fn().mockResolvedValue({ version: '53.0' }),
    vmCreate: jest.fn().mockResolvedValue(undefined),
    vmBoot: jest.fn().mockResolvedValue(undefined),
    vmInfo: jest.fn().mockResolvedValue({ state: 'Running' }),
    vmCounters: jest.fn().mockResolvedValue({ net0: { rx_bytes: 0 } }),
    vmShutdown: jest.fn().mockResolvedValue(undefined),
    vmmShutdown: jest.fn().mockResolvedValue(undefined),
  } as unknown as CloudHypervisorApiClient;
  return {
    preflight: jest.fn().mockResolvedValue({
      version: '53.0',
      cloudHypervisorBinary: '/opt/cloud-hypervisor',
      virtiofsdBinary: '/opt/virtiofsd',
      kernelPath: '/opt/vmlinux',
      rootfsPath: '/opt/rootfs.ext4',
      tools: hostTools,
      supervisorPath: '/opt/awf-supervisor',
      cgroupVersion: 2,
      kvmGid: 978,
    }),
    launch: jest.fn().mockReturnValue(processMock()),
    mkdir: jest.fn().mockResolvedValue(undefined),
    copyFile: jest.fn().mockResolvedValue(undefined),
    copySparseFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    chown: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFileTail: jest.fn().mockResolvedValue(Buffer.alloc(0)),
    access: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    sleep: jest.fn().mockResolvedValue(undefined),
    createClient: jest.fn().mockReturnValue(client),
    reserveNetwork: jest.fn(async (runId, options) => {
      const plan = createMicrovmNetworkPlan(runId, options);
      return { plan, release: jest.fn().mockResolvedValue(undefined) };
    }),
    createNetwork: jest.fn((plan) => networkLifecycle(plan)),
    cleanupRegistry: cleanupRegistryMock(),
    createRootfsPreparer: jest.fn(() => rootfsPreparerMock()),
    createVirtiofsdManager: jest.fn(() => virtiofsdManagerMock()),
    createVsockClient: jest.fn(),
    createCgroup: jest.fn(() => cgroupMock()),
    verifyConfinement: jest.fn().mockResolvedValue({
      schemaVersion: 1,
      verifiedAt: '2026-08-31T00:00:00.000Z',
      process: {
        pid: 4242,
        startTimeTicks: '123',
        executable: '/opt/cloud-hypervisor',
      },
      identity: { uid: 1000, gid: 1000, supplementaryGroups: [978] },
      capabilities: {
        inheritable: '0000000000001000',
        permitted: '0000000000001000',
        effective: '0000000000001000',
        bounding: '0000000000001000',
        ambient: '0000000000001000',
      },
      noNewPrivs: 1,
      seccomp: { mode: 2, relevantThreadIds: [4243], observedThreadCount: 2 },
      networkNamespace: { name: 'awfvm-test', inode: 'net:[42]' },
      cgroup: {
        path: '/sys/fs/cgroup/awf-cloud-hypervisor/run',
        membership: '/awf-cloud-hypervisor/run',
        limits: {
          memoryMax: String(768 * 1024 * 1024),
          cpuMax: '300000 100000',
          pidsMax: '256',
        },
      },
    }),
    createVmmIdentity: jest.fn(() => vmmIdentityMock()),
    resolveIdentity: jest.fn().mockReturnValue({ uid: 1000, gid: 1000 }),
    ...overrides,
  };
}


export { hostTools, exportsConfig, rootfsPreparerMock, virtiofsdManagerMock, config, processMock, networkConfig, guestConfig, networkLifecycle, cgroupMock, cleanupHandleMock, cleanupRegistryMock, vmmIdentityMock, dependencies };
