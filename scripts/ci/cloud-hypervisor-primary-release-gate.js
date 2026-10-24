'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPOSITORY = 'github/gh-aw-firewall';
const WORKFLOW = `${REPOSITORY}/.github/workflows/test-cloud-hypervisor.yml`;
const REQUIRED_PATHS = Object.freeze([
  '.github/workflows/test-cloud-hypervisor.yml',
  'scripts/ci/cloud-hypervisor-primary-release-gate.js',
  'scripts/ci/cloud-hypervisor-host-preflight.sh',
  'scripts/ci/cloud-hypervisor-live-smoke.sh',
]);
const root = path.resolve(__dirname, '../..');
const defaults = {
  git: (...args) => execFileSync('git', ['-C', root, '-c', `safe.directory=${root}`, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim(),
  readJson: file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')),
};

function verifyPrimaryReleaseCheckout(environment = process.env, dependencies = defaults) {
  const { git, readJson } = dependencies;
  const acceptanceCommit = environment.AWF_ACCEPTANCE_COMMIT;
  const tag = environment.GITHUB_REF_NAME;
  if (environment.GITHUB_REPOSITORY !== REPOSITORY ||
      environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      environment.GITHUB_REF_TYPE !== 'tag' ||
      !/^v\d+\.\d+\.\d+$/.test(tag || '') ||
      environment.GITHUB_REF !== `refs/tags/${tag}` ||
      environment.GITHUB_WORKFLOW_REF !== `${WORKFLOW}@refs/tags/${tag}` ||
      !/^[a-f0-9]{40}$/.test(acceptanceCommit || '')) {
    throw new Error('Primary release validation requires an exact native release-tag dispatch and full acceptance_commit SHA');
  }
  const commit = git('rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(commit) ||
      commit !== environment.GITHUB_SHA || commit !== environment.GITHUB_WORKFLOW_SHA ||
      git('rev-parse', `refs/tags/${tag}^{commit}`) !== commit ||
      readJson('package.json').version !== tag.slice(1) ||
      readJson('src/cloud-hypervisor/artifact-compatibility.json').releaseTag !== tag) {
    throw new Error('Primary release source, package and artifact compatibility identities must agree');
  }
  git('merge-base', '--is-ancestor', acceptanceCommit, commit);
  for (const file of REQUIRED_PATHS) git('cat-file', '-e', `${acceptanceCommit}:${file}`);
  return { tag, commit };
}

if (require.main === module) {
  try {
    const { tag, commit } = verifyPrimaryReleaseCheckout();
    console.log(`Primary release validation checkout verified: ${tag} (${commit})`);
  } catch (error) {
    console.error(`Primary release validation gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { REQUIRED_PATHS, verifyPrimaryReleaseCheckout };
