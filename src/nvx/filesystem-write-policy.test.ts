import {
  isNvxWritableGuestPath,
  planNvxFilesystemWrites,
} from './filesystem-write-policy';
import { NVX_GUEST_WORKSPACE, type NvxDirectoryExport } from './workspace-export';

const WORKSPACE_SOURCE = '/home/runner/work/repo';
const TOOL_CACHE_SOURCE = '/opt/hostedtoolcache';

const workspace: NvxDirectoryExport = {
  tag: 'workspace',
  source: WORKSPACE_SOURCE,
  target: NVX_GUEST_WORKSPACE,
  mode: 'rw',
};
const toolCache: NvxDirectoryExport = {
  tag: 'runner-tool-cache',
  source: TOOL_CACHE_SOURCE,
  target: TOOL_CACHE_SOURCE,
  mode: 'ro',
};

/** Treats every path as an existing, non-symlink directory. */
const directories = {
  realpath: async (target: string) => target,
  lstat: async () => ({
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  }),
};

describe('planNvxFilesystemWrites', () => {
  it('leaves every export unrestricted when no allowlist is supplied', async () => {
    const plan = await planNvxFilesystemWrites([workspace, toolCache], undefined);

    expect(plan.restricted).toBe(false);
    expect(plan.overlays).toEqual([]);
    expect(plan.exports.map((entry) => entry.disposition))
      .toEqual(['unrestricted', 'unrestricted']);
    expect(plan.exports.map((entry) => entry.stagedOwnership))
      .toEqual(['workload', 'root']);
  });

  it('narrows a workspace export to the allowed subpaths', async () => {
    const plan = await planNvxFilesystemWrites(
      [workspace],
      ['/workspace/dist', '/workspace/.cache'],
      directories,
    );

    expect(plan.restricted).toBe(true);
    expect(plan.allowedPaths).toEqual(['/workspace/.cache', '/workspace/dist']);
    expect(plan.exports[0].disposition).toBe('selective');
    expect(plan.exports[0].stagedOwnership).toBe('root');
    expect(plan.overlays).toEqual([
      {
        exportTag: 'workspace',
        guestPath: '/workspace/.cache',
        hostPath: `${WORKSPACE_SOURCE}/.cache`,
        relativePath: '.cache',
        kind: 'directory',
      },
      {
        exportTag: 'workspace',
        guestPath: '/workspace/dist',
        hostPath: `${WORKSPACE_SOURCE}/dist`,
        relativePath: 'dist',
        kind: 'directory',
      },
    ]);
  });

  it('collapses duplicate and descendant allowlist entries', async () => {
    const plan = await planNvxFilesystemWrites(
      [workspace],
      ['/workspace/dist/', '/workspace/dist', '/workspace/dist/assets'],
      directories,
    );

    expect(plan.allowedPaths).toEqual(['/workspace/dist']);
    expect(plan.overlays).toHaveLength(1);
  });

  it('keeps a whole export writable when the export root itself is allowed', async () => {
    const plan = await planNvxFilesystemWrites(
      [workspace],
      ['/workspace', '/workspace/dist'],
      directories,
    );

    expect(plan.exports[0].disposition).toBe('writable');
    expect(plan.exports[0].stagedOwnership).toBe('workload');
    expect(plan.overlays).toEqual([]);
  });

  it('stages a writable export read-only when the allowlist never mentions it', async () => {
    const plan = await planNvxFilesystemWrites([workspace], [], directories);

    expect(plan.restricted).toBe(true);
    expect(plan.exports[0].disposition).toBe('read-only');
    expect(plan.exports[0].stagedOwnership).toBe('root');
  });

  it('leaves internal exports writable and consumes allowlist entries inside them', async () => {
    const internal: NvxDirectoryExport = {
      tag: 'awf-tmp',
      source: '/tmp/gh-aw',
      target: '/tmp/gh-aw',
      mode: 'rw',
    };
    const plan = await planNvxFilesystemWrites(
      [workspace, internal],
      ['/tmp/gh-aw/cache'],
      { ...directories, internalTags: ['awf-tmp'] },
    );

    expect(plan.exports[1].disposition).toBe('writable');
    expect(plan.overlays).toEqual([]);
  });

  it('rejects allowlist entries that are relative, traversing, or outside every writable export', async () => {
    await expect(planNvxFilesystemWrites([workspace], ['dist'], directories))
      .rejects.toThrow(/must be absolute/);
    await expect(planNvxFilesystemWrites([workspace], ['/workspace/../etc'], directories))
      .rejects.toThrow(/must not traverse upwards/);
    await expect(planNvxFilesystemWrites([workspace, toolCache], ['/opt/hostedtoolcache/node'], directories))
      .rejects.toThrow(/not inside any writable NVX guest export/);
  });

  it('rejects allowlist entries that do not exist, are symlinks, or escape the export', async () => {
    await expect(planNvxFilesystemWrites([workspace], ['/workspace/missing'], {
      realpath: async () => { throw new Error('ENOENT'); },
      lstat: directories.lstat,
    })).rejects.toThrow(/does not exist on the host/);

    await expect(planNvxFilesystemWrites([workspace], ['/workspace/link'], {
      realpath: async () => '/etc',
      lstat: directories.lstat,
    })).rejects.toThrow(/escapes its export via a symlink/);

    await expect(planNvxFilesystemWrites([workspace], ['/workspace/link'], {
      realpath: async (target: string) => target,
      lstat: async () => ({
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
      }),
    })).rejects.toThrow(/must not be a symlink/);

    await expect(planNvxFilesystemWrites([workspace], ['/workspace/socket'], {
      realpath: async (target: string) => target,
      lstat: async () => ({
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
    })).rejects.toThrow(/must be a regular file or directory/);
  });
});

describe('isNvxWritableGuestPath', () => {
  it('follows the declared export mode when unrestricted', async () => {
    const plan = await planNvxFilesystemWrites([workspace, toolCache], undefined);

    expect(isNvxWritableGuestPath(plan, '/workspace/src/main.ts')).toBe(true);
    expect(isNvxWritableGuestPath(plan, `${TOOL_CACHE_SOURCE}/node`)).toBe(false);
    expect(isNvxWritableGuestPath(plan, '/etc/passwd')).toBe(false);
  });

  it('permits only the allowed subtrees of a selectively narrowed export', async () => {
    const plan = await planNvxFilesystemWrites([workspace], ['/workspace/dist'], directories);

    expect(isNvxWritableGuestPath(plan, '/workspace/dist')).toBe(true);
    expect(isNvxWritableGuestPath(plan, '/workspace/dist/app.js')).toBe(true);
    expect(isNvxWritableGuestPath(plan, '/workspace/dist/../src/main.ts')).toBe(false);
    expect(isNvxWritableGuestPath(plan, '/workspace/src/main.ts')).toBe(false);
  });

  it('denies everything inside a fully read-only export', async () => {
    const plan = await planNvxFilesystemWrites([workspace], [], directories);
    expect(isNvxWritableGuestPath(plan, '/workspace/anything')).toBe(false);
  });
});
