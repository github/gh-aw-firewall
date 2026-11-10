import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const source = fs.readFileSync(path.join(workflowsDir, 'self-hosted-runner-doctor-updater.md'), 'utf8');
const lock = fs.readFileSync(path.join(workflowsDir, 'self-hosted-runner-doctor-updater.lock.yml'), 'utf8');
const shared = fs.readFileSync(path.join(workflowsDir, 'shared/diagnosis-maintenance.md'), 'utf8');

describe('runner doctor updater workflow config', () => {
  it('uses shared complete merged intake, not keyword-only candidate gating', () => {
    expect(source).toContain('name: Runner Doctor Updater');
    expect(source).toContain('schedule: daily');
    expect(source).toContain('workflow_dispatch:');
    expect(source).toContain('- shared/diagnosis-maintenance.md');
    expect(source).toContain('allowed-repos: [github/gh-aw-firewall]');
    expect(source).toContain('min-integrity: approved');
    expect(source).toContain('threat-detection:\n    enabled: true');
    expect(source).not.toContain('prepare_candidates');
    expect(source).not.toContain('- shared/self-hosted-failure-modes.md');
    expect(source).toContain('reserve IDs appearing in either surface');
    expect(source).toContain('toolsets: [issues, pull_requests]');
    expect(source).toContain('grep -n "#<ISSUE_OR_PR_NUMBER>"');
    expect(source).not.toContain('cat .github/workflows/shared/self-hosted-failure-modes.md');
    expect(source).toContain('title-prefix: "🩺 Runner Doctor Update"');
    expect(source).toContain('label:runner-doctor');
    expect(source).toContain('id: awf');
    expect(source).not.toContain('runtime: cloud-hypervisor');
    expect(shared).toContain('receipts.json');
    expect(shared).toContain('cache-memory: true');
  });

  it('compiles shared preparation after cache restore and before the sandboxed agent', () => {
    expect(lock).toContain('schedule:');
    expect(lock).toContain('cron:');
    expect(lock).toContain('issues: read');
    expect(lock).toContain('pull-requests: read');
    expect(lock).toContain("GH_AW_GITHUB_REPOS: '[\"github/gh-aw-firewall\"]'");
    expect(lock).toContain("GH_AW_GITHUB_MIN_INTEGRITY: 'approved'");
    expect(lock).toContain('🩺 Runner Doctor Update');
    expect(lock).toContain('Collect merged PR intake and historical catchup');
    expect(lock).toContain('name: diagnosis-intake');
    expect(lock).toContain('scripts/diagnostics/intake.ts');
    expect(lock.indexOf('Restore cache-memory file share data'))
      .toBeLessThan(lock.indexOf('Collect merged PR intake and historical catchup'));
    expect(lock.indexOf('Collect merged PR intake and historical catchup'))
      .toBeLessThan(lock.indexOf('Install AWF binary'));
    expect(lock).toContain('GH_AW_INFO_AGENT_RUNTIME: ""');
    expect(lock).not.toContain('--container-runtime cloud-hypervisor');
    expect(lock).toMatch(/github\/gh-aw(?:-actions\/|\/actions\/)setup@[a-f0-9]{40}/);
    const manifestLine = lock.split('\n').find((line) => line.startsWith('# gh-aw-manifest: '))!;
    const manifest = JSON.parse(manifestLine.slice('# gh-aw-manifest: '.length)) as {
      mcp_servers: { name: string; tools: string[] }[];
      threat_detection: { mode: string };
    };
    expect(manifest.threat_detection.mode).toBe('enabled');
    const compiled = yaml.load(lock) as {
      jobs: { agent: { steps: { id?: string; env?: Record<string, string> }[] } };
    };
    const finalRecoveryStep = compiled.jobs.agent.steps.find(
      (step) => step.id === 'validate_final_recovery_envelopes',
    );
    const recoveryRoots = JSON.parse(
      finalRecoveryStep?.env?.GH_AW_RECOVERY_ADDITIONAL_ROOTS ?? '[]',
    ) as string[];
    expect(recoveryRoots).not.toContain('/tmp/gh-aw/proxy-logs/');
    expect(recoveryRoots).not.toContain('/tmp/gh-aw');
    const githubTools = manifest.mcp_servers.find((server) => server.name === 'github')?.tools;
    expect(githubTools).toEqual(expect.arrayContaining(['issue_read', 'pull_request_read']));
    expect(githubTools).not.toContain('get_commit');
    expect(githubTools).not.toContain('search_code');
  });

  it('retains the bounded dependency-install retry contract in the shared step', () => {
    const workflow = yaml.load(shared.split('---')[1]) as {
      steps: { name: string; run?: string }[];
    };
    const compiled = yaml.load(lock) as { jobs: { agent: { steps: { name: string; run?: string }[] } } };
    const install = workflow.steps.find(
      (step) => step.name === 'Install root dependencies for diagnostics tooling',
    )?.run;
    expect(install).toBeDefined();
    expect(compiled.jobs.agent.steps.find(
      (step) => step.name === 'Install root dependencies for diagnostics tooling',
    )?.run).toBe(install);
    for (const [succeedOn, expectedStatus, expectedAttempts] of [[2, 0, '2'], [4, 1, '3']] as const) {
      const result = spawnSync('bash', ['-c',
        `attempt_count=0
         trap 'echo "$attempt_count"' EXIT
         npm() { attempt_count=$((attempt_count + 1)); [ "$attempt_count" -eq ${succeedOn} ]; }
         sleep() { :; }
         ${install}`,
      ], { encoding: 'utf8' });
      expect(result.status).toBe(expectedStatus);
      expect(result.stdout.trim()).toBe(expectedAttempts);
    }
  });
});
