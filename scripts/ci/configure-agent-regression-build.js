'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIGNER_WORKFLOW = 'github/gh-aw-firewall/.github/workflows/daily-agent-runtime-regression.yml';

function configure(directory, commit, environment = process.env) {
  if (!/^[a-f0-9]{40}$/.test(commit || '')
    || environment.GITHUB_ACTIONS !== 'true'
    || environment.GITHUB_REPOSITORY !== 'github/gh-aw-firewall'
    || !['schedule', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME)
    || environment.GITHUB_WORKFLOW_REF !== `${SIGNER_WORKFLOW}@refs/heads/main`) {
    throw new Error('Regression build requires the daily workflow on main and a pinned source commit');
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
  if (head !== commit) throw new Error('Regression build checkout does not match the pinned main commit');
  fs.writeFileSync(path.join(directory, 'src/cloud-hypervisor/artifact-compatibility.json'),
    `${JSON.stringify({
      releaseTag: `v0.0.0-regression.${commit}`, signerWorkflow: SIGNER_WORKFLOW,
    }, null, 2)}\n`);
}

if (require.main === module) configure(path.resolve(__dirname, '../..'), process.env.SOURCE_SHA);

module.exports = { configure, SIGNER_WORKFLOW };
