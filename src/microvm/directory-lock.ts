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
  sleep(milliseconds: number): Promise<void>;
  pid: number;
  processStartTime(pid: number): Promise<string | undefined>;
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
