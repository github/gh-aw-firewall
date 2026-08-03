import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'auth-doctor-updater.md');
const lockPath = path.join(workflowsDir, 'auth-doctor-updater.lock.yml');

describe('auth doctor updater workflow config', () => {
  it('uses updater cadence with a bounded documentation PR contract', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('name: Auth Doctor Updater');
    expect(source).toContain('schedule: daily');
    expect(source).toContain('workflow_dispatch:');
    expect(source).toContain('Compute scan window');
    expect(source).toContain('query: \'is:pr is:open in:title "[docs] auth:"\'');
    expect(source).toContain('title-prefix: "[docs] auth: "');
    expect(source).toContain('labels: [documentation, ai-generated]');
    expect(source).toContain('create-pull-request:');
    expect(source).toContain('allowed-files:');
    expect(source).toContain('docs/auth-matrix.md');
    expect(source).toContain('never run `git commit`, `git push`, or `gh pr create`');
    expect(source).not.toContain('create-issue:');
  });

  it('audits supported auth paths and keeps trust boundaries explicit', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    for (const expected of [
      'OpenAI',
      'Anthropic',
      'GitHub Copilot',
      'BYOK',
      'Gemini',
      'Vertex',
      'Azure',
      'AWS Bedrock',
      'GCP Vertex',
      'Anthropic WIF',
      'auth.type: github-oidc',
      'github/gh-aw#50053',
      'github/gh-aw-firewall#6894',
    ]) {
      expect(source).toContain(expected);
    }

    expect(source).toContain('AWF does not launch or configure mcpg.');
    expect(source).toContain('Never run credential probes, token exchanges, inference requests');
    expect(source).not.toContain('${{ secrets.');
    expect(source).not.toContain('${{ env.');
  });

  it('compiles the schedule, scan window, permissions, and safe outputs', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('schedule:');
    expect(lock).toContain('cron:');
    expect(lock).toContain('issues: read');
    expect(lock).toContain('pull-requests: read');
    expect(lock).toContain('[docs] auth:');
    expect(lock).toContain('Compute scan window');
    expect(lock).toContain('create_pull_request');
    expect(lock).toContain('docs/auth-matrix.md');
    expect(lock).toMatch(/memory-none-nopolicy-\$\{\{ env\.GH_AW_WORKFLOW_ID_SANITIZED \}\}-/);
    expect(lock).toMatch(/github\/gh-aw(?:-actions\/|\/actions\/)setup@[a-f0-9]{40}/);
  });
});
