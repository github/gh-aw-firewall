import * as fs from 'fs';
import * as path from 'path';
import { COPILOT_PLACEHOLDER_TOKEN } from '../../src/constants/placeholders';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const securityGuardSourcePath = path.join(workflowsDir, 'security-guard.md');
const securityGuardLockPath = path.join(workflowsDir, 'security-guard.lock.yml');

describe('security guard workflow optimization config', () => {
  it('pins model/turn limits and keeps key security checks in prompt', () => {
    const source = fs.readFileSync(securityGuardSourcePath, 'utf-8');

    expect(source).toContain('model: claude-haiku-4-5');
    expect(source).toContain('max-turns: 6');
    expect(source).toContain('## ⚡ Fast Path');
    expect(source).toContain('safeoutputs noop');
    expect(source).toContain('[DIFF TRUNCATED ...]');
    expect(source).toContain('mcp__github__get_pull_request_diff');
    expect(source).toContain('Do NOT call `gh pr diff`, `gh pr view`, `gh api`, `git diff`, `git log`, or `git show`.');
    expect(source).toContain('Do NOT read files from the checkout.');
    expect(source).toContain('Fetch PR metadata');
    expect(source).toContain('${{ steps.pr-meta.outputs.PR_META }}');
    expect(source).toContain('## Security Checks');
    expect(source).toContain('DROP/REJECT');
    expect(source).toContain('egress expansion');
    expect(source).toContain('firewall chain changes');
    expect(source).toContain('Squid ACL regressions');
    expect(source).toContain('SYS_ADMIN/NET_RAW');
    expect(source).toContain('seccomp relaxations');
    expect(source).toContain('DNS/wildcard bypass');
    expect(source).toContain('input validation weakening');
    expect(source).toContain('secrets');
  });

  it('compiles the model/turn settings into lock workflow', () => {
    const lock = fs.readFileSync(securityGuardLockPath, 'utf-8');

    expect(lock).toContain('"agent_model":"claude-haiku-4-5"');
    expect(lock).toContain('COPILOT_MODEL: claude-haiku-4-5');
    expect(lock).toContain('COPILOT_DUMMY_BYOK: dummy-byok-key-for-offline-mode');
    expect(lock).not.toContain(`COPILOT_DUMMY_BYOK: ${COPILOT_PLACEHOLDER_TOKEN}`);
    expect(lock).toContain('GH_AW_MAX_TURNS: 6');
    expect(lock).toContain('github/gh-aw-actions/setup@2ad2a516e432f0a0000cfaed33d262a380f9e58f # v0.82.0');
    expect(lock).not.toContain('github/gh-aw-actions/setup@v0.80.6');
    expect(lock).toContain('ghcr.io/github/github-mcp-server:v1.5.0');
  });
});
