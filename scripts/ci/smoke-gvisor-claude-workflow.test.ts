import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeGvisorClaudeLockPath = path.join(workflowsDir, 'smoke-gvisor-claude.lock.yml');

describe('smoke gVisor Claude workflow', () => {
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

    // The awf-config.json is embedded in the lock file as escaped JSON in a YAML string.
    // containerRuntime is set inside the container config object.
    expect(lock).toContain('containerRuntime\\":\\"gvisor\\"');
  });
});
