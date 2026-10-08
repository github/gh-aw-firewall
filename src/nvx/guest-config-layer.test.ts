import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NvxGuestConfigLayer } from './guest-config-layer';

describe('NvxGuestConfigLayer', () => {
  it('stages only the AWF run script and allowed guest-home state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-nvx-config-'));
    const home = path.join(root, 'home');
    await fs.mkdir(path.join(home, '.npm'), { recursive: true });
    await fs.writeFile(path.join(home, '.npm', 'cache'), 'allowed');
    await fs.mkdir(path.join(home, '.config', 'gh'), { recursive: true });
    await fs.writeFile(path.join(home, '.config', 'gh', 'hosts.yml'), 'secret');
    await fs.mkdir(path.join(home, '.azure'), { recursive: true });
    await fs.writeFile(path.join(home, '.azure', 'credentials'), 'secret');
    await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
    await fs.writeFile(path.join(home, '.ssh', 'id_ed25519'), 'secret');
    const layer = new NvxGuestConfigLayer({
      stagingRoot: path.join(root, 'staging'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      runScript: '#!/bin/sh\nexec true\n',
      homePath: home,
    }, {
      chown: async () => undefined,
      lchown: async () => undefined,
    });
    try {
      const source = await layer.stage();
      await expect(fs.readFile(path.join(source, 'etc/awf/nvx-run.sh'), 'utf8'))
        .resolves.toContain('exec true');
      await expect(fs.readFile(path.join(source, 'home/awf/.npm/cache'), 'utf8'))
        .resolves.toBe('allowed');
      await expect(fs.lstat(path.join(source, 'home/awf/.config/gh')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(path.join(source, 'home/awf/.azure/credentials')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      const stagingRoot = await fs.stat(path.dirname(source));
      expect(stagingRoot.mode & 0o777).toBe(0o700);
      await expect(fs.lstat(path.join(source, 'workspace'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.lstat(path.join(source, 'home/awf/.ssh'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await layer.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked allowed home directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-nvx-config-'));
    const home = path.join(root, 'home');
    await fs.mkdir(home);
    await fs.symlink('/etc', path.join(home, '.npm'));
    const layer = new NvxGuestConfigLayer({
      stagingRoot: path.join(root, 'staging'),
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      runScript: '#!/bin/sh\n',
      homePath: home,
    }, {
      chown: async () => undefined,
      lchown: async () => undefined,
    });
    try {
      await expect(layer.stage()).rejects.toThrow(/must be a real directory/);
    } finally {
      await layer.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
