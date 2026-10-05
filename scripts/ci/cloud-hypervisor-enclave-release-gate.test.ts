import * as fs from 'fs';
import * as path from 'path';

const gate = require('./cloud-hypervisor-enclave-release-gate') as {
  assertAcceptanceRef(input: {
    ref: string; packageTag: string; head: string; tagCommit: string;
    acceptanceCommit: string; includesAcceptance: boolean;
  }): void;
  assertManifestSource(manifest: unknown, tag: string, commit: string): void;
  verifyAcceptanceCheckout(environment: NodeJS.ProcessEnv): unknown;
};

describe('exact enclave acceptance release identity', () => {
  const input = {
    ref: 'refs/tags/v1.2.3', packageTag: 'v1.2.3', head: 'a'.repeat(40),
    tagCommit: 'a'.repeat(40), acceptanceCommit: 'b'.repeat(40), includesAcceptance: true,
  };
  it('accepts only package-matched tagged source including the pinned follow-up', () => {
    expect(() => gate.assertAcceptanceRef(input)).not.toThrow();
    for (const override of [
      { ref: 'refs/heads/main' }, { ref: 'refs/pull/42/head' },
      { packageTag: 'v0.23.1' }, { tagCommit: 'c'.repeat(40) },
      { acceptanceCommit: '' }, { acceptanceCommit: '--help' },
      { includesAcceptance: false },
    ]) {
      expect(() => gate.assertAcceptanceRef({ ...input, ...override })).toThrow();
    }
    expect(() => gate.verifyAcceptanceCheckout({ AWF_ACCEPTANCE_COMMIT: '--help' })).toThrow();
  });
  it('binds both artifact manifests to the checked-out release commit', () => {
    const manifest = { release: { tag: 'v1.2.3', sourceCommit: 'a'.repeat(40) } };
    expect(() => gate.assertManifestSource(manifest, 'v1.2.3', 'a'.repeat(40))).not.toThrow();
    expect(() => gate.assertManifestSource(manifest, 'v1.2.4', 'a'.repeat(40))).toThrow();
    expect(() => gate.assertManifestSource(manifest, 'v1.2.3', 'b'.repeat(40))).toThrow();
  });
  it('checks ancestry and harness presence without changing package versions', () => {
    const source = fs.readFileSync(path.join(__dirname, 'cloud-hypervisor-enclave-release-gate.js'), 'utf8');
    expect(source).toContain("'merge-base', '--is-ancestor'");
    expect(source).toContain("'cat-file', '-e'");
    expect(source).toContain('CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG');
    expect(source).not.toMatch(/npm version|release.*latest|AWF_VERSION\s*=/);
  });
});
