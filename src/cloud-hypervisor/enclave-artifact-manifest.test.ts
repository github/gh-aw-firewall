import { version as AWF_VERSION } from '../../package.json';
import {
  enclaveRootfsArtifactForRole,
  parseCloudHypervisorEnclaveArtifactManifest,
} from './enclave-artifact-manifest';

const digest = 'a'.repeat(64);
const releaseTag = `v${AWF_VERSION}`;

function role(role: 'script' | 'agent'): Record<string, unknown> {
  return {
    file: `enclave-${role}-rootfs.ext4`,
    role,
    version: releaseTag,
    sha256: digest,
    sizeBytes: 4096,
    uid: 65534,
    gid: 65534,
    entrypoint: `/usr/local/bin/run-enclave-${role}`,
    sourceImage: `ghcr.io/github/gh-aw-firewall/enclave-${role}@sha256:${digest}`,
    sourceImageDigest: digest,
    sbom: {
      file: `enclave-${role}-rootfs.sbom.spdx.json`,
      sha256: digest,
    },
  };
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    artifactType: 'awf-cloud-hypervisor-enclave-rootfs-set',
    architecture: 'x86_64',
    release: {
      repository: 'github/gh-aw-firewall',
      workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
      tag: releaseTag,
      sourceCommit: 'b'.repeat(40),
    },
    compatibility: {
      cloudHypervisorVersion: '53.0',
      kernelVersion: '6.1.141',
      supervisorVersion: releaseTag,
    },
    rootfs: {
      script: role('script'),
      agent: role('agent'),
    },
    ...overrides,
  });
}

describe('Cloud Hypervisor enclave artifact manifest', () => {
  it('binds distinct script and agent rootfs metadata to this release', () => {
    const parsed = parseCloudHypervisorEnclaveArtifactManifest(manifest(), releaseTag);
    expect(enclaveRootfsArtifactForRole(parsed, 'script')).toEqual(
      expect.objectContaining({
        file: 'enclave-script-rootfs.ext4',
        role: 'script',
        uid: 65534,
        gid: 65534,
        entrypoint: '/usr/local/bin/run-enclave-script',
        sizeBytes: 4096,
      }),
    );
    expect(enclaveRootfsArtifactForRole(parsed, 'agent')).toEqual(
      expect.objectContaining({
        file: 'enclave-agent-rootfs.ext4',
        role: 'agent',
        entrypoint: '/usr/local/bin/run-enclave-agent',
      }),
    );
  });

  it.each([
    ['wrong role', { ...role('script'), role: 'agent' }, /role must be script/],
    ['wrong file', { ...role('script'), file: 'rootfs.ext4' }, /file must be enclave-script/],
    ['wrong entrypoint', { ...role('script'), entrypoint: '/bin/sh' }, /entrypoint/],
    ['wrong version', { ...role('script'), version: 'v0.0.0' }, /version must match/],
    ['wrong uid', { ...role('script'), uid: 0 }, /fixed uid\/gid/],
    ['empty image digest', { ...role('script'), sourceImageDigest: '' }, /non-empty string/],
    ['invalid digest', { ...role('script'), sha256: 'invalid' }, /lowercase SHA-256/],
    ['mutable image', { ...role('script'), sourceImage: 'enclave-script:latest' }, /release-pinned/],
    ['zero size', { ...role('script'), sizeBytes: 0 }, /positive safe integer/],
    ['fractional size', { ...role('script'), sizeBytes: 1.5 }, /positive safe integer/],
    ['non-object SBOM', { ...role('script'), sbom: null }, /sbom must be a JSON object/],
    ['wrong SBOM file', {
      ...role('script'),
      sbom: { file: 'agent.spdx.json', sha256: digest },
    }, /sbom.file must be enclave-script/],
    ['unknown role field', { ...role('script'), unexpected: true }, /must contain exactly/],
  ])('rejects script role confusion: %s', (_name, script, expected) => {
    expect(() => parseCloudHypervisorEnclaveArtifactManifest(manifest({
      rootfs: { script, agent: role('agent') },
    }), releaseTag)).toThrow(expected);
  });

  it('rejects stale releases, signer substitution, and unknown metadata', () => {
    expect(() => parseCloudHypervisorEnclaveArtifactManifest(manifest(), 'v0.0.0'))
      .toThrow(/must match this AWF release/);
    expect(() => parseCloudHypervisorEnclaveArtifactManifest(manifest({
      release: {
        repository: 'attacker/repo',
        workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
        tag: releaseTag,
        sourceCommit: 'b'.repeat(40),
      },
    }), releaseTag)).toThrow(/release.repository/);
    expect(() => parseCloudHypervisorEnclaveArtifactManifest(manifest({
      unexpected: true,
    }), releaseTag)).toThrow(/must contain exactly/);
    expect(() => parseCloudHypervisorEnclaveArtifactManifest(manifest({
      compatibility: {
        cloudHypervisorVersion: '53.0',
        kernelVersion: '6.1.142',
        supervisorVersion: releaseTag,
      },
    }), releaseTag)).toThrow(/requires kernel 6\.1\.141/);
  });

  it.each([
    ['invalid JSON', '{', /not valid JSON/],
    ['array document', '[]', /must be a JSON object/],
    ['wrong schema', manifest({ schemaVersion: 2 }), /schemaVersion must be 1/],
    ['wrong artifact type', manifest({ artifactType: 'other' }), /artifactType/],
    ['wrong architecture', manifest({ architecture: 'aarch64' }), /architecture/],
    ['non-object release', manifest({ release: null }), /release must be a JSON object/],
    ['unknown release field', manifest({
      release: {
        repository: 'github/gh-aw-firewall',
        workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
        tag: releaseTag,
        sourceCommit: 'b'.repeat(40),
        unexpected: true,
      },
    }), /release must contain exactly/],
    ['wrong workflow', manifest({
      release: {
        repository: 'github/gh-aw-firewall',
        workflow: 'attacker/release.yml',
        tag: releaseTag,
        sourceCommit: 'b'.repeat(40),
      },
    }), /release.workflow/],
    ['wrong manifest release', manifest({
      release: {
        repository: 'github/gh-aw-firewall',
        workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
        tag: 'v0.0.0',
        sourceCommit: 'b'.repeat(40),
      },
    }), /release mismatch/],
    ['invalid source commit', manifest({
      release: {
        repository: 'github/gh-aw-firewall',
        workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
        tag: releaseTag,
        sourceCommit: 'not-a-commit',
      },
    }), /40-character Git SHA/],
    ['non-object compatibility', manifest({ compatibility: [] }), /compatibility must be a JSON object/],
    ['unknown compatibility field', manifest({
      compatibility: {
        cloudHypervisorVersion: '53.0',
        kernelVersion: '6.1.141',
        supervisorVersion: releaseTag,
        unexpected: true,
      },
    }), /compatibility must contain exactly/],
    ['wrong Cloud Hypervisor version', manifest({
      compatibility: {
        cloudHypervisorVersion: '52.0',
        kernelVersion: '6.1.141',
        supervisorVersion: releaseTag,
      },
    }), /requires Cloud Hypervisor 53\.0/],
    ['wrong supervisor version', manifest({
      compatibility: {
        cloudHypervisorVersion: '53.0',
        kernelVersion: '6.1.141',
        supervisorVersion: 'v0.0.0',
      },
    }), /supervisorVersion/],
    ['non-object rootfs', manifest({ rootfs: null }), /rootfs must be a JSON object/],
    ['missing rootfs role', manifest({ rootfs: { script: role('script') } }), /rootfs must contain exactly/],
  ])('rejects malformed manifest structure: %s', (_name, contents, expected) => {
    expect(() => parseCloudHypervisorEnclaveArtifactManifest(
      contents,
      releaseTag,
    )).toThrow(expected);
  });
});
