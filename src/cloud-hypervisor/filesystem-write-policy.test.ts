import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CloudHypervisorDirectoryExport } from './exports';
import { planCloudHypervisorFilesystemWrites } from './filesystem-write-policy';

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
        effectiveMode: 'rw',
        internal: false,
        overlays: [],
      },
      {
        export: exports[1],
        disposition: 'unrestricted',
        effectiveMode: 'ro',
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
    expect(plan.exports.map((entry) => [entry.export.tag, entry.disposition, entry.effectiveMode]))
      .toEqual([
        ['workspace', 'read-only', 'ro'],
        ['runner-tool-cache', 'read-only', 'ro'],
        ['tmp-gh-aw', 'writable', 'rw'],
      ]);
    expect(plan.exports[2].internal).toBe(true);
  });

  it('keeps a whole export writable when its target is allowed', () => {
    const plan = planCloudHypervisorFilesystemWrites(exports, ['/workspace']);

    expect(plan.allowedPaths).toEqual(['/workspace']);
    expect(plan.exports[0]).toEqual({
      export: exports[0],
      disposition: 'writable',
      effectiveMode: 'rw',
      internal: false,
      overlays: [],
    });
    expect(plan.exports[1].disposition).toBe('read-only');
    expect(plan.overlays).toEqual([]);
  });

  it('narrows an export to a nested writable directory overlay', () => {
    const plan = planCloudHypervisorFilesystemWrites(exports, ['/workspace/nested/deep']);

    expect(plan.exports[0].disposition).toBe('selective');
    expect(plan.exports[0].effectiveMode).toBe('ro');
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
      effectiveMode: 'ro',
      internal: false,
      overlays: [],
    });
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
});
