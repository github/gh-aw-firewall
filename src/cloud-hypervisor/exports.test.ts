import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveCloudHypervisorExports,
  validateCloudHypervisorExports,
} from './exports';

describe('Cloud Hypervisor directory exports', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ch-exports-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('defaults to workspace-only and does not infer tool-cache exposure from the environment', async () => {
    const workspace = path.join(directory, 'workspace');
    const tools = path.join(directory, 'tools');
    const runnerTemp = path.join(directory, 'runner-temp');
    await Promise.all([
      fs.mkdir(workspace),
      fs.mkdir(tools),
      fs.mkdir(path.join(runnerTemp, 'gh-aw'), { recursive: true }),
    ]);
    const [realWorkspace, realTools, realRunnerTemp] = await Promise.all([
      fs.realpath(workspace),
      fs.realpath(tools),
      fs.realpath(runnerTemp),
    ]);
    const exports = await resolveCloudHypervisorExports({
      GITHUB_WORKSPACE: workspace,
      RUNNER_TOOL_CACHE: tools,
      RUNNER_TEMP: runnerTemp,
    });
    expect(exports).toEqual(expect.arrayContaining([
      { tag: 'workspace', source: realWorkspace, target: '/workspace', mode: 'rw' },
      {
        tag: 'runner-temp-gh-aw',
        source: path.join(realRunnerTemp, 'gh-aw'),
        target: path.join(runnerTemp, 'gh-aw'),
        mode: 'ro',
      },
    ]));
    expect(exports).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: runnerTemp }),
      expect.objectContaining({ source: realTools }),
    ]));
  });

  it('mounts RUNNER_TOOL_CACHE read-only only under the explicit opt-in policy', async () => {
    const workspace = path.join(directory, 'workspace');
    const tools = path.join(directory, 'tools');
    await Promise.all([fs.mkdir(workspace), fs.mkdir(tools)]);
    const realTools = await fs.realpath(tools);

    await expect(resolveCloudHypervisorExports(
      { GITHUB_WORKSPACE: workspace, RUNNER_TOOL_CACHE: tools },
      directory,
      'workspace-and-tool-cache',
    )).resolves.toEqual(expect.arrayContaining([
      { tag: 'runner-tool-cache', source: realTools, target: tools, mode: 'ro' },
    ]));
  });

  it('rejects a tool cache that aliases a writable export source', async () => {
    const workspace = path.join(directory, 'workspace');
    const tools = path.join(workspace, 'tools');
    await fs.mkdir(tools, { recursive: true });

    await expect(resolveCloudHypervisorExports(
      { GITHUB_WORKSPACE: workspace, RUNNER_TOOL_CACHE: tools },
      directory,
      'workspace-and-tool-cache',
    )).rejects.toThrow(
      'Cloud Hypervisor runner tool cache source overlaps writable export "workspace"',
    );
    await expect(resolveCloudHypervisorExports(
      { GITHUB_WORKSPACE: tools, RUNNER_TOOL_CACHE: workspace },
      directory,
      'workspace-and-tool-cache',
    )).rejects.toThrow(
      'Cloud Hypervisor runner tool cache source overlaps writable export "workspace"',
    );
  });

  it('uses AGENT_TOOLSDIRECTORY only under the explicit opt-in policy', async () => {
    const workspace = path.join(directory, 'workspace');
    const tools = path.join(directory, 'agent-tools');
    await fs.mkdir(workspace);
    await fs.mkdir(tools);
    const [realWorkspace, realTools] = await Promise.all([
      fs.realpath(workspace),
      fs.realpath(tools),
    ]);
    await expect(resolveCloudHypervisorExports(
      {
        GITHUB_WORKSPACE: workspace,
        AGENT_TOOLSDIRECTORY: tools,
      },
      directory,
      'workspace-and-tool-cache',
    )).resolves.toEqual(expect.arrayContaining([
      { tag: 'workspace', source: realWorkspace, target: '/workspace', mode: 'rw' },
      { tag: 'runner-tool-cache', source: realTools, target: tools, mode: 'ro' },
    ]));
  });

  it('fails closed when tool-cache opt-in has no usable cache path', async () => {
    const workspace = path.join(directory, 'workspace');
    await fs.mkdir(workspace);

    await expect(resolveCloudHypervisorExports(
      { GITHUB_WORKSPACE: workspace },
      directory,
      'workspace-and-tool-cache',
    )).rejects.toThrow(/requires RUNNER_TOOL_CACHE or AGENT_TOOLSDIRECTORY/);
    await expect(resolveCloudHypervisorExports(
      { GITHUB_WORKSPACE: workspace, RUNNER_TOOL_CACHE: path.join(directory, 'missing') },
      directory,
      'workspace-and-tool-cache',
    )).rejects.toThrow(/runner-tool-cache.*existing real directory/);
  });

  it('fails closed on an unsupported policy', async () => {
    await expect(resolveCloudHypervisorExports(
      { GITHUB_WORKSPACE: directory },
      directory,
      'automatic' as 'workspace-only',
    )).rejects.toThrow('Unsupported Cloud Hypervisor mount policy: automatic');
  });

  it('rejects unsafe, duplicate, and overlapping contracts', () => {
    expect(() => validateCloudHypervisorExports([
      { tag: 'workspace', source: '/host/work', target: '/workspace', mode: 'rw' },
      { tag: 'bad/tag', source: '/host/cache', target: '/cache', mode: 'ro' },
    ])).toThrow(/Unsafe.*tag/);
    expect(() => validateCloudHypervisorExports([
      { tag: 'workspace', source: '/host/work', target: '/workspace', mode: 'rw' },
      { tag: 'cache', source: '/host/cache', target: '/workspace/cache', mode: 'ro' },
    ])).toThrow(/Overlapping/);
    expect(() => validateCloudHypervisorExports([
      { tag: 'workspace', source: 'relative', target: '/workspace', mode: 'rw' },
    ])).toThrow(/absolute clean/);
  });

  it('only permits a read-only workspace when explicitly allowed', () => {
    const readOnlyWorkspace = [
      { tag: 'workspace', source: '/host/work', target: '/workspace', mode: 'ro' as const },
    ];

    expect(() => validateCloudHypervisorExports(readOnlyWorkspace))
      .toThrow('Cloud Hypervisor requires read-write tag "workspace" at /workspace');
    expect(() => validateCloudHypervisorExports(readOnlyWorkspace, {}))
      .toThrow('Cloud Hypervisor requires read-write tag "workspace" at /workspace');
    expect(validateCloudHypervisorExports(readOnlyWorkspace, { allowReadOnlyWorkspace: true }))
      .toEqual(readOnlyWorkspace);
    // The option relaxes only the mode, never the presence or target of the
    // workspace export.
    expect(() => validateCloudHypervisorExports(
      [{ tag: 'cache', source: '/host/cache', target: '/cache', mode: 'ro' }],
      { allowReadOnlyWorkspace: true },
    )).toThrow('Cloud Hypervisor requires tag "workspace" at /workspace');
  });
});
