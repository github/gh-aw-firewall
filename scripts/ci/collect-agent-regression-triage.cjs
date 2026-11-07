/* global module, require */
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash } = require('node:crypto');

const WORKFLOW_PATH = '.github/workflows/daily-agent-runtime-regression.yml';
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const MAX_REPORTS = 20;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const DIAGNOSTIC_NAME = /^agent-(?:runtime|enclave)-(?:copilot|codex|claude)-(?:docker|cloud-hypervisor|nvx)$/;

async function boundedList(endpoint, parameters, field, maxPages = 20) {
  const result = [];
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await endpoint({ ...parameters, per_page: 100, page });
    const items = field === 'jobs' ? data.jobs : field === 'artifacts' ? data.artifacts : data;
    if (!Array.isArray(items)) throw new Error('Invalid regression triage API response');
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error(`Regression triage collection limit reached (${maxPages * 100} items); narrow the backlog before retrying`);
}

function reportRunId(issue, repository) {
  if (issue.pull_request || issue.state !== 'open' ||
      issue.user?.login !== 'github-actions[bot]' || issue.user?.type !== 'Bot') return null;
  const match = /^<!-- awf-agent-runtime-regression:([^:\s]+):([1-9][0-9]*) -->\r?\n/.exec(issue.body ?? '');
  if (!match || match[1] !== repository || !Number.isSafeInteger(Number(match[2]))) return null;
  return Number(match[2]);
}

function testedSource(body, repository, serverUrl) {
  const match = /^Tested source revision: \[`([0-9a-f]{40})`\]\(([^)]+)\)\r?$/mi.exec(body);
  if (!match || match[2] !== `${serverUrl}/${repository}/commit/${match[1]}`) return null;
  return match[1];
}

function artifactMetadata(artifact) {
  const diagnostic = DIAGNOSTIC_NAME.test(artifact.name);
  const sizeValid = Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes >= 0;
  const reason = !diagnostic ? 'not-diagnostic' : artifact.expired ? 'expired'
    : !sizeValid ? 'unknown-size' : artifact.size_in_bytes > MAX_ARTIFACT_BYTES ? 'oversized' : null;
  return {
    id: artifact.id,
    name: artifact.name,
    size_in_bytes: artifact.size_in_bytes,
    expired: artifact.expired,
    created_at: artifact.created_at,
    eligible: reason === null,
    exclusion: reason,
  };
}

module.exports = async function collectAgentRegressionTriage({ github, context, core }) {
  const repo = context.repo;
  const repository = `${repo.owner}/${repo.repo}`;
  const serverUrl = context.serverUrl;
  const { data: workflow } = await github.rest.actions.getWorkflow({
    ...repo, workflow_id: 'daily-agent-runtime-regression.yml',
  });
  if (workflow.path !== WORKFLOW_PATH || workflow.name !== 'Daily Agent Runtime Regression') {
    throw new Error('Unexpected regression detector workflow identity');
  }

  // REST listing, not search indexing or a report comment, recovers partially published outputs.
  const issues = await boundedList(github.rest.issues.listForRepo, {
    ...repo, state: 'open', sort: 'created', direction: 'asc',
  });
  const candidates = issues.filter(issue => reportRunId(issue, repository) !== null);
  if (candidates.length > MAX_REPORTS) {
    throw new Error(`Regression triage report limit reached (${MAX_REPORTS}); review the open detector backlog`);
  }
  const existing = issues.filter(issue => !issue.pull_request &&
    issue.body?.includes(`<!-- awf-regression-job:${repository}:`)).map(issue => ({
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    body: issue.body.slice(0, 8000),
    body_truncated: issue.body.length > 8000,
    job_markers: issue.body.match(/<!-- awf-regression-job:[^>\r\n]+ -->/g) ?? [],
  }));
  const reports = [];
  const unavailableReports = [];
  for (const issue of candidates) {
    const runId = reportRunId(issue, repository);
    let run;
    try {
      ({ data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: runId }));
    } catch (error) {
      if (error.status !== 404 && error.status !== 410) throw error;
      core.warning(`Detector report #${issue.number}: run ${runId} unavailable; provenance cannot be verified`);
      unavailableReports.push({ number: issue.number, run_id: runId, reason: 'run-unavailable-provenance-unverified' });
      continue;
    }
    if (run.workflow_id !== workflow.id || run.path !== WORKFLOW_PATH ||
        run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
        run.head_branch !== 'main' || !['schedule', 'workflow_dispatch'].includes(run.event)) {
      core.warning(`Ignoring report #${issue.number}: run ${runId} does not match detector provenance`);
      continue;
    }
    const base = {
      number: issue.number,
      url: issue.html_url,
      run_id: runId,
      attempt: run.run_attempt,
      run_url: `${serverUrl}/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}`,
      workflow_sha: run.head_sha,
      tested_sha: testedSource(issue.body, repository, serverUrl),
      status: run.status,
    };
    if (run.status !== 'completed') {
      reports.push({ ...base, disposition: 'defer-in-progress' });
      continue;
    }
    const jobs = await boundedList(github.rest.actions.listJobsForWorkflowRun, {
      ...repo, run_id: runId, filter: 'latest',
    }, 'jobs', 3);
    if (jobs.length === 0) {
      core.warning(`Detector report #${issue.number}: no job metadata is available`);
      reports.push({ ...base, disposition: 'evidence-unavailable', reason: 'no-job-metadata' });
      continue;
    }
    if (jobs.some(job => job.status !== 'completed')) {
      reports.push({ ...base, disposition: 'defer-in-progress' });
      continue;
    }
    const failures = jobs.filter(job => FAILURE_CONCLUSIONS.has(job.conclusion)).map(job => ({
      id: job.id,
      name: job.name,
      attempt: job.run_attempt ?? null,
      started_at: job.started_at,
      completed_at: job.completed_at,
      url: `${serverUrl}/${repository}/actions/runs/${runId}/job/${job.id}`,
      conclusion: job.conclusion,
      failed_steps: (job.steps ?? []).filter(step => FAILURE_CONCLUSIONS.has(step.conclusion))
        .map(step => ({ number: step.number, name: step.name, conclusion: step.conclusion })),
      marker: `<!-- awf-regression-job:${repository}:${runId}:${job.id} -->`,
    }));
    const snapshot = createHash('sha256').update(JSON.stringify([
      runId, run.run_attempt, base.tested_sha,
      jobs.map(job => [job.id, job.run_attempt, job.conclusion]).sort((a, b) => a[0] - b[0]),
    ])).digest('hex').slice(0, 16);
    const artifacts = failures.length === 0 ? [] : await boundedList(
      github.rest.actions.listWorkflowRunArtifacts, { ...repo, run_id: runId }, 'artifacts', 2,
    );
    reports.push({
      ...base,
      disposition: failures.length ? 'triage' : 'no-current-failures',
      snapshot_marker: `<!-- awf-regression-triage:${repository}:${runId}:${snapshot} -->`,
      failures,
      artifacts: artifacts.map(artifactMetadata),
    });
  }
  core.info(`Prepared ${reports.length} verified detector reports and ${existing.length} open remediation issues (metadata only)`);
  return {
    repository,
    collected_at: new Date().toISOString(),
    limits: { reports: MAX_REPORTS, artifact_bytes: MAX_ARTIFACT_BYTES },
    reports,
    unavailable_reports: unavailableReports,
    existing_remediation_issues: existing,
  };
};

module.exports.reportRunId = reportRunId;
module.exports.artifactMetadata = artifactMetadata;
