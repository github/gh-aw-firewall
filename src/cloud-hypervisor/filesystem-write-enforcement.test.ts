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

  function expectedGhAwMasks(): { destination: string }[] {
    return [
      path.join(tmpGhAwSource, 'mcp-logs'),
      path.join(tmpGhAwSource, 'sandbox', 'firewall', 'logs'),
      path.join(tmpGhAwSource, 'sandbox', 'firewall', 'audit'),
    ].map((destination) => ({ destination }));
  }

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

  it('recursively enforces an opted-in tool cache when the write policy is undefined', () => {
    const result = planCloudHypervisorFilesystemWriteEnforcement(exports, undefined);

    expect(result.mountEnforcement).toEqual({
      plans: [
        { tag: 'runner-tool-cache', writableOverlays: [] },
        { tag: 'tmp-gh-aw', writableOverlays: [], maskedPaths: expectedGhAwMasks() },
      ],
    });
    expect(result.exports).toEqual(exports);
    result.exports.forEach((entry, index) => expect(entry).toBe(exports[index]));
    expect(hasReadOnlyWorkspaceMountPlan(result.mountEnforcement)).toBe(false);
    expect(result.writeBoundary).toEqual([]);
  });

  it('masks sensitive paths without a write policy or tool-cache export', () => {
    const withoutToolCache = exports.filter((entry) => entry.tag !== 'runner-tool-cache');
    const result = planCloudHypervisorFilesystemWriteEnforcement(withoutToolCache, undefined);

    expect(result.mountEnforcement).toEqual({
      plans: [{
        tag: 'tmp-gh-aw',
        writableOverlays: [],
        maskedPaths: expectedGhAwMasks(),
      }],
    });
    expect(result.exports).toEqual(withoutToolCache);
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
        { tag: 'tmp-gh-aw', writableOverlays: [], maskedPaths: expectedGhAwMasks() },
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
        maskedPaths: expectedGhAwMasks(),
      },
    ]);
    // The motivating gh-aw failure was a write to /tmp/gh-aw/repo-memory, which
    // this policy leaves read-only; the boundary line is what makes that visible
    // before the guest reports a bare EROFS.
    expect(result.writeBoundary).toEqual([
      '/workspace=ro',
      '/tools=ro',
      '/tmp/gh-aw=ro except /tmp/gh-aw/agent',
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
      plans: [
        { tag: 'runner-tool-cache', writableOverlays: [] },
        { tag: 'tmp-gh-aw', writableOverlays: [], maskedPaths: expectedGhAwMasks() },
      ],
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
      { tag: 'tmp-gh-aw', writableOverlays: [], maskedPaths: expectedGhAwMasks() },
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

  describe('mcpg log directory masking', () => {
    let mcpLogsSource: string;

    beforeEach(async () => {
      mcpLogsSource = path.join(tmpGhAwSource, 'mcp-logs');
      await fs.mkdir(mcpLogsSource, { recursive: true });
    });

    it('adds a masks-only plan for /tmp/gh-aw/mcp-logs when no write policy is set', () => {
      const result = planCloudHypervisorFilesystemWriteEnforcement(exports, undefined);

      expect(result.mountEnforcement?.plans).toEqual([
        { tag: 'runner-tool-cache', writableOverlays: [] },
        {
          tag: 'tmp-gh-aw',
          writableOverlays: [],
          maskedPaths: expectedGhAwMasks(),
        },
      ]);
    });

    it('merges the mask into the existing tmp-gh-aw plan under a restrictive allowlist', () => {
      const result = planCloudHypervisorFilesystemWriteEnforcement(exports, ['/tmp/gh-aw/agent']);

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
          maskedPaths: expectedGhAwMasks(),
        },
      ]);
    });

    it('still masks mcp-logs when /tmp/gh-aw is wholly allowed and would otherwise have no plan', () => {
      const result = planCloudHypervisorFilesystemWriteEnforcement(
        exports,
        ['/workspace', '/tmp/gh-aw'],
      );

      expect(result.mountEnforcement?.plans).toEqual([
        { tag: 'runner-tool-cache', writableOverlays: [] },
        {
          tag: 'tmp-gh-aw',
          writableOverlays: [],
          maskedPaths: expectedGhAwMasks(),
        },
      ]);
    });

    it('skips masking when /tmp/gh-aw is not an export', () => {
      const withoutTmpGhAw = exports.filter((entry) => entry.tag !== 'tmp-gh-aw');
      const result = planCloudHypervisorFilesystemWriteEnforcement(withoutTmpGhAw, undefined);

      expect(result.mountEnforcement).toEqual({
        plans: [{ tag: 'runner-tool-cache', writableOverlays: [] }],
      });
    });

    it('creates and masks registered paths that do not yet exist', async () => {
      await fs.rm(mcpLogsSource, { recursive: true, force: true });
      const result = planCloudHypervisorFilesystemWriteEnforcement(exports, undefined);

      expect((await fs.stat(mcpLogsSource)).isDirectory()).toBe(true);
      expect(result.mountEnforcement?.plans.find((entry) => entry.tag === 'tmp-gh-aw')?.maskedPaths)
        .toEqual(expectedGhAwMasks());
      expect(result.sensitiveMasks.map(({ id }) => id))
        .toEqual(['mcp-logs', 'firewall-logs', 'firewall-audit']);
    });

    it('fails closed when mcp-logs is a symlink rather than a real directory', async () => {
      await fs.rm(mcpLogsSource, { recursive: true, force: true });
      const realTarget = path.join(directory, 'elsewhere-mcp-logs');
      await fs.mkdir(realTarget, { recursive: true });
      await fs.symlink(realTarget, mcpLogsSource);
      expect(() => planCloudHypervisorFilesystemWriteEnforcement(exports, undefined))
        .toThrow(`Sensitive path must not be a symlink: ${mcpLogsSource}`);
    });

    it('fails closed when mcp-logs exists but is a file', async () => {
      await fs.rm(mcpLogsSource, { recursive: true, force: true });
      await fs.writeFile(mcpLogsSource, 'not a directory');
      expect(() => planCloudHypervisorFilesystemWriteEnforcement(exports, undefined))
        .toThrow(`Sensitive path must be a directory: ${mcpLogsSource}`);
    });

    it('fails closed when a missing registered path has a symlinked parent', async () => {
      const sandbox = path.join(tmpGhAwSource, 'sandbox');
      const realTarget = path.join(directory, 'elsewhere-sandbox');
      await fs.mkdir(realTarget);
      await fs.symlink(realTarget, sandbox);

      expect(() => planCloudHypervisorFilesystemWriteEnforcement(exports, undefined))
        .toThrow(`Sensitive path must not be a symlink: ${sandbox}`);
      await expect(fs.access(path.join(realTarget, 'firewall'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('masks every registered firewall directory that exists in the export', async () => {
      const firewallLogs = path.join(tmpGhAwSource, 'sandbox', 'firewall', 'logs');
      const firewallAudit = path.join(tmpGhAwSource, 'sandbox', 'firewall', 'audit');
      await fs.mkdir(firewallLogs, { recursive: true });
      await fs.mkdir(firewallAudit, { recursive: true });

      const result = planCloudHypervisorFilesystemWriteEnforcement(exports, undefined);
      const tmpGhAwPlan = result.mountEnforcement?.plans.find((entry) => entry.tag === 'tmp-gh-aw');

      expect(tmpGhAwPlan?.maskedPaths).toEqual([
        { destination: mcpLogsSource },
        { destination: firewallLogs },
        { destination: firewallAudit },
      ]);
      expect(result.sensitiveMasks.map(({ id }) => id))
        .toEqual(['mcp-logs', 'firewall-logs', 'firewall-audit']);
    });

    it('keeps the explicitly exempt mcp-payloads path readable and classified', async () => {
      await fs.mkdir(path.join(tmpGhAwSource, 'mcp-payloads'));

      const result = planCloudHypervisorFilesystemWriteEnforcement(exports, undefined);

      expect(result.sensitiveMasks.map(({ id }) => id))
        .toEqual(['mcp-logs', 'firewall-logs', 'firewall-audit']);
      expect(result.unclassifiedPaths).toEqual([]);
    });

    it('reports unknown immediate children for warning-only runtime auditing', async () => {
      const unknown = path.join(tmpGhAwSource, 'new-output');
      await fs.mkdir(unknown);

      const result = planCloudHypervisorFilesystemWriteEnforcement(exports, undefined);

      expect(result.unclassifiedPaths).toEqual([unknown]);
    });
  });
});
