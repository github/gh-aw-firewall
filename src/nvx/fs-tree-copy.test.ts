import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { NvxLayerSourceManifestEntry } from './filesystem-builder';
import { copyDeterministicTree } from './fs-tree-copy';

const linuxIt = process.platform === 'linux' ? it : it.skip;

describe('NVX deterministic tree copy', () => {
  let root: string;
  let source: string;
  let destination: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'awf-nvx-tree-'));
    source = path.join(root, 'source');
    destination = path.join(root, 'destination');
    await fs.mkdir(source);
    await fs.mkdir(destination);
    jest.spyOn(fs, 'chown').mockResolvedValue(undefined);
    jest.spyOn(fs, 'lchown').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  linuxIt('copies a sorted manifest with exclusions, safe modes, hashes, and timestamps', async () => {
    await fs.writeFile(path.join(source, 'z-file'), 'payload');
    await fs.chmod(path.join(source, 'z-file'), 0o4755);
    await fs.mkdir(path.join(source, 'a-dir'));
    await fs.writeFile(path.join(source, 'a-dir', 'keep'), 'safe');
    await fs.mkdir(path.join(source, 'a-dir', '.ssh'));
    await fs.writeFile(path.join(source, 'a-dir', '.ssh', 'key'), 'excluded');
    await fs.symlink('/z-file', path.join(source, 'link'));
    const manifest: NvxLayerSourceManifestEntry[] = [];

    await copyDeterministicTree(source, destination, ['.ssh'], manifest, 1234);

    expect(manifest.map((entry) => entry.path)).toEqual([
      '', 'a-dir', 'a-dir/keep', 'link', 'z-file',
    ]);
    expect(manifest.find((entry) => entry.path === 'z-file')).toEqual({
      path: 'z-file',
      type: 'file',
      mode: 0o755,
      size: 7,
      sha256: createHash('sha256').update('payload').digest('hex'),
      uid: 0,
      gid: 0,
    });
    expect(await fs.readFile(path.join(destination, 'z-file'), 'utf8')).toBe('payload');
    expect(await fs.readlink(path.join(destination, 'link'))).toBe('z-file');
    await expect(fs.access(path.join(destination, 'a-dir', '.ssh'))).rejects.toThrow();
    for (const entry of manifest) {
      expect((await fs.lstat(path.join(destination, entry.path))).mtimeMs).toBe(1234000);
    }
    expect(fs.lchown).toHaveBeenCalledWith(path.join(destination, 'link'), 0, 0);
  });

  linuxIt('keeps copy contexts independent and omits overlay root metadata', async () => {
    await fs.writeFile(path.join(source, 'file'), 'content');
    await fs.symlink('file', path.join(source, 'link'));
    await fs.chmod(source, 0o755);
    await fs.chmod(destination, 0o700);
    const owner = await fs.stat(path.join(source, 'file'));
    const overlay: NvxLayerSourceManifestEntry[] = [];
    await copyDeterministicTree(source, destination, [], overlay, 42, true, false);

    expect(overlay.map((entry) => entry.path)).toEqual(['file', 'link']);
    expect(overlay.every((entry) => entry.uid === owner.uid && entry.gid === owner.gid)).toBe(true);
    expect(fs.chown).toHaveBeenCalledWith(path.join(destination, 'file'), owner.uid, owner.gid);
    expect(fs.lchown).toHaveBeenCalledWith(path.join(destination, 'link'), owner.uid, owner.gid);
    expect(fs.chown).not.toHaveBeenCalledWith(destination, expect.anything(), expect.anything());
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o700);

    const secondDestination = path.join(root, 'second');
    const second: NvxLayerSourceManifestEntry[] = [];
    await copyDeterministicTree(source, secondDestination, ['link'], second, 0);
    expect(second.map((entry) => entry.path)).toEqual(['', 'file']);
    expect(second.every((entry) => entry.uid === 0 && entry.gid === 0)).toBe(true);
    expect(overlay.map((entry) => entry.path)).toEqual(['file', 'link']);
    expect((await fs.stat(path.join(secondDestination, 'file'))).mtimeMs).toBe(0);
  });

  linuxIt('rejects source directory symlinks and escaping targets', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(source, alias);
    await expect(copyDeterministicTree(alias, destination, [], [], 0)).rejects.toThrow();
    await fs.symlink('../outside', path.join(source, 'escape'));
    await expect(copyDeterministicTree(source, destination, [], [], 0))
      .rejects.toThrow(/symlink target.*escapes/);
    await expect(fs.lstat(path.join(destination, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  linuxIt('rejects special filesystem entries without copying them', async () => {
    const socket = (await import('net')).createServer();
    const sourceSocket = path.join(source, 'socket');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(sourceSocket, resolve);
    });
    try {
      await expect(copyDeterministicTree(source, destination, [], [], 0))
        .rejects.toThrow(/Special filesystem entry is not safe for NVX layer/);
      await expect(fs.lstat(path.join(destination, 'socket')))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve, reject) => {
        socket.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
