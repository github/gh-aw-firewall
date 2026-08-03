import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { collectCapabilities, evaluate, renderMatrix } = require(
  path.join(__dirname, 'report-bounded-agent-runtime-matrix.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

describe('bounded-agent runtime capability report', () => {
  it('reports all nine combinations and preserves the sbx bounded-agent security block', () => {
    const capabilities = collectCapabilities((command: string, args: string[]) => {
      if (command === 'docker') {
        return { ok: true, stdout: '{"runc":{},"runsc":{}}' };
      }
      if (args.includes('probe-bounded-agent-primary-sbx.js')) {
        return { ok: true, stdout: 'Docker Sandboxes v0.37.1' };
      }
      if (args.includes('sbx-capability-probe.js')) {
        return { ok: false, stdout: '{"supported":false}' };
      }
      return { ok: false, stdout: '' };
    });
    const report = renderMatrix(capabilities);
    const rows = report.split('\n').filter((line: string) => /^\| (docker|gvisor|sbx) /.test(line));
    expect(rows).toHaveLength(9);
    expect(report).toContain(
      '| sbx | sbx | BLOCKED | supported | blocked | bounded-agent-preflight |',
    );
    expect(report).toContain('BLOCKED is an expected fail-closed security result, not runtime success');
    expect(report).toContain('bounded-agent sbx enclave is BLOCKED unconditionally today');
  });

  it('never promotes an unavailable primary or bounded-agent runtime through fallback', () => {
    const capabilities = {
      primary: { docker: 'supported', gvisor: 'unavailable', sbx: 'unavailable' },
      boundedAgent: { docker: 'supported', gvisor: 'unavailable', sbx: 'blocked' },
    };
    expect(evaluate('gvisor', 'docker', capabilities)).toEqual({
      status: 'BLOCKED',
      capability: 'unavailable',
      phase: 'primary-preflight',
    });
    expect(evaluate('docker', 'gvisor', capabilities)).toEqual({
      status: 'BLOCKED',
      capability: 'unavailable',
      phase: 'bounded-agent-preflight',
    });
    expect(evaluate('docker', 'sbx', capabilities)).toEqual({
      status: 'BLOCKED',
      capability: 'blocked',
      phase: 'bounded-agent-preflight',
    });
  });

  it('supports primary sbx paired with docker/gvisor bounded-agent enclaves once primary sbx is proven', () => {
    // `supported` means the collector's executable ingress probe completed.
    const capabilities = {
      primary: { docker: 'supported', gvisor: 'supported', sbx: 'supported' },
      boundedAgent: { docker: 'supported', gvisor: 'supported', sbx: 'blocked' },
    };
    expect(evaluate('sbx', 'docker', capabilities).status).toBe('SUPPORTED');
    expect(evaluate('sbx', 'gvisor', capabilities).status).toBe('SUPPORTED');
    expect(evaluate('sbx', 'sbx', capabilities).status).toBe('BLOCKED');
  });

  it('does not promote primary sbx when only its CLI and daemon are available', () => {
    const capabilities = collectCapabilities((command: string, args: string[]) => {
      if (command === 'docker') return { ok: true, stdout: '{"runc":{}}' };
      if (command === 'sbx' && args[0] === 'ls') return { ok: true, stdout: '[]' };
      return { ok: false, stdout: '' };
    });
    expect(capabilities.primary.sbx).toBe('unavailable');
    expect(evaluate('sbx', 'docker', capabilities)).toEqual({
      status: 'BLOCKED',
      capability: 'unavailable',
      phase: 'primary-preflight',
    });
  });

  it('emits an explicit capability-blocked report (not a false pass) when no real sbx binary is present', () => {
    const capabilities = collectCapabilities((command: string) => {
      if (command === 'docker') {
        return { ok: true, stdout: '{"runc":{}}' };
      }
      // Simulate the local/CI environment used in this task: no `sbx` binary
      // installed at all, and no bounded-agent broker probe reachable.
      return { ok: false, stdout: '' };
    });
    expect(capabilities.primary.sbx).toBe('unavailable');
    expect(capabilities.boundedAgent.sbx).toBe('blocked');
    expect(() => {
      const report = renderMatrix(capabilities);
      const requirement = evaluate('sbx', 'sbx', capabilities);
      if (requirement.status !== 'SUPPORTED') {
        throw new Error(
          `Required runtime combination sbx/sbx is ${requirement.status} at ${requirement.phase}`,
        );
      }
      return report;
    }).toThrow(/sbx\/sbx is BLOCKED at primary-preflight/);
  });
});
