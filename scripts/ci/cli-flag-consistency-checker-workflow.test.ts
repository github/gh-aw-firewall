import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

describe('CLI flag consistency checker timeout', () => {
  it('allows 25 minutes for analysis in the source and compiled workflow', () => {
    const source = fs.readFileSync(
      path.join(workflowsDir, 'cli-flag-consistency-checker.md'), 'utf-8',
    );
    const frontmatter = yaml.load(source.split('---')[1]) as Record<string, unknown>;
    const lock = yaml.load(fs.readFileSync(
      path.join(workflowsDir, 'cli-flag-consistency-checker.lock.yml'), 'utf-8',
    )) as {
      jobs: Record<string, {
        steps: Array<{
          name: string;
          'timeout-minutes'?: number;
          env?: Record<string, unknown>;
          run?: string;
        }>;
      }>;
    };
    const execution = lock.jobs.agent.steps.find(
      step => step.name === 'Execute GitHub Copilot CLI',
    );
    const errorDetection = lock.jobs.agent.steps.find(
      step => step.env?.GH_AW_ENGINE_STEP_TIMEOUT_MINUTES !== undefined,
    );
    const failureReport = lock.jobs.conclusion.steps.find(
      step => step.env?.GH_AW_FAILURE_REPORT_AS_ISSUE === 'true',
    );

    expect(frontmatter['timeout-minutes']).toBe(25);
    expect(execution?.['timeout-minutes']).toBe(25);
    expect(execution?.env?.GH_AW_TIMEOUT_MINUTES).toBe(25);
    expect(execution?.run).toContain('agentTimeout\\":25');
    expect(errorDetection?.env?.GH_AW_ENGINE_STEP_TIMEOUT_MINUTES).toBe(25);
    expect(failureReport?.env?.GH_AW_TIMEOUT_MINUTES).toBe('25');
  });
});
