import { promises as fs } from 'fs';
import type { CloudHypervisorCleanupHandle } from './cleanup-registry';
import type {
  CleanupRecord,
  FileIdentity,
  InterfaceIdentity,
  MountIdentity,
  ProcessIdentity,
} from './cleanup-identity';
import { createNetworkCleanupHandle } from './cleanup-handle-network';
import { createVmmCleanupHandle } from './cleanup-handle-vmm';
import { createProcessCleanupHandle } from './cleanup-handle-process';

export interface CleanupHandleFactoryOptions {
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
  const { recordPath, record } = options;
  const update = async (): Promise<void> => {
    record.updatedAt = new Date().toISOString();
    await options.persist();
  };
  return {
    ...createNetworkCleanupHandle(options, update),
    ...createVmmCleanupHandle(options, update),
    ...createProcessCleanupHandle(options, update),
    complete: async () => {
      await options.unlink(recordPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
}
