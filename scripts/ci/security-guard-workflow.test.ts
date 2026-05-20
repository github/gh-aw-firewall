import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const securityGuardSourcePath = path.join(workflowsDir, 'security-guard.md');
const securityGuardLockPath = path.join(workflowsDir, 'security-guard.lock.yml');

describe('security guard workflow optimization config', () => {
  it('pins model/turn limits and includes fast noop gate', () => {
    const source = fs.readFileSync(securityGuardSourcePath, 'utf-8');

    expect(source).toContain('model: claude-sonnet-4-5');
    expect(source).toContain('max-turns: 3');
    expect(source).toContain('## Immediate Decision Gate');
    expect(source).toContain('Call `safeoutputs noop` immediately without further tool use.');
    expect(source).toContain(
      'Check: iptables ACCEPT/DROP changes, Squid ACL regressions, capability additions (SYS_ADMIN/NET_RAW), seccomp relaxation, egress port expansion, DNS bypass, wildcard bypass, secrets.'
    );
  });

  it('compiles the model/turn settings into lock workflow', () => {
    const lock = fs.readFileSync(securityGuardLockPath, 'utf-8');

    expect(lock).toContain('"agent_model":"claude-sonnet-4-5"');
    expect(lock).toContain('--max-turns 3');
    expect(lock).toContain('ANTHROPIC_MODEL: claude-sonnet-4-5');
    expect(lock).toContain('GH_AW_MAX_TURNS: 3');
  });
});
