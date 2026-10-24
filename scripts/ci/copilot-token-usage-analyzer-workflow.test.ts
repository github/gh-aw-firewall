import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'copilot-token-usage-analyzer.md');

describe('copilot token usage analyzer workflow prompt', () => {
  it('pins the CLI install to the reviewed release instead of resolving mutable compatibility defaults', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');
    const frontmatter = yaml.load(source.split('---')[1]) as {
      engine: { id: string; version: string };
    };
    const lock = fs.readFileSync(
      path.join(workflowsDir, 'copilot-token-usage-analyzer.lock.yml'),
      'utf-8',
    );
    const compiled = yaml.load(lock) as {
      jobs: { agent: { steps: Array<{ name?: string; run?: string }> } };
    };
    const installStep = compiled.jobs.agent.steps.find(
      step => step.name === 'Install GitHub Copilot CLI',
    );
    const metadata = JSON.parse(lock.split('\n')[0].slice('# gh-aw-metadata: '.length));

    expect(frontmatter.engine).toEqual({ id: 'copilot', version: '1.0.98' });
    expect(metadata.engine_versions.copilot).toBe(frontmatter.engine.version);
    expect(installStep?.run).toBe(
      `bash "\${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" ${frontmatter.engine.version}`,
    );
  });

  it('includes explicit compact-output guardrails to reduce AI credit usage', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('<summary><b>Top Per-Workflow Details</b></summary>');
    expect(source).not.toMatch(/^##.*Per-Workflow Details/m);
    expect(source).toContain('include detailed bullets for at most the top 10 workflows by token usage');
    expect(source).toContain('if output size is high, trim detail instead of repeatedly reformatting the full report');
  });
});
