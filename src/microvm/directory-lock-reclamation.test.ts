import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { withNvxDeviceAclLock, type NvxRuntimeLifecycleDependencies } from '../nvx/runtime-lifecycle';
import { withCloudHypervisorDeviceAclLock } from '../cloud-hypervisor/vmm-identity';
import { tools } from '../cloud-hypervisor/vmm-identity.test-utils';
import { readProcessStartTime } from './identity-utils';

describe.each(['NVX', 'Cloud Hypervisor'])('%s shared directory-lock reclamation', (flavor) => {
  let root: string;
  let dependencies: NvxRuntimeLifecycleDependencies;
  let withLock: (operation: () => Promise<void>) => Promise<void>;
  const staleOwner = { pid: 2_147_483_647, startTime: '1', nonce: 'a'.repeat(32) };
  const lockName = '.device-acl-lock';
  const translate = (filePath: string): string =>
    filePath.replace(/^\/run\/awf-(nvx|cloud-hypervisor)/, root);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-directory-lock-'));
    dependencies = {
      mkdir: (directory, options) => fs.mkdir(translate(directory), options),
      writeFile: (filePath, contents, options) => fs.writeFile(translate(filePath), contents, options),
      readFile: (filePath, encoding) => fs.readFile(translate(filePath), encoding),
      rm: jest.fn((filePath, options) => fs.rm(translate(filePath), options)),
      rename: jest.fn((from, to) => fs.rename(translate(from), translate(to))),
      rmdir: (directory) => fs.rmdir(translate(directory)),
      lstat: (filePath) => fs.lstat(translate(filePath)),
      run: jest.fn().mockRejectedValue(new Error('Account tools must not run')),
      sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
      pid: process.pid,
      processStartTime: readProcessStartTime,
    };
    withLock = (operation) => flavor === 'NVX'
      ? withNvxDeviceAclLock(operation, dependencies)
      : withCloudHypervisorDeviceAclLock(tools, operation, dependencies);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedLock(owner?: unknown): Promise<void> {
    await fs.mkdir(path.join(root, lockName));
    if (owner !== undefined) {
      await fs.writeFile(path.join(root, lockName, 'owner.json'), JSON.stringify(owner));
    }
  }

  it('quarantines and reclaims a dead owner before acquiring the lock', async () => {
    await seedLock(staleOwner);
    const operation = jest.fn().mockResolvedValue(undefined);
    await withLock(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(dependencies.rename).toHaveBeenCalledWith(
      expect.stringMatching(/\.device-acl-lock$/),
      expect.stringMatching(/\.device-acl-lock\.stale-[a-f0-9]{32}$/),
    );
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('reclaims an old incomplete lock without refreshing its mtime', async () => {
    await seedLock();
    await fs.utimes(path.join(root, lockName), new Date(0), new Date(0));
    await withLock(async () => undefined);
    expect(dependencies.rename).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('does not evict an old reaper claim or delete a lock through it', async () => {
    await seedLock(staleOwner);
    const reaper = path.join(root, `${lockName}.reaper`);
    await fs.mkdir(reaper);
    await fs.utimes(reaper, new Date(0), new Date(0));
    dependencies.sleep = async () => { throw new Error('stop waiting'); };
    await expect(withLock(async () => undefined)).rejects.toThrow('stop waiting');
    expect(dependencies.rename).not.toHaveBeenCalled();
    expect(dependencies.rm).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([lockName, `${lockName}.reaper`]);
  });

  it.each(['live owner', 'quarantine-read error'])(
    'blocks a delayed creator during quarantine verification: %s', async (race) => {
      let resumeCreator!: () => void;
      let creatorPaused!: () => void;
      let ownerPublished!: () => void;
      const resume = new Promise<void>((resolve) => { resumeCreator = resolve; });
      const paused = new Promise<void>((resolve) => { creatorPaused = resolve; });
      const published = new Promise<void>((resolve) => { ownerPublished = resolve; });
      const writeFile = dependencies.writeFile;
      let firstWrite = true;
      const readFile = dependencies.readFile;
      dependencies.readFile = async (filePath, encoding) => {
        if (filePath.includes('.stale-') && race === 'quarantine-read error') {
          throw new Error('quarantine read failed');
        }
        return readFile(filePath, encoding);
      };
      dependencies.writeFile = async (filePath, contents, options) => {
        if (firstWrite) {
          firstWrite = false;
          creatorPaused();
          await resume;
          await writeFile(filePath, contents, options);
          ownerPublished();
        } else {
          await writeFile(filePath, contents, options);
        }
      };
      const operation = jest.fn().mockResolvedValue(undefined);
      const creator = withLock(operation).catch((error: unknown) => error);
      await paused;
      await fs.utimes(path.join(root, lockName), new Date(0), new Date(0));
      const rename = dependencies.rename;
      dependencies.rename = async (from, to) => {
        resumeCreator();
        await published;
        // The creator has published ownership but cannot enter its operation
        // while the reaper holds the admission barrier.
        expect(operation).not.toHaveBeenCalled();
        await rename(from, to);
      };
      await expect(withLock(operation)).rejects.toThrow(
        race === 'live owner' ? 'reclamation raced' : 'quarantine read failed',
      );
      await expect(creator).resolves.toBeInstanceOf(Error);
      expect(operation).not.toHaveBeenCalled();
      expect(dependencies.rm).not.toHaveBeenCalled();
    },
  );

  it.each(['live owner', 'fresh incomplete lock'])('preserves a %s', async (kind) => {
    await seedLock(kind === 'live owner' ? {
      ...staleOwner, pid: process.pid, startTime: await readProcessStartTime(process.pid),
    } : undefined);
    dependencies.sleep = async () => { throw new Error('stop waiting'); };
    const operation = jest.fn();
    await expect(withLock(operation)).rejects.toThrow('stop waiting');
    expect(operation).not.toHaveBeenCalled();
    expect(dependencies.rename).not.toHaveBeenCalled();
    expect(dependencies.rm).not.toHaveBeenCalled();
  });

  it('propagates process-read errors without reclaiming the lock', async () => {
    await seedLock(staleOwner);
    dependencies.processStartTime = (pid) => pid === process.pid
      ? readProcessStartTime(pid)
      : readProcessStartTime(pid, async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      });
    await expect(withLock(async () => undefined)).rejects.toThrow('denied');
    expect(dependencies.rename).not.toHaveBeenCalled();
    expect(dependencies.rm).not.toHaveBeenCalled();
  });

  it('serializes competing stale-lock reclaimers', async () => {
    await seedLock(staleOwner);
    let active = 0;
    const operation = jest.fn(async () => {
      active += 1;
      expect(active).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
    });
    await Promise.all(Array.from({ length: 4 }, () => withLock(operation)));
    expect(operation).toHaveBeenCalledTimes(4);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('serializes competing callers and releases the lock on operation failure', async () => {
    const events: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const first = withLock(async () => {
      events.push('first');
      entered();
      await gate;
      events.push('released');
    });
    await ready;
    const second = withLock(async () => { events.push('second'); });
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first', 'released', 'second']);
    await expect(withLock(async () => { throw new Error('operation failed'); }))
      .rejects.toThrow('operation failed');
    expect(await fs.readdir(root)).toEqual([]);
  });
});
