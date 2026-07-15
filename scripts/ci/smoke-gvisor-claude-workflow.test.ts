import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeGvisorClaudeLockPath = path.join(workflowsDir, 'smoke-gvisor-claude.lock.yml');

describe('smoke gVisor Claude workflow', () => {
  it('disables Bun JIT in the gVisor Claude smoke workflow', () => {
    const lock = fs.readFileSync(smokeGvisorClaudeLockPath, 'utf-8');

    // BUN_JSC_useJIT=0 must be passed to the AWF command so JavaScriptCore runs
    // in interpreter mode. This avoids the SIGSEGV/SIGABRT failures observed when
    // Claude Code's Bun runtime enables JIT in this gVisor workflow.
    // Reference for the option: https://github.com/oven-sh/bun/issues/22901
    expect(lock).toContain('BUN_JSC_useJIT=0');
    expect(lock).toContain('--env BUN_JSC_useJIT=0');
  });

  it('uses gVisor container runtime', () => {
    const lock = fs.readFileSync(smokeGvisorClaudeLockPath, 'utf-8');

    // The awf-config.json is embedded in the lock file as escaped JSON in a YAML string.
    // containerRuntime is set inside the container config object.
    expect(lock).toContain('containerRuntime\\":\\"gvisor\\"');
  });
});
