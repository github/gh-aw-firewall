import {
  CloudHypervisorVmmIdentityManager,
  cloudHypervisorVmmIdentityTestHelpers,
} from './vmm-identity';
import { dependencies, tools } from './vmm-identity.test-utils';

describe('CloudHypervisorVmmIdentityManager locking', () => {
  it('serializes concurrent allocation calls on one manager', async () => {
    let releaseUseradd!: () => void;
    const useraddGate = new Promise<void>((resolve) => {
      releaseUseradd = resolve;
    });

    const base = dependencies({
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    const originalRun = base.deps.run;
    base.deps.run = jest.fn(async (command, args) => {
      if (command === tools.useradd) await useraddGate;
      return originalRun(command, args);
    });
    const manager = new CloudHypervisorVmmIdentityManager('concurrent', tools, base.deps);

    const first = manager.allocate();
    const second = manager.allocate();
    releaseUseradd();

    const [firstIdentity, secondIdentity] = await Promise.all([first, second]);
    expect(secondIdentity).toEqual(firstIdentity);
    expect((base.deps.run as jest.Mock).mock.calls.filter(
      ([command]) => command === tools.useradd,
    )).toHaveLength(1);
  });

  it('rejects invalid allocator identity output and missing lock-owner process metadata', async () => {
    const invalidBase = dependencies();
    const invalidOriginalRun = invalidBase.deps.run;
    invalidBase.deps.run = jest.fn(async (command, args) => {
      const result = await invalidOriginalRun(command, args);
      if (command === tools.id && args[0] === '-u') return { stdout: '0\n', stderr: '' };
      return result;
    });
    const invalidManager = new CloudHypervisorVmmIdentityManager(
      'invalid-identity',
      tools,
      invalidBase.deps,
    );
    await expect(invalidManager.allocate()).rejects.toThrow(/invalid uid/);

    const missingStart = dependencies({
      processStartTime: jest.fn().mockResolvedValue(undefined),
    });
    const missingStartManager = new CloudHypervisorVmmIdentityManager(
      'missing-start',
      tools,
      missingStart.deps,
    );
    await expect(missingStartManager.allocate()).rejects.toThrow(/Cannot determine AWF process start time/);
  });

  it('treats a missing process as a stale lock owner', async () => {
    await expect(cloudHypervisorVmmIdentityTestHelpers.readProcessStartTime(2_147_483_647))
      .resolves.toBeUndefined();
  });

  it('strictly validates lock owners and positive numeric account identifiers', () => {
    const valid = { pid: 1234, startTime: '99', nonce: 'a'.repeat(32) };
    expect(cloudHypervisorVmmIdentityTestHelpers.isLockOwner(valid)).toBe(true);
    for (const invalid of [
      { ...valid, pid: 0 },
      { ...valid, pid: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, startTime: 99 },
      { ...valid, startTime: 'not-numeric' },
      { ...valid, nonce: 123 },
      { ...valid, nonce: 'not-a-nonce' },
    ]) {
      expect(cloudHypervisorVmmIdentityTestHelpers.isLockOwner(invalid as never)).toBe(false);
    }
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(valid, valid)).toBe(true);
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(
      valid,
      { ...valid, nonce: 'b'.repeat(32) },
    )).toBe(false);
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(
      valid,
      { ...valid, pid: 4321 },
    )).toBe(false);
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(
      valid,
      { ...valid, startTime: '100' },
    )).toBe(false);
    expect(cloudHypervisorVmmIdentityTestHelpers.isSameLockOwner(
      valid,
      { ...valid, nonce: 'invalid' },
    )).toBe(false);
    expect(cloudHypervisorVmmIdentityTestHelpers.parsePositiveInteger('42\n', 'uid')).toBe(42);
    expect(() => cloudHypervisorVmmIdentityTestHelpers.parsePositiveInteger(
      '9007199254740992',
      'uid',
    )).toThrow(/unsafe uid/);
    expect(cloudHypervisorVmmIdentityTestHelpers.formatError(new Error('failure'))).toBe('failure');
    expect(cloudHypervisorVmmIdentityTestHelpers.formatError('failure')).toBe('failure');
    const processFields = Array.from({ length: 20 }, (_, index) => String(index));
    processFields[19] = '777';
    expect(cloudHypervisorVmmIdentityTestHelpers.parseProcessStatStartTime(
      `123 (command with spaces) ${processFields.join(' ')}`,
    )).toBe('777');
  });

  it('waits for a live account-lock owner instead of reclaiming it', async () => {
    let lockExists = true;
    const owner = { pid: 4321, startTime: '77', nonce: 'a'.repeat(32) };
    let ownerContents = `${JSON.stringify(owner)}\n`;
    const base = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          lockExists = true;
        }
      }),
      writeFile: jest.fn(async (_filePath, contents) => {
        ownerContents = contents;
      }),
      readFile: jest.fn(async () => ownerContents),
      lstat: jest.fn().mockResolvedValue({ uid: 0, gid: 0, ino: 42, mtimeMs: 0 }),
      processStartTime: jest.fn(async (pid) => pid === owner.pid ? owner.startTime : '99'),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    const manager = new CloudHypervisorVmmIdentityManager('live-lock', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
    expect(base.deps.rm).toHaveBeenCalledTimes(1);
  });

  it('waits for a fresh incomplete account lock', async () => {
    let lockExists = true;
    let ownerContents = '{';
    const base = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          lockExists = true;
        }
      }),
      writeFile: jest.fn(async (_filePath, contents) => {
        ownerContents = contents;
      }),
      readFile: jest.fn(async () => ownerContents),
      lstat: jest.fn().mockResolvedValue({
        uid: 0,
        gid: 0,
        ino: 42,
        mtimeMs: Date.now(),
      }),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    const manager = new CloudHypervisorVmmIdentityManager('fresh-lock', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
  });

  it('backs off when another process owns stale-lock reclamation', async () => {
    let lockExists = true;
    let reaperExists = true;
    const owner = { pid: 4321, startTime: '77', nonce: 'a'.repeat(32) };
    let ownerContents = `${JSON.stringify(owner)}\n`;
    const base = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.reaper')) {
          if (reaperExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          reaperExists = true;
        } else if (directory.endsWith('.account-lock')) {
          if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          lockExists = true;
        }
      }),
      writeFile: jest.fn(async (_filePath, contents) => {
        ownerContents = contents;
      }),
      readFile: jest.fn(async () => ownerContents),
      lstat: jest.fn(async (filePath) => ({
        uid: 0,
        gid: 0,
        ino: 42,
        mtimeMs: filePath.endsWith('.reaper') ? 0 : Date.now(),
      })),
      processStartTime: jest.fn(async (pid) => pid === 4321 ? 'stale' : '99'),
      rmdir: jest.fn(async () => {
        reaperExists = false;
      }),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    const manager = new CloudHypervisorVmmIdentityManager('reaper-lock', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
    expect(base.deps.rmdir).toHaveBeenCalled();
  });

  it('does not reap a lock whose inode changes after claiming the reaper', async () => {
    let lockExists = true;
    let ownerContents = `${JSON.stringify({
      pid: 4321,
      startTime: '77',
      nonce: 'a'.repeat(32),
    })}\n`;
    let lockStatsReads = 0;
    const base = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          lockExists = true;
        }
      }),
      writeFile: jest.fn(async (_filePath, contents) => {
        ownerContents = contents;
      }),
      readFile: jest.fn(async () => ownerContents),
      lstat: jest.fn(async () => ({
        uid: 0,
        gid: 0,
        ino: ++lockStatsReads === 1 ? 42 : 43,
        mtimeMs: 0,
      })),
      processStartTime: jest.fn(async (pid) => pid === 4321 ? 'stale' : '99'),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    const manager = new CloudHypervisorVmmIdentityManager('replaced-lock', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
    expect(base.deps.rm).toHaveBeenCalledTimes(1);
  });

  it('revalidates stale-lock liveness and freshness after claiming the reaper', async () => {
    const owner = { pid: 4321, startTime: '77', nonce: 'a'.repeat(32) };
    let lockExists = true;
    let ownerContents = `${JSON.stringify(owner)}\n`;
    let ownerChecks = 0;
    const becameLive = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          lockExists = true;
        }
      }),
      writeFile: jest.fn(async (_filePath, contents) => {
        ownerContents = contents;
      }),
      readFile: jest.fn(async () => ownerContents),
      lstat: jest.fn().mockResolvedValue({ uid: 0, gid: 0, ino: 42, mtimeMs: 0 }),
      processStartTime: jest.fn(async (pid) => {
        if (pid !== owner.pid) return '99';
        return ownerChecks++ === 0 ? 'stale' : owner.startTime;
      }),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'became-live-lock',
      tools,
      becameLive.deps,
    ).allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });

    lockExists = true;
    ownerContents = '';
    let statsReads = 0;
    const becameFresh = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          lockExists = true;
        }
      }),
      writeFile: jest.fn(async (_filePath, contents) => {
        ownerContents = contents;
      }),
      readFile: jest.fn(async () => ownerContents),
      lstat: jest.fn(async () => ({
        uid: 0,
        gid: 0,
        ino: 42,
        mtimeMs: statsReads++ === 0 ? 0 : Date.now(),
      })),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'became-fresh-lock',
      tools,
      becameFresh.deps,
    ).allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
  });

  it('surfaces unexpected stale-lock metadata errors', async () => {
    const unreadable = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
      }),
      lstat: jest.fn().mockResolvedValue({ uid: 0, gid: 0, ino: 42, mtimeMs: 0 }),
      readFile: jest.fn(async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'unreadable-lock',
      tools,
      unreadable.deps,
    ).allocate()).rejects.toThrow('denied');

    const reaperDenied = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory === '/run/awf-cloud-hypervisor') return;
        throw Object.assign(
          new Error('denied'),
          { code: directory.endsWith('.reaper') ? 'EACCES' : 'EEXIST' },
        );
      }),
      lstat: jest.fn().mockResolvedValue({ uid: 0, gid: 0, ino: 42, mtimeMs: 0 }),
      readFile: jest.fn(async () => ''),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'reaper-denied',
      tools,
      reaperDenied.deps,
    ).allocate()).rejects.toThrow('denied');
  });

  it('handles missing and unexpected lock-stat failures', async () => {
    const now = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(10_001);
    const missing = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
      }),
      lstat: jest.fn(async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'missing-lock',
      tools,
      missing.deps,
    ).allocate()).rejects.toThrow(/Timed out waiting/);
    now.mockRestore();

    const denied = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.account-lock')) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
      }),
      lstat: jest.fn(async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'lock-stat-denied',
      tools,
      denied.deps,
    ).allocate()).rejects.toThrow('denied');
  });

  it('backs off when a competing reaper disappears', async () => {
    let lockExists = true;
    const owner = { pid: 4321, startTime: '77', nonce: 'a'.repeat(32) };
    let ownerContents = `${JSON.stringify(owner)}\n`;
    const base = dependencies({
      mkdir: jest.fn(async (directory) => {
        if (directory.endsWith('.reaper')) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
        if (directory.endsWith('.account-lock')) {
          if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
          lockExists = true;
        }
      }),
      writeFile: jest.fn(async (_filePath, contents) => {
        ownerContents = contents;
      }),
      readFile: jest.fn(async () => ownerContents),
      lstat: jest.fn(async (filePath) => {
        if (filePath.endsWith('.reaper')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return { uid: 0, gid: 0, ino: 42, mtimeMs: 0 };
      }),
      processStartTime: jest.fn(async (pid) => pid === owner.pid ? 'stale' : '99'),
      sleep: jest.fn(async () => {
        lockExists = false;
      }),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'vanished-reaper',
      tools,
      base.deps,
    ).allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
  });

  it('detects identity replacement while waiting to grant device access', async () => {
    const base = dependencies();
    const manager = new CloudHypervisorVmmIdentityManager('changed-identity', tools, base.deps);
    await manager.allocate();
    let lockAttempt = 0;
    base.deps.mkdir = jest.fn(async (directory) => {
      if (directory.endsWith('.device-acl-lock') && lockAttempt++ === 0) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
    });
    base.deps.lstat = jest.fn(async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    base.deps.sleep = jest.fn(async () => {
      Reflect.set(manager, 'identity', undefined);
    });

    await expect(manager.withDeviceAccess(async () => undefined)).rejects.toThrow(/identity changed/);
  });

  it('rejects removal when acquired lock ownership changes', async () => {
    let ownerContents = '';
    const base = dependencies({
      writeFile: jest.fn(async (_filePath, contents) => {
        const owner = JSON.parse(contents) as { pid: number; startTime: string; nonce: string };
        ownerContents = JSON.stringify({ ...owner, nonce: 'b'.repeat(32) });
      }),
      readFile: jest.fn(async () => ownerContents),
    });
    await expect(new CloudHypervisorVmmIdentityManager(
      'changed-owner',
      tools,
      base.deps,
    ).allocate()).rejects.toThrow(/lock ownership changed unexpectedly/);
  });

  it('recovers a stale zero-byte lock without racing a replacement owner', async () => {
    const base = dependencies();
    let lockExists = true;
    let reaperExists = false;
    let ownerContents = '';
    base.deps.mkdir = jest.fn(async (directory) => {
      if (directory.endsWith('.reaper')) {
        if (reaperExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        reaperExists = true;
      } else if (directory.endsWith('.account-lock')) {
        if (lockExists) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        lockExists = true;
      }
    });
    base.deps.writeFile = jest.fn(async (filePath, contents) => {
      if (filePath.endsWith('owner.json')) ownerContents = contents;
    });
    base.deps.readFile = jest.fn(async () => ownerContents);
    base.deps.lstat = jest.fn(async (filePath) => {
      if (filePath.endsWith('.reaper') && !reaperExists) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (!lockExists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { uid: 0, gid: 0, ino: 42, mtimeMs: 0 };
    });
    base.deps.rm = jest.fn(async (filePath) => {
      if (filePath.endsWith('.account-lock')) {
        lockExists = false;
        reaperExists = false;
      }
    });
    base.deps.rmdir = jest.fn(async () => {
      if (!reaperExists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      reaperExists = false;
    });
    const manager = new CloudHypervisorVmmIdentityManager('run-4', tools, base.deps);

    await expect(manager.allocate()).resolves.toMatchObject({ uid: 23001, gid: 23002 });
    expect(base.deps.rm).toHaveBeenCalledWith(
      '/run/awf-cloud-hypervisor/.account-lock',
      { recursive: true, force: true },
    );
  });
});
