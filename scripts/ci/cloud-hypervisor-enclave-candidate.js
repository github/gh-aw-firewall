'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const releaseGate = require('./cloud-hypervisor-enclave-release-gate');

const REPOSITORY = 'github/gh-aw-firewall';
const WORKFLOW = `${REPOSITORY}/.github/workflows/test-cloud-hypervisor-enclaves.yml`;
const SIGNER_WORKFLOW = `${REPOSITORY}/.github/workflows/test-cloud-hypervisor.yml`;
const root = path.resolve(__dirname, '../..');

function assertCandidateSource(environment, head) {
  const commit = environment.AWF_ACCEPTANCE_COMMIT;
  const ref = environment.GITHUB_REF;
  if (environment.AWF_ENCLAVE_ACCEPTANCE_MODE !== 'candidate'
      || environment.GITHUB_ACTIONS !== 'true'
      || environment.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || environment.GITHUB_REPOSITORY !== REPOSITORY
      || environment.GITHUB_REF_TYPE !== 'branch'
      || typeof ref !== 'string' || !/^refs\/heads\/[^\s]+$/.test(ref)
      || !environment.GITHUB_REF_NAME || ref !== `refs/heads/${environment.GITHUB_REF_NAME}`
      || !/^[a-f0-9]{40}$/.test(commit || '')
      || commit !== head || environment.GITHUB_SHA !== head
      || environment.GITHUB_WORKFLOW_REF !== `${WORKFLOW}@${ref}`
      || environment.GITHUB_WORKFLOW_SHA !== head) {
    throw new Error('Candidate acceptance requires an exact explicitly pinned manual PR-branch checkout');
  }
  return { mode: 'candidate', commit, ref, tag: `v0.0.0-candidate.${commit}` };
}

function verifyAcceptanceSource(environment = process.env, requiredPaths) {
  const mode = environment.AWF_ENCLAVE_ACCEPTANCE_MODE || 'release';
  if (mode === 'release') {
    return { ...releaseGate.verifyAcceptanceCheckout(environment, requiredPaths), mode };
  }
  if (mode !== 'candidate') throw new Error('Unsupported enclave acceptance artifact mode');
  const head = execFileSync('git', ['-C', root, '-c', `safe.directory=${root}`,
    'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return assertCandidateSource(environment, head);
}

function configureCandidateBuild(checkout, directory = root) {
  if (checkout.mode !== 'candidate' || !/^[a-f0-9]{40}$/.test(checkout.commit)
      || checkout.tag !== `v0.0.0-candidate.${checkout.commit}`) {
    throw new Error('Candidate build configuration requires verified candidate source');
  }
  // This is a build-time compatibility profile, never an operator/runtime bypass.
  fs.writeFileSync(path.join(directory, 'src/cloud-hypervisor/artifact-compatibility.json'),
    `${JSON.stringify({ releaseTag: checkout.tag, signerWorkflow: SIGNER_WORKFLOW }, null, 2)}\n`);
}

function candidateAttestationArguments(checkout) {
  if (checkout.mode !== 'candidate' || !/^[a-f0-9]{40}$/.test(checkout.commit)
      || !/^refs\/heads\/[^\s]+$/.test(checkout.ref)
      || checkout.tag !== `v0.0.0-candidate.${checkout.commit}`) {
    throw new Error('Candidate attestation requires verified candidate source');
  }
  return [
    '--repo', REPOSITORY, '--signer-workflow', SIGNER_WORKFLOW,
    '--source-digest', checkout.commit, '--signer-digest', checkout.commit,
    '--source-ref', checkout.ref, '--deny-self-hosted-runners',
  ];
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['configure', 'verify', 'verify-environment-probe'].includes(args[0])) {
      throw new Error('Unsupported candidate acceptance command');
    }
    const checkout = verifyAcceptanceSource(process.env,
      args[0] === 'verify-environment-probe' ? releaseGate.ENVIRONMENT_PROBE_REQUIRED_PATHS : undefined);
    if (args[0] === 'configure') configureCandidateBuild(checkout);
    console.log(args[0] === 'configure' ? `tag=${checkout.tag}`
      : `Enclave acceptance source verified: ${checkout.mode} (${checkout.commit})`);
  } catch {
    console.error('Enclave acceptance source verification failed; no credentials were used.');
    process.exitCode = 1;
  }
}

module.exports = {
  SIGNER_WORKFLOW, assertCandidateSource, configureCandidateBuild,
  candidateAttestationArguments, verifyAcceptanceSource,
};
