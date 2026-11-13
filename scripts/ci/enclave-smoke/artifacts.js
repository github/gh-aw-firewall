'use strict';

const fs = require('fs');
const path = require('path');
const CI_DIRECTORY = path.resolve(__dirname, '..');
const { run } = require('./commands');
const { RELEASE_ASSETS } = require('./constants');
const { makeConfig } = require('./fixtures');

function assertReleaseAssets(required, published) {
  const available = new Set(published);
  const missing = required.filter((asset) => !available.has(asset)
    && !(asset.endsWith('.ext4') && available.has(`${asset}.gz`)));
  if (missing.length) {
    throw new Error(
      `Package-matched AWF release is missing required release-attested Cloud Hypervisor assets: ${missing.join(', ')}. `
      + 'Publish a release for this package version with the attested Cloud Hypervisor and enclave artifact set; '
      + 'unattested build artifacts are not accepted.',
    );
  }
}

function releaseTag() {
  return require('../../../dist/cloud-hypervisor/artifact-manifest').CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG;
}

function prepareReleaseArtifacts(tag, directory, environment) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let published;
  try {
    published = run('gh', [
      'release', 'view', tag, '--repo', 'github/gh-aw-firewall', '--json', 'assets',
      '--jq', '.assets[].name',
    ], { env: environment });
  } catch (error) {
    throw new Error(
      `Package-matched AWF release ${tag} is unavailable; publish its signed Cloud Hypervisor and enclave artifact set before opting into live acceptance.`,
      { cause: error },
    );
  }
  const assets = published.trim().split(/\r?\n/).filter(Boolean);
  assertReleaseAssets(RELEASE_ASSETS, assets);
  run('gh', [
    'release', 'download', tag, '--repo', 'github/gh-aw-firewall', '--dir', directory,
    '--pattern', RELEASE_ASSETS[0],
    '--pattern', RELEASE_ASSETS[1],
    '--pattern', RELEASE_ASSETS[2],
  ], { env: environment });
  run('tar', [
    '--extract', '--gzip', '--file', path.join(directory, RELEASE_ASSETS[0]),
    '--directory', directory,
  ]);
  const enclaveCache = path.join(directory, 'enclave-cache');
  const setupEnvironment = { ...environment };
  delete setupEnvironment.GITHUB_ENV;
  const setup = run('bash', [
  path.join(CI_DIRECTORY, '../../guest/cloud-hypervisor/setup-enclave-artifacts.sh'),
  tag,
  enclaveCache,
  ], { env: setupEnvironment });
  const enclaveDirectory = path.join(enclaveCache, tag, 'x86_64');
  const enclaveArtifactEnvironment = {
  AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS: path.join(enclaveDirectory, 'enclave-rootfs.ext4'),
  AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS: path.join(enclaveDirectory, 'enclave-rootfs.ext4'),
  AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: path.join(enclaveDirectory, 'enclave-rootfs.ext4'),
  AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST: path.join(enclaveDirectory, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json'),
  AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE: path.join(enclaveDirectory, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl'),
  };
  for (const [name, file] of Object.entries(enclaveArtifactEnvironment)) {
  if (!setup.includes(`${name}=${file}`)) {
    throw new Error('Release-attested enclave artifact setup did not resolve every required artifact');
  }
  }
  return {
    directory,
    enclaveArtifactEnvironment,
    enclaveDirectory,
    tag,
  };
}

function prepareAcceptanceArtifacts(checkout, directory, environment) {
  if (checkout.mode !== 'candidate') return prepareReleaseArtifacts(checkout.tag, directory, environment);
  const { SIGNER_WORKFLOW, candidateAttestationArguments } = require('../cloud-hypervisor-enclave-candidate');
  const candidate = environment.AWF_CLOUD_HYPERVISOR_CANDIDATE_ARTIFACTS;
  const policy = require('../../../dist/cloud-hypervisor/artifact-manifest');
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)
      || path.normalize(candidate) !== candidate
      || policy.CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG !== checkout.tag
      || policy.CLOUD_HYPERVISOR_ARTIFACT_SIGNER_WORKFLOW !== SIGNER_WORKFLOW) {
    throw new Error('Candidate acceptance requires its exact compiled artifact compatibility profile');
  }
  const enclaveManifest = path.join(candidate, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json');
  const enclaveBundle = path.join(candidate, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl');
  const subjects = [
    [path.join(candidate, RELEASE_ASSETS[1]), path.join(candidate, RELEASE_ASSETS[2])],
    [enclaveManifest, enclaveBundle],
    [path.join(candidate, 'enclave-rootfs.ext4'), path.join(candidate, 'enclave-rootfs.provenance.sigstore.jsonl')],
  ];
  for (const [subject, bundle] of subjects) {
    run('gh', ['attestation', 'verify', subject, '--bundle', bundle,
      ...candidateAttestationArguments(checkout)], { env: environment });
  }
  console.log(`AWF_ENCLAVE_ACCEPTANCE_SOURCE ${JSON.stringify({
    mode: 'candidate', commit: checkout.commit, tag: checkout.tag,
  })}`);
  return {
    directory: candidate, enclaveDirectory: candidate, tag: checkout.tag,
    enclaveArtifactEnvironment: {
      AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS: path.join(candidate, 'enclave-rootfs.ext4'),
      AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS: path.join(candidate, 'enclave-rootfs.ext4'),
      AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: path.join(candidate, 'enclave-rootfs.ext4'),
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST: enclaveManifest,
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE: enclaveBundle,
    },
  };
}

function assertUnifiedProfiles(artifacts, primaryManifest, enclaveManifest, enclaveSbom) {
  const primaryRootfs = primaryManifest?.artifacts?.rootfs;
  const enclaveRootfs = enclaveManifest?.rootfs;
  const base = primaryManifest?.userspace;
  const guestBase = enclaveManifest?.guestBase;
  const digest = enclaveRootfs?.sha256;
  const sbomRootfs = enclaveSbom?.packages?.find((item) => item.SPDXID === 'SPDXRef-Rootfs');
  const sbomDigest = sbomRootfs?.checksums?.find((item) => item.algorithm === 'SHA256')?.checksumValue;
  const sourceImage = enclaveSbom?.packages?.find((item) => item.SPDXID === 'SPDXRef-SourceImage');
  if (!base?.baseImage || !/^sha256:[a-f0-9]{64}$/.test(base.baseImageId || '')
      || base.baseImage !== guestBase?.image || base.baseImageId !== guestBase.imageId) {
    throw new Error('Unified Cloud Hypervisor profiles do not share the manifest guest base image');
  }
  if (enclaveManifest?.schemaVersion !== 2
      || primaryRootfs?.file !== 'rootfs.ext4' || !/^[a-f0-9]{64}$/.test(primaryRootfs.sha256 || '')
      || enclaveRootfs?.file !== 'enclave-rootfs.ext4' || !/^[a-f0-9]{64}$/.test(digest || '')
      || digest !== sbomDigest
      || !/^[a-f0-9]{64}$/.test(enclaveRootfs.sourceImageDigest || '')
      || !enclaveRootfs.sourceImage
      || sourceImage?.versionInfo !== enclaveRootfs.sourceImageDigest
      || sourceImage?.externalRefs?.[0]?.referenceLocator !== enclaveRootfs.sourceImage) {
    throw new Error('Unified Cloud Hypervisor profiles lack matching final enclave rootfs metadata');
  }
  const scriptRootfs = artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS;
  const agentRootfs = artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS;
  const sharedRootfs = artifacts.enclaveArtifactEnvironment.AWF_CLOUD_HYPERVISOR_ENCLAVE_ROOTFS;
  if (scriptRootfs !== sharedRootfs || agentRootfs !== sharedRootfs
      || sharedRootfs !== path.join(artifacts.enclaveDirectory, enclaveRootfs.file)) {
    throw new Error('Unified Cloud Hypervisor profiles must use the same final enclave rootfs');
  }
  for (const [name, count] of [['primary', 0], ['script-only', 1], ['agent-only', 1], ['combined', 2]]) {
    const config = makeConfig(artifacts, 'profile-work', 'profile-workspace', {}, name);
    const enclaves = config.enclaves;
    if (config.container.containerRuntime !== 'cloud-hypervisor'
        || config.container.imageTag !== artifacts.tag
        || config.cloudHypervisor.rootfsPath !== path.join(artifacts.directory, primaryRootfs.file)
        || enclaves.length !== count
        || enclaves.some((entry) => entry.runtime !== 'cloud-hypervisor')
        || (name === 'script-only' && !enclaves[0]?.script)
        || (name === 'agent-only' && !enclaves[0]?.agent)
        || (name === 'combined' && (!enclaves[0]?.script || !enclaves[1]?.agent))) {
      throw new Error(`Unified Cloud Hypervisor ${name} profile configuration is inconsistent`);
    }
  }
}

module.exports = {
  assertReleaseAssets,
  releaseTag,
  prepareReleaseArtifacts,
  prepareAcceptanceArtifacts,
  assertUnifiedProfiles,
};
