import {
  CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG,
  artifactDigestsFromManifest,
  assertArtifactBasenames,
  parseCloudHypervisorArtifactManifest,
} from './artifact-manifest';

const digest = 'a'.repeat(64);

const releaseTag = CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG;

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    architecture: 'x86_64',
    release: {
      repository: 'github/gh-aw-firewall',
      workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
      tag: releaseTag,
      sourceCommit: 'b'.repeat(40),
    },
    artifacts: {
      cloudHypervisor: { file: 'cloud-hypervisor', version: '53.0', sha256: digest },
      virtiofsd: { file: 'virtiofsd', version: '1.13.3', sha256: digest },
      kernel: { file: 'vmlinux.bin', version: '6.1.141', sha256: digest },
      rootfs: { file: 'rootfs.ext4', version: releaseTag, sha256: digest },
      supervisor: { file: 'awf-supervisor', version: releaseTag, sha256: digest },
    },
    ...overrides,
  });
}

describe('Cloud Hypervisor artifact manifest', () => {
  it('uses a reviewed guest compatibility pin independently of the host package identity', () => {
    jest.isolateModules(() => {
      jest.doMock('../../package.json', () => ({ version: '99.0.0-dev' }));
      try {
        const parser: typeof import('./artifact-manifest') = jest.requireActual('./artifact-manifest');
        const enclaveParser: typeof import('./enclave-artifact-manifest') =
          jest.requireActual('./enclave-artifact-manifest');
        expect(parser.CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG).toBe(releaseTag);
        expect(parser.parseCloudHypervisorArtifactManifest(manifest(), releaseTag).release.tag)
          .toBe(releaseTag);
        expect(() => parser.parseCloudHypervisorArtifactManifest(manifest(), 'v99.0.0-dev'))
          .toThrow(/compatibility pin/);
        expect(() => enclaveParser.parseCloudHypervisorEnclaveArtifactManifest('{}', 'v99.0.0-dev'))
          .toThrow(/compatibility pin/);
      } finally {
        jest.dontMock('../../package.json');
      }
    });
  });

  it('binds release metadata, versions, filenames, and all five digests', () => {
    const parsed = parseCloudHypervisorArtifactManifest(manifest(), releaseTag);
    expect(artifactDigestsFromManifest(parsed)).toEqual({
      cloudHypervisor: digest,
      virtiofsd: digest,
      kernel: digest,
      rootfs: digest,
      supervisor: digest,
    });
    expect(() => assertArtifactBasenames(parsed, {
      cloudHypervisor: '/opt/cloud-hypervisor',
      virtiofsd: '/opt/virtiofsd',
      kernel: '/opt/vmlinux.bin',
      rootfs: '/opt/rootfs.ext4',
      supervisor: '/opt/awf-supervisor',
    })).not.toThrow();
  });

  it('rejects a different release, signer metadata, filename, or digest', () => {
    expect(() => parseCloudHypervisorArtifactManifest(manifest(), 'v1.2.4'))
      .toThrow(/must match this AWF release/);
    expect(() => parseCloudHypervisorArtifactManifest(manifest({
      release: {
        repository: 'attacker/repo',
        workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
        tag: releaseTag,
        sourceCommit: 'b'.repeat(40),
      },
    }), releaseTag)).toThrow(/release.repository/);
    expect(() => parseCloudHypervisorArtifactManifest(manifest({
      artifacts: {
        cloudHypervisor: { file: 'other', version: '53.0', sha256: digest },
        virtiofsd: { file: 'virtiofsd', version: '1.13.3', sha256: digest },
        kernel: { file: 'vmlinux.bin', version: '6.1.141', sha256: digest },
        rootfs: { file: 'rootfs.ext4', version: releaseTag, sha256: digest },
        supervisor: { file: 'awf-supervisor', version: releaseTag, sha256: digest },
      },
    }), releaseTag)).toThrow(/must be cloud-hypervisor/);
    expect(() => parseCloudHypervisorArtifactManifest(manifest({
      artifacts: {
        cloudHypervisor: { file: 'cloud-hypervisor', version: '53.0', sha256: 'bad' },
        virtiofsd: { file: 'virtiofsd', version: '1.13.3', sha256: digest },
        kernel: { file: 'vmlinux.bin', version: '6.1.141', sha256: digest },
        rootfs: { file: 'rootfs.ext4', version: releaseTag, sha256: digest },
        supervisor: { file: 'awf-supervisor', version: releaseTag, sha256: digest },
      },
    }), releaseTag)).toThrow(/lowercase SHA-256/);
    expect(() => parseCloudHypervisorArtifactManifest(manifest({
      artifacts: {
        cloudHypervisor: { file: 'cloud-hypervisor', version: '53.0', sha256: digest },
        virtiofsd: { file: 'virtiofsd', version: '1.10.0', sha256: digest },
        kernel: { file: 'vmlinux.bin', version: '6.1.141', sha256: digest },
        rootfs: { file: 'rootfs.ext4', version: releaseTag, sha256: digest },
        supervisor: { file: 'awf-supervisor', version: releaseTag, sha256: digest },
      },
    }), releaseTag)).toThrow(/virtiofsd version must be 1\.13\.3/);
  });

  it('rejects local artifact names that do not match the signed manifest', () => {
    const parsed = parseCloudHypervisorArtifactManifest(manifest(), releaseTag);
    expect(() => assertArtifactBasenames(parsed, {
      cloudHypervisor: '/opt/renamed-vmm',
      virtiofsd: '/opt/virtiofsd',
      kernel: '/opt/vmlinux.bin',
      rootfs: '/opt/rootfs.ext4',
      supervisor: '/opt/awf-supervisor',
    })).toThrow(/must be named cloud-hypervisor/);
  });
});
