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
    expect(source).toContain('## Security Checks');
    expect(source).toContain('DROP/REJECT');
    expect(source).toContain('firewall chain changes');
    expect(source).toContain('Squid ACL regressions');
    expect(source).toContain('SYS_ADMIN/NET_RAW');
    expect(source).toContain('seccomp relaxations');
    expect(source).toContain('input validation weakening');
    expect(source).toContain('secrets');
  });

  it('compiles the model/turn settings into lock workflow', () => {
    const lock = fs.readFileSync(securityGuardLockPath, 'utf-8');

    expect(lock).toContain('"agent_model":"claude-sonnet-4-5"');
    expect(lock).toContain('--max-turns 6');
    expect(lock).toContain('ANTHROPIC_MODEL: claude-sonnet-4-5');
    expect(lock).toContain('GH_AW_MAX_TURNS: 6');
  });
});
