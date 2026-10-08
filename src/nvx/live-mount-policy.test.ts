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
  await fs.mkdir(workspaceRoot);
  const dependencies: NvxLiveMountPolicyDependencies = {
    realpath: fs.realpath,
    lstat: fs.lstat,
    readdir: fs.readdir,
    mkdir: fs.mkdir,
    readMountInfo: async () => '1 0 8:1 / / rw - ext4 /dev/root rw\n',
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

  it('rejects nested mounts inside a share', async () => {
    const value = await fixture();
    const nested = path.join(value.workspace.source, 'nested');
    await fs.mkdir(nested);
    try {
      await expect(planNvxLiveMounts([value.workspace], undefined, {
        ...value.dependencies,
        readMountInfo: async () =>
          `1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:2 / ${nested} rw - ext4 /dev/other rw\n`,
      })).rejects.toThrow(/contains nested mount/);
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
