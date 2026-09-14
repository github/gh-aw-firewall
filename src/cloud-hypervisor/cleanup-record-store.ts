import { randomBytes } from 'crypto';
import { constants } from 'fs';
import type { BigIntStats } from 'fs';
import * as path from 'path';
import {
  validateProcessIdentity,
  validateRecord,
  sameMountIdentity,
  type CleanupRecord,
  type FileIdentity,
  type MountIdentity,
  type ProcessIdentity,
} from './cleanup-identity';
import { captureProcessIdentity, processMatches, readMounts } from './cleanup-process';
import {
  formatError,
  pathExists,
  runChecked,
  type ResolvedCleanupDependencies,
} from './cleanup-dependencies';

const CGROUP_REMOVAL_WAIT_MS = 5_000;
const CGROUP_REMOVAL_INTERVAL_MS = 100;

export async function ensureRegistryDirectory(
  dependencies: ResolvedCleanupDependencies,
): Promise<void> {
  if (dependencies.effectiveUid !== 0) {
    throw new Error('Cloud Hypervisor cleanup registry requires effective uid 0');
  }
  await dependencies.mkdir(dependencies.rootDirectory, { recursive: true, mode: 0o700 });
  const value = await dependencies.lstat(dependencies.rootDirectory);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    value.uid !== 0 ||
    (value.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      `Cloud Hypervisor cleanup registry has unsafe ownership or mode: ${dependencies.rootDirectory}`,
    );
  }
}

export async function readRecord(
  dependencies: ResolvedCleanupDependencies,
  recordPath: string,
): Promise<CleanupRecord> {
  const fileStat = await dependencies.lstat(recordPath);
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.uid !== 0 ||
    (fileStat.mode & 0o777) !== 0o600
  ) {
    throw new Error('cleanup record is not a root-owned mode-0600 regular file');
  }
  const parsed = JSON.parse(await dependencies.readFile(recordPath, 'utf8')) as CleanupRecord;
  validateRecord(parsed, recordPath, dependencies.rootDirectory);
  return parsed;
}

export async function writeRecord(
  dependencies: ResolvedCleanupDependencies,
  recordPath: string,
  record: CleanupRecord,
  exclusive: boolean,
): Promise<void> {
  const temporaryPath = `${recordPath}.tmp-${dependencies.processId}-${randomBytes(6).toString('hex')}`;
  await writePrivateFile(dependencies, temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
  try {
    if (exclusive) {
      try {
        await dependencies.link(temporaryPath, recordPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`Cleanup record already exists for run "${record.runId}"`);
        }
        throw error;
      }
      await dependencies.unlink(temporaryPath);
    } else {
      await dependencies.rename(temporaryPath, recordPath);
    }
    const directory = await dependencies.open(dependencies.rootDirectory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await dependencies.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function writePrivateFile(
  dependencies: ResolvedCleanupDependencies,
  filePath: string,
  contents: string,
): Promise<void> {
  const handle = await dependencies.open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function unmountVirtiofsdResources(
  dependencies: ResolvedCleanupDependencies,
  record: CleanupRecord,
  umountPath: string,
): Promise<void> {
  for (const expected of [...record.mounts].sort(
    (left, right) => right.mountPoint.length - left.mountPoint.length,
  )) {
    const current = (await readRegistryMounts(dependencies)).find(
      (mount) => mount.mountPoint === expected.mountPoint,
    );
    if (!current) continue;
    if (!sameMountIdentity(current, expected)) {
      throw new Error(`mount identity changed: ${expected.mountPoint}`);
    }
    await runChecked(dependencies.run, umountPath, [expected.mountPoint]);
  }
}

async function readRegistryMounts(
  dependencies: ResolvedCleanupDependencies,
): Promise<MountIdentity[]> {
  return readMounts(dependencies.readFile);
}

export async function assertNoMountsUnder(
  dependencies: ResolvedCleanupDependencies,
  directory: string,
): Promise<void> {
  const remaining = (await readRegistryMounts(dependencies)).filter((mount) =>
    mount.mountPoint === directory || mount.mountPoint.startsWith(`${directory}${path.sep}`),
  );
  if (remaining.length > 0) {
    throw new Error(
      `refusing recursive removal while mounts remain under ${directory}: ` +
      remaining.map((mount) => mount.mountPoint).join(', '),
    );
  }
}

export async function removeExactDirectory(
  directory: string,
  expected: FileIdentity | undefined,
  dependencies: ResolvedCleanupDependencies,
  recursive: boolean,
): Promise<void> {
  if (!(await pathExists(directory, dependencies.lstat))) return;
  if (!expected) throw new Error(`${directory} exists without a committed identity`);
  const current = await dependencies.lstat(directory, { bigint: true });
  if (
    current.dev.toString() !== expected.device ||
    current.ino.toString() !== expected.inode
  ) throw new Error(`${directory} identity changed`);
  if (recursive) {
    await dependencies.rm(directory, { recursive: true, force: false });
    return;
  }
  const deadline = Date.now() + CGROUP_REMOVAL_WAIT_MS;
  for (;;) {
    try {
      await dependencies.rmdir(directory);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EBUSY' && code !== 'ENOTEMPTY') || Date.now() >= deadline) throw error;
      const retryIdentity = await dependencies.lstat(directory, { bigint: true });
      if (
        retryIdentity.dev.toString() !== expected.device ||
        retryIdentity.ino.toString() !== expected.inode
      ) throw new Error(`${directory} identity changed during cgroup drain`);
      await dependencies.sleep(CGROUP_REMOVAL_INTERVAL_MS);
    }
  }
}

/**
 * Takes exclusive ownership of a stale cleanup record, returning a release
 * callback, or `undefined` when another live process already owns it.
 */
export async function claimRecord(
  dependencies: ResolvedCleanupDependencies,
  recordPath: string,
): Promise<(() => Promise<void>) | undefined> {
  const lockPath = `${recordPath}.lock`;
  const owner = await captureProcessIdentity(dependencies, dependencies.processId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await hasActiveRenamedClaim(dependencies, recordPath)) return undefined;
    const temporaryPath = `${lockPath}.tmp-${dependencies.processId}-${randomBytes(6).toString('hex')}`;
    await writePrivateFile(dependencies, temporaryPath, `${JSON.stringify(owner)}\n`);
    let acquired = false;
    try {
      await dependencies.link(temporaryPath, lockPath);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await dependencies.unlink(temporaryPath).catch(() => undefined);
    }
    if (acquired) {
      if (await hasActiveRenamedClaim(dependencies, recordPath)) {
        await dependencies.unlink(lockPath).catch(() => undefined);
        return undefined;
      }
      return async () => {
        await dependencies.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      };
    }
    const before = await lstatIfPresent(dependencies, lockPath);
    if (!before) continue;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== 0n ||
      (before.mode & 0o777n) !== 0o600n
    ) throw new Error(`cleanup claim has unsafe ownership or mode: ${lockPath}`);
    let existing: ProcessIdentity;
    try {
      existing = JSON.parse(await dependencies.readFile(lockPath, 'utf8')) as ProcessIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`cleanup claim is unreadable; refusing to replace it: ${formatError(error)}`);
    }
    validateProcessIdentity(existing, 'cleanup claim owner');
    if (await processMatches(dependencies, existing)) return undefined;
    const claimedPath = `${lockPath}-claimed-owner`;
    const claimedTemporaryPath = `${claimedPath}.tmp-${dependencies.processId}-${randomBytes(6).toString('hex')}`;
    await writePrivateFile(dependencies, claimedTemporaryPath, `${JSON.stringify(owner)}\n`);
    try {
      await dependencies.link(claimedTemporaryPath, claimedPath);
    } catch (error) {
      await dependencies.unlink(claimedTemporaryPath).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw error;
    }
    await dependencies.unlink(claimedTemporaryPath);
    const current = await lstatIfPresent(dependencies, lockPath);
    if (current && (before.dev !== current.dev || before.ino !== current.ino)) {
      await dependencies.unlink(claimedPath);
      return undefined;
    }
    if (current) await dependencies.unlink(lockPath);
    return async () => {
      await dependencies.unlink(claimedPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    };
  }
  throw new Error(`could not atomically claim stale cleanup record: ${recordPath}`);
}

async function lstatIfPresent(
  dependencies: ResolvedCleanupDependencies,
  filePath: string,
): Promise<BigIntStats | undefined> {
  return dependencies.lstat(filePath, { bigint: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
}

async function hasActiveRenamedClaim(
  dependencies: ResolvedCleanupDependencies,
  recordPath: string,
): Promise<boolean> {
  const prefix = `${path.basename(recordPath)}.lock-claimed-`;
  for (const name of await dependencies.readdir(dependencies.rootDirectory)) {
    if (!name.startsWith(prefix)) continue;
    const claimPath = path.join(dependencies.rootDirectory, name);
    let owner: ProcessIdentity;
    try {
      owner = JSON.parse(await dependencies.readFile(claimPath, 'utf8')) as ProcessIdentity;
    } catch (error) {
      throw new Error(`cleanup claim is unreadable; refusing to replace it: ${formatError(error)}`);
    }
    validateProcessIdentity(owner, 'renamed cleanup claim owner');
    if (await processMatches(dependencies, owner)) return true;
    await dependencies.unlink(claimPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return false;
}
