import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'self-hosted-runner-doctor-updater.md');
const lockPath = path.join(workflowsDir, 'self-hosted-runner-doctor-updater.lock.yml');

describe('runner doctor updater workflow config', () => {
  it('defines a daily knowledge-base maintenance workflow with the shared failure-mode import', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('name: Runner Doctor Updater');
    expect(source).toContain('schedule: daily');
    expect(source).toContain('workflow_dispatch:');
    expect(source).toContain('shared/self-hosted-failure-modes.md');
    expect(source).toContain('title-prefix: "🩺 Runner Doctor Update"');
    expect(source).toContain('label:runner-doctor');
    expect(source).toContain('Compute scan window');
    expect(source).toContain('for attempt in 1 2 3; do');
    expect(source).toContain('if npm ci; then');
    expect(source).toContain('if [ "$attempt" -eq 3 ]; then');
    expect(source).toContain('id: awf');
    expect(source).not.toContain('runtime: cloud-hypervisor');
  });

  it('compiles the schedule, scan window, safe outputs, and knowledge-base references into the lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('schedule:');
    expect(lock).toContain('cron:');
    expect(lock).toContain('issues: read');
    expect(lock).toContain('pull-requests: read');
    expect(lock).toContain('🩺 Runner Doctor Update');
    expect(lock).toContain('shared/self-hosted-failure-modes.md');
    expect(lock).toContain('Compute scan window');
    expect(lock).toContain('for attempt in 1 2 3; do');
    expect(lock).toContain('if npm ci; then');
    expect(lock).toContain('if [ "$attempt" -eq 3 ]; then');
    expect(lock).toContain('GH_AW_INFO_AGENT_RUNTIME: ""');
    expect(lock).not.toContain('--container-runtime cloud-hypervisor');
    expect(lock).toMatch(/memory-none-nopolicy-\$\{\{ env\.GH_AW_WORKFLOW_ID_SANITIZED \}\}-/);
    expect(lock).toMatch(/github\/gh-aw(?:-actions\/|\/actions\/)setup@[a-f0-9]{40}/);
  });

  it('retries a failed install and stops after three failed attempts', () => {
    const lock = yaml.load(fs.readFileSync(lockPath, 'utf-8')) as {
      jobs: { agent: { steps: { name: string; run?: string }[] } };
    };
    const install = lock.jobs.agent.steps.find(
      (step) => step.name === 'Install root dependencies for diagnostics tooling'
    )?.run;
    expect(install).toBeDefined();

    for (const [succeedOn, expectedStatus, expectedAttempts] of [[2, 0, '2'], [4, 1, '3']] as const) {
      const result = spawnSync('bash', ['-c',
        `attempt_count=0
         trap 'echo "$attempt_count"' EXIT
         npm() { attempt_count=$((attempt_count + 1)); [ "$attempt_count" -eq ${succeedOn} ]; }
         sleep() { :; }
         ${install}`,
      ], { encoding: 'utf-8' });
      expect(result.status).toBe(expectedStatus);
      expect(result.stdout.trim()).toBe(expectedAttempts);
    }
  });
});
