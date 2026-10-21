import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const candidate = require('./cloud-hypervisor-enclave-candidate');
const releaseGate = require('./cloud-hypervisor-enclave-release-gate');
const sha = 'a'.repeat(40);
const ref = 'refs/heads/reviewed-candidate';
const environment = {
  GITHUB_ACTIONS: 'true',
  AWF_ENCLAVE_ACCEPTANCE_MODE: 'candidate',
  AWF_ACCEPTANCE_COMMIT: sha,
  GITHUB_REPOSITORY: 'github/gh-aw-firewall',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF_TYPE: 'branch',
  GITHUB_REF_NAME: 'reviewed-candidate',
  GITHUB_REF: ref,
  GITHUB_SHA: sha,
  GITHUB_WORKFLOW_SHA: sha,
  GITHUB_WORKFLOW_REF: `github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor-enclaves.yml@${ref}`,
};

function renderBuilderManifest(tag: string): string {
  const builder = fs.readFileSync(path.resolve(__dirname,
    '../../guest/cloud-hypervisor/build-test-artifacts.sh'), 'utf8');
  const template = builder.match(/cat >"\$OUTPUT\/enclave-manifest\.json" <<EOF\n([\s\S]*?)\nEOF/);
  if (!template) throw new Error('Builder enclave manifest template is missing');
  const values: Record<string, string> = {
    ARTIFACT_SIGNER_WORKFLOW: candidate.SIGNER_WORKFLOW,
    RELEASE_TAG: tag,
    CLOUD_HYPERVISOR_VERSION: '53.0',
    LINUX_VERSION: '6.1.141',
    GUEST_BASE_IMAGE: 'awf-cloud-hypervisor-guest-base:build',
    guest_base_image_id: `sha256:${'d'.repeat(64)}`,
    ENCLAVE_IMAGE: 'awf-cloud-hypervisor-enclave:build',
    enclave_image_digest: 'c'.repeat(64),
    enclave_image_id: `sha256:${'c'.repeat(64)}`,
  };
  let rendered = template[1].replace(/\$\{(\w+)\}/g, (_, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`Unrecognized builder manifest variable: ${name}`);
    }
    return values[name];
  });
  const commands = new Map([
    ['$(git -C "$ROOT" rev-parse HEAD)', sha],
    ['$(stat -c \'%s\' "$OUTPUT/enclave-rootfs.ext4")', '4096'],
    ['$(sha256sum "$OUTPUT/enclave-rootfs.ext4" | awk \'{print $1}\')', 'a'.repeat(64)],
    ['$(sha256sum "$OUTPUT/enclave-rootfs.sbom.spdx.json" | awk \'{print $1}\')', 'b'.repeat(64)],
  ]);
  for (const [command, value] of commands) rendered = rendered.split(command).join(value);
  if (rendered.includes('$(')) throw new Error('Unrecognized builder manifest command');
  return rendered;
}

describe('explicit same-commit candidate acceptance', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requires the exact manual source, signer revision, branch, and reviewed commit', () => {
    expect(candidate.assertCandidateSource(environment, sha)).toEqual({
      mode: 'candidate', commit: sha, ref, tag: `v0.0.0-candidate.${sha}`,
    });
    for (const name of Object.keys(environment)) {
      const changed: NodeJS.ProcessEnv = { ...environment };
      delete changed[name];
      expect(() => candidate.assertCandidateSource(changed, sha)).toThrow(/exact explicitly pinned/);
    }
    for (const changed of [
      { GITHUB_EVENT_NAME: 'pull_request' },
      { GITHUB_EVENT_NAME: 'push' },
      { GITHUB_REPOSITORY: 'fork/gh-aw-firewall' },
      { GITHUB_SHA: 'b'.repeat(40) },
      { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
      { AWF_ACCEPTANCE_COMMIT: 'b'.repeat(40) },
      { AWF_ACCEPTANCE_COMMIT: '--help' },
      { GITHUB_REF_TYPE: 'tag' },
      { GITHUB_REF: 'refs/tags/v1.2.3' },
      { GITHUB_REF_NAME: 'different' },
      { GITHUB_WORKFLOW_REF: `github/gh-aw-firewall/.github/workflows/release.yml@${ref}` },
    ]) {
      expect(() => candidate.assertCandidateSource({ ...environment, ...changed }, sha)).toThrow();
    }
    expect(() => candidate.assertCandidateSource(environment, 'b'.repeat(40))).toThrow();
  });

  it('defaults to the unchanged release gate and rejects unknown modes', () => {
    const verify = jest.spyOn(releaseGate, 'verifyAcceptanceCheckout')
      .mockReturnValue({ tag: 'v1.2.3', commit: sha });
    expect(candidate.verifyAcceptanceSource({ AWF_ACCEPTANCE_COMMIT: sha }, ['required']))
      .toEqual({ tag: 'v1.2.3', commit: sha, mode: 'release' });
    expect(verify).toHaveBeenCalledWith({ AWF_ACCEPTANCE_COMMIT: sha }, ['required']);
    expect(() => candidate.verifyAcceptanceSource({ AWF_ENCLAVE_ACCEPTANCE_MODE: 'unknown' }))
      .toThrow(/Unsupported/);
  });

  it('pins source commit, source ref, signer workflow/commit and hosted-runner provenance', () => {
    const checkout = candidate.assertCandidateSource(environment, sha);
    const args = candidate.candidateAttestationArguments(checkout);
    expect(args).toEqual([
      '--repo', 'github/gh-aw-firewall',
      '--signer-workflow', 'github/gh-aw-firewall/.github/workflows/test-cloud-hypervisor.yml',
      '--source-digest', sha, '--signer-digest', sha,
      '--source-ref', ref, '--deny-self-hosted-runners',
    ]);
    for (const changed of [{ mode: 'release' }, { commit: '--help' }, { ref: 'refs/tags/v1.2.3' }]) {
      expect(() => candidate.candidateAttestationArguments({ ...checkout, ...changed })).toThrow();
    }
  });

  it('configures only the explicit candidate build profile, not a runtime bypass', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-candidate-profile-'));
    try {
      fs.mkdirSync(path.join(directory, 'src/cloud-hypervisor'), { recursive: true });
      const checkout = candidate.assertCandidateSource(environment, sha);
      candidate.configureCandidateBuild(checkout, directory);
      expect(JSON.parse(fs.readFileSync(path.join(directory,
        'src/cloud-hypervisor/artifact-compatibility.json'), 'utf8'))).toEqual({
        releaseTag: `v0.0.0-candidate.${sha}`,
        signerWorkflow: candidate.SIGNER_WORKFLOW,
      });
      expect(() => candidate.configureCandidateBuild({ ...checkout, mode: 'release' }, directory))
        .toThrow(/verified candidate/);
    } finally {
      fs.rmSync(directory, { recursive: true });
    }
  });

  it('keeps production artifact signer defaults and rejects unrecognized compiled signers', () => {
    const policy = require('../../src/cloud-hypervisor/artifact-manifest');
    expect(policy.CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW)
      .toBe('github/gh-aw-firewall/.github/workflows/release.yml');
    const compatibility = '../../src/cloud-hypervisor/artifact-compatibility.json';
    try {
      jest.doMock(compatibility, () => ({ releaseTag: 'v1.2.3', signerWorkflow: 'untrusted/workflow.yml' }));
      expect(() => jest.isolateModules(() => require('../../src/cloud-hypervisor/artifact-manifest')))
        .toThrow(/Unsupported compiled/);
    } finally {
      jest.dontMock(compatibility);
    }
  });

  it('verifies every actual candidate subject before returning paths and never falls back on failure', () => {
    const checkout = candidate.assertCandidateSource(environment, sha);
    const policy = {
      CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG: checkout.tag,
      CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW: candidate.SIGNER_WORKFLOW,
    };
    const spawnSync = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const compiledPolicy = '../../dist/cloud-hypervisor/artifact-manifest';
    try {
      jest.doMock('child_process', () => ({ ...jest.requireActual('child_process'), spawnSync }));
      jest.doMock(compiledPolicy, () => policy);
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
      jest.isolateModules(() => {
        const live = require('./cloud-hypervisor-enclave-live-smoke');
        const env = { ...environment, AWF_CLOUD_HYPERVISOR_CANDIDATE_ARTIFACTS: '/candidate' };
        const artifacts = live.prepareAcceptanceArtifacts(checkout, '/unused-release', env);
        expect(artifacts.directory).toBe('/candidate');
        expect(artifacts.enclaveArtifactEnvironment).toMatchObject({
          AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS: '/candidate/enclave-rootfs.ext4',
          AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: '/candidate/enclave-rootfs.ext4',
          AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS: '/candidate/enclave-rootfs.ext4',
        });
        expect(spawnSync.mock.calls.map(call => call[1][2])).toEqual([
          '/candidate/cloud-hypervisor-test-x86_64.manifest.json',
          '/candidate/cloud-hypervisor-enclave-rootfs-x86_64.manifest.json',
          '/candidate/enclave-rootfs.ext4',
        ]);
        for (const [command, args] of spawnSync.mock.calls) {
          expect(command).toBe('gh');
          expect(args.slice(0, 2)).toEqual(['attestation', 'verify']);
          expect(args.slice(5)).toEqual(candidate.candidateAttestationArguments(checkout));
        }
        spawnSync.mockClear();
        expect(() => live.prepareAcceptanceArtifacts(checkout, '/unused-release', {
          ...env, AWF_CLOUD_HYPERVISOR_CANDIDATE_ARTIFACTS: 'relative',
        })).toThrow(/compiled artifact compatibility/);
        expect(spawnSync).not.toHaveBeenCalled();
        spawnSync.mockReturnValue({ status: 1, stdout: 'private-failure-detail', stderr: '' });
        expect(() => live.prepareAcceptanceArtifacts(checkout, '/unused-release', env))
          .toThrow('Required live enclave command failed: gh');
        expect(spawnSync).toHaveBeenCalledTimes(1);
        spawnSync.mockClear();
        policy.CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW =
          'github/gh-aw-firewall/.github/workflows/release.yml';
        expect(() => live.prepareAcceptanceArtifacts(checkout, '/unused-release', env))
          .toThrow(/compiled artifact compatibility/);
        expect(spawnSync).not.toHaveBeenCalled();
      });
    } finally {
      jest.dontMock('child_process');
      jest.dontMock(compiledPolicy);
    }
  });

  it('passes the real builder manifest template through candidate admission without weakening release images', () => {
    const tag = `v0.0.0-candidate.${sha}`;
    const contents = renderBuilderManifest(tag);
    const raw = JSON.parse(contents);
    const releasePolicy = require('../../src/cloud-hypervisor/artifact-manifest');
    const releaseParser = require('../../src/cloud-hypervisor/enclave-artifact-manifest');
    const releaseVersion = releasePolicy.CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG;
    const releaseShaped = {
      ...raw,
      release: { ...raw.release, tag: releaseVersion, workflow: releasePolicy.CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW },
      compatibility: { ...raw.compatibility, supervisorVersion: releaseVersion },
      rootfs: { ...raw.rootfs, version: releaseVersion },
    };
    expect(() => releaseParser.parseCloudHypervisorEnclaveArtifactManifest(
      JSON.stringify(releaseShaped), releaseVersion,
    )).toThrow(/release-pinned/);
    const compatibility = '../../src/cloud-hypervisor/artifact-compatibility.json';
    try {
      jest.doMock(compatibility, () => ({ releaseTag: tag, signerWorkflow: candidate.SIGNER_WORKFLOW }));
      jest.isolateModules(() => {
        const { parseCloudHypervisorEnclaveArtifactManifest: parse } =
          require('../../src/cloud-hypervisor/enclave-artifact-manifest');
        const parsed = parse(contents, tag);
        expect(parsed.release.sourceCommit).toBe(sha);
        expect(parsed.guestBase).toEqual(raw.guestBase);
        expect(parsed.rootfs.script.sourceImageId).toBe(`sha256:${raw.rootfs.sourceImageDigest}`);
        expect(parsed.rootfs.script.sha256).toBe(parsed.rootfs.agent.sha256);
        for (const changed of [
          { ...raw, release: { ...raw.release, sourceCommit: 'b'.repeat(40) } },
          { ...raw, schemaVersion: 1 },
          { ...raw, guestBase: { ...raw.guestBase, image: `ghcr.io/github/gh-aw-firewall/cloud-hypervisor-guest-base@sha256:${'d'.repeat(64)}` } },
          { ...raw, guestBase: { ...raw.guestBase, imageId: 'mutable' } },
          { ...raw, rootfs: { ...raw.rootfs, sourceImage: 'untrusted:build' } },
          { ...raw, rootfs: { ...raw.rootfs, sourceImageId: `sha256:${'e'.repeat(64)}` } },
          { ...raw, rootfs: { ...raw.rootfs, sourceImageDigest: 'e'.repeat(64) } },
          { ...raw, rootfs: { ...raw.rootfs, sha256: 'invalid' } },
          { ...raw, rootfs: { ...raw.rootfs, sbom: { ...raw.rootfs.sbom, sha256: 'invalid' } } },
          { ...raw, release: { ...raw.release, workflow: releasePolicy.CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW } },
        ]) expect(() => parse(JSON.stringify(changed), tag)).toThrow();
      });
    } finally {
      jest.dontMock(compatibility);
    }
  });
});
