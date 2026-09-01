import { promises as fs } from 'fs';
import * as path from 'path';
import type { MicrovmNetworkPlan } from '../microvm/network';
import type { CloudHypervisorVmmIdentity } from './vmm-identity';
import type { CloudHypervisorCleanupHandle, CloudHypervisorNetworkResource } from './cleanup-registry';
import {
  assertSafeProcessKey,
  assertSafeRecordPaths,
  type CleanupRecord,
  type FileIdentity,
  type InterfaceIdentity,
  type MountIdentity,
  type ProcessIdentity,
} from './cleanup-identity';

const PROCESS_IDENTITY_WAIT_MS = 2_000;
const PROCESS_IDENTITY_INTERVAL_MS = 10;

interface CleanupHandleFactoryOptions {
  readonly recordPath: string;
  readonly record: CleanupRecord;
  readonly ipPath: string;
  readonly persist: () => Promise<void>;
  readonly unlink: typeof fs.unlink;
  readonly realpath: typeof fs.realpath;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pathExists: (filePath: string) => Promise<boolean>;
  readonly captureFileIdentity: (filePath: string) => Promise<FileIdentity>;
  readonly captureInterfaceIdentity: (
    ipPath: string,
    name: string,
    namespace?: string,
  ) => Promise<InterfaceIdentity>;
  readonly captureProcessIdentity: (pid: number) => Promise<ProcessIdentity>;
  readonly readMounts: () => Promise<MountIdentity[]>;
}

export function createCleanupHandle(options: CleanupHandleFactoryOptions): CloudHypervisorCleanupHandle {
  const { recordPath, record, ipPath } = options;
  const update = async (): Promise<void> => {
    record.updatedAt = new Date().toISOString();
    await options.persist();
  };
  return {
    captureNetworkPlan: async (plan: MicrovmNetworkPlan) => {
      assertSafeRecordPaths({
        ...record.paths,
        runId: record.runId,
        runBaseDir: path.dirname(path.dirname(record.paths.runDirectory)),
      }, plan);
      if (record.network) throw new Error('Cleanup network plan is already committed');
      record.network = serializeNetworkPlan(plan);
      await update();
    },
    captureArtifactSnapshot: async (directory: string) => {
      const snapshotRoot = path.join(
        path.dirname(path.dirname(record.paths.runDirectory)),
        'trusted-artifacts',
      );
      if (
        !path.isAbsolute(directory) ||
        path.dirname(directory) !== snapshotRoot ||
        !/^run-[A-Za-z0-9_-]+$/.test(path.basename(directory))
      ) throw new Error(`Unsafe artifact snapshot cleanup path: ${directory}`);
      record.paths.artifactSnapshotDirectory = directory;
      record.identities.artifactSnapshotDirectory = await options.captureFileIdentity(directory);
      await update();
    },
    prepareVmmAccount: async (name: string) => {
      if (!/^awfvmm-[a-f0-9]{20}$/.test(name) || record.vmmIdentity) {
        throw new Error(`Unsafe or duplicate VMM cleanup account: ${name}`);
      }
      record.vmmIdentity = { state: 'pending', name, aclPaths: [] };
      await update();
    },
    captureVmmIdentity: async (identity: CloudHypervisorVmmIdentity) => {
      const pending = record.vmmIdentity;
      if (
        !pending ||
        pending.name !== identity.name ||
        !Number.isSafeInteger(identity.uid) ||
        identity.uid <= 0 ||
        !Number.isSafeInteger(identity.gid) ||
        identity.gid <= 0
      ) throw new Error('VMM cleanup identity does not match its pending account');
      record.vmmIdentity = { ...pending, state: 'live', uid: identity.uid, gid: identity.gid };
      await update();
    },
    prepareVmmAcl: async (aclPath: string) => {
      if (!record.vmmIdentity || record.vmmIdentity.state !== 'live') {
        throw new Error('VMM cleanup identity is not committed before ACL grant');
      }
      if (aclPath !== '/dev/kvm' && aclPath !== '/dev/net/tun') {
        throw new Error(`Unsafe VMM ACL cleanup path: ${aclPath}`);
      }
      if (!record.vmmIdentity.aclPaths.includes(aclPath)) {
        record.vmmIdentity.aclPaths.push(aclPath);
        await update();
      }
    },
    releaseVmmAcl: async (aclPath: string) => {
      if (!record.vmmIdentity || record.vmmIdentity.state !== 'live') {
        throw new Error('VMM cleanup identity is not committed before ACL release');
      }
      const index = record.vmmIdentity.aclPaths.indexOf(aclPath);
      if (index < 0) throw new Error(`VMM ACL cleanup intent is missing for ${aclPath}`);
      record.vmmIdentity.aclPaths.splice(index, 1);
      await update();
    },
    captureNetworkResource: async (resource: CloudHypervisorNetworkResource) => {
      const network = requireNetwork(record);
      switch (resource) {
        case 'netns':
          record.identities.netns = await options.captureFileIdentity(network.netnsPath);
          break;
        case 'hostVeth':
          record.identities.hostVeth = await options.captureInterfaceIdentity(
            ipPath, network.hostVethName,
          );
          break;
        case 'namespaceVeth':
          record.identities.namespaceVeth = await options.captureInterfaceIdentity(
            ipPath, network.namespaceVethName, network.namespaceName,
          );
          break;
        case 'tap':
          record.identities.tap = await options.captureInterfaceIdentity(
            ipPath, network.tapName, network.namespaceName,
          );
          break;
      }
      await update();
    },
    captureRunDirectory: async () => {
      record.identities.runDirectory = await options.captureFileIdentity(record.paths.runDirectory);
      await update();
    },
    captureCgroup: async () => {
      record.identities.cgroup = await options.captureFileIdentity(record.paths.cgroupPath);
      await update();
    },
    captureVirtiofsdResources: async () => {
      if (await options.pathExists(record.paths.virtiofsdShareDirectory)) {
        record.identities.virtiofsdShareDirectory = await options.captureFileIdentity(
          record.paths.virtiofsdShareDirectory,
        );
        record.mounts = (await options.readMounts()).filter((mount) =>
          mount.mountPoint === record.paths.virtiofsdShareDirectory ||
          mount.mountPoint.startsWith(`${record.paths.virtiofsdShareDirectory}${path.sep}`),
        );
      }
      await update();
    },
    prepareProcess: async (key: string, executable: string, socketPath: string, sourcePath?: string) => {
      assertSafeProcessKey(key);
      // The key is restricted to a non-prototypal identifier alphabet above.
      // eslint-disable-next-line security/detect-object-injection
      record.processes[key] = {
        state: 'pending',
        executable: await options.realpath(executable),
        socketPath,
        ...(sourcePath ? { sourcePath } : {}),
      };
      await update();
    },
    captureProcess: async (key: string, pid: number) => {
      assertSafeProcessKey(key);
      // The key is restricted to a non-prototypal identifier alphabet above.
      // eslint-disable-next-line security/detect-object-injection
      const pending = record.processes[key];
      if (!pending) throw new Error(`Cleanup identity was not prepared for process "${key}"`);
      const expectedNetworkNamespace = key === 'vmm'
        ? `net:[${record.identities.netns?.inode}]`
        : undefined;
      const requiresPrivateNetworkNamespace = key.startsWith('virtiofsd-');
      const deadline = Date.now() + PROCESS_IDENTITY_WAIT_MS;
      let identity: ProcessIdentity;
      for (;;) {
        identity = await options.captureProcessIdentity(pid);
        if (
          identity.executable === pending.executable &&
          (
            expectedNetworkNamespace === undefined ||
            identity.networkNamespace === expectedNetworkNamespace
          ) &&
          (
            !requiresPrivateNetworkNamespace ||
            identity.networkNamespace !== record.owner.networkNamespace
          )
        ) break;
        if (Date.now() >= deadline) {
          throw new Error(`Process "${key}" did not match its prepared cleanup identity`);
        }
        // execa returns after fork; allow the trusted ip -> setpriv -> target
        // exec chain to finish before requiring the final executable/netns.
        await options.sleep(PROCESS_IDENTITY_INTERVAL_MS);
      }
      // eslint-disable-next-line security/detect-object-injection
      record.processes[key] = { ...pending, state: 'live', identity };
      await update();
    },
    complete: async () => {
      await options.unlink(recordPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
}

function serializeNetworkPlan(plan: MicrovmNetworkPlan): CleanupRecord['network'] {
  return {
    namespaceName: plan.namespaceName,
    netnsPath: plan.netnsPath,
    hostVethName: plan.hostVethName,
    namespaceVethName: plan.namespaceVethName,
    tapName: plan.tapName,
    infrastructureBridge: plan.infrastructureBridge,
    hostForwardRuleComment: plan.hostForwardRuleComment,
  };
}

function requireNetwork(record: CleanupRecord): NonNullable<CleanupRecord['network']> {
  if (!record.network) throw new Error('Cleanup network plan is not committed');
  return record.network;
}
