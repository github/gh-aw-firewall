import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CloudHypervisorDirectoryExport } from './exports';
import {
  hasReadOnlyWorkspaceMountPlan,
  planCloudHypervisorFilesystemWriteEnforcement,
} from './filesystem-write-enforcement';

describe('Cloud Hypervisor filesystem write enforcement translation', () => {
  let directory: string;
  let workspaceSource: string;
  let toolsSource: string;
  let tmpGhAwSource: string;
  let exports: CloudHypervisorDirectoryExport[];

  beforeEach(async () => {
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ch-write-enforce-')));
    workspaceSource = path.join(directory, 'workspace');
    toolsSource = path.join(directory, 'tools');
    tmpGhAwSource = path.join(directory, 'gh-aw');
    await fs.mkdir(path.join(workspaceSource, 'nested'), { recursive: true });
    await fs.mkdir(path.join(tmpGhAwSource, 'agent'), { recursive: true });
    await fs.mkdir(path.join(tmpGhAwSource, 'cache'), { recursive: true });
    await fs.mkdir(toolsSource, { recursive: true });
    await fs.writeFile(path.join(workspaceSource, 'nested', 'file.txt'), 'data');
    exports = [
      { tag: 'workspace', source: workspaceSource, target: '/workspace', mode: 'rw' },
      { tag: 'runner-tool-cache', source: toolsSource, target: '/tools', mode: 'ro' },
      { tag: 'tmp-gh-aw', source: tmpGhAwSource, target: '/tmp/gh-aw', mode: 'rw' },
    ];
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('produces no enforcement and untouched exports when the policy is undefined', () => {
    const result = planCloudHypervisorFilesystemWriteEnforcement(exports, undefined);

    expect(result.mountEnforcement).toBeUndefined();
    expect('mountEnforcement' in result).toBe(false);
    expect(result.exports).toEqual(exports);
    // Identity matters: the published list must be the resolved exports
    // verbatim so virtiofsd's legacy staging path stays byte-identical.
    result.exports.forEach((entry, index) => expect(entry).toBe(exports[index]));
    expect(hasReadOnlyWorkspaceMountPlan(result.mountEnforcement)).toBe(false);
  });

  it('narrows every writable export for an empty allowlist without exempting /tmp/gh-aw', () => {
    const result = planCloudHypervisorFilesystemWriteEnforcement(exports, []);

    expect(result.exports).toEqual([
      { ...exports[0], mode: 'ro' },
      { ...exports[1], mode: 'ro' },
      { ...exports[2], mode: 'ro' },
    ]);
    expect(result.mountEnforcement).toEqual({
      plans: [
        { tag: 'workspace', writableOverlays: [] },
        { tag: 'runner-tool-cache', writableOverlays: [] },
        { tag: 'tmp-gh-aw', writableOverlays: [] },
      ],
    });
    expect(hasReadOnlyWorkspaceMountPlan(result.mountEnforcement)).toBe(true);
  });

  it('maps the motivating /tmp/gh-aw/agent policy to one selective overlay', () => {
    const result = planCloudHypervisorFilesystemWriteEnforcement(exports, ['/tmp/gh-aw/agent']);

    expect(result.exports).toEqual([
      { ...exports[0], mode: 'ro' },
      { ...exports[1], mode: 'ro' },
      // Selective exports must stay read-write guest-side or the announced
      // writable submount would inherit MNT_READONLY from its parent.
      { ...exports[2], mode: 'rw' },
    ]);
    expect(result.mountEnforcement?.plans).toEqual([
      { tag: 'workspace', writableOverlays: [] },
      { tag: 'runner-tool-cache', writableOverlays: [] },
      {
        tag: 'tmp-gh-aw',
        writableOverlays: [{
          source: path.join(tmpGhAwSource, 'agent'),
          destination: path.join(tmpGhAwSource, 'agent'),
          kind: 'directory',
        }],
      },
    ]);
  });

  it('keeps a wholly allowed export read-write with no plan', () => {
    const result = planCloudHypervisorFilesystemWriteEnforcement(
      exports,
      ['/workspace', '/tmp/gh-aw'],
    );

    expect(result.exports).toEqual([
      { ...exports[0], mode: 'rw' },
      { ...exports[1], mode: 'ro' },
      { ...exports[2], mode: 'rw' },
    ]);
    expect(result.mountEnforcement).toEqual({
      plans: [{ tag: 'runner-tool-cache', writableOverlays: [] }],
    });
    expect(hasReadOnlyWorkspaceMountPlan(result.mountEnforcement)).toBe(false);
  });

  it('maps a selective file overlay with its canonical host path and kind', () => {
    const result = planCloudHypervisorFilesystemWriteEnforcement(
      exports,
      ['/workspace/nested/file.txt', '/tmp/gh-aw'],
    );

    expect(result.exports[0]).toEqual({ ...exports[0], mode: 'rw' });
    expect(result.mountEnforcement?.plans).toEqual([
      {
        tag: 'workspace',
        writableOverlays: [{
          source: path.join(workspaceSource, 'nested', 'file.txt'),
          destination: path.join(workspaceSource, 'nested', 'file.txt'),
          kind: 'file',
        }],
      },
      { tag: 'runner-tool-cache', writableOverlays: [] },
    ]);
    // A selective workspace has a plan, so it is legitimately published `rw`
    // while its host root is staged read-only.
    expect(hasReadOnlyWorkspaceMountPlan(result.mountEnforcement)).toBe(true);
  });

  it('emits plan tags that exist in the published exports, in export order', () => {
    const result = planCloudHypervisorFilesystemWriteEnforcement(exports, ['/tmp/gh-aw/cache']);
    const publishedTags = result.exports.map((entry) => entry.tag);

    expect(result.mountEnforcement?.plans.map((plan) => plan.tag))
      .toEqual(['workspace', 'runner-tool-cache', 'tmp-gh-aw']);
    result.mountEnforcement?.plans.forEach((plan) => {
      expect(publishedTags).toContain(plan.tag);
    });
    expect(new Set(result.mountEnforcement?.plans.map((plan) => plan.tag)).size)
      .toBe(result.mountEnforcement?.plans.length);
  });

  it('fails closed on a missing or escaping allowlist path instead of widening', () => {
    expect(() => planCloudHypervisorFilesystemWriteEnforcement(exports, ['/workspace/absent']))
      .toThrow('filesystem.allowWrite path is not an existing path within a writable');
    expect(() => planCloudHypervisorFilesystemWriteEnforcement(exports, ['/tools/tool.txt']))
      .toThrow('filesystem.allowWrite path is not an existing path within a writable');
    expect(() => planCloudHypervisorFilesystemWriteEnforcement(exports, ['relative/path']))
      .toThrow("filesystem.allowWrite path must be absolute without '..'");
  });
});
