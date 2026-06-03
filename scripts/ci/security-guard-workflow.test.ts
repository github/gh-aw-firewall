import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const securityGuardSourcePath = path.join(workflowsDir, 'security-guard.md');
const securityGuardLockPath = path.join(workflowsDir, 'security-guard.lock.yml');

describe('security guard workflow optimization config', () => {
  it('pins model/turn limits and keeps key security checks in prompt', () => {
    const source = fs.readFileSync(securityGuardSourcePath, 'utf-8');

    expect(source).toContain('model: claude-sonnet-4-5');
    expect(source).toContain('max-turns: 6');
    expect(source).toContain('## ⚡ Fast Path');
    expect(source).toContain('safeoutputs noop');
    expect(source).toContain('[DIFF TRUNCATED ...]');
    expect(source).toContain('mcp__github__get_pull_request_diff');
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

    expect(lock).toContain('"agent_model":"claude-sonnet-4-5"');
    expect(lock).toContain('--max-turns 6');
    expect(lock).toContain('ANTHROPIC_MODEL: claude-sonnet-4-5');
    expect(lock).toContain('GH_AW_MAX_TURNS: 6');
    expect(lock).toContain('github/gh-aw-actions/setup@3ea13c02d765410340d533515cb31a7eef2baaf0 # v0.77.5');
    expect(lock).not.toContain('github/gh-aw-actions/setup@v0.77.5');
    expect(lock).toContain('ghcr.io/github/github-mcp-server:v1.1.0@sha256:71b07d9abecb83b4a2595bcd8ccb35f9a0166361a12335f9e16da1ef07172029');
    expect(lock).not.toContain('"container": "ghcr.io/github/github-mcp-server:v1.1.0"');
  });
});
