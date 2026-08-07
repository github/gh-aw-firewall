import * as path from 'path';
import { resolveEnclavePaths } from './paths';

describe('resolveEnclavePaths', () => {
  it('keeps private state and the gateway capability handoff disjoint', () => {
    const paths = resolveEnclavePaths('/tmp/awf-test', '/private');
    expect(paths.root).toMatch(/^\/private\/awf-enclave-private-/);
    expect(paths.ingressRoot).toMatch(/^\/private\/awf-enclave-control-/);
    expect(paths.ingressRoot).not.toContain(paths.root);
    expect(paths.capabilityPath).toBe(path.join(paths.runDir, 'auth-token'));
    expect(paths.auditDir.startsWith(paths.root)).toBe(true);
  });
});
