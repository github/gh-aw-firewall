/* global module, require */
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readFileSync } = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const collect = require('./collect-agent-regression-triage.cjs');

const WORKFLOW_PATH = '.github/workflows/daily-agent-runtime-regression.yml';
const ALLOWED_OUTPUTS = new Set([
  'add_comment', 'create_issue', 'noop', 'report_incomplete', 'report_missing_data', 'report_missing_tool',
]);

function readJson(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid triage validation input');
  }
  return value;
}

function commentNumber(entry) {
  const fields = ['item_number', 'pr', 'pr_number'].filter(field => entry[field] !== undefined);
  if (fields.length !== 1 || !/^[1-9][0-9]*$/.test(String(entry[fields[0]])) ||
      !Number.isSafeInteger(Number(entry[fields[0]]))) {
    throw new Error('Safe-output comment has no unique positive issue number');
  }
  return Number(entry[fields[0]]);
}

async function validateTriageOutputs({ github, context, core,
  inputPath = '/tmp/gh-aw/agent/regression-triage.json',
  outputsPath = '/tmp/gh-aw/agent-output/safeoutputs.jsonl' }) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const input = readJson(inputPath);
  if (input.repository !== repository || !Array.isArray(input.reports)) {
    throw new Error('Triage validation input does not match the current repository');
  }
  const reports = new Map();
  for (const report of input.reports) {
    if (!Number.isSafeInteger(report.number) || report.number < 1 ||
        !Number.isSafeInteger(report.run_id) || report.run_id < 1 ||
        !Number.isSafeInteger(report.attempt) || report.attempt < 1) {
      throw new Error('Triage validation input contains an invalid report identity');
    }
    if (reports.has(report.number)) throw new Error('Triage validation input contains duplicate reports');
    reports.set(report.number, report);
  }

  const entries = readFileSync(outputsPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (!entries.every(entry => entry && ALLOWED_OUTPUTS.has(entry.type))) {
    throw new Error('Safe-output file contains an unknown output type');
  }
  const comments = entries.filter(entry => entry.type === 'add_comment');
  if (comments.length > 20) throw new Error('Safe-output comment limit exceeded');
  if (comments.length === 0) return true;

  const { data: workflow } = await github.rest.actions.getWorkflow({
    ...context.repo, workflow_id: 'daily-agent-runtime-regression.yml',
  });
  if (workflow.path !== WORKFLOW_PATH || workflow.name !== 'Daily Agent Runtime Regression') {
    throw new Error('Unexpected regression detector workflow identity');
  }

  const validatedIssues = new Set();
  const validatedRuns = new Map();
  const commentedIssues = new Set();
  for (const comment of comments) {
    const number = commentNumber(comment);
    const report = reports.get(number);
    if (!report || !['triage', 'no-current-failures'].includes(report.disposition) ||
        typeof report.snapshot_marker !== 'string' ||
        !new RegExp(`^AWF-REGRESSION-TRIAGE:${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:` +
          `${report.run_id}:[a-f0-9]{16}$`).test(report.snapshot_marker) ||
        typeof comment.body !== 'string' || !comment.body.includes(report.snapshot_marker) ||
        comment.reply_to_id !== undefined ||
        (comment.repo !== undefined && comment.repo !== repository)) {
      throw new Error('Safe-output comment does not match a collected source report');
    }
    if (commentedIssues.has(number)) throw new Error('Safe-output contains duplicate source-report comments');
    commentedIssues.add(number);
    if (!validatedIssues.has(number)) {
      const { data: issue } = await github.rest.issues.get({
        ...context.repo, issue_number: number,
      });
      if (issue.pull_request || issue.state !== 'open' ||
          issue.title !== `Daily agent/runtime regression failed (run ${report.run_id})` ||
          collect.reportRunId(issue, repository) !== report.run_id) {
        throw new Error('Safe-output target is not a trusted open detector report');
      }
      validatedIssues.add(number);
    }
    let run = validatedRuns.get(report.run_id);
    if (!run) {
      ({ data: run } = await github.rest.actions.getWorkflowRun({
        ...context.repo, run_id: report.run_id,
      }));
      validatedRuns.set(report.run_id, run);
    }
    if (run.workflow_id !== workflow.id || run.path !== WORKFLOW_PATH ||
        run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
        run.head_branch !== 'main' || !['schedule', 'workflow_dispatch'].includes(run.event) ||
        run.status !== 'completed' || run.run_attempt !== report.attempt ||
        run.head_sha !== report.workflow_sha) {
      throw new Error('Safe-output target no longer matches verified detector provenance');
    }
    validatedRuns.set(report.run_id, run);
  }

  core.info(`Validated ${comments.length} safe-output comment target(s) against live detector provenance`);
  return true;
}

module.exports = validateTriageOutputs;
module.exports.commentNumber = commentNumber;
