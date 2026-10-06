'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

function assertAcceptanceRef({ ref, packageTag, head, tagCommit, acceptanceCommit, includesAcceptance }) {
  if (ref !== `refs/tags/${packageTag}` || head !== tagCommit) {
    throw new Error('Live enclave acceptance requires the exact package-matched release-tag checkout, not main or a PR branch');
  }
  if (!/^[a-f0-9]{40}$/.test(acceptanceCommit || '') || !includesAcceptance) {
    throw new Error('The release tag must contain the explicitly pinned acceptance commit and its required harness');
  }
}

function assertManifestSource(manifest, tag, commit) {
  if (manifest.release?.tag !== tag || manifest.release?.sourceCommit !== commit) {
    throw new Error('Live enclave artifact manifest must identify the exact checked-out release tag and commit');
  }
}

const ACCEPTANCE_REQUIRED_PATHS = Object.freeze([
  'scripts/ci/cloud-hypervisor-enclave-startup-faults.js',
]);
// The environment probe additionally requires its integration to be in the reviewed release.
const ENVIRONMENT_PROBE_REQUIRED_PATHS = Object.freeze([
  ...ACCEPTANCE_REQUIRED_PATHS,
  'scripts/ci/cloud-hypervisor-enclave-environment-probe.js',
  'examples/enclave-environment-probe/probe.py',
  'examples/enclave-environment-probe/build-request.py',
  'examples/enclave-environment-probe/awf.yaml',
]);

function verifyAcceptanceCheckout(environment = process.env, requiredPaths = ACCEPTANCE_REQUIRED_PATHS) {
  const { CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG: packageTag } =
    require('../../dist/cloud-hypervisor/artifact-manifest');
  const root = path.resolve(__dirname, '../..');
  const git = (...args) => execFileSync('git', ['-C', root, '-c', `safe.directory=${root}`, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const acceptanceCommit = environment.AWF_ACCEPTANCE_COMMIT;
  // Validate before passing input as a revision to git.
  if (!/^[a-f0-9]{40}$/.test(acceptanceCommit || '')) {
    throw new Error('Live enclave acceptance requires a full acceptance_commit SHA');
  }
  const head = git('rev-parse', 'HEAD');
  const tagCommit = git('rev-parse', `refs/tags/${packageTag}^{commit}`);
  git('merge-base', '--is-ancestor', acceptanceCommit, head);
  for (const requiredPath of requiredPaths) {
    if (!ENVIRONMENT_PROBE_REQUIRED_PATHS.includes(requiredPath)) {
      throw new Error('Live enclave acceptance required path is not a fixed reviewed harness path');
    }
    git('cat-file', '-e', `${acceptanceCommit}:${requiredPath}`);
  }
  assertAcceptanceRef({
    ref: environment.GITHUB_REF, packageTag, head, tagCommit, acceptanceCommit,
    includesAcceptance: true,
  });
  return { tag: packageTag, commit: head };
}

if (require.main === module) {
  try {
    const mode = process.argv.slice(2);
    if (mode.length > 1 || (mode.length === 1 && mode[0] !== '--environment-probe')) {
      throw new Error('Unsupported release gate mode');
    }
    const identity = verifyAcceptanceCheckout(
      process.env,
      mode.length ? ENVIRONMENT_PROBE_REQUIRED_PATHS : ACCEPTANCE_REQUIRED_PATHS,
    );
    console.log(`Live enclave acceptance checkout verified: ${identity.tag} (${identity.commit})`);
  } catch {
    console.error('Live enclave release gate failed: dispatch an exact published package-matched release tag containing acceptance_commit and its required harness paths. No credentials were used.');
    process.exitCode = 1;
  }
}

module.exports = {
  ACCEPTANCE_REQUIRED_PATHS,
  ENVIRONMENT_PROBE_REQUIRED_PATHS,
  assertAcceptanceRef,
  assertManifestSource,
  verifyAcceptanceCheckout,
};
