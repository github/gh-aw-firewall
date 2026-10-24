'use strict';

const { execFileSync } = require('child_process');

const REPOSITORY = 'github/gh-aw-firewall';
const REQUIRED_ASSETS = Object.freeze([
  'cloud-hypervisor-test-x86_64.tar.gz',
  'cloud-hypervisor-test-x86_64.SHA256SUMS',
  'cloud-hypervisor-test-x86_64.manifest.json',
  'cloud-hypervisor-test-x86_64.manifest.sigstore.jsonl',
  'cloud-hypervisor-test-x86_64.sbom.spdx.json',
  'cloud-hypervisor-enclave-rootfs-x86_64.tar.gz',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json',
  'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
  'enclave-rootfs.ext4.gz',
  'enclave-rootfs.sbom.spdx.json',
  'cloud-hypervisor-rootfs.sbom.spdx.json',
  'enclave-rootfs.provenance.sigstore.jsonl',
  'setup-cloud-hypervisor-enclave-artifacts.sh',
]);

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function api(method, endpoint, body) {
  const args = ['api', '--method', method, endpoint];
  if (body) args.push('--input', '-');
  const output = execFileSync('gh', args, {
    encoding: 'utf8',
    input: body ? JSON.stringify(body) : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return output.trim() ? JSON.parse(output) : undefined;
}

function dispatchReleaseConformance(environment = process.env, dependencies = { git, api }, primary = false) {
  const workflow = primary ? 'test-cloud-hypervisor.yml' : 'test-cloud-hypervisor-enclaves.yml';
  const jobName = primary ? 'Dispatch release primary-agent live KVM' : 'Dispatch full release enclave conformance';
  const tag = environment.AWF_RELEASE_TAG;
  const source = environment.GITHUB_SHA;
  if (environment.GITHUB_REPOSITORY !== REPOSITORY ||
      environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      environment.GITHUB_REF_TYPE !== 'branch' ||
      environment.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/release.yml@${environment.GITHUB_REF}` ||
      !/^[a-f0-9]{40}$/.test(source || '') ||
      !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ID || '') ||
      !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ATTEMPT || '') ||
      !/^v\d+\.\d+\.\d+$/.test(tag || '')) {
    throw new Error('Conformance handoff requires the native release workflow, exact source SHA and version tag');
  }
  const { git: readGit, api: request } = dependencies;
  if (readGit('rev-parse', 'HEAD') !== source ||
      readGit('rev-parse', `refs/tags/${tag}^`) !== source) {
    throw new Error('Release tag must be the version commit directly on the selected release source');
  }
  const commit = readGit('rev-parse', `refs/tags/${tag}^{commit}`);
  if (!/^[a-f0-9]{40}$/.test(commit) ||
      JSON.parse(readGit('show', `refs/tags/${tag}:package.json`)).version !== tag.slice(1) ||
      JSON.parse(readGit('show', `refs/tags/${tag}:src/cloud-hypervisor/artifact-compatibility.json`)).releaseTag !== tag) {
    throw new Error('Release tag, package and artifact compatibility identities must agree');
  }
  const release = request('GET', `repos/${REPOSITORY}/releases/tags/${tag}`);
  if (release.tag_name !== tag || release.draft !== false || !release.published_at ||
      !Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error('Conformance requires the exact published release');
  }
  const assets = [];
  for (let page = 1; ; page++) {
    const batch = request('GET', `repos/${REPOSITORY}/releases/${release.id}/assets?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid release asset response');
    assets.push(...batch);
    if (batch.length < 100) break;
  }
  for (const name of REQUIRED_ASSETS) {
    const matches = assets.filter(asset => asset.name === name);
    if (matches.length !== 1 || matches[0].state !== 'uploaded' || !(matches[0].size > 0)) {
      throw new Error(`Required release asset is missing, ambiguous or incomplete: ${name}`);
    }
  }
  const endpoint = `repos/${REPOSITORY}/actions/workflows/${workflow}`;
  // A previous attempt that reached this step may have POSTed successfully even
  // if its response was lost. Skipped jobs (e.g. publication failed) are safe.
  if (environment.GITHUB_RUN_ATTEMPT !== '1') {
    for (let page = 1; ; page++) {
      const history = request('GET',
        `repos/${REPOSITORY}/actions/runs/${environment.GITHUB_RUN_ID}/jobs?filter=all&per_page=100&page=${page}`);
      if (!Array.isArray(history.jobs)) throw new Error('Invalid release job history');
      for (const job of history.jobs) {
        if (job.name !== `${jobName} (${tag})`) continue;
        if (!Number.isSafeInteger(job.run_attempt) || !Array.isArray(job.steps)) {
          throw new Error('Ambiguous prior conformance job identity');
        }
        if (job.run_attempt >= Number(environment.GITHUB_RUN_ATTEMPT)) continue;
        if (job.steps.some(step => step.name === 'Dispatch exact published tag once' &&
            step.conclusion !== 'skipped')) {
          throw new Error('A prior attempt reached the dispatch step; inspect runs before manual recovery');
        }
      }
      if (history.jobs.length < 100) break;
    }
  }
  const runs = request('GET', `${endpoint}/runs?event=workflow_dispatch&head_sha=${commit}&per_page=1`);
  if (runs.total_count !== 0 || !Array.isArray(runs.workflow_runs) || runs.workflow_runs.length !== 0) {
    throw new Error('Conformance already exists for this release commit, or run identity is ambiguous; inspect manually');
  }
  // Do not retry: a transport failure does not prove the dispatch was rejected.
  request('POST', `${endpoint}/dispatches`, {
    ref: tag,
    inputs: primary ? {
      run_live_kvm: 'true',
      acceptance_commit: source,
    } : {
      run_host_probes: 'true',
      run_live_kvm: 'true',
      run_environment_probe: 'true',
      acceptance_commit: source,
    },
  });
  return { tag, source, commit };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--primary')) {
      throw new Error('Unsupported release validation target');
    }
    const primary = args[0] === '--primary';
    const { tag, source } = dispatchReleaseConformance(process.env, { git, api }, primary);
    console.log(`Submitted ${primary ? 'primary-agent live KVM' : 'full enclave conformance'} for ${tag}, acceptance_commit=${source}. Submission is not VM acceptance; check the dispatched workflow for results.`);
  } catch (error) {
    console.error(`Release validation handoff failed: ${error.message}. No automatic retry; inspect workflow runs before manual recovery.`);
    process.exitCode = 1;
  }
}

module.exports = { REQUIRED_ASSETS, dispatchReleaseConformance };
