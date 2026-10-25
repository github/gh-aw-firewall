import type { PathLike, promises as fs } from 'fs';
import * as path from 'path';
import { resolveCleanupDependencies } from '../cloud-hypervisor/cleanup-dependencies';
import type { MountIdentity } from '../cloud-hypervisor/cleanup-identity';
import { hostPreflightReason } from '../cloud-hypervisor/host-preflight-progress';
import { hostExecutorStorageDirectory, hostExecutorVmRunId } from './host-executor-journal';
import {
  allowedStorageMount, assertIdentity, closeStorageRecord, storageAncestors,
  trustedDirectory, validateResourceRecord, verifyStorageRecord, type ResourceRecord,
} from './host-executor-storage-records';

const identity = { device: '50', inode: '700' };

function fixture() {
  const root = '/trusted/invocations';
  const ids = { runId: 'a'.repeat(32), invocationId: 'b'.repeat(24), entryId: 'script' };
  const vmRunId = hostExecutorVmRunId(ids);
  const directory = path.join(root, ids.entryId, ids.invocationId);
  const storageDirectory = hostExecutorStorageDirectory(vmRunId);
  const mount = (mountPoint: string, mountId: number, mountRoot: string): MountIdentity => ({
    mountId, device: '0:50', root: mountRoot, mountPoint,
    filesystemType: 'tmpfs', source: 'awf-enclave-invocation',
  });
  const mounts = [
    mount(storageDirectory, 1000, '/'),
    mount(directory, 1001, '/state'),
    mount(path.join(storageDirectory, 'artifacts'), 1002, '/artifacts'),
    mount(path.join(storageDirectory, 'artifacts/run-test'), 1003, '/artifacts/run-test'),
  ];
  const record: ResourceRecord = {
    version: 1, ...ids, vmRunId,
    owner: {
      pid: 1234, startTime: '12345', executable: '/trusted/node',
      executableIdentity: identity, uid: 1000, gid: 1000, networkNamespace: 'net:[1234]',
    },
    bootId: 'boot', root, directory,
    ancestors: [root, path.dirname(directory)].map((ancestor) => ({ path: ancestor, identity })),
    directoryIdentity: identity, mountPending: false, mount: mounts[1],
    snapshotPending: false, state: 'pending',
    snapshot: {
      path: path.join(storageDirectory, 'artifacts/run-test'), identity, parentIdentity: identity,
    },
    storage: {
      directory: storageDirectory, parentIdentity: identity, directoryIdentity: identity,
      mountedIdentity: identity,
      ancestors: storageAncestors().map((ancestor) => ({ path: ancestor, identity })),
      mounts,
    },
  };
  let currentMounts = [...mounts];
  let exists = true;
  const stat = {
    uid: 1000, mode: 0o40700, dev: 50, ino: 700,
    isDirectory: () => true, isSymbolicLink: () => false,
  };
  const lstat = jest.fn(async (file: PathLike) => {
    if (String(file) === storageDirectory && !exists) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    }
    return stat;
  });
  const readFile = jest.fn(async () => currentMounts.map((value) =>
    `${value.mountId} 1 ${value.device} ${value.root} ${value.mountPoint} rw - ` +
    `${value.filesystemType} ${value.source} rw`).join('\n'));
  const run = jest.fn(async (_command: string, args: readonly string[]) => {
    currentMounts = currentMounts.filter((value) => value.mountPoint !== args[0]);
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  const rm = jest.fn(async () => { exists = false; });
  const realpath = jest.fn(async (file: PathLike) => String(file));
  const dependencies = resolveCleanupDependencies({
    effectiveUid: 1000,
    lstat: lstat as unknown as typeof fs.lstat,
    readFile: readFile as unknown as typeof fs.readFile,
    realpath: realpath as unknown as typeof fs.realpath,
    run, rm,
  });
  return {
    record, dependencies, stat, lstat, readFile, realpath, run, rm,
    file: `/trusted/journal/${ids.runId}-${ids.invocationId}.resources.json`,
    get mounts() { return currentMounts; },
    set mounts(value: MountIdentity[]) { currentMounts = value; },
    removeDirectory() { exists = false; },
  };
}

describe('host executor resource record validation', () => {
  it('accepts the aggregate layout without changing the record', () => {
    const { record, file } = fixture();
    const before = JSON.stringify(record);
    expect(() => validateResourceRecord(record, file)).not.toThrow();
    expect(JSON.stringify(record)).toBe(before);
  });

  it('accepts independent host storage backings with a matching snapshot bind', () => {
    const { record, file } = fixture();
    const storage = record.storage!;
    storage.mounts[2] = { ...storage.mounts[2], device: '0:51', root: '/' };
    storage.mounts[3] = { ...storage.mounts[3], device: '0:51', root: '/run-test' };
    expect(() => validateResourceRecord(record, file)).not.toThrow();
  });

  it.each<[string, (record: ResourceRecord) => void, string]>([
    ['VM identity', (record) => { record.vmRunId = 'f'.repeat(32); }, 'Invalid resource recovery record'],
    ['directory ownership', (record) => { record.directory = '/unrelated'; }, 'Invalid resource recovery record'],
    ['ancestor path', (record) => { record.ancestors[0].path = '/unrelated'; }, 'Invalid resource recovery record'],
    ['owner', (record) => { record.owner = { ...record.owner, pid: 1 }; }, 'host executor owner identity is malformed'],
    ['inode overflow', (record) => { record.directoryIdentity = { ...identity, inode: '18446744073709551616' }; }, 'Invalid recovery file identity'],
    ['snapshot path', (record) => { record.snapshot!.path = '/unrelated/run-test'; }, 'Invalid snapshot path'],
    ['invocation bind root', (record) => { record.mount = { ...record.mount!, root: '/' }; }, 'Invalid invocation mount record'],
    ['pending mount', (record) => { record.storage!.pending = '/unrelated'; }, 'Invalid invocation storage record'],
    ['duplicate mount', (record) => { record.storage!.mounts.push(record.storage!.mounts[0]); }, 'Invalid invocation storage record'],
    ['allocation ordering', (record) => { record.storage!.mounts.reverse(); }, 'Invalid invocation storage record'],
    ['bind backing', (record) => { record.storage!.mounts[1] = { ...record.storage!.mounts[1], device: '0:99' }; }, 'Invalid invocation storage record'],
    ['snapshot bind root', (record) => { record.storage!.mounts[3] = { ...record.storage!.mounts[3], root: '/unrelated' }; }, 'Invalid invocation storage record'],
    ['shared independent backing', (record) => { record.storage!.mounts[2] = { ...record.storage!.mounts[2], root: '/' }; }, 'Invalid invocation storage record'],
  ])('rejects a changed %s', (_name, change, error) => {
    const { record, file } = fixture();
    change(record);
    expect(() => validateResourceRecord(record, file)).toThrow(error);
  });

  it('binds the filename to both run and invocation identities', () => {
    const { record } = fixture();
    expect(() => validateResourceRecord(record, '/trusted/other.resources.json'))
      .toThrow('Invalid resource recovery record');
  });

  it('limits mount intents to exact owned paths and immediate snapshot children', () => {
    const { record } = fixture();
    const root = record.storage!.directory;
    for (const directory of [
      root, record.directory, `${root}/runs`, `${root}/cloud-hypervisor-rootfs`,
      `${root}/artifacts`, `${root}/artifacts/run-test`,
    ]) expect(allowedStorageMount(record, directory)).toBe(true);
    for (const directory of [
      `${root}-other`, `${root}/unknown`, `${root}/artifacts/run-test/nested`,
      `${root}/artifacts/not-a-snapshot`, `${record.directory}/nested`,
    ]) expect(allowedStorageMount(record, directory)).toBe(false);
  });
});

describe('host executor storage directory trust', () => {
  it('captures and compares the committed device and inode', async () => {
    const { record, dependencies } = fixture();
    await expect(trustedDirectory(record.storage!.directory, dependencies)).resolves.toEqual(identity);
    await expect(assertIdentity(record.storage!.directory, identity, dependencies)).resolves.toBeUndefined();
    await expect(assertIdentity(record.storage!.directory, { ...identity, inode: '701' }, dependencies))
      .rejects.toThrow('Recovery directory identity changed');
  });

  it.each(['symlink', 'owner', 'mode', 'not-directory'])('rejects an unsafe %s', async (kind) => {
    const { record, dependencies, stat } = fixture();
    if (kind === 'symlink') stat.isSymbolicLink = () => true;
    if (kind === 'owner') stat.uid = 2000;
    if (kind === 'mode') stat.mode = 0o40722;
    if (kind === 'not-directory') stat.isDirectory = () => false;
    await expect(trustedDirectory(record.storage!.directory, dependencies)).rejects.toThrow('Unsafe recovery directory');
  });

  it('rejects noncanonical ancestors before examining the directory', async () => {
    const { record, dependencies, realpath, lstat } = fixture();
    realpath.mockResolvedValue('/replaced');
    await expect(trustedDirectory(record.storage!.directory, dependencies))
      .rejects.toThrow('Recovery path has symlink ancestors');
    expect(lstat).not.toHaveBeenCalled();
  });
});

describe('host executor storage mount verification', () => {
  it('verifies every committed mount without invoking cleanup', async () => {
    const { record, dependencies, run, rm } = fixture();
    await expect(verifyStorageRecord(record, dependencies)).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it.each(['pending', 'directory'])('rejects uncommitted %s identity before reading mounts', async (kind) => {
    const { record, dependencies, readFile } = fixture();
    if (kind === 'pending') record.storage!.pending = record.storage!.directory;
    else delete record.storage!.directoryIdentity;
    await expect(verifyStorageRecord(record, dependencies)).rejects.toThrow('Storage identity is uncommitted');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('requires the mounted inode identity while the allocation mount exists', async () => {
    const { record, dependencies } = fixture();
    delete record.storage!.mountedIdentity;
    await expect(verifyStorageRecord(record, dependencies))
      .rejects.toThrow('Mounted storage inode identity is uncommitted');
  });

  it.each(['missing', 'replaced', 'duplicate'])('rejects a %s committed mount even during recovery', async (kind) => {
    const f = fixture();
    const mount = f.mounts[3];
    f.mounts = kind === 'missing' ? f.mounts.slice(0, -1)
      : kind === 'duplicate' ? [...f.mounts, mount]
      : [...f.mounts.slice(0, -1), { ...mount, mountId: 9999 }];
    await expect(verifyStorageRecord(f.record, f.dependencies))
      .rejects.toThrow('Invocation storage mount identity changed');
    if (kind !== 'missing') {
      await expect(verifyStorageRecord(f.record, f.dependencies, true))
        .rejects.toThrow('Invocation storage mount identity changed');
    }
  });

  it.each(['storage-child', 'invocation-child', 'outside-bind'])('rejects an unrecorded %s mount', async (kind) => {
    const f = fixture();
    const mountPoint = kind === 'storage-child' ? `${f.record.storage!.directory}/unknown`
      : kind === 'invocation-child' ? `${f.record.directory}/unknown` : '/outside-bind';
    f.mounts = [...f.mounts, { ...f.mounts[0], mountId: 9999, mountPoint }];
    const failure = await verifyStorageRecord(f.record, f.dependencies).catch((error: unknown) => error);
    expect(failure).toEqual(expect.objectContaining({ message: 'Unrecorded invocation storage mount' }));
    expect(hostPreflightReason(failure)).toBe('storage-mount-unrecorded');
  });

  it('allows absent mounts and directories only for idempotent recovery', async () => {
    const f = fixture();
    f.mounts = [];
    f.removeDirectory();
    await expect(verifyStorageRecord(f.record, f.dependencies)).rejects.toThrow('Invocation storage enforcement is missing');
    await expect(verifyStorageRecord(f.record, f.dependencies, true)).resolves.toBeUndefined();
  });
});

describe('host executor storage closing', () => {
  it('unmounts in reverse capture order before removing the exact directory', async () => {
    const f = fixture();
    const reverse = [...f.mounts].reverse();
    const before = JSON.stringify(f.record);
    await closeStorageRecord(f.record, f.dependencies, '/trusted/umount');
    expect(f.run.mock.calls).toEqual(reverse.map((mount) => ['/trusted/umount', [mount.mountPoint]]));
    expect(f.rm).toHaveBeenCalledWith(f.record.storage!.directory, { recursive: true, force: false });
    expect(f.run.mock.invocationCallOrder[f.run.mock.calls.length - 1]).toBeLessThan(f.rm.mock.invocationCallOrder[0]);
    expect(JSON.stringify(f.record)).toBe(before);
  });

  it('skips absent mounts and tolerates an already removed allocation', async () => {
    const f = fixture();
    f.mounts = [];
    f.removeDirectory();
    await expect(closeStorageRecord(f.record, f.dependencies, '/trusted/umount')).resolves.toBeUndefined();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.rm).not.toHaveBeenCalled();
  });

  it('does not unmount or remove anything after verification fails', async () => {
    const f = fixture();
    f.mounts = [...f.mounts, { ...f.mounts[0], mountId: 9999, mountPoint: '/outside-bind' }];
    await expect(closeStorageRecord(f.record, f.dependencies, '/trusted/umount'))
      .rejects.toThrow('Unrecorded invocation storage mount');
    expect(f.run).not.toHaveBeenCalled();
    expect(f.rm).not.toHaveBeenCalled();
  });

  it('rechecks mount identity immediately before each unmount', async () => {
    const f = fixture();
    const originalRead = f.readFile.getMockImplementation()!;
    f.readFile.mockImplementationOnce(originalRead).mockImplementationOnce(async () => {
      f.mounts = [...f.mounts.slice(0, -1), { ...f.mounts[3], mountId: 9999 }];
      return originalRead();
    });
    await expect(closeStorageRecord(f.record, f.dependencies, '/trusted/umount'))
      .rejects.toThrow('Invocation storage mount replaced');
    expect(f.run).not.toHaveBeenCalled();
    expect(f.rm).not.toHaveBeenCalled();
  });

  it('retains the allocation when an unmount fails', async () => {
    const f = fixture();
    f.run.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'busy' });
    await expect(closeStorageRecord(f.record, f.dependencies, '/trusted/umount'))
      .rejects.toThrow('Invocation storage unmount failed');
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(f.rm).not.toHaveBeenCalled();
  });

  it('refuses recursive removal while an unmount leaves mounts behind', async () => {
    const f = fixture();
    f.run.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    await expect(closeStorageRecord(f.record, f.dependencies, '/trusted/umount'))
      .rejects.toThrow('refusing recursive removal while mounts remain');
    expect(f.rm).not.toHaveBeenCalled();
  });

  it('retains a directory whose inode changed after unmounting', async () => {
    const f = fixture();
    const originalRun = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (command, args) => {
      const result = await originalRun(command, args);
      if (!f.mounts.length) f.stat.ino = 701;
      return result;
    });
    await expect(closeStorageRecord(f.record, f.dependencies, '/trusted/umount'))
      .rejects.toThrow('Recovery directory identity changed');
    expect(f.rm).not.toHaveBeenCalled();
  });
});
