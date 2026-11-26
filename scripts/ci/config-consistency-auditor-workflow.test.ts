import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');

describe('Config Consistency Auditor timeout', () => {
  it('allows 30 minutes for analysis in the source and compiled workflow', () => {
    const source = fs.readFileSync(
      path.join(workflowsDir, 'config-consistency-auditor.md'), 'utf-8',
    );
    const frontmatter = yaml.load(source.split('---')[1]) as Record<string, unknown>;
    const lock = yaml.load(fs.readFileSync(
      path.join(workflowsDir, 'config-consistency-auditor.lock.yml'), 'utf-8',
    )) as {
      jobs: Record<string, {
        'timeout-minutes'?: number;
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

    expect(frontmatter['timeout-minutes']).toBe(30);
    expect(execution?.['timeout-minutes']).toBe(30);
    expect(execution?.env?.GH_AW_TIMEOUT_MINUTES).toBe(30);
    expect(execution?.run).toContain('agentTimeout\\":30');
    expect(errorDetection?.env?.GH_AW_ENGINE_STEP_TIMEOUT_MINUTES).toBe(30);
    expect(failureReport?.env?.GH_AW_TIMEOUT_MINUTES).toBe('30');
    expect(lock.jobs.agent['timeout-minutes']).toBeGreaterThan(30);
  });
});
