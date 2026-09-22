import { promises as fs } from 'fs';
import type { PathLike } from 'fs';
import * as path from 'path';
import {
  DurableNvxCleanupRegistry,
  type NvxCleanupRegistryDependencies,
  type NvxCleanupToolPaths,
} from './cleanup-registry';
import { NvxCleanupStore, type NvxCleanupStoreDependencies } from './cleanup-store';

const RUN_ID = 'c'.repeat(32);
const tools: NvxCleanupToolPaths = {
  getent: '/usr/bin/getent',
  groupdel: '/usr/sbin/groupdel',
  id: '/usr/bin/id',
  ip: '/usr/sbin/ip',
  iptables: '/usr/sbin/iptables',
  setfacl: '/usr/bin/setfacl',
  userdel: '/usr/sbin/userdel',
};

describe('DurableNvxCleanupRegistry', () => {
  let root: string;
  let ownerAlive: boolean;
  let run: jest.Mock;
  let registry: DurableNvxCleanupRegistry;
  let store: NvxCleanupStore;

  beforeEach(async () => {
    root = path.join(process.cwd(), `.nvx-cleanup-test-${process.pid}-${Date.now()}`);
    ownerAlive = true;
    const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
      const value = await fs.lstat(filePath, options as never);
      return Object.assign(value, {
        uid: (options as { bigint?: boolean } | undefined)?.bigint ? 0n : 0,
      });
    }) as typeof fs.lstat;
    const processIdentity = {
      pid: 4242,
      startTimeTicks: '1000',
      executable: '/usr/bin/node',
      executableDevice: '8',
      executableInode: '9',
      uid: 0,
      gid: 0,
      networkNamespace: 'net:[4026531840]',
    };
    const readFile: typeof fs.readFile = (async (filePath: PathLike, options?: unknown) => {
      const value = String(filePath);
      if (value === '/proc/4242/stat') {
        return `4242 (node) ${['S', ...Array(18).fill('0'), ownerAlive ? '1000' : '2000'].join(' ')}`;
      }
      if (value === '/proc/4242/status') {
        return 'Uid:\t0 0 0 0\nGid:\t0 0 0 0\n';
      }
      return fs.readFile(filePath, options as never);
    }) as typeof fs.readFile;
    const readlink: typeof fs.readlink = (async (filePath: PathLike) => {
      if (String(filePath) === '/proc/4242/exe') return '/usr/bin/node';
      if (String(filePath) === '/proc/4242/ns/net') return 'net:[4026531840]';
      return fs.readlink(filePath);
    }) as typeof fs.readlink;
    const stat: typeof fs.stat = (async (filePath: PathLike, options?: unknown) => {
      if (String(filePath) === '/proc/4242/exe') {
        return { dev: 8n, ino: 9n } as never;
      }
      return fs.stat(filePath, options as never);
    }) as typeof fs.stat;
    const processMatches = jest.fn(async (identity) =>
      ownerAlive && identity.pid === processIdentity.pid &&
      identity.startTimeTicks === processIdentity.startTimeTicks);
    store = new NvxCleanupStore({
      effectiveUid: 0,
      pid: 4242,
      lstat,
      processMatches,
    } satisfies Partial<NvxCleanupStoreDependencies>, root);
    run = jest.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' }));
    const dependencies: NvxCleanupRegistryDependencies = {
      store,
      pid: 4242,
      lstat,
      stat,
      readFile,
      readlink,
      rm: fs.rm,
      rmdir: fs.rmdir,
      kill: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      run,
    };
    registry = new DurableNvxCleanupRegistry(dependencies);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates an atomic private pending record with a process owner identity', async () => {
    await registry.createPending(RUN_ID);
    const recordPath = path.join(root, `${RUN_ID}.json`);
    const record = await store.read(recordPath);
    expect(record.owner).toMatchObject({
      pid: 4242,
      startTimeTicks: '1000',
      executable: '/usr/bin/node',
    });
    expect(record.vmmIdentity).toBeUndefined();
    expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it('skips a live owner and reaps the same record after the owner becomes stale', async () => {
    await registry.createPending(RUN_ID);
    const recordPath = path.join(root, `${RUN_ID}.json`);
    await registry.reapPending(tools);
    await expect(fs.access(recordPath)).resolves.toBeUndefined();

    ownerAlive = false;
    await registry.reapPending(tools);
    await expect(fs.access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains a stale record when pending account ownership is ambiguous', async () => {
    const handle = await registry.createPending(RUN_ID);
    await handle.prepareAccount(`awfnvx-${'d'.repeat(20)}`);
    ownerAlive = false;
    run.mockResolvedValue({ exitCode: 0, stdout: '23001\n', stderr: '' });

    await expect(registry.reapPending(tools)).rejects.toThrow(
      /unverified pending NVX account/,
    );
    await expect(fs.access(path.join(root, `${RUN_ID}.json`))).resolves.toBeUndefined();
  });

  it('reaps an exactly validated account left pending after useradd', async () => {
    const name = `awfnvx-${'d'.repeat(20)}`;
    const handle = await registry.createPending(RUN_ID);
    await handle.prepareAccount(name);
    ownerAlive = false;
    run.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'passwd') {
        return {
          exitCode: 0,
          stdout: `${name}:x:23001:23002:AWF NVX ${RUN_ID}:/nonexistent:/usr/sbin/nologin\n`,
          stderr: '',
        };
      }
      if (args[0] === 'group') {
        return { exitCode: 0, stdout: `${name}:x:23002:\n`, stderr: '' };
      }
      if (args[0] === '-G') {
        return { exitCode: 0, stdout: '23002\n', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await expect(registry.reapPending(tools)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(tools.userdel, [name]);
    expect(run).toHaveBeenCalledWith(tools.groupdel, [name]);
  });

  it('allows only one concurrent cleanup claimant', async () => {
    const handle = await registry.createPending(RUN_ID);
    const recordPath = path.join(root, `${RUN_ID}.json`);
    const first = await store.claim(recordPath, handle.record.owner);
    expect(first).toBeDefined();
    const second = await store.claim(recordPath, handle.record.owner);
    expect(second).toBeUndefined();
    await first?.();
  });
});
