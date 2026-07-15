import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const smokeGvisorClaudeLockPath = path.join(workflowsDir, 'smoke-gvisor-claude.lock.yml');

describe('smoke gVisor Claude workflow', () => {
  it('disables Bun JIT to prevent SIGSEGV/SIGABRT crashes under gVisor', () => {
    const lock = fs.readFileSync(smokeGvisorClaudeLockPath, 'utf-8');

    // BUN_JSC_useJIT=0 must be passed to the AWF command so JavaScriptCore runs
    // in interpreter mode. Without this, Bun's JSC JIT compiler triggers
    // SIGSEGV/SIGABRT under gVisor due to incompatible W^X memory operations.
    // Reference: https://bun.sh/docs/runtime/gvisor
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
