import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

interface WorkflowFrontmatter {
  engine?: {
    id: string;
    version: string;
    'checksums-sha256': string;
  };
  tools?: {
    bash?: string[];
  };
}

function loadFrontmatter(file: string): WorkflowFrontmatter {
  const source = fs.readFileSync(path.join(workflowsDir, file), 'utf-8');
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error(`No frontmatter found in ${file}`);
  }
  return yaml.load(match[1]) as WorkflowFrontmatter;
}

const copilotSmokeWorkflows = [
  { name: 'smoke-copilot-byok-aoai-apikey', file: 'smoke-copilot-byok-aoai-apikey.md' },
  { name: 'smoke-copilot-byok-aoai-entra', file: 'smoke-copilot-byok-aoai-entra.md' },
  { name: 'smoke-copilot-byok', file: 'smoke-copilot-byok.md' },
  { name: 'smoke-copilot', file: 'smoke-copilot.md' },
  { name: 'smoke-copilot-network-isolation', file: 'smoke-copilot-network-isolation.md' },
];

const copilotInstallerWorkflows = [
  ...copilotSmokeWorkflows,
  ...[
    'build-test',
    'firewall-issue-dispatcher',
    'security-guard',
    'smoke-chroot',
    'smoke-cloud-hypervisor',
    'smoke-otel-tracing',
    'smoke-services',
  ].map(name => ({ name, file: `${name}.md` })),
];

describe('smoke copilot workflow output requirements', () => {
  it('runs token-usage verification only after the agent succeeds', () => {
    for (const file of ['smoke-copilot.md', 'smoke-copilot.lock.yml']) {
      const workflow = fs.readFileSync(path.join(workflowsDir, file), 'utf-8');

      expect(workflow).toMatch(
        /^[ \t]*verify_token_usage:[ \t]*\r?\n(?:[ \t]*name:[^\r\n]*\r?\n)?[ \t]*needs:[ \t]*agent[ \t]*\r?\n[ \t]*if:[ \t]*needs\.agent\.result == 'success'[ \t]*$/m,
      );
      expect(workflow).toContain('check-token-usage.js --artifact-root /tmp/gh-aw-agent --engine copilot');
    }
  });

  for (const workflow of copilotInstallerWorkflows) {
    it(`${workflow.name}: pins the CLI release and its independently reviewed checksum manifest`, () => {
      const engine = loadFrontmatter(workflow.file).engine;
      expect(engine).toMatchObject({
        id: 'copilot',
        version: '1.0.101',
        'checksums-sha256': '018625eac68670d66ede904b9b82cdcd6ab8f87ba20e6e1fbdf0b62c8295d5be',
      });

      const lock = yaml.load(fs.readFileSync(
        path.join(workflowsDir, `${workflow.name}.lock.yml`), 'utf-8',
      )) as {
        jobs: { agent: { steps: { name?: string; run?: string }[] } };
      };
      const installer = lock.jobs.agent.steps.find(step =>
        step.name === 'Install GitHub Copilot CLI');
      expect(installer?.run?.trim()).toBe(
        'bash "${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" 1.0.101 ' +
        '--checksums-sha256 018625eac68670d66ede904b9b82cdcd6ab8f87ba20e6e1fbdf0b62c8295d5be',
      );
    });

  }

  for (const workflow of copilotSmokeWorkflows) {
    it(`${workflow.name}: requires noop fallback when no pull request context exists`, () => {
      const source = fs.readFileSync(path.join(workflowsDir, workflow.file), 'utf-8');

      if (workflow.file === 'smoke-copilot.md') {
        expect(source).toContain(
          'For a `workflow_dispatch` or `schedule` trigger, call `noop`',
        );
        expect(source).toContain(
          'Do not attempt pull request comments or labels when there is no pull request.',
        );
      } else {
        expect(source).toContain('**If triggered by a pull request**');
        expect(source).toContain('If all tests pass on a pull request trigger:');
        expect(source).toContain(
          '**If triggered by workflow_dispatch or schedule** (no PR context), call `noop`',
        );
        expect(source).toContain(
          'Do NOT attempt to add pull request comments or labels when there is no pull request.',
        );
      }
    });
  }

  it('smoke-copilot: reports PR context and uses noop without a PR', () => {
    const source = fs.readFileSync(
      path.join(workflowsDir, 'smoke-copilot.md'),
      'utf-8',
    );
    const lock = fs.readFileSync(
      path.join(workflowsDir, 'smoke-copilot.lock.yml'),
      'utf-8',
    );

    expect(source).toContain(
      'If the pre-computed trigger is `pull_request`, call `add_comment`',
    );
    expect(source).toContain('Mention the current pull request author and any assignees');
    expect(source).toContain(
      'For a `workflow_dispatch` or `schedule` trigger, call `noop`',
    );
    expect(lock).not.toContain("--allow-tool '\\''shell(github:*)'\\''");
    expect(lock).toContain("github(list_pull_requests)");
  });

  it('smoke-copilot-network-isolation: grants granular curl shell permission', () => {
    const frontmatter = loadFrontmatter('smoke-copilot-network-isolation.md');
    const lock = fs.readFileSync(
      path.join(workflowsDir, 'smoke-copilot-network-isolation.lock.yml'),
      'utf-8'
    );

    expect(frontmatter.tools?.bash).toEqual(expect.arrayContaining(['curl', 'echo']));
    expect(lock).toContain("--allow-tool '\\''shell(curl:*)'\\''");
    expect(lock).toContain("--allow-tool '\\''shell(echo)'\\''");
  });
});
