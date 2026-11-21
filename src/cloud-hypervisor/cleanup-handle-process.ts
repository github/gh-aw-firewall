import * as path from 'path';
import type { CloudHypervisorCleanupHandle } from './cleanup-registry';
import type { CleanupHandleFactoryOptions } from './cleanup-handle';
import {
  assertSafeProcessKey,
  isTrustedArtifactSnapshotDirectory,
  type ProcessIdentity,
} from './cleanup-identity';

const PROCESS_IDENTITY_WAIT_MS = 2_000;
const PROCESS_IDENTITY_INTERVAL_MS = 10;

export function createProcessCleanupHandle(
  options: CleanupHandleFactoryOptions,
  update: () => Promise<void>,
): Pick<CloudHypervisorCleanupHandle,
  'captureArtifactSnapshot' | 'captureRunDirectory' | 'captureCgroup' |
  'captureVirtiofsdResources' | 'prepareProcess' | 'captureProcess'
> {
  const { record } = options;
  return {
    captureArtifactSnapshot: async (directory: string) => {
      if (
        !path.isAbsolute(directory) ||
        !isTrustedArtifactSnapshotDirectory(directory, record.paths.runDirectory) ||
        !/^run-[A-Za-z0-9_-]+$/.test(path.basename(directory))
      ) throw new Error(`Unsafe artifact snapshot cleanup path: ${directory}`);
      record.paths.artifactSnapshotDirectory = directory;
      record.identities.artifactSnapshotDirectory = await options.captureFileIdentity(directory);
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
  };
}
