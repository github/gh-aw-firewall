'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

function assertAcceptanceRef({ ref, packageTag, head, tagCommit, acceptanceCommit, includesAcceptance }) {
  if (ref !== `refs/tags/${packageTag}` || head !== tagCommit) {
    throw new Error('Live enclave acceptance requires the exact package-matched release-tag checkout, not main or a PR branch');
  }
  if (!/^[a-f0-9]{40}$/.test(acceptanceCommit || '') || !includesAcceptance) {
    throw new Error('The release tag must contain the explicitly pinned acceptance commit and its startup-fault harness');
  }
}

function assertManifestSource(manifest, tag, commit) {
  if (manifest.release?.tag !== tag || manifest.release?.sourceCommit !== commit) {
    throw new Error('Live enclave artifact manifest must identify the exact checked-out release tag and commit');
  }
}

function verifyAcceptanceCheckout(environment = process.env) {
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
  git('cat-file', '-e', `${acceptanceCommit}:scripts/ci/cloud-hypervisor-enclave-startup-faults.js`);
  assertAcceptanceRef({
    ref: environment.GITHUB_REF, packageTag, head, tagCommit, acceptanceCommit,
    includesAcceptance: true,
  });
  return { tag: packageTag, commit: head };
}

if (require.main === module) {
  try {
    const identity = verifyAcceptanceCheckout();
    console.log(`Live enclave acceptance checkout verified: ${identity.tag} (${identity.commit})`);
  } catch {
    console.error('Live enclave release gate failed: dispatch an exact published package-matched release tag containing acceptance_commit and the startup-fault harness. No credentials were used.');
    process.exitCode = 1;
  }
}

module.exports = { assertAcceptanceRef, assertManifestSource, verifyAcceptanceCheckout };
