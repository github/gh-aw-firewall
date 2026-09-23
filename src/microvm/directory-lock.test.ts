import {
  withDirectoryLock,
  type DirectoryLockDependencies,
  type DirectoryLockOwner,
} from './directory-lock';

interface Recorded {
  readonly mkdir: string[];
  readonly writeFile: Array<{ path: string; contents: string; options?: unknown }>;
  readonly sleeps: number[];
  readonly reclaimed: string[];
  readonly released: DirectoryLockOwner[];
}

function createHarness(existingLockAttempts: number) {
  const recorded: Recorded = {
    mkdir: [],
    writeFile: [],
    sleeps: [],
    reclaimed: [],
    released: [],
  };
  let remainingConflicts = existingLockAttempts;
  const dependencies: DirectoryLockDependencies = {
    mkdir: async (directory) => {
      recorded.mkdir.push(directory);
      if (directory === '/run/awf-test/.lock' && remainingConflicts > 0) {
        remainingConflicts -= 1;
        const error: NodeJS.ErrnoException = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      }
      return undefined;
    },
    writeFile: async (filePath, contents, options) => {
      recorded.writeFile.push({ path: filePath, contents, options });
    },
    sleep: async (milliseconds) => {
      recorded.sleeps.push(milliseconds);
    },
    pid: 4242,
    processStartTime: async () => '991',
  };
  return { recorded, dependencies };
}

function baseOptions(
  dependencies: DirectoryLockDependencies,
  recorded: Recorded,
) {
  return {
    lockDirectory: '/run/awf-test/.lock',
    timeoutMs: 1_000,
    retryMs: 7,
    dependencies,
    startTimeErrorMessage: 'no start time',
    timeoutErrorMessage: 'timed out',
    reclaimStaleLock: async (directory: string) => {
      recorded.reclaimed.push(directory);
    },
    removeOwnedLock: async (_directory: string, owner: DirectoryLockOwner) => {
      recorded.released.push(owner);
    },
  };
}

describe('withDirectoryLock', () => {
  it('creates the lock, records ownership, and releases it after the operation', async () => {
    const { recorded, dependencies } = createHarness(0);

    const result = await withDirectoryLock({
      ...baseOptions(dependencies, recorded),
      operation: async () => 'done',
    });

    expect(result).toBe('done');
    expect(recorded.mkdir).toEqual(['/run/awf-test', '/run/awf-test/.lock']);
    expect(recorded.writeFile).toHaveLength(1);
    expect(recorded.writeFile[0].path).toBe('/run/awf-test/.lock/owner.json');
    expect(recorded.writeFile[0].options).toEqual({ flag: 'wx', mode: 0o600 });
    const owner = JSON.parse(recorded.writeFile[0].contents) as DirectoryLockOwner;
    expect(owner.pid).toBe(4242);
    expect(owner.startTime).toBe('991');
    expect(owner.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(recorded.released).toEqual([owner]);
    expect(recorded.reclaimed).toEqual([]);
  });

  it('reclaims stale locks and retries until the lock is acquired', async () => {
    const { recorded, dependencies } = createHarness(2);

    await withDirectoryLock({
      ...baseOptions(dependencies, recorded),
      operation: async () => undefined,
    });

    expect(recorded.reclaimed).toEqual(['/run/awf-test/.lock', '/run/awf-test/.lock']);
    expect(recorded.sleeps).toEqual([7, 7]);
  });

  it('releases the lock when the operation throws', async () => {
    const { recorded, dependencies } = createHarness(0);

    await expect(withDirectoryLock({
      ...baseOptions(dependencies, recorded),
      operation: async () => {
        throw new Error('operation failed');
      },
    })).rejects.toThrow('operation failed');
    expect(recorded.released).toHaveLength(1);
  });

  it('throws the caller-provided timeout message once the deadline passes', async () => {
    const { recorded, dependencies } = createHarness(Number.MAX_SAFE_INTEGER);

    await expect(withDirectoryLock({
      ...baseOptions(dependencies, recorded),
      timeoutMs: -1,
      operation: async () => undefined,
    })).rejects.toThrow('timed out');
    expect(recorded.released).toEqual([]);
  });

  it('throws the caller-provided start-time message when the pid start time is unknown', async () => {
    const { recorded, dependencies } = createHarness(0);

    await expect(withDirectoryLock({
      ...baseOptions(dependencies, recorded),
      dependencies: { ...dependencies, processStartTime: async () => undefined },
      operation: async () => undefined,
    })).rejects.toThrow('no start time');
  });

  it('propagates unexpected mkdir failures', async () => {
    const { recorded, dependencies } = createHarness(0);
    const failure: NodeJS.ErrnoException = new Error('denied');
    failure.code = 'EACCES';

    await expect(withDirectoryLock({
      ...baseOptions(dependencies, recorded),
      dependencies: {
        ...dependencies,
        mkdir: async (directory) => {
          if (directory === '/run/awf-test/.lock') throw failure;
          return undefined;
        },
      },
      operation: async () => undefined,
    })).rejects.toThrow('denied');
  });
});
