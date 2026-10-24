import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

describe('copilot token optimizer workflow', () => {
  it('pins the CLI install and reviewed checksum instead of resolving mutable compatibility defaults', () => {
    const source = fs.readFileSync(
      path.join(workflowsDir, 'copilot-token-optimizer.md'),
      'utf-8',
    );
    const frontmatter = yaml.load(source.split('---')[1]) as {
      engine: { id: string; version: string; 'checksums-sha256': string };
    };
    const lock = fs.readFileSync(
      path.join(workflowsDir, 'copilot-token-optimizer.lock.yml'),
      'utf-8',
    );
    const compiled = yaml.load(lock) as {
      jobs: { agent: { steps: Array<{ name?: string; run?: string }> } };
    };
    const installStep = compiled.jobs.agent.steps.find(
      step => step.name === 'Install GitHub Copilot CLI',
    );
    const metadata = JSON.parse(lock.split('\n')[0].slice('# gh-aw-metadata: '.length));

    expect(frontmatter.engine).toEqual({
      id: 'copilot',
      version: '1.0.101',
      'checksums-sha256': '018625eac68670d66ede904b9b82cdcd6ab8f87ba20e6e1fbdf0b62c8295d5be',
    });
    expect(metadata.engine_versions.copilot).toBe(frontmatter.engine.version);
    expect(installStep?.run).toBe(
      `bash "\${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" ${frontmatter.engine.version} --checksums-sha256 ${frontmatter.engine['checksums-sha256']}`,
    );
  });
});
