import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { load } from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

const workflows = [
  {
    source: 'smoke-bounded-agents.md',
    lock: 'smoke-bounded-agents.lock.yml',
    runtime: 'docker',
  },
  {
    source: 'smoke-bounded-agents-gvisor.md',
    lock: 'smoke-bounded-agents-gvisor.lock.yml',
    runtime: 'gvisor',
  },
];

describe.each(workflows)('$source', ({ source, lock, runtime }) => {
  it('validates successful invocations using protected audit and runtime telemetry', () => {
    const sourceText = fs.readFileSync(path.join(workflowsDir, source), 'utf-8');

    expect(sourceText).not.toContain('invocations[0].outcome');
    expect(sourceText).toContain('record.kind === "invocation"');
    expect(sourceText).toContain('record.category === "success"');
  });

  it('configures bounded agents only after gh-aw generates the AWF config', () => {
    const sourceText = fs.readFileSync(path.join(workflowsDir, source), 'utf-8');
    const lockText = fs.readFileSync(path.join(workflowsDir, lock), 'utf-8');

    expect(sourceText).not.toContain('RUNNER_TEMP}/gh-aw/awf-config.json');
    expect(sourceText).toContain(
      `configure-bounded-agent.cjs" "$config_path" ${runtime}`,
    );

    const configGeneration = lockText.indexOf(
      `> "\${RUNNER_TEMP}/gh-aw/awf-config.json"`,
    );
    const wrapperInvocation = lockText.indexOf(
      `configure-bounded-agent.cjs\\" \\"$config_path\\" ${runtime}`,
    );
    const awfInvocation = lockText.indexOf(
      'awf --config "${RUNNER_TEMP}/gh-aw/awf-config.json"',
    );

    expect(configGeneration).toBeGreaterThan(-1);
    expect(wrapperInvocation).toBeGreaterThan(-1);
    expect(awfInvocation).toBeGreaterThan(configGeneration);
  });

  it('patches the generated config immediately before invoking AWF', () => {
    const lockText = fs.readFileSync(path.join(workflowsDir, lock), 'utf-8');
    const workflow = load(lockText) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const setup = workflow.jobs.agent.steps?.find(
      (step) => step.name === 'Replace release bootstrap with current AWF build',
    )?.run;
    expect(setup).toBeDefined();

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-smoke-'));
    const workspace = path.join(tempDir, 'workspace');
    const configPath = path.join(tempDir, 'awf-config.json');
    fs.mkdirSync(path.join(workspace, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, 'dist/cli.js'),
      [
        'const fs = require("fs");',
        'const index = process.argv.indexOf("--config");',
        'process.stdout.write(fs.readFileSync(process.argv[index + 1], "utf8"));',
      ].join('\n'),
    );

    const env = {
      ...process.env,
      HOME: tempDir,
      GITHUB_WORKSPACE: workspace,
    };

    try {
      execFileSync('bash', ['-c', setup ?? 'exit 1'], { env });
      fs.writeFileSync(configPath, '{"apiProxy":{"enabled":true}}\n');
      const output = execFileSync(
        path.join(tempDir, '.local/bin/awf'),
        ['--config', configPath],
        { encoding: 'utf-8', env },
      );
      const config = JSON.parse(output) as {
        apiProxy: { enabled: boolean; targets?: { copilot?: object } };
        boundedAgents: { enabled: boolean; engine: string; runtime: string };
      };

      expect(config.apiProxy.enabled).toBe(true);
      expect(config.apiProxy.targets?.copilot).toEqual({});
      expect(config.boundedAgents).toMatchObject({ enabled: true, engine: 'copilot', runtime });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
