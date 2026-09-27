import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeGvisorClaudeLockPath = path.resolve(__dirname, '../../.github/disabled-workflows/smoke-gvisor-claude.lock.yml');

describe('disabled gVisor and Docker SBX workflows', () => {
  it.each([
    'sbx-gvisor-doc-updater',
    'sbx-rollout-monitor',
    'smoke-gvisor',
    'smoke-gvisor-build-test',
    'smoke-gvisor-claude',
    'smoke-gvisor-codex',
    'smoke-playwright-gvisor',
  ])('keeps %s out of active workflows', workflow => {
    expect(fs.existsSync(path.join(workflowsDir, `${workflow}.md`))).toBe(false);
    expect(fs.existsSync(path.join(workflowsDir, `${workflow}.lock.yml`))).toBe(false);
    expect(fs.existsSync(path.resolve(workflowsDir, `../disabled-workflows/${workflow}.md`))).toBe(true);
  });

  it.each(['test-gvisor-compat', 'test-gvisor-firewall-comparison'])(
    'keeps %s out of active workflows',
    workflow => {
      expect(fs.existsSync(path.join(workflowsDir, `${workflow}.yml`))).toBe(false);
      expect(fs.existsSync(path.resolve(workflowsDir, `../disabled-workflows/${workflow}.yml`))).toBe(true);
    }
  );

  it('does not need --env BUN_JSC_useJIT=0 in the lock file (AWF injects it at runtime)', () => {
    const lock = fs.readFileSync(smokeGvisorClaudeLockPath, 'utf-8');

    // BUN_JSC_useJIT=0 is now injected automatically by AWF when it detects
    // Claude running under gVisor (see tool-specific-environment.ts).
    // The lock file should NOT contain the flag — if it does, the postprocess
    // workaround was not fully removed.
    expect(lock).not.toContain('--env BUN_JSC_useJIT=0');
  });

  it('uses gVisor container runtime', () => {
    const lock = fs.readFileSync(smokeGvisorClaudeLockPath, 'utf-8');

    expect(lock).toContain('awf --container-runtime gvisor --config');
  });
});
