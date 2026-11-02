import { readFileSync } from 'fs';
import * as path from 'path';
import {
  NVX_ARTIFACT_RELEASE_TAG,
  NVX_ARTIFACT_REPOSITORY,
  NVX_ARTIFACT_SIGNER_WORKFLOW,
  NVX_CANARY_SIGNER_WORKFLOW,
  NVX_CAMPAIGN_SIGNER_WORKFLOW,
  NVX_COMMIT,
  NVX_OPENVMM_COMMIT,
  NVX_RELEASE_TAG,
  assertNvxArtifactBasenames,
  parseNvxArtifactManifest,
} from './artifact-manifest';

function manifest() {
  return {
    schemaVersion: 2,
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
      openvmm: { file: 'openvmm', sizeBytes: 100, sha256: '2'.repeat(64) },
      kernel: { file: 'vmlinux', sizeBytes: 100, sha256: '3'.repeat(64) },
      initramfs: { file: 'initramfs.cpio.gz', sizeBytes: 100, sha256: '4'.repeat(64) },
    },
  };
}

describe('NVX artifact manifest', () => {
  it('pins the expected NVX release and source revisions', () => {
    expect({
      releaseTag: NVX_RELEASE_TAG,
      nvxCommit: NVX_COMMIT,
      openvmmCommit: NVX_OPENVMM_COMMIT,
    }).toEqual({
      releaseTag: 'v0.1.0-dev.8fb0f1d64f2f',
      nvxCommit: '8fb0f1d64f2f67e0017a4f94693244297852ed1f',
      openvmmCommit: '0ac254109ed32fc5fa2b1a6fc526a10593b1f986',
    });
  });

  it('binds the AWF attestation to the pinned NVX and OpenVMM sources', () => {
    expect(parseNvxArtifactManifest(
      JSON.stringify(manifest()),
      NVX_ARTIFACT_RELEASE_TAG,
    )).toEqual(manifest());
  });

  it.each([
    '.github/workflows/nvx-phase-0-feasibility.md',
    '.github/workflows/nvx-phase-0-feasibility.lock.yml',
    '.github/workflows/nvx-phase-3b-live-kvm.yml',
    '.github/workflows/nvx-phase-4-canary.yml',
    '.github/workflows/release.yml',
    '.github/workflows/smoke-nvx-build-test.md',
    '.github/workflows/smoke-nvx-build-test.lock.yml',
    '.github/workflows/smoke-nvx-copilot.md',
    '.github/workflows/smoke-nvx-copilot.lock.yml',
    '.github/workflows/smoke-verify-release-nvx-assets.md',
    '.github/workflows/smoke-verify-release-nvx-assets.lock.yml',
    'scripts/ci/nvx-phase4-provision-nvx.sh',
    'docs/nvx-security-design.md',
  ])('keeps the upstream identity synchronized in %s', (file) => {
    const source = readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    expect(source).toContain(NVX_RELEASE_TAG);
    expect(source).toContain(NVX_COMMIT);
    expect(source).toContain(NVX_OPENVMM_COMMIT);
    if (!file.includes('smoke-verify-release')) {
      expect(source).toContain(
        '0a4bb74e76e80a524c3dccd9336b77705ef91d6a908d6979403c59151a5883da',
      );
    }
    expect(source).not.toContain('be859aa77ffa');
    expect(source).not.toContain('762bc1c7a203');
    expect(source).not.toContain('ad6bf948d84d');
    expect(source).not.toContain('13504aa3497c');
    expect(source).not.toContain('b58040ee46c6');
    expect(source).not.toContain('df8ad7aaeeee');
  });

  it.each([
    '.github/workflows/nvx-phase-4-benchmark.yml',
    'docs/nvx-promotion-thresholds.json',
    'docs/nvx-promotion-evaluation.md',
  ])('measures the pinned release in the promotion baseline in %s', (file) => {
    const source = readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
    expect(source).toContain(`microsoft/nvx@${NVX_RELEASE_TAG}`);
    expect(source).not.toContain('be859aa77ffa');
  });

  it('uses the packaged Rust launcher and source contract in feasibility workflows', () => {
    const phase0 = readFileSync(path.resolve(
      __dirname, '../../.github/workflows/nvx-phase-0-feasibility.md',
    ), 'utf8');
    expect(phase0.match(/bin\/nvx-rs" \\\n\s+sandbox run/g)).toHaveLength(2);
    expect(phase0).not.toMatch(/nvx\.py\s+\\?\s*sandbox/);
    const phase3b = readFileSync(path.resolve(
      __dirname, '../../.github/workflows/nvx-phase-3b-live-kvm.yml',
    ), 'utf8');
    expect(phase3b).toContain('nvx-rs/src/host/sandbox/plan.rs');
    expect(phase3b).not.toContain('nvx_tools/sandbox.py');
    expect(phase3b).toContain('AWF_NVX_PACKAGE_ROOT: ${{ runner.temp }}/nvx-package/nvx-0.1.0-linux-kvm');
    expect(phase3b).toContain('scripts/ci/nvx-release-contract.test.ts');
  });

  it('trusts the bounded Phase 4 canary signer workflow', () => {
    const value = manifest();
    value.release.workflow = NVX_CANARY_SIGNER_WORKFLOW;
    expect(parseNvxArtifactManifest(
      JSON.stringify(value),
      NVX_ARTIFACT_RELEASE_TAG,
      NVX_CANARY_SIGNER_WORKFLOW,
    )).toEqual(value);
  });

  it('trusts only the exact Phase 4 campaign signer workflow', () => {
    const value = manifest();
    value.release.workflow = NVX_CAMPAIGN_SIGNER_WORKFLOW;
    expect(parseNvxArtifactManifest(
      JSON.stringify(value),
      NVX_ARTIFACT_RELEASE_TAG,
      NVX_CAMPAIGN_SIGNER_WORKFLOW,
    )).toEqual(value);

    value.release.workflow = `${NVX_CAMPAIGN_SIGNER_WORKFLOW}-other`;
    expect(() => parseNvxArtifactManifest(
      JSON.stringify(value),
      NVX_ARTIFACT_RELEASE_TAG,
      value.release.workflow,
    )).toThrow(/Untrusted NVX artifact signer workflow/);
  });

  it.each([
    ['release tag', () => {
      const value = manifest();
      value.upstream.releaseTag = 'v0.1.0-dev.be859aa77ffa';
      return value;
    }, /releaseTag/],
    ['NVX commit', () => {
      const value = manifest();
      value.upstream.nvxCommit = 'be859aa77ffa7a20f9ef50f68c5386acdfca9955';
      return value;
    }, /nvxCommit/],
    ['OpenVMM commit', () => {
      const value = manifest();
      value.upstream.openvmmCommit = '762bc1c7a203b16aee752324d6a4ab0bde1a713a';
      return value;
    }, /openvmmCommit/],
    ['artifact role', () => {
      const value = manifest();
      value.artifacts.kernel.file = 'openvmm';
      return value;
    }, /kernel\.file/],
    ['artifact size', () => {
      const value = manifest();
      value.artifacts.openvmm.sizeBytes = (1024 * 1024 * 1024) + 1;
      return value;
    }, /openvmm\.sizeBytes/],
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

  it('accepts an OpenVMM artifact at the bounded 1 GiB ceiling', () => {
    const value = manifest();
    value.artifacts.openvmm.sizeBytes = 1024 * 1024 * 1024;
    expect(parseNvxArtifactManifest(
      JSON.stringify(value),
      NVX_ARTIFACT_RELEASE_TAG,
    ).artifacts.openvmm.sizeBytes).toBe(1024 * 1024 * 1024);
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
      openvmm: '/trusted/openvmm',
      kernel: '/trusted/vmlinux',
      initramfs: '/trusted/not-initramfs',
    })).toThrow(/initramfs artifact must be named/);
  });
});
