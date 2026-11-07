/* global module */
'use strict';

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

function escapeMarkdown(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;')
    .replace(/[\\`*_[\]{}()|]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');
}

module.exports = async function reportAgentRegressionFailures({
  github, context, core, sourceSha, sourceAttempt, runAttempt,
}) {
  const repository = context.repo;
  const { data: run } = await github.rest.actions.getWorkflowRun({
    ...repository, run_id: context.runId,
  });
  // Keep successful cells from earlier attempts when only failed jobs were rerun.
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repository, run_id: context.runId, filter: 'latest', per_page: 100,
  });
  const failures = jobs.filter(job => FAILURE_CONCLUSIONS.has(job.conclusion));
  if (failures.length === 0) {
    core.info('No failed regression or build jobs to report.');
    return;
  }

  const marker = `<!-- awf-agent-runtime-regression:${repository.owner}/${repository.repo}:${context.runId} -->`;
  const sourceValid = /^[0-9a-f]{40}$/i.test(sourceSha ?? '') &&
    Number.isSafeInteger(sourceAttempt) && sourceAttempt > 0;
  const source = sourceValid
    ? `[\`${sourceSha}\`](${context.serverUrl}/${repository.owner}/${repository.repo}/commit/${sourceSha})`
    : 'Unavailable: the shared build did not publish its pinned source revision.';
  const sourceAttemptText = sourceValid ? `\`${sourceAttempt}\`` : '`Unavailable`';
  const rows = failures.map(job => {
    const steps = (job.steps ?? [])
      .filter(step => FAILURE_CONCLUSIONS.has(step.conclusion))
      .map(step => escapeMarkdown(step.name))
      .join(', ');
    return `| [${escapeMarkdown(job.name)}](${job.html_url}) | ${job.conclusion} | ${steps || 'Not available'} |`;
  });
  const title = `Daily agent/runtime regression failed (run ${context.runId})`;
  const body = [
    marker,
    '## Daily agent/runtime regression failures',
    '',
    `Run: [${context.runId}, attempt ${runAttempt}](${run.html_url}/attempts/${runAttempt})`,
    `Build source job attempt: ${sourceAttemptText}`,
    `Tested source revision: ${source}`,
    `Workflow revision: \`${run.head_sha}\``,
    '',
    `${failures.length} failed build or regression job(s). Successful, skipped, and cancelled jobs are omitted.`,
    'For partial reruns, the table includes the latest result for each job across attempts.',
    '',
    '| Failed job | Conclusion | Failed steps |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'This report contains Actions job metadata only. Inspect the linked jobs for logs and evidence.',
    'The workflow remains failed; this issue reports the failure rather than suppressing it.',
  ].join('\n');

  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repository, state: 'all', creator: 'github-actions[bot]',
    since: run.created_at, sort: 'created', direction: 'desc', per_page: 100,
  });
  const existing = issues.find(issue => !issue.pull_request && issue.body?.includes(marker));
  if (existing) {
    await github.rest.issues.update({
      ...repository, issue_number: existing.number, title, body,
    });
    core.info(`Updated regression failure issue #${existing.number}.`);
  } else {
    const { data: issue } = await github.rest.issues.create({ ...repository, title, body });
    core.info(`Created regression failure issue #${issue.number}.`);
  }
};
