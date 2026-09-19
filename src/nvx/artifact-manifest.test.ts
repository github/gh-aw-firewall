import {
  NVX_ARTIFACT_RELEASE_TAG,
  NVX_ARTIFACT_REPOSITORY,
  NVX_ARTIFACT_SIGNER_WORKFLOW,
  NVX_COMMIT,
  NVX_OPENVMM_COMMIT,
  NVX_RELEASE_TAG,
  assertNvxArtifactBasenames,
  parseNvxArtifactManifest,
} from './artifact-manifest';

function manifest() {
  return {
    schemaVersion: 1,
    release: {
      repository: NVX_ARTIFACT_REPOSITORY,
      workflow: NVX_ARTIFACT_SIGNER_WORKFLOW,
      tag: NVX_ARTIFACT_RELEASE_TAG,
      sourceCommit: 'a'.repeat(40),
    },
    upstream: {
      releaseTag: NVX_RELEASE_TAG,
      nvxCommit: NVX_COMMIT,
      openvmmCommit: NVX_OPENVMM_COMMIT,
    },
    architecture: 'x86_64',
    artifacts: {
      launcher: { file: 'nvx.py', sha256: '1'.repeat(64) },
      openvmm: { file: 'openvmm', sha256: '2'.repeat(64) },
      kernel: { file: 'vmlinux', sha256: '3'.repeat(64) },
      initramfs: { file: 'initramfs.cpio.gz', sha256: '4'.repeat(64) },
    },
  };
}

describe('NVX artifact manifest', () => {
  it('binds the AWF attestation to the pinned NVX and OpenVMM sources', () => {
    expect(parseNvxArtifactManifest(
      JSON.stringify(manifest()),
      NVX_ARTIFACT_RELEASE_TAG,
    )).toEqual(manifest());
  });

  it.each([
    ['release tag', () => {
      const value = manifest();
      value.upstream.releaseTag = 'v0.1.0';
      return value;
    }, /releaseTag/],
    ['NVX commit', () => {
      const value = manifest();
      value.upstream.nvxCommit = 'b'.repeat(40);
      return value;
    }, /nvxCommit/],
    ['OpenVMM commit', () => {
      const value = manifest();
      value.upstream.openvmmCommit = 'c'.repeat(40);
      return value;
    }, /openvmmCommit/],
    ['artifact role', () => {
      const value = manifest();
      value.artifacts.kernel.file = 'openvmm';
      return value;
    }, /kernel\.file/],
    ['unexpected field', () => ({
      ...manifest(),
      fallbackUrl: 'https://example.invalid',
    }), /contain exactly/],
  ])('rejects an invalid %s', (_label, build, error) => {
    expect(() => parseNvxArtifactManifest(
      JSON.stringify(build()),
      NVX_ARTIFACT_RELEASE_TAG,
    )).toThrow(error);
  });

  it('rejects artifacts from another AWF release', () => {
    expect(() => parseNvxArtifactManifest(
      JSON.stringify(manifest()),
      'v0.0.0',
    )).toThrow(/must match this AWF release/);
  });

  it('requires role-specific artifact basenames', () => {
    const parsed = parseNvxArtifactManifest(
      JSON.stringify(manifest()),
      NVX_ARTIFACT_RELEASE_TAG,
    );
    expect(() => assertNvxArtifactBasenames(parsed, {
      launcher: '/trusted/nvx.py',
      openvmm: '/trusted/openvmm',
      kernel: '/trusted/vmlinux',
      initramfs: '/trusted/not-initramfs',
    })).toThrow(/initramfs artifact must be named/);
  });
});
