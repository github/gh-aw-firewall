/* global module, require */
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash } = require('node:crypto');

const WORKFLOW_PATH = '.github/workflows/daily-agent-runtime-regression.yml';
const BUILD_JOB_NAME = 'Build AWF and images once from main';
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
const MAX_REPORTS = 20;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const DIAGNOSTIC_NAME = /^agent-(?:runtime|enclave)-(?:copilot|codex|claude)-(?:docker|cloud-hypervisor|nvx)$/;

function positiveSafeInteger(value) {
  return /^[1-9][0-9]*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value));
}

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
  if (!match || match[1] !== repository || !positiveSafeInteger(match[2])) return null;
  return Number(match[2]);
}

function testedSource(body, repository, serverUrl) {
  const reportAttempt = /^Run: \[(\d+), attempt ([1-9][0-9]*)\]\(/mi.exec(body ?? '');
  const buildAttempt = /^Build source job attempt: `([1-9][0-9]*)`\r?$/mi.exec(body ?? '');
  const match = /^Tested source revision: \[`([0-9a-f]{40})`\]\(([^)]+)\)\r?$/mi.exec(body ?? '');
  if (!reportAttempt || !buildAttempt ||
      !positiveSafeInteger(reportAttempt[2]) || !positiveSafeInteger(buildAttempt[1])) return null;
  return {
    sha: match?.[1] && match[2] === `${serverUrl}/${repository}/commit/${match[1]}` ? match[1] : null,
    reportAttempt: Number(reportAttempt[2]),
    buildAttempt: Number(buildAttempt[1]),
  };
}

function verifiedTestedSource(body, repository, serverUrl, runAttempt, jobs) {
  const source = testedSource(body, repository, serverUrl);
  const buildJobs = jobs.filter(job => job.name === BUILD_JOB_NAME);
  if (!source || source.reportAttempt !== runAttempt || buildJobs.length !== 1) return null;
  const [build] = buildJobs;
  if (build.status !== 'completed' || build.conclusion !== 'success' ||
      !positiveSafeInteger(build.run_attempt) || source.buildAttempt !== Number(build.run_attempt)) return null;
  return source.sha;
}

function selectReportBatch(candidates, date = new Date()) {
  if (candidates.length <= MAX_REPORTS) return { selected: candidates, deferred: [] };
  const day = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
  const batchCount = Math.ceil(candidates.length / MAX_REPORTS);
  const start = (day % batchCount) * MAX_REPORTS;
  return {
    selected: candidates.slice(start, start + MAX_REPORTS),
    deferred: [...candidates.slice(0, start), ...candidates.slice(start + MAX_REPORTS)],
  };
}

function remediationJobMarkers(issue, repository) {
  if (issue.pull_request || issue.state !== 'open' ||
      issue.user?.login !== 'github-actions[bot]' || issue.user?.type !== 'Bot' ||
      typeof issue.body !== 'string') return [];
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(
    `^AWF-REGRESSION-JOB:${escapedRepository}:([1-9][0-9]*):([1-9][0-9]*)$`, 'gm',
  );
  return [...issue.body.matchAll(expression)]
    .filter(match => positiveSafeInteger(match[1]) && positiveSafeInteger(match[2]))
    .map(match => `AWF-REGRESSION-JOB:${repository}:${Number(match[1])}:${Number(match[2])}`);
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

module.exports = async function collectAgentRegressionTriage({ github, context, core, now = new Date() }) {
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
  const { selected, deferred } = selectReportBatch(candidates, now);
  const existing = issues.flatMap(issue => {
    const jobMarkers = remediationJobMarkers(issue, repository);
    if (jobMarkers.length === 0) return [];
    return [{
      number: issue.number,
      url: issue.html_url,
      title_present: typeof issue.title === 'string' && issue.title.length > 0,
      title_length: typeof issue.title === 'string' ? issue.title.length : 0,
      job_markers: [...new Set(jobMarkers)],
    }];
  });
  const reports = [];
  const unavailableReports = [];
  for (const issue of selected) {
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
    const jobs = run.status === 'completed' ? await boundedList(github.rest.actions.listJobsForWorkflowRun, {
      ...repo, run_id: runId, filter: 'latest',
    }, 'jobs', 3) : [];
    const base = {
      number: issue.number,
      url: issue.html_url,
      run_id: runId,
      attempt: run.run_attempt,
      run_url: `${serverUrl}/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}`,
      workflow_sha: run.head_sha,
      tested_sha: run.status === 'completed'
        ? verifiedTestedSource(issue.body, repository, serverUrl, run.run_attempt, jobs)
        : null,
      status: run.status,
    };
    if (run.status !== 'completed') {
      reports.push({ ...base, disposition: 'defer-in-progress' });
      continue;
    }
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
      marker: `AWF-REGRESSION-JOB:${repository}:${runId}:${job.id}`,
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
      snapshot_marker: `AWF-REGRESSION-TRIAGE:${repository}:${runId}:${snapshot}`,
      failures,
      artifacts: artifacts.map(artifactMetadata),
    });
  }
  core.info(`Prepared ${reports.length} verified detector reports; ${deferred.length} reports deferred by the per-scan limit`);
  return {
    repository,
    collected_at: now.toISOString(),
    limits: { reports: MAX_REPORTS, artifact_bytes: MAX_ARTIFACT_BYTES },
    backlog: {
      total_reports: candidates.length,
      processed_reports: selected.length,
      deferred_report_numbers: deferred.map(issue => issue.number),
    },
    reports,
    unavailable_reports: unavailableReports,
    existing_remediation_issues: existing,
  };
};

module.exports.reportRunId = reportRunId;
module.exports.artifactMetadata = artifactMetadata;
module.exports.testedSource = testedSource;
module.exports.verifiedTestedSource = verifiedTestedSource;
module.exports.remediationJobMarkers = remediationJobMarkers;
module.exports.selectReportBatch = selectReportBatch;
