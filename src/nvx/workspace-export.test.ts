import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  NVX_GUEST_WORKSPACE,
  resolveNvxExports,
  validateNvxExports,
  type NvxDirectoryExport,
} from './workspace-export';

async function makeTempDirectory(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nvx-exports-')));
}

function workspaceExport(overrides: Partial<NvxDirectoryExport> = {}): NvxDirectoryExport {
  return {
    tag: 'workspace',
    source: '/home/runner/work/repo',
    target: NVX_GUEST_WORKSPACE,
    mode: 'rw',
    ...overrides,
  };
}

describe('resolveNvxExports', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDirectory();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('exports only the canonicalized workspace under the default mount policy', async () => {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    await fs.symlink(workspace, path.join(root, 'link'));

    const resolved = await resolveNvxExports(
      { GITHUB_WORKSPACE: path.join(root, 'link') },
      root,
      'workspace-only',
    );

    expect(resolved).toEqual([
      { tag: 'workspace', source: workspace, target: NVX_GUEST_WORKSPACE, mode: 'rw' },
    ]);
  });

  it('falls back to the current working directory when GITHUB_WORKSPACE is unset', async () => {
    const resolved = await resolveNvxExports({}, root);
    expect(resolved[0].source).toBe(root);
  });

  it('adds a read-only tool cache export under workspace-and-tool-cache', async () => {
    const workspace = path.join(root, 'workspace');
    const toolCache = path.join(root, 'tool-cache');
    await fs.mkdir(workspace);
    await fs.mkdir(toolCache);

    const resolved = await resolveNvxExports(
      { GITHUB_WORKSPACE: workspace, RUNNER_TOOL_CACHE: toolCache },
      root,
      'workspace-and-tool-cache',
    );

    expect(resolved).toHaveLength(2);
    expect(resolved[1]).toEqual({
      tag: 'runner-tool-cache',
      source: toolCache,
      target: toolCache,
      mode: 'ro',
    });
  });

  it('fails closed when the tool cache policy has no tool cache directory', async () => {
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    await expect(resolveNvxExports(
      { GITHUB_WORKSPACE: workspace },
      root,
      'workspace-and-tool-cache',
    )).rejects.toThrow(/requires RUNNER_TOOL_CACHE or AGENT_TOOLSDIRECTORY/);
  });

  it('rejects an unsupported mount policy and a non-directory workspace', async () => {
    await expect(resolveNvxExports({ GITHUB_WORKSPACE: root }, root, 'everything' as never))
      .rejects.toThrow(/Unsupported NVX mount policy/);

    const file = path.join(root, 'file');
    await fs.writeFile(file, 'x');
    await expect(resolveNvxExports({ GITHUB_WORKSPACE: file }, root))
      .rejects.toThrow(/must be a directory/);
  });
});

describe('validateNvxExports', () => {
  it('accepts a minimal workspace-only layout', () => {
    expect(() => validateNvxExports([workspaceExport()])).not.toThrow();
  });

  it('requires a workspace export staged at the fixed guest path', () => {
    expect(() => validateNvxExports([workspaceExport({ tag: 'other' })]))
      .toThrow(/must include a "workspace" export/);
    expect(() => validateNvxExports([workspaceExport({ target: '/srv' })]))
      .toThrow(/must be staged at \/workspace/);
  });

  it('rejects empty and oversized export sets', () => {
    expect(() => validateNvxExports([])).toThrow(/between 1 and 2 guest exports/);
    expect(() => validateNvxExports([
      workspaceExport(),
      workspaceExport({ tag: 'a', source: '/a', target: '/a' }),
      workspaceExport({ tag: 'b', source: '/b', target: '/b' }),
    ])).toThrow(/between 1 and 2 guest exports/);
  });

  it('rejects unsafe, duplicate, relative, and root-level entries', () => {
    expect(() => validateNvxExports([workspaceExport(), workspaceExport({ tag: 'bad tag' })]))
      .toThrow(/Unsafe NVX export tag/);
    expect(() => validateNvxExports([workspaceExport(), workspaceExport()]))
      .toThrow(/Duplicate NVX export tag/);
    expect(() => validateNvxExports([workspaceExport({ source: 'repo' })]))
      .toThrow(/source must be an absolute normalized path/);
    expect(() => validateNvxExports([
      workspaceExport(),
      workspaceExport({ tag: 'cache', source: '/cache', target: '/cache/../cache' }),
    ])).toThrow(/target must be an absolute normalized path/);
    expect(() => validateNvxExports([
      workspaceExport(),
      workspaceExport({ tag: 'root', source: '/cache', target: '/' }),
    ])).toThrow(/must not be staged at the guest filesystem root/);
  });

  it('rejects targets colliding with the AWF-owned run script directory', () => {
    expect(() => validateNvxExports([
      workspaceExport(),
      workspaceExport({ tag: 'awf', source: '/cache', target: '/etc/awf' }),
    ])).toThrow(/collides with an AWF-owned guest path/);
    expect(() => validateNvxExports([
      workspaceExport(),
      workspaceExport({ tag: 'home-config', source: '/cache', target: '/home/awf/.config' }),
    ])).toThrow(/collides with an AWF-owned guest path/);
    expect(() => validateNvxExports([
      workspaceExport(),
      workspaceExport({ tag: 'awf-child', source: '/cache', target: '/etc/awf/cache' }),
    ])).toThrow(/collides with an AWF-owned guest path/);
  });

  it('rejects nested export targets and nested export sources', () => {
    expect(() => validateNvxExports([
      workspaceExport(),
      workspaceExport({ tag: 'nested', source: '/cache', target: '/workspace/cache' }),
    ])).toThrow(/targets must not nest/);
    expect(() => validateNvxExports([
      workspaceExport(),
      workspaceExport({
        tag: 'nested',
        source: '/home/runner/work/repo/cache',
        target: '/cache',
      }),
    ])).toThrow(/sources must not nest/);
  });
});
