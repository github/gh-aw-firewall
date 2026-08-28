import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CloudHypervisorDirectoryExport } from './exports';
import { planCloudHypervisorFilesystemWrites, summarizeCloudHypervisorFilesystemWriteBoundary } from './filesystem-write-policy';

describe('Cloud Hypervisor filesystem write policy planner', () => {
  let directory: string;
  let workspaceSource: string;
  let toolsSource: string;
  let exports: CloudHypervisorDirectoryExport[];

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ch-write-policy-')));
    workspaceSource = path.join(directory, 'workspace');
    toolsSource = path.join(directory, 'tools');
    await fs.mkdir(path.join(workspaceSource, 'nested', 'deep'), { recursive: true });
    await fs.mkdir(toolsSource, { recursive: true });
    await fs.writeFile(path.join(workspaceSource, 'nested', 'file.txt'), 'data');
    await fs.writeFile(path.join(toolsSource, 'tool.txt'), 'tool');
    exports = [
      { tag: 'workspace', source: workspaceSource, target: '/workspace', mode: 'rw' },
      { tag: 'runner-tool-cache', source: toolsSource, target: '/tools', mode: 'ro' },
    ];
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('preserves unrestricted per-export behavior when allowWrite is undefined', () => {
    const plan = planCloudHypervisorFilesystemWrites(exports, undefined);

    expect(plan.restricted).toBe(false);
    expect(plan.allowedPaths).toEqual([]);
    expect(plan.overlays).toEqual([]);
    expect(plan.exports).toEqual([
      {
        export: exports[0],
        disposition: 'unrestricted',
        hostRootMode: 'rw',
        guestMountMode: 'rw',
        internal: false,
        overlays: [],
      },
      {
        export: exports[1],
        disposition: 'unrestricted',
        hostRootMode: 'ro',
        guestMountMode: 'ro',
        internal: false,
        overlays: [],
      },
    ]);
  });

  it('makes every writable non-internal export read-only for an empty allowlist', () => {
    const withInternal = [
      ...exports,
      { tag: 'tmp-gh-aw', source: directory, target: '/tmp/gh-aw', mode: 'rw' as const },
    ];

    const plan = planCloudHypervisorFilesystemWrites(withInternal, [], {
      internalTags: ['tmp-gh-aw'],
    });

    expect(plan.restricted).toBe(true);
    expect(plan.overlays).toEqual([]);
    expect(plan.exports.map((entry) =>
      [entry.export.tag, entry.disposition, entry.hostRootMode, entry.guestMountMode]))
      .toEqual([
        ['workspace', 'read-only', 'ro', 'ro'],
        ['runner-tool-cache', 'read-only', 'ro', 'ro'],
        ['tmp-gh-aw', 'writable', 'rw', 'rw'],
      ]);
    expect(plan.exports[2].internal).toBe(true);
  });

  describe('internal exports', () => {
    let internalSource: string;
    let withInternal: CloudHypervisorDirectoryExport[];

    beforeEach(async () => {
      internalSource = path.join(directory, 'internal');
      await fs.mkdir(path.join(internalSource, 'cache'), { recursive: true });
      withInternal = [
        ...exports,
        { tag: 'tmp-gh-aw', source: internalSource, target: '/tmp/gh-aw', mode: 'rw' },
      ];
    });

    const plan = (allowWrite: string[]) =>
      planCloudHypervisorFilesystemWrites(withInternal, allowWrite, {
        internalTags: ['tmp-gh-aw'],
      });

    it('consumes an allowlist entry naming the internal export target exactly', () => {
      const result = plan(['/tmp/gh-aw']);

      expect(result.exports[2]).toEqual({
        export: withInternal[2],
        disposition: 'writable',
        hostRootMode: 'rw',
        guestMountMode: 'rw',
        internal: true,
        overlays: [],
      });
      expect(result.overlays).toEqual([]);
      expect(result.exports[0].disposition).toBe('read-only');
    });

    it('consumes an existing nested path inside the internal export without an overlay', () => {
      const result = plan(['/tmp/gh-aw/cache']);

      expect(result.exports[2].disposition).toBe('writable');
      expect(result.exports[2].overlays).toEqual([]);
      expect(result.overlays).toEqual([]);
    });

    it('rejects a nested path that does not exist inside the internal export', () => {
      expect(() => plan(['/tmp/gh-aw/missing'])).toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /tmp/gh-aw/missing',
      );
    });

    it('rejects a strict ancestor of the internal export target', () => {
      expect(() => plan(['/tmp'])).toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /tmp',
      );
    });

    it('rejects a symlink that escapes the internal export source', async () => {
      const outside = path.join(directory, 'internal-outside');
      await fs.mkdir(outside);
      await fs.symlink(outside, path.join(internalSource, 'escape'));

      expect(() => plan(['/tmp/gh-aw/escape'])).toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /tmp/gh-aw/escape',
      );
    });
  });

  it('keeps a whole export writable when its target is allowed', () => {
    const plan = planCloudHypervisorFilesystemWrites(exports, ['/workspace']);

    expect(plan.allowedPaths).toEqual(['/workspace']);
    expect(plan.exports[0]).toEqual({
      export: exports[0],
      disposition: 'writable',
      hostRootMode: 'rw',
      guestMountMode: 'rw',
      internal: false,
      overlays: [],
    });
    expect(plan.exports[1].disposition).toBe('read-only');
    expect(plan.overlays).toEqual([]);
  });

  it('narrows an export to a nested writable directory overlay', () => {
    const plan = planCloudHypervisorFilesystemWrites(exports, ['/workspace/nested/deep']);

    expect(plan.exports[0].disposition).toBe('selective');
    expect(plan.exports[0].hostRootMode).toBe('ro');
    expect(plan.exports[0].guestMountMode).toBe('rw');
    expect(plan.overlays).toEqual([
      {
        exportTag: 'workspace',
        guestPath: '/workspace/nested/deep',
        hostPath: path.join(workspaceSource, 'nested', 'deep'),
        relativePath: 'nested/deep',
        kind: 'directory',
      },
    ]);
  });

  it('keeps the guest mount read-write wherever a writable overlay exists', () => {
    const plan = planCloudHypervisorFilesystemWrites(exports, ['/workspace/nested/deep']);

    // A guest-level MS_RDONLY would propagate to announced virtio-fs submounts
    // (finish_automount passes the parent's mnt_flags), so read-only enforcement
    // for a selective export must come from the host backing tree instead.
    for (const entry of plan.exports) {
      if (entry.overlays.length > 0) {
        expect(entry.disposition).toBe('selective');
        expect(entry.guestMountMode).toBe('rw');
        expect(entry.hostRootMode).toBe('ro');
      } else {
        expect(entry.guestMountMode).toBe(entry.hostRootMode);
      }
      // A read-write host root is never published to a read-only guest mount.
      expect(entry.hostRootMode === 'rw' && entry.guestMountMode === 'ro').toBe(false);
    }
  });

  it('supports an existing file as an allowed path', () => {
    const plan = planCloudHypervisorFilesystemWrites(exports, ['/workspace/nested/file.txt']);

    expect(plan.overlays).toEqual([
      {
        exportTag: 'workspace',
        guestPath: '/workspace/nested/file.txt',
        hostPath: path.join(workspaceSource, 'nested', 'file.txt'),
        relativePath: 'nested/file.txt',
        kind: 'file',
      },
    ]);
  });

  it('translates guest paths to host source paths for non-identity targets', async () => {
    const source = path.join(directory, 'exported');
    await fs.mkdir(path.join(source, 'sub'), { recursive: true });
    const plan = planCloudHypervisorFilesystemWrites(
      [
        { tag: 'workspace', source, target: '/workspace', mode: 'rw' },
      ],
      ['/workspace/sub'],
    );

    expect(plan.overlays).toEqual([
      {
        exportTag: 'workspace',
        guestPath: '/workspace/sub',
        hostPath: path.join(source, 'sub'),
        relativePath: 'sub',
        kind: 'directory',
      },
    ]);
  });

  it('normalizes duplicates and drops descendants covered by an ancestor', () => {
    const plan = planCloudHypervisorFilesystemWrites(exports, [
      '/workspace/nested',
      '/workspace/./nested/',
      '/workspace/nested/deep',
      '/workspace/nested/file.txt',
    ]);

    expect(plan.allowedPaths).toEqual(['/workspace/nested']);
    expect(plan.overlays).toHaveLength(1);
    expect(plan.overlays[0].guestPath).toBe('/workspace/nested');
  });

  it('rejects relative paths and paths containing ".."', () => {
    expect(() => planCloudHypervisorFilesystemWrites(exports, ['workspace/nested']))
      .toThrow("filesystem.allowWrite path must be absolute without '..': workspace/nested");
    expect(() => planCloudHypervisorFilesystemWrites(exports, ['/workspace/../etc']))
      .toThrow("filesystem.allowWrite path must be absolute without '..': /workspace/../etc");
  });

  it('rejects a path that does not exist on the host', () => {
    expect(() => planCloudHypervisorFilesystemWrites(exports, ['/workspace/missing']))
      .toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /workspace/missing',
      );
  });

  it('rejects a symlink that escapes the export source', async () => {
    const outside = path.join(directory, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspaceSource, 'escape'));

    expect(() => planCloudHypervisorFilesystemWrites(exports, ['/workspace/escape']))
      .toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /workspace/escape',
      );
  });

  it('never upgrades a read-only export', () => {
    expect(() => planCloudHypervisorFilesystemWrites(exports, ['/tools/tool.txt']))
      .toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /tools/tool.txt',
      );
    expect(() => planCloudHypervisorFilesystemWrites(exports, ['/tools']))
      .toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /tools',
      );

    const plan = planCloudHypervisorFilesystemWrites(exports, ['/workspace/nested']);
    expect(plan.exports[1]).toEqual({
      export: exports[1],
      disposition: 'read-only',
      hostRootMode: 'ro',
      guestMountMode: 'ro',
      internal: false,
      overlays: [],
    });
  });

  it('rejects an ancestor of an export target instead of widening the whole export', () => {
    // `/` is above every export target, not an existing path reachable within
    // one, so it must not be treated as a full-export match even though it is
    // lexically "at or below" itself for every candidate target.
    expect(() => planCloudHypervisorFilesystemWrites(exports, ['/']))
      .toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /',
      );
  });

  it('rejects a path outside every export target', () => {
    expect(() => planCloudHypervisorFilesystemWrites(exports, ['/elsewhere']))
      .toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /elsewhere',
      );
  });

  it('reports every unmatched path in one error', () => {
    expect(() => planCloudHypervisorFilesystemWrites(exports, ['/elsewhere', '/workspace/missing']))
      .toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /elsewhere, /workspace/missing',
      );
  });

  it('resolves overlapping exports to the deepest matching export', () => {
    const nestedSource = path.join(workspaceSource, 'nested');
    const overlapping: CloudHypervisorDirectoryExport[] = [
      { tag: 'workspace', source: workspaceSource, target: '/workspace', mode: 'rw' },
      { tag: 'nested', source: nestedSource, target: '/workspace/nested', mode: 'rw' },
    ];

    const plan = planCloudHypervisorFilesystemWrites(overlapping, ['/workspace/nested/deep']);

    expect(plan.exports[0].disposition).toBe('read-only');
    expect(plan.exports[1].disposition).toBe('selective');
    expect(plan.overlays).toEqual([
      {
        exportTag: 'nested',
        guestPath: '/workspace/nested/deep',
        hostPath: path.join(nestedSource, 'deep'),
        relativePath: 'deep',
        kind: 'directory',
      },
    ]);
  });

  it('does not widen a deeper read-only export through a shallower writable one', () => {
    const overlapping: CloudHypervisorDirectoryExport[] = [
      { tag: 'workspace', source: workspaceSource, target: '/workspace', mode: 'rw' },
      {
        tag: 'nested',
        source: path.join(workspaceSource, 'nested'),
        target: '/workspace/nested',
        mode: 'ro',
      },
    ];

    expect(() => planCloudHypervisorFilesystemWrites(overlapping, ['/workspace/nested/deep']))
      .toThrow(
        'filesystem.allowWrite path is not an existing path within a writable ' +
        'Cloud Hypervisor export: /workspace/nested/deep',
      );
  });

  it('collects multiple overlays for one export in allowlist order', () => {
    const plan = planCloudHypervisorFilesystemWrites(exports, [
      '/workspace/nested/deep',
      '/workspace/nested/file.txt',
    ]);

    expect(plan.exports[0].disposition).toBe('selective');
    expect(plan.exports[0].overlays.map((overlay) => overlay.guestPath))
      .toEqual(['/workspace/nested/deep', '/workspace/nested/file.txt']);
    expect(plan.overlays).toHaveLength(2);
  });

  describe('write boundary summary', () => {
    it('describes nothing when no policy is in force', () => {
      const plan = planCloudHypervisorFilesystemWrites(exports, undefined);

      expect(summarizeCloudHypervisorFilesystemWriteBoundary(plan)).toEqual([]);
    });

    it('names the writable paths of every export so an EROFS is explainable', () => {
      const plan = planCloudHypervisorFilesystemWrites(exports, [
        '/workspace/nested/deep',
      ]);

      expect(summarizeCloudHypervisorFilesystemWriteBoundary(plan)).toEqual([
        '/workspace=ro except /workspace/nested/deep',
        '/tools=ro',
      ]);
    });

    it('reports a fully writable export without an exception list', () => {
      const plan = planCloudHypervisorFilesystemWrites(exports, ['/workspace']);

      expect(summarizeCloudHypervisorFilesystemWriteBoundary(plan)).toEqual([
        '/workspace=rw',
        '/tools=ro',
      ]);
    });
  });
});
