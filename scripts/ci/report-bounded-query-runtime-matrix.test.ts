import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const { collectCapabilities, evaluate, renderMatrix } = require(
  path.join(__dirname, 'report-bounded-query-runtime-matrix.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

describe('bounded-query runtime capability report', () => {
  it('reports all nine combinations and preserves the sbx query security block', () => {
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
    expect(report).toContain('| sbx | sbx | BLOCKED | supported | blocked | query-preflight |');
    expect(report).toContain('BLOCKED is an expected fail-closed security result, not runtime success');
  });

  it('never promotes an unavailable primary or query runtime through fallback', () => {
    const capabilities = {
      primary: { docker: 'supported', gvisor: 'unavailable', sbx: 'unavailable' },
      query: { docker: 'supported', gvisor: 'unavailable', sbx: 'blocked' },
    };
    expect(evaluate('gvisor', 'docker', capabilities)).toEqual({
      status: 'BLOCKED',
      capability: 'unavailable',
      phase: 'primary-preflight',
    });
    expect(evaluate('docker', 'gvisor', capabilities)).toEqual({
      status: 'BLOCKED',
      capability: 'unavailable',
      phase: 'query-preflight',
    });
    expect(evaluate('docker', 'sbx', capabilities)).toEqual({
      status: 'BLOCKED',
      capability: 'blocked',
      phase: 'query-preflight',
    });
  });
});
