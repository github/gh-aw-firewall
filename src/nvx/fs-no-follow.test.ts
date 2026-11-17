import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import {
  assertDescriptorTraversalSupport,
  assertSourceUnchanged,
  descriptorPath,
  openDirectoryNoFollow,
} from './fs-no-follow';

const linuxIt = process.platform === 'linux' ? it : it.skip;

describe('NVX no-follow descriptor traversal', () => {
  afterEach(() => jest.restoreAllMocks());

  linuxIt('opens real directories but refuses symlink and regular-file roots', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'awf-nvx-descriptor-'));
    try {
      await assertDescriptorTraversalSupport();
      const handle = await openDirectoryNoFollow(root);
      try {
        expect((await fs.stat(descriptorPath(handle))).ino).toBe((await handle.stat()).ino);
      } finally {
        await handle.close();
      }
      const alias = `${root}-link`;
      await fs.symlink(root, alias);
      try {
        await expect(openDirectoryNoFollow(alias)).rejects.toThrow();
      } finally {
        await fs.unlink(alias);
      }
      const file = path.join(root, 'file');
      await fs.writeFile(file, 'data');
      await expect(openDirectoryNoFollow(file)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  linuxIt('fails closed when the descriptor filesystem is unavailable', async () => {
    jest.spyOn(fs, 'access').mockRejectedValue(new Error('not mounted'));
    await expect(assertDescriptorTraversalSupport()).rejects.toThrow(/mounted \/proc\/self\/fd/);
    expect(fs.access).toHaveBeenCalledWith('/proc/self/fd');
  });

  it('detects changes to every source identity and metadata field', async () => {
    const before = await fs.stat(__filename);
    expect(() => assertSourceUnchanged(before, before, 'source')).not.toThrow();
    for (const field of [
      'dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeMs', 'ctimeMs',
    ] as const) {
      const after = Object.assign(Object.create(Object.getPrototypeOf(before)), before, {
        [field]: before[field] + 1,
      });
      expect(() => assertSourceUnchanged(before, after, 'source'))
        .toThrow('NVX layer source changed during staging: source');
    }
  });
});
