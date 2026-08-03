import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'auth-doctor-updater.md');
const lockPath = path.join(workflowsDir, 'auth-doctor-updater.lock.yml');

describe('auth doctor updater workflow config', () => {
  it('mirrors the runner doctor updater cadence and proposal-issue contract', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('name: Auth Doctor Updater');
    expect(source).toContain('schedule: daily');
    expect(source).toContain('workflow_dispatch:');
    expect(source).toContain('Compute scan window');
    expect(source).toContain('title-prefix: "🩺 Auth Doctor Update"');
    expect(source).toContain('labels: [documentation, automated]');
    expect(source).toContain('Your only output is one proposed-changes issue or a `noop`.');
    expect(source).toContain('never modify code, create a branch, or open a pull request');
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
    expect(lock).toContain('🩺 Auth Doctor Update');
    expect(lock).toContain('Compute scan window');
    expect(lock).toMatch(/memory-none-nopolicy-\$\{\{ env\.GH_AW_WORKFLOW_ID_SANITIZED \}\}-/);
    expect(lock).toMatch(/github\/gh-aw(?:-actions\/|\/actions\/)setup@[a-f0-9]{40}/);
  });
});
