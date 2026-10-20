import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'model-api-mapping-updater.md');
const lockPath = path.join(workflowsDir, 'model-api-mapping-updater.lock.yml');

describe('model API mapping review workflow', () => {
  it('only runs manually and cannot author mapping changes', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const frontmatter = yaml.load(source.split('---')[1]) as {
      on: Record<string, unknown>;
      tools: { edit?: unknown };
      'safe-outputs': Record<string, unknown>;
    };

    expect(Object.keys(frontmatter.on)).toEqual(['workflow_dispatch']);
    expect(frontmatter.tools.edit).toBeUndefined();
    expect(frontmatter['safe-outputs']).toMatchObject({
      'report-failed-jobs': false,
      'report-failure-as-issue': false,
      jobs: { 'report-mapping-review': { inputs: { findings: { required: true } } } },
      noop: { 'report-as-issue': false },
    });
    expect(source).toContain('Do not edit the mapping or any other repository file.');
    expect(source).toContain('Do not update `lastUpdated` based on the wall clock.');
    expect(source).not.toContain('allowed-files:');
    expect(source).not.toContain('create a pull request with title');
  });

  it('compiles to a dispatch-only workflow with no authoring safe outputs', () => {
    const lockText = fs.readFileSync(lockPath, 'utf-8');
    const lock = yaml.load(lockText) as { on: Record<string, unknown> };
    const manifestLine = lockText.split('\n').find(line => line.startsWith('# gh-aw-manifest: '));
    expect(manifestLine).toBeDefined();
    const manifest = JSON.parse(manifestLine!.slice('# gh-aw-manifest: '.length)) as {
      mcp_servers: { name: string; tools: string[] }[];
    };
    const safeTools = manifest.mcp_servers.find(server => server.name === 'safeoutputs')?.tools;

    expect(Object.keys(lock.on)).toEqual(['workflow_dispatch']);
    expect(safeTools).toContain('noop');
    expect(safeTools).toContain('report_mapping_review');
    expect(safeTools).not.toContain('create_pull_request');
    expect(safeTools).not.toContain('create_issue');
    expect(lockText).not.toContain('allowed-files:');
    expect(lockText).not.toContain('"report-as-issue":"true"');
  });
});
