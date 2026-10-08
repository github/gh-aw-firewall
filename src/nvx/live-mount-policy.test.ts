import { promises as fs } from 'fs';
import * as path from 'path';
import {
  planNvxLiveMounts,
  type NvxLiveMountPolicyDependencies,
} from './live-mount-policy';
import type { NvxDirectoryExport } from './workspace-export';

async function fixture(): Promise<{
  root: string;
  workspace: NvxDirectoryExport;
  dependencies: NvxLiveMountPolicyDependencies;
}> {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.awf-nvx-policy-'));
  const workspaceRoot = path.join(root, 'workspace');
  const homePath = path.join(root, 'home');
  await fs.mkdir(workspaceRoot);
  await fs.mkdir(homePath);
  const dependencies: NvxLiveMountPolicyDependencies = {
    realpath: fs.realpath,
    lstat: fs.lstat,
    readdir: fs.readdir,
    mkdir: fs.mkdir,
    readMountInfo: async () => '1 0 8:1 / / rw - ext4 /dev/root rw\n',
    homePath,
  };
  return {
    root,
    workspace: {
      tag: 'workspace',
      source: workspaceRoot,
      target: '/workspace',
      mode: 'rw',
    },
    dependencies,
  };
}

describe('planNvxLiveMounts', () => {
  it('plans a live mount with the production filesystem dependencies', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), '.awf-nvx-policy-defaults-'));
    const workspaceRoot = path.join(root, 'workspace');
    const ghAwRoot = path.join(root, 'gh-aw');
    const readFile = jest.spyOn(fs, 'readFile').mockResolvedValue(
      '1 0 8:1 / / rw - ext4 /dev/root rw\n',
    );
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(ghAwRoot);
    await fs.mkdir(path.join(workspaceRoot, 'dist'));
    try {
      const plan = await planNvxLiveMounts([
        {
          tag: 'workspace',
          source: workspaceRoot,
          target: '/workspace',
          mode: 'rw',
        },
        {
          tag: 'tmp-gh-aw',
          source: ghAwRoot,
          target: '/tmp/gh-aw',
          mode: 'rw',
        },
      ], ['/workspace/dist']);
      expect(plan.mounts[0]).toEqual(expect.objectContaining({
        hostPath: workspaceRoot,
        writablePaths: [path.join(workspaceRoot, 'dist')],
      }));
      expect(plan.mounts[1].deniedPaths).toEqual(expect.arrayContaining([
        path.join(ghAwRoot, 'mcp-logs'),
        path.join(ghAwRoot, 'sandbox', 'firewall', 'logs'),
      ]));
    } finally {
      readFile.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('maps write narrowing to host paths and preserves an independent read-only cache', async () => {
    const value = await fixture();
    const cache = path.join(value.root, 'tool-cache');
    await fs.mkdir(cache);
    await fs.mkdir(path.join(value.workspace.source, 'dist'));
    try {
      const plan = await planNvxLiveMounts([
        value.workspace,
        {
          tag: 'runner-tool-cache',
          source: cache,
          target: '/opt/hostedtoolcache',
          mode: 'ro',
        },
      ], ['/workspace/dist'], value.dependencies);
      expect(plan.mounts).toEqual([
        expect.objectContaining({
          guestTarget: '/workspace',
          mode: 'rw',
          writablePaths: [path.join(value.workspace.source, 'dist')],
        }),
        expect.objectContaining({
          guestTarget: '/opt/hostedtoolcache',
          mode: 'ro',
          writablePaths: [],
        }),
      ]);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked policy components', async () => {
    const value = await fixture();
    await fs.mkdir(path.join(value.workspace.source, 'real'));
    await fs.symlink('real', path.join(value.workspace.source, 'link'));
    try {
      await expect(planNvxLiveMounts(
        [value.workspace],
        ['/workspace/link'],
        value.dependencies,
      )).rejects.toThrow(/must not contain symlinks/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('denies central credential paths when an export overlaps the host home', async () => {
    const value = await fixture();
    await fs.writeFile(path.join(value.workspace.source, '.npmrc'), 'token');
    await fs.mkdir(path.join(value.workspace.source, '.azure'));
    await fs.writeFile(
      path.join(value.workspace.source, '.azure', 'credentials'),
      'token',
    );
    await fs.mkdir(path.join(value.workspace.source, '.config', 'gh'), { recursive: true });
    await fs.writeFile(
      path.join(value.workspace.source, '.config', 'gh', 'hosts.yml'),
      'token',
    );
    try {
      const plan = await planNvxLiveMounts([value.workspace], undefined, {
        ...value.dependencies,
        homePath: value.workspace.source,
      });
      expect(plan.mounts[0].deniedPaths).toEqual(expect.arrayContaining([
        path.join(value.workspace.source, '.npmrc'),
        path.join(value.workspace.source, '.azure', 'credentials'),
        path.join(value.workspace.source, '.config', 'gh'),
      ]));
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects a non-file credential entry when an export overlaps the host home', async () => {
    const value = await fixture();
    const npmrc = path.join(value.workspace.source, '.npmrc');
    await fs.writeFile(npmrc, 'token');
    try {
      await expect(planNvxLiveMounts([value.workspace], undefined, {
        ...value.dependencies,
        homePath: value.workspace.source,
        lstat: async (candidate) => {
          const stats = await fs.lstat(candidate);
          if (candidate !== npmrc) return stats;
          return {
            dev: stats.dev,
            ino: stats.ino,
            uid: stats.uid,
            gid: stats.gid,
            nlink: stats.nlink,
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => false,
          };
        },
      })).rejects.toThrow(/must be a regular file or directory/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('propagates credential canonicalization errors other than missing paths', async () => {
    const value = await fixture();
    const npmrc = path.join(value.workspace.source, '.npmrc');
    await fs.writeFile(npmrc, 'token');
    try {
      await expect(planNvxLiveMounts([value.workspace], undefined, {
        ...value.dependencies,
        homePath: value.workspace.source,
        realpath: async (candidate) => {
          if (candidate === npmrc) {
            const error = new Error('denied') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
          }
          return fs.realpath(candidate);
        },
      })).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('does not follow a symlink while creating missing sensitive paths', async () => {
    const value = await fixture();
    const source = path.join(value.root, 'gh-aw');
    const outside = path.join(value.root, 'outside');
    await fs.mkdir(source);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(source, 'sandbox'));
    try {
      await expect(planNvxLiveMounts([
        value.workspace,
        {
          tag: 'tmp-gh-aw',
          source,
          target: '/tmp/gh-aw',
          mode: 'rw',
        },
      ], undefined, value.dependencies)).rejects.toThrow(/must not contain symlinks/);
      await expect(fs.lstat(path.join(outside, 'firewall'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked sensitive-path exemption', async () => {
    const value = await fixture();
    const source = path.join(value.root, 'gh-aw');
    const payloadTarget = path.join(value.root, 'payload-target');
    await fs.mkdir(source);
    await fs.mkdir(payloadTarget);
    await fs.symlink(payloadTarget, path.join(source, 'mcp-payloads'));
    try {
      await expect(planNvxLiveMounts([
        value.workspace,
        {
          tag: 'tmp-gh-aw',
          source,
          target: '/tmp/gh-aw',
          mode: 'rw',
        },
      ], undefined, value.dependencies)).rejects.toThrow(/must not contain symlinks/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects a noncanonical sensitive policy directory', async () => {
    const value = await fixture();
    const source = path.join(value.root, 'gh-aw');
    const mcpLogs = path.join(source, 'mcp-logs');
    await fs.mkdir(source);
    try {
      await expect(planNvxLiveMounts([
        value.workspace,
        {
          tag: 'tmp-gh-aw',
          source,
          target: '/tmp/gh-aw',
          mode: 'rw',
        },
      ], undefined, {
        ...value.dependencies,
        realpath: async (candidate) => (
          candidate === mcpLogs ? `${candidate}-alias` : fs.realpath(candidate)
        ),
      })).rejects.toThrow(/must be canonical/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('propagates sensitive-path filesystem errors', async () => {
    const value = await fixture();
    const source = path.join(value.root, 'gh-aw');
    const mcpLogs = path.join(source, 'mcp-logs');
    await fs.mkdir(source);
    try {
      await expect(planNvxLiveMounts([
        value.workspace,
        {
          tag: 'tmp-gh-aw',
          source,
          target: '/tmp/gh-aw',
          mode: 'rw',
        },
      ], undefined, {
        ...value.dependencies,
        lstat: async (candidate) => {
          if (candidate === mcpLogs) {
            const error = new Error('denied') as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
          }
          return fs.lstat(candidate);
        },
      })).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects a writable path that overlaps a sensitive read denial', async () => {
    const value = await fixture();
    const source = path.join(value.root, 'tmp-gh-aw');
    await fs.mkdir(source);
    await fs.mkdir(path.join(source, 'mcp-logs'));
    try {
      await expect(planNvxLiveMounts([
        value.workspace,
        {
          tag: 'tmp-gh-aw',
          source,
          target: '/tmp/gh-aw',
          mode: 'rw',
        },
      ], ['/tmp/gh-aw/mcp-logs'], value.dependencies)).rejects.toThrow(
        /sensitive read denial overlaps filesystem\.allowWrite/,
      );
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects nested mounts inside a share', async () => {
    const value = await fixture();
    const nested = path.join(value.workspace.source, 'nested mount');
    await fs.mkdir(nested);
    try {
      await expect(planNvxLiveMounts([value.workspace], undefined, {
        ...value.dependencies,
        readMountInfo: async () =>
          `1 0 8:1 / / rw - ext4 /dev/root rw\n` +
          `2 1 8:2 / ${nested.replace(' ', '\\040')} rw - ext4 /dev/other rw\n`,
      })).rejects.toThrow(/contains nested mount/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects malformed mountinfo records', async () => {
    const value = await fixture();
    try {
      await expect(planNvxLiveMounts([value.workspace], undefined, {
        ...value.dependencies,
        readMountInfo: async () => 'malformed\n',
      })).rejects.toThrow(/Malformed \/proc\/self\/mountinfo entry/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects root-owned share roots before launching OpenVMM', async () => {
    const value = await fixture();
    try {
      await expect(planNvxLiveMounts([value.workspace], undefined, {
        ...value.dependencies,
        lstat: async (candidate) => {
          const stats = await fs.lstat(candidate);
          if (candidate === value.workspace.source) {
            Object.defineProperty(stats, 'uid', { value: 0 });
          }
          return stats;
        },
      })).rejects.toThrow(/must not be owned by root/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects overlapping and bind-aliased share roots', async () => {
    const value = await fixture();
    try {
      await expect(planNvxLiveMounts([
        value.workspace,
        {
          tag: 'runner-tool-cache',
          source: path.join(value.workspace.source, 'cache'),
          target: '/opt/hostedtoolcache',
          mode: 'ro',
        },
      ], undefined, value.dependencies)).rejects.toThrow(/sources must not nest/);

      const fakeStats = (dev: number, ino: number) => ({
        dev,
        ino,
        uid: 1000,
        gid: 1000,
        nlink: 1,
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
      });
      await expect(planNvxLiveMounts([
        {
          tag: 'workspace',
          source: '/shares/a',
          target: '/workspace',
          mode: 'rw',
        },
        {
          tag: 'runner-tool-cache',
          source: '/shares/b',
          target: '/opt/hostedtoolcache',
          mode: 'ro',
        },
      ], undefined, {
        ...value.dependencies,
        lstat: async (candidate) => {
          if (candidate === '/shares/a') return fakeStats(1, 10);
          if (candidate === '/shares/b' || candidate === '/shares') return fakeStats(1, 20);
          return fakeStats(1, 1);
        },
        readMountInfo: async () => '',
      })).rejects.toThrow(/cross through a bind mount/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects a symlink in a share-root lineage', async () => {
    const value = await fixture();
    try {
      await expect(planNvxLiveMounts([value.workspace], undefined, {
        ...value.dependencies,
        lstat: async (candidate) => {
          const stats = await fs.lstat(candidate);
          if (candidate !== value.root) return stats;
          return {
            dev: stats.dev,
            ino: stats.ino,
            uid: stats.uid,
            gid: stats.gid,
            nlink: stats.nlink,
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => true,
          };
        },
      })).rejects.toThrow(/share root lineage contains a symlink/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects a bind-mounted share root nested below another export', async () => {
    const value = await fixture();
    const nested = path.join(value.workspace.source, 'cache');
    const cache = path.join(value.root, 'cache-bind');
    await fs.mkdir(nested);
    await fs.mkdir(cache);
    const aliasedStats = {
      dev: 900,
      ino: 901,
      uid: 1000,
      gid: 1000,
      nlink: 1,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    };
    try {
      await expect(planNvxLiveMounts([
        value.workspace,
        {
          tag: 'runner-tool-cache',
          source: cache,
          target: '/opt/hostedtoolcache',
          mode: 'ro',
        },
      ], undefined, {
        ...value.dependencies,
        lstat: async (candidate) => (
          candidate === nested || candidate === cache
            ? aliasedStats
            : fs.lstat(candidate)
        ),
      })).rejects.toThrow(/cross through a bind mount/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects hard-link aliases across writable and read-only boundaries', async () => {
    const value = await fixture();
    const dist = path.join(value.workspace.source, 'dist');
    const src = path.join(value.workspace.source, 'src');
    await fs.mkdir(dist);
    await fs.mkdir(src);
    const writable = path.join(dist, 'artifact');
    await fs.writeFile(writable, 'same inode');
    await fs.link(writable, path.join(src, 'alias'));
    try {
      await expect(planNvxLiveMounts(
        [value.workspace],
        ['/workspace/dist'],
        value.dependencies,
      )).rejects.toThrow(/hard-link alias crosses a filesystem policy boundary/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('ignores unrelated symlinks while scanning for hard-link aliases', async () => {
    const value = await fixture();
    await fs.writeFile(path.join(value.workspace.source, 'target'), 'content');
    await fs.symlink('target', path.join(value.workspace.source, 'alias'));
    try {
      await expect(planNvxLiveMounts(
        [value.workspace],
        undefined,
        value.dependencies,
      )).resolves.toEqual(expect.objectContaining({
        mounts: [expect.objectContaining({ tag: 'workspace' })],
      }));
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects hard-link aliases across different write policies on rw shares', async () => {
    const value = await fixture();
    const cache = path.join(value.root, 'cache');
    const dist = path.join(value.workspace.source, 'dist');
    const src = path.join(value.workspace.source, 'src');
    await fs.mkdir(cache);
    await fs.mkdir(dist);
    await fs.mkdir(src);
    const readOnly = path.join(src, 'artifact');
    await fs.writeFile(readOnly, 'same inode');
    await fs.link(readOnly, path.join(cache, 'alias'));
    try {
      await expect(planNvxLiveMounts([
        value.workspace,
        {
          tag: 'cache',
          source: cache,
          target: '/cache',
          mode: 'rw',
        },
      ], ['/workspace/dist', '/cache'], value.dependencies))
        .rejects.toThrow(/hard-link alias crosses a filesystem policy boundary/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });

  it('rejects hard-link aliases across denied and readable paths', async () => {
    const value = await fixture();
    const source = path.join(value.root, 'gh-aw');
    await fs.mkdir(source);
    const exportEntry: NvxDirectoryExport = {
      tag: 'tmp-gh-aw',
      source,
      target: '/tmp/gh-aw',
      mode: 'rw',
    };
    const denied = path.join(exportEntry.source, 'mcp-logs');
    const readable = path.join(exportEntry.source, 'mcp-payloads');
    await fs.mkdir(denied);
    await fs.mkdir(readable);
    const secret = path.join(denied, 'request.json');
    await fs.writeFile(secret, '{}');
    await fs.link(secret, path.join(readable, 'alias.json'));
    try {
      await expect(planNvxLiveMounts(
        [value.workspace, exportEntry],
        undefined,
        value.dependencies,
      )).rejects.toThrow(/hard-link alias crosses a filesystem policy boundary/);
    } finally {
      await fs.rm(value.root, { recursive: true, force: true });
    }
  });
});
