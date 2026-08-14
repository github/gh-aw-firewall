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

  it('resolves only the workspace and narrow existing runtime paths', async () => {
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
      { tag: 'runner-tool-cache', source: realTools, target: tools, mode: 'ro' },
      {
        tag: 'runner-temp-gh-aw',
        source: path.join(realRunnerTemp, 'gh-aw'),
        target: path.join(runnerTemp, 'gh-aw'),
        mode: 'ro',
      },
    ]));
    expect(exports).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: runnerTemp }),
    ]));
  });

  it('uses AGENT_TOOLSDIRECTORY fallback and skips absent optional paths', async () => {
    const workspace = path.join(directory, 'workspace');
    const tools = path.join(directory, 'agent-tools');
    await fs.mkdir(workspace);
    await fs.mkdir(tools);
    const [realWorkspace, realTools] = await Promise.all([
      fs.realpath(workspace),
      fs.realpath(tools),
    ]);
    await expect(resolveCloudHypervisorExports({
      GITHUB_WORKSPACE: workspace,
      AGENT_TOOLSDIRECTORY: tools,
    })).resolves.toEqual(expect.arrayContaining([
      { tag: 'workspace', source: realWorkspace, target: '/workspace', mode: 'rw' },
      { tag: 'runner-tool-cache', source: realTools, target: tools, mode: 'ro' },
    ]));
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
});
