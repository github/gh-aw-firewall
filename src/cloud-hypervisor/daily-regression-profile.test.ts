import { CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG, CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW } from './artifact-manifest';

const commit = 'a'.repeat(40);
const workflow = 'github/gh-aw-firewall/.github/workflows/daily-agent-runtime-regression.yml';
const tag = `v0.0.0-regression.${commit}`;

function withProfile(profile: Record<string, string>, operation: () => void): void {
  jest.isolateModules(() => {
    jest.doMock('./artifact-compatibility.json', () => profile);
    try { operation(); }
    finally { jest.dontMock('./artifact-compatibility.json'); }
  });
}

it('keeps the production release pin and signer unchanged', () => {
  expect(CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG).toBe('v0.28.66');
  expect(CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW).toBe('github/gh-aw-firewall/.github/workflows/release.yml');
});

it('requires a full-SHA build-time regression profile, not a runtime signer bypass', () => {
  for (const releaseTag of ['latest', 'v0.28.66', 'v0.0.0-regression.abc']) {
    withProfile({ releaseTag, signerWorkflow: workflow }, () => {
      expect(() => jest.requireActual('./artifact-manifest')).toThrow(/full-SHA compiled regression tag/);
    });
  }
  withProfile({ releaseTag: tag, signerWorkflow: 'attacker/workflow.yml' }, () => {
    expect(() => jest.requireActual('./artifact-manifest')).toThrow(/Unsupported compiled/);
  });
});

it('binds both common and enclave manifests to the same compiled main commit', () => {
  withProfile({ releaseTag: tag, signerWorkflow: workflow }, () => {
    const policy: typeof import('./artifact-manifest') = jest.requireActual('./artifact-manifest');
    const enclave: typeof import('./enclave-artifact-manifest') = jest.requireActual('./enclave-artifact-manifest');
    expect(policy.CLOUD_HYPERVISOR_REGRESSION_COMMIT).toBe(commit);
    expect(policy.CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW).toBe(workflow);
    const release = { repository: 'github/gh-aw-firewall', workflow, tag, sourceCommit: 'b'.repeat(40) };
    expect(() => policy.parseCloudHypervisorArtifactManifest(JSON.stringify({
      schemaVersion: 1, architecture: 'x86_64', release, artifacts: {},
    }), tag)).toThrow(/source must match the compiled main commit/);
    expect(() => enclave.parseCloudHypervisorEnclaveArtifactManifest(JSON.stringify({
      schemaVersion: 2, artifactType: 'awf-cloud-hypervisor-enclave-rootfs-set',
      architecture: 'x86_64', release, compatibility: {}, guestBase: {}, rootfs: {}, entrypoints: {},
    }), tag)).toThrow(/shared rootfs from the compiled main commit/);
  });
});

it('accepts a complete generated-style regression enclave manifest with local image identities', () => {
  withProfile({ releaseTag: tag, signerWorkflow: workflow }, () => {
    const enclave: typeof import('./enclave-artifact-manifest') = jest.requireActual('./enclave-artifact-manifest');
    const digest = 'a'.repeat(64);
    const imageId = `sha256:${digest}`;
    const manifest = {
      schemaVersion: 2,
      artifactType: 'awf-cloud-hypervisor-enclave-rootfs-set',
      architecture: 'x86_64',
      release: { repository: 'github/gh-aw-firewall', workflow, tag, sourceCommit: commit },
      compatibility: {
        cloudHypervisorVersion: '53.0', kernelVersion: '6.1.141', supervisorVersion: tag,
      },
      guestBase: { image: 'awf-cloud-hypervisor-guest-base:build', imageId },
      rootfs: {
        file: 'enclave-rootfs.ext4', version: tag, sha256: digest, sizeBytes: 4096,
        uid: 65534, gid: 65534, sourceImage: 'awf-cloud-hypervisor-enclave:build',
        sourceImageDigest: digest, sourceImageId: imageId,
        sbom: { file: 'enclave-rootfs.sbom.spdx.json', sha256: digest },
      },
      entrypoints: {
        script: '/usr/local/bin/run-enclave-script', agent: '/usr/local/bin/run-enclave-agent',
      },
    };
    expect(() => enclave.parseCloudHypervisorEnclaveArtifactManifest(JSON.stringify(manifest), tag)).not.toThrow();
    expect(() => enclave.parseCloudHypervisorEnclaveArtifactManifest(JSON.stringify({
      ...manifest, rootfs: { ...manifest.rootfs, sourceImageId: `sha256:${'b'.repeat(64)}` },
    }), tag)).toThrow(/local Docker config ID must match/);
    expect(() => enclave.parseCloudHypervisorEnclaveArtifactManifest(JSON.stringify({
      ...manifest, guestBase: { ...manifest.guestBase, image: 'awf-cloud-hypervisor-guest-base:other' },
    }), tag)).toThrow(/local build identity/);
  });
});
