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
      if (command === 'sbx') {
        expect(args).toEqual(['ls']);
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
      '| sbx | sbx | BLOCKED | available | blocked | primary-sbx-ingress-unproven |',
    );
    expect(report).toContain('BLOCKED is an expected fail-closed security result, not runtime success');
    expect(report).toContain('bounded-agent sbx enclave is BLOCKED unconditionally today');
  });

  it('never reports SUPPORTED for primary sbx from `sbx ls` alone, only `available`', () => {
    const capabilities = collectCapabilities((command: string) => {
      if (command === 'docker') return { ok: true, stdout: '{"runc":{}}' };
      // `sbx ls` succeeds: the CLI/daemon is installed, authenticated, and
      // reachable, but no ingress proof was executed by this static report.
      if (command === 'sbx') return { ok: true, stdout: 'Docker Sandboxes v0.37.1' };
      return { ok: false, stdout: '' };
    });
    expect(capabilities.primary.sbx).toBe('available');
    expect(capabilities.primary.sbx).not.toBe('supported');

    for (const boundedAgent of ['docker', 'gvisor', 'sbx']) {
      const result = evaluate('sbx', boundedAgent, capabilities);
      expect(result.status).toBe('BLOCKED');
      expect(result.phase).toBe('primary-sbx-ingress-unproven');
      expect(result.capability).toBe('available');
    }
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
    // `evaluate` only reaches SUPPORTED for a primary sbx combination once the
    // capability is literally `supported` — a value this collector never
    // assigns to primary sbx. This exercises that promotion path directly with
    // a hand-built capabilities object, standing in for a future collector
    // (or a live run) that has actually executed the ingress proof.
    const capabilities = {
      primary: { docker: 'supported', gvisor: 'supported', sbx: 'supported' },
      boundedAgent: { docker: 'supported', gvisor: 'supported', sbx: 'blocked' },
    };
    expect(evaluate('sbx', 'docker', capabilities).status).toBe('SUPPORTED');
    expect(evaluate('sbx', 'gvisor', capabilities).status).toBe('SUPPORTED');
    expect(evaluate('sbx', 'sbx', capabilities).status).toBe('BLOCKED');
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
