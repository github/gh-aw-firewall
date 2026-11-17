import {
  readDirectoryLockOwner,
  reclaimStaleDirectoryLock,
  removeOwnedDirectoryLock,
  withDirectoryLock,
  type DirectoryLockDependencies,
  type DirectoryLockOwner,
  type DirectoryLockReclamationDependencies,
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
    readFile: async () => recorded.writeFile[recorded.writeFile.length - 1].contents,
    rmdir: async () => undefined,
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

describe('shared directory-lock ownership and reclamation', () => {
  const directory = '/run/awf-test/.lock';
  const owner = { pid: 4321, startTime: '77', nonce: 'a'.repeat(32) };
  const stats = { dev: 5, ino: 42, mtimeMs: 0 };

  function dependencies() {
    return {
      mkdir: jest.fn().mockResolvedValue(undefined),
      sleep: jest.fn().mockResolvedValue(undefined),
      readFile: jest.fn().mockResolvedValue(JSON.stringify(owner)),
      rm: jest.fn().mockResolvedValue(undefined),
      rename: jest.fn().mockResolvedValue(undefined),
      rmdir: jest.fn().mockResolvedValue(undefined),
      lstat: jest.fn().mockResolvedValue(stats),
      processStartTime: jest.fn().mockResolvedValue(undefined),
    } satisfies DirectoryLockReclamationDependencies;
  }

  it.each(['null', '[]', '{}', '{', '{"pid":0}', '"owner"'])(
    'tolerates invalid owner metadata %s', async (contents) => {
      const deps = dependencies();
      deps.readFile.mockResolvedValue(contents);
      await expect(readDirectoryLockOwner(deps, directory)).resolves.toBeUndefined();
    },
  );

  it.each(['pid', 'startTime', 'nonce'])('refuses release after a changed %s', async (field) => {
    const deps = dependencies();
    deps.readFile.mockResolvedValue(JSON.stringify({ ...owner, [field]: 'changed' }));
    await expect(removeOwnedDirectoryLock(deps, directory, owner, 'ownership changed'))
      .rejects.toThrow('ownership changed');
    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('leaves release untouched when a reaper holds the admission barrier', async () => {
    const deps = dependencies();
    deps.mkdir.mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    await expect(removeOwnedDirectoryLock(deps, directory, owner, 'ownership changed'))
      .rejects.toThrow('Timed out waiting to release directory lock');
    expect(deps.readFile).not.toHaveBeenCalled();
    expect(deps.rm).not.toHaveBeenCalled();
    expect(deps.rmdir).not.toHaveBeenCalled();
  });

  it('retries release rather than silently abandoning a live-owned lock', async () => {
    const deps = dependencies();
    deps.mkdir.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    await removeOwnedDirectoryLock(deps, directory, owner, 'ownership changed', {
      timeoutMs: 1_000, retryMs: 7,
    });
    expect(deps.sleep).toHaveBeenCalledWith(7);
    expect(deps.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
    expect(deps.rmdir).toHaveBeenCalledWith(`${directory}.reaper`);
  });

  it.each([
    { ...stats, ino: 43 },
    { ...stats, dev: 6 },
    { ...stats, ino: undefined },
  ])('does not quarantine a replacement or unverifiable inode: %j', async (current) => {
    const deps = dependencies();
    deps.lstat.mockResolvedValueOnce(stats).mockResolvedValue(current);
    await reclaimStaleDirectoryLock(deps, directory);
    expect(deps.rename).not.toHaveBeenCalled();
    expect(deps.rm).not.toHaveBeenCalled();
    expect(deps.rmdir).toHaveBeenCalledWith(`${directory}.reaper`);
  });

  it('compares the nonce before quarantining even when PID/start time match', async () => {
    const deps = dependencies();
    deps.readFile.mockResolvedValueOnce(JSON.stringify(owner))
      .mockResolvedValue(JSON.stringify({ ...owner, nonce: 'b'.repeat(32) }));
    await reclaimStaleDirectoryLock(deps, directory);
    expect(deps.rename).not.toHaveBeenCalled();
    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('backs off while a competing reaper holds a claim', async () => {
    const deps = dependencies();
    deps.mkdir.mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    await reclaimStaleDirectoryLock(deps, directory);
    expect(deps.rmdir).not.toHaveBeenCalled();
    expect(deps.rename).not.toHaveBeenCalled();
    expect(deps.rm).not.toHaveBeenCalled();
  });

  it('deletes only quarantine even if another holder recreates the lock path', async () => {
    const deps = dependencies();
    await reclaimStaleDirectoryLock(deps, directory);
    const quarantine = deps.rename.mock.calls[0][1] as string;
    expect(quarantine).toMatch(/\.stale-[a-f0-9]{32}$/);
    expect(deps.rm.mock.calls).toEqual([[quarantine, { recursive: true, force: true }]]);
  });

  it.each(['inode', 'owner', 'liveness'])(
    'retains unverified quarantine on a post-rename %s race', async (race) => {
      const deps = dependencies();
      if (race === 'inode') {
        deps.lstat.mockResolvedValueOnce(stats).mockResolvedValueOnce(stats)
          .mockResolvedValue({ ...stats, ino: 43 });
      } else if (race === 'owner') {
        deps.readFile.mockResolvedValueOnce(JSON.stringify(owner))
          .mockResolvedValueOnce(JSON.stringify(owner))
          .mockResolvedValue(JSON.stringify({ ...owner, nonce: 'b'.repeat(32) }));
      } else {
        deps.processStartTime.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
          .mockResolvedValue(owner.startTime);
      }
      await expect(reclaimStaleDirectoryLock(deps, directory))
        .rejects.toThrow('reclamation raced with another lock owner');
      expect(deps.rename).toHaveBeenCalledTimes(1);
      expect(deps.rm).not.toHaveBeenCalled();
      expect(deps.rmdir).toHaveBeenCalledWith(`${directory}.reaper`);
    },
  );

  it('propagates process-read errors after quarantine without deleting it', async () => {
    const deps = dependencies();
    deps.processStartTime.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('process read failed'));
    await expect(reclaimStaleDirectoryLock(deps, directory)).rejects.toThrow('process read failed');
    expect(deps.rm).not.toHaveBeenCalled();
    expect(deps.rmdir).toHaveBeenCalledWith(`${directory}.reaper`);
  });

  it('releases its claim after a quarantine deletion error', async () => {
    const deps = dependencies();
    deps.rm.mockRejectedValue(new Error('denied'));
    await expect(reclaimStaleDirectoryLock(deps, directory)).rejects.toThrow('denied');
    expect(deps.rmdir).toHaveBeenCalledWith(`${directory}.reaper`);
  });
});

describe('withDirectoryLock', () => {
  it('creates the lock, records ownership, and releases it after the operation', async () => {
    const { recorded, dependencies } = createHarness(0);

    const result = await withDirectoryLock({
      ...baseOptions(dependencies, recorded),
      operation: async () => 'done',
    });

    expect(result).toBe('done');
    expect(recorded.mkdir).toEqual([
      '/run/awf-test', '/run/awf-test/.lock', '/run/awf-test/.lock.reaper',
    ]);
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
