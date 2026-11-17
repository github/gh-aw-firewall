import { randomBytes } from 'crypto';
import * as path from 'path';

/** Ownership record written into a directory lock so stale locks can be reclaimed safely. */
export interface DirectoryLockOwner {
  readonly pid: number;
  readonly startTime: string;
  readonly nonce: string;
}

export interface DirectoryLockDependencies {
  mkdir(directory: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  writeFile(filePath: string, contents: string, options?: { flag?: string; mode?: number }): Promise<void>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  rmdir(directory: string): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  pid: number;
  processStartTime(pid: number): Promise<string | undefined>;
}

export interface DirectoryLockReclamationDependencies {
  mkdir: DirectoryLockDependencies['mkdir'];
  sleep: DirectoryLockDependencies['sleep'];
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  rm(filePath: string, options: { recursive: true; force: true }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rmdir(directory: string): Promise<void>;
  lstat(filePath: string): Promise<{
    dev?: number | bigint;
    ino?: number | bigint;
    mtimeMs?: number;
  }>;
  processStartTime: DirectoryLockDependencies['processStartTime'];
}

const INCOMPLETE_LOCK_STALE_MS = 1_000;

export function isLockOwner(value: unknown): value is DirectoryLockOwner {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<DirectoryLockOwner>;
  return Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 &&
    typeof owner.startTime === 'string' && /^\d+$/.test(owner.startTime) &&
    typeof owner.nonce === 'string' && /^[a-f0-9]{32}$/.test(owner.nonce);
}

export function isSameLockOwner(left: unknown, right: unknown): boolean {
  return isLockOwner(left) && isLockOwner(right) &&
    left.pid === right.pid && left.startTime === right.startTime && left.nonce === right.nonce;
}

export async function readDirectoryLockOwner(
  dependencies: Pick<DirectoryLockReclamationDependencies, 'readFile'>,
  lockDirectory: string,
): Promise<DirectoryLockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await dependencies.readFile(path.join(lockDirectory, 'owner.json'), 'utf8'),
    );
    return isLockOwner(parsed) ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

export async function removeOwnedDirectoryLock(
  dependencies: Pick<DirectoryLockReclamationDependencies, 'mkdir' | 'rmdir' | 'readFile' | 'rm' | 'sleep'>,
  lockDirectory: string,
  owner: DirectoryLockOwner,
  ownershipErrorMessage: string,
  options = { timeoutMs: 0, retryMs: 25 },
): Promise<void> {
  const reaperDirectory = `${lockDirectory}.reaper`;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    try {
      await dependencies.mkdir(reaperDirectory, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    // Neither successful release nor failed-entry cleanup may delete through a reaper.
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting to release directory lock: ${lockDirectory}`);
    }
    await dependencies.sleep(options.retryMs);
  }
  try {
    const current = await readDirectoryLockOwner(dependencies, lockDirectory);
    if (!isSameLockOwner(owner, current)) throw new Error(ownershipErrorMessage);
    await dependencies.rm(lockDirectory, { recursive: true, force: true });
  } finally {
    await dependencies.rmdir(reaperDirectory);
  }
}

type LockStats = Awaited<ReturnType<DirectoryLockReclamationDependencies['lstat']>>;

function sameInode(left: LockStats, right: LockStats): boolean {
  return left.ino !== undefined && right.ino !== undefined &&
    String(left.ino) === String(right.ino) && String(left.dev ?? '') === String(right.dev ?? '');
}

/**
 * Elect one reaper, revalidate identity/liveness, then quarantine atomically.
 * Only the verified quarantine is deleted, never a possibly recreated lock path.
 * Incomplete owners get a grace period; unknown inode identity fails closed.
 * A reaper claim is never evicted by age: a paused reaper may still resume.
 * After an interrupted reaper, an operator must remove its orphaned claim only
 * once all users of the lock have stopped.
 */
export async function reclaimStaleDirectoryLock(
  dependencies: DirectoryLockReclamationDependencies,
  lockDirectory: string,
): Promise<void> {
  let initialStats: LockStats;
  try {
    initialStats = await dependencies.lstat(lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (initialStats.ino === undefined) return;
  const owner = await readDirectoryLockOwner(dependencies, lockDirectory);
  const isLive = async (candidate: DirectoryLockOwner | undefined): Promise<boolean> =>
    candidate !== undefined &&
    await dependencies.processStartTime(candidate.pid) === candidate.startTime;
  const isFresh = (stats: LockStats): boolean =>
    stats.mtimeMs === undefined || Date.now() - stats.mtimeMs < INCOMPLETE_LOCK_STALE_MS;
  if (owner ? await isLive(owner) : isFresh(initialStats)) return;

  // Keep the claim outside the lock so it cannot refresh an incomplete lock's mtime.
  const reaperDirectory = `${lockDirectory}.reaper`;
  try {
    await dependencies.mkdir(reaperDirectory, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST') return;
    throw error;
  }

  try {
    const currentStats = await dependencies.lstat(lockDirectory);
    if (!sameInode(initialStats, currentStats)) return;
    const currentOwner = await readDirectoryLockOwner(dependencies, lockDirectory);
    if (owner || currentOwner) {
      if (!isSameLockOwner(owner, currentOwner) || await isLive(currentOwner)) return;
    } else if (isFresh(currentStats)) return;

    const quarantinePath = `${lockDirectory}.stale-${randomBytes(16).toString('hex')}`;
    try {
      await dependencies.rename(lockDirectory, quarantinePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return;
      throw error;
    }
    const quarantinedStats = await dependencies.lstat(quarantinePath);
    const quarantinedOwner = await readDirectoryLockOwner(dependencies, quarantinePath);
    const unchangedOwner = currentOwner || quarantinedOwner
      ? isSameLockOwner(currentOwner, quarantinedOwner)
      : true;
    if (
      !sameInode(currentStats, quarantinedStats) || !unchangedOwner ||
      (quarantinedOwner ? await isLive(quarantinedOwner) : isFresh(quarantinedStats))
    ) {
      // Do not delete unverified state or overwrite a replacement lock to restore it.
      throw new Error(`Directory lock reclamation raced with another lock owner: ${quarantinePath}`);
    }
    await dependencies.rm(quarantinePath, { recursive: true, force: true });
  } finally {
    await dependencies.rmdir(reaperDirectory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export interface DirectoryLockOptions<T> {
  readonly lockDirectory: string;
  readonly timeoutMs: number;
  readonly retryMs: number;
  readonly dependencies: DirectoryLockDependencies;
  /** Message thrown when the AWF process start time cannot be resolved. */
  readonly startTimeErrorMessage: string;
  /** Message thrown when the lock cannot be acquired before the deadline. */
  readonly timeoutErrorMessage: string;
  /** Manager-specific stale-lock recovery, invoked between acquisition attempts. */
  reclaimStaleLock(lockDirectory: string): Promise<void>;
  /** Manager-specific release that must verify ownership before removing the lock. */
  removeOwnedLock(lockDirectory: string, owner: DirectoryLockOwner): Promise<void>;
  operation(): Promise<T>;
}

/**
 * Acquires an exclusive `mkdir`-based directory lock, runs `operation`, and always
 * releases the lock through the caller-provided `removeOwnedLock` hook.
 *
 * `reclaimStaleLock` runs before the deadline check, so a contended lock is always
 * offered for stale-lock recovery at least once even when `timeoutMs` has elapsed.
 */
export async function withDirectoryLock<T>(options: DirectoryLockOptions<T>): Promise<T> {
  const { lockDirectory, dependencies } = options;
  await dependencies.mkdir(path.dirname(lockDirectory), { recursive: true, mode: 0o711 });
  const startTime = await dependencies.processStartTime(dependencies.pid);
  if (!startTime) throw new Error(options.startTimeErrorMessage);
  const owner: DirectoryLockOwner = {
    pid: dependencies.pid,
    startTime,
    nonce: randomBytes(16).toString('hex'),
  };
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    let acquired = false;
    try {
      await dependencies.mkdir(lockDirectory, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (acquired) {
      try {
        await dependencies.writeFile(
          path.join(lockDirectory, 'owner.json'),
          `${JSON.stringify(owner)}\n`,
          { flag: 'wx', mode: 0o600 },
        );
        // A creator paused before publishing owner.json must not enter while a
        // reaper verifies quarantine, even if its process is still alive.
        const reaperDirectory = `${lockDirectory}.reaper`;
        for (;;) {
          try {
            await dependencies.mkdir(reaperDirectory, { mode: 0o700 });
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          if (Date.now() >= deadline) throw new Error(options.timeoutErrorMessage);
          await dependencies.sleep(options.retryMs);
        }
        try {
          if (!isSameLockOwner(owner, await readDirectoryLockOwner(dependencies, lockDirectory))) {
            throw new Error('Directory lock ownership changed before operation');
          }
        } finally {
          await dependencies.rmdir(reaperDirectory);
        }
        return await options.operation();
      } finally {
        await options.removeOwnedLock(lockDirectory, owner);
      }
    }
    await options.reclaimStaleLock(lockDirectory);
    if (Date.now() >= deadline) throw new Error(options.timeoutErrorMessage);
    await dependencies.sleep(options.retryMs);
  }
}
