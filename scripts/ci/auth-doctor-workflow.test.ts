import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const sourcePath = path.join(workflowsDir, 'auth-doctor.md');
const lockPath = path.join(workflowsDir, 'auth-doctor.lock.yml');

describe('auth doctor workflow config', () => {
  it('mirrors the runner doctor trigger and safe-output UX', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).toContain('name: Auth Doctor');
    expect(source).toContain('roles: all');
    expect(source).toContain('slash_command:');
    expect(source).toContain('name: auth-doctor');
    expect(source).toContain('actions: read');
    expect(source).toContain('title-prefix: "🩺 Auth Doctor"');
    expect(source).toContain('add-comment:');
    expect(source).toContain('create-issue:');
  });

  it('covers supported auth paths and preserves credential boundaries', () => {
    const source = fs.readFileSync(sourcePath, 'utf-8');

    for (const expected of [
      'OpenAI',
      'Anthropic',
      'GitHub Copilot / Copilot BYOK',
      'Gemini',
      'Vertex AI',
      'Azure',
      'AWS',
      'GCP',
      'Anthropic WIF',
      'auth.type: github-oidc',
      'github/gh-aw#50053',
      'github/gh-aw-firewall#6894',
    ]) {
      expect(source).toContain(expected);
    }

    expect(source).toContain('AWF does not launch or configure mcpg.');
    expect(source).toContain('Do not recommend exposing the Actions OIDC variables to the AWF agent');
    expect(source).toContain('Never inspect the Actions request token or a minted/exchanged credential.');
    expect(source).not.toContain('${{ secrets.');
    expect(source).not.toContain('${{ env.');
  });

  it('compiles the trigger, permissions, and safe outputs into the lock workflow', () => {
    const lock = fs.readFileSync(lockPath, 'utf-8');

    expect(lock).toContain('auth-doctor');
    expect(lock).toContain('actions: read');
    expect(lock).toContain('issues: read');
    expect(lock).toContain('pull-requests: read');
    expect(lock).toContain('🩺 Auth Doctor');
    expect(lock).toMatch(/github\/gh-aw(?:-actions\/|\/actions\/)setup@(?:[a-f0-9]{40}|v\d+\.\d+\.\d+)/);
  });
});
