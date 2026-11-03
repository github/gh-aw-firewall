---
name: Daily Workflow Runtime Auditor
description: Rank the slowest GitHub Actions workflows and feed evidence to the runtime optimizer.
on:
  schedule: daily
  workflow_dispatch:
permissions:
  copilot-requests: write
  contents: read
  actions: read
  issues: read
imports:
  - shared/reporting.md
checkout:
  ref: main
sandbox:
  agent:
    id: awf
network:
  allowed: []
tools:
  github: false
safe-outputs:
  create-issue:
    title-prefix: "[Workflow Runtime Audit] "
    labels: [workflow-runtime-report]
    close-older-issues: true
    max: 1
timeout-minutes: 20
strict: true
steps:
  - name: Collect workflow runtime evidence
    uses: actions/github-script@v9
    with:
      script: |
        const fs = require('fs');
        const dir = '/tmp/gh-aw/runtime-audit';
        fs.mkdirSync(dir, { recursive: true });
        const repo = context.repo;
        const { data: audit } = await github.rest.actions.getWorkflowRun({
          ...repo, run_id: context.runId,
        });
        const end = new Date(audit.created_at);
        const start = new Date(end.getTime() - 7 * 86400000);
        const auditDate = end.toISOString().slice(0, 10);
        const previous = await github.paginate(github.rest.issues.listForRepo, {
          ...repo, labels: 'workflow-runtime-report', state: 'all', per_page: 100,
        });
        const existing = previous.find(issue => !issue.pull_request &&
          Number.isSafeInteger(issue.number) && issue.number > 0 &&
          /^Audit producer: workflow-runtime-auditor$/m.test(issue.body ?? '') &&
          issue.body?.match(new RegExp(`^Audit date: ${auditDate}$`, 'm')));
        if (existing) {
          fs.writeFileSync(`${dir}/report.json`, JSON.stringify({
            duplicate_report: `https://github.com/${repo.owner}/${repo.repo}/issues/${existing.number}`,
            audit_date: auditDate,
          }));
          return;
        }

        const runs = [];
        let total = 0;
        for (let page = 1; page <= 5; page++) {
          const { data } = await github.rest.actions.listWorkflowRunsForRepo({
            ...repo, status: 'completed', per_page: 100, page,
            created: `${start.toISOString()}..${end.toISOString()}`,
          });
          total = data.total_count;
          runs.push(...data.workflow_runs);
          if (data.workflow_runs.length < 100 || runs.length >= total) break;
        }
        const excludedPaths = new Set([
          '.github/workflows/workflow-runtime-auditor.lock.yml',
          '.github/workflows/workflow-runtime-optimizer.lock.yml',
        ]);
        const measured = [];
        const unmeasured = [];
        const cohorts = new Map();
        let excluded = 0;
        const validWorkflowPath = value => typeof value === 'string' &&
          value.length <= 300 &&
          /^\.github\/workflows\/[A-Za-z0-9._/-]+\.(?:yml|yaml)$/.test(value) &&
          !value.split('/').includes('..');
        for (const run of runs) {
          const workflowPath = typeof run.path === 'string' ? run.path.split('@')[0] : null;
          if (excludedPaths.has(workflowPath)) {
            excluded++;
            continue;
          }
          if (!validWorkflowPath(workflowPath) ||
              ![run.id, run.workflow_id, run.run_attempt].every(value =>
                Number.isSafeInteger(value) && value > 0)) {
            unmeasured.push({ reason: 'Invalid workflow path or run identifiers' });
            continue;
          }
          const jobs = await github.paginate(
            github.rest.actions.listJobsForWorkflowRunAttempt,
            { ...repo, run_id: run.id, attempt_number: run.run_attempt, per_page: 100 },
          );
          const executed = jobs.filter(job => job.conclusion !== 'skipped');
          const valid = executed.length > 0 && executed.every(job =>
            job.status === 'completed' &&
            Number.isFinite(Date.parse(job.started_at)) &&
            Number.isFinite(Date.parse(job.completed_at)) &&
            Date.parse(job.completed_at) >= Date.parse(job.started_at));
          if (!valid) {
            unmeasured.push({ run_id: run.id, workflow_path: workflowPath,
              reason: 'Missing, invalid, or incomplete job timestamps' });
            continue;
          }
          const first = Math.min(...executed.map(job => Date.parse(job.started_at)));
          const last = Math.max(...executed.map(job => Date.parse(job.completed_at)));
          measured.push({
            workflow_id: run.workflow_id, workflow_path: workflowPath,
            run_id: run.id, attempt: run.run_attempt,
            url: `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id}`,
            succeeded: run.conclusion === 'success',
            elapsed_seconds: (last - first) / 1000,
            initial_queue_seconds: run.run_attempt === 1
              ? (first - Date.parse(run.created_at)) / 1000 : null,
          });
          if (!cohorts.has(workflowPath)) {
            cohorts.set(workflowPath, { events: new Set(), branches: new Set() });
          }
          cohorts.get(workflowPath).events.add(run.event);
          cohorts.get(workflowPath).branches.add(run.head_branch);
        }
        const groups = new Map();
        for (const run of measured) {
          if (!groups.has(run.workflow_path)) groups.set(run.workflow_path, []);
          groups.get(run.workflow_path).push(run);
        }
        const workflows = [...groups].map(([workflowPath, samples]) => {
          const successes = samples.filter(run => run.succeeded);
          const durations = successes.map(run => run.elapsed_seconds).sort((a, b) => a - b);
          const percentile = p => durations.length
            ? durations[Math.ceil(durations.length * p) - 1] : null;
          const totalSeconds = durations.reduce((sum, value) => sum + value, 0);
          return {
            workflow_id: samples[0].workflow_id, workflow_path: workflowPath,
            measured_runs: samples.length,
            successful_runs: successes.length,
            other_conclusions: samples.length - successes.length,
            mean_seconds: durations.length ? totalSeconds / durations.length : null,
            p50_seconds: percentile(0.5), p95_seconds: percentile(0.95),
            total_success_seconds: totalSeconds,
            event_count: cohorts.get(workflowPath).events.size,
            branch_count: cohorts.get(workflowPath).branches.size,
            evidence: successes.sort((a, b) => b.elapsed_seconds - a.elapsed_seconds)
              .slice(0, 3),
          };
        });
        const ranked = workflows.filter(workflow => workflow.successful_runs > 0).sort((a, b) =>
          b.mean_seconds - a.mean_seconds || b.p95_seconds - a.p95_seconds ||
          b.total_success_seconds - a.total_success_seconds ||
          a.workflow_path.localeCompare(b.workflow_path));
        const report = {
          audit_date: auditDate, audit_run_id: context.runId,
          window_start: start.toISOString(), window_end: end.toISOString(),
          window_basis: 'Run creation time, inclusive UTC bounds; latest attempt only',
          available_runs: total, sampled_runs: runs.length,
          truncated: total > runs.length, excluded_self_runs: excluded,
          measured_runs: measured.length, unmeasured_runs: unmeasured,
          candidates: ranked.slice(0, 10),
          workflows_without_success: workflows.filter(workflow => workflow.successful_runs === 0),
        };
        if (report.truncated) core.warning('Runtime audit is limited to the newest 500 completed runs.');
        if (unmeasured.length) core.warning(`${unmeasured.length} runs have unusable job timestamps.`);
        fs.writeFileSync(`${dir}/runs.json`, JSON.stringify(measured));
        fs.writeFileSync(`${dir}/report.json`, JSON.stringify(report));
---

# Daily Workflow Runtime Auditor

Identify where maintainers can reduce GitHub Actions latency across **all workflow
types and engines**, not just Copilot. Read the precomputed
`/tmp/gh-aw/runtime-audit/report.json`; use `runs.json` only for targeted detail.
Do not refetch runs or download logs. The files contain only validated workflow
paths, numeric identifiers/metrics, boolean outcomes, and canonical run links.
Free-form names, branch names, events, commit text, and issue bodies are excluded.

## Measurement contract

The report covers the seven days ending at this audit run's creation time (UTC),
grouped by exact workflow path/ID across branches and events. It samples at most
the newest 500 completed runs created in that window, using only each run's latest
attempt. State the actual window, coverage counts, truncation, and missing data.
Never describe a truncated sample as an exhaustive repository ranking.

Elapsed runtime is **first executed job start to last executed job completion**,
including inter-job waits but excluding initial queue time. Never use
`updated_at` as a completion timestamp. Do not sum parallel job durations or call
elapsed time billable minutes. Initial queue time is separate and unavailable for
reruns. Failed, cancelled, timed-out, and skipped runs do not enter the successful
runtime ranking; disclose them and unmeasured runs separately.

Use the provided top ten candidates, ranked by mean successful elapsed runtime,
then p95, then total successful elapsed time. Percentiles use nearest rank.
Flag fewer than three successful samples as low confidence. Note mixed event/branch
cohorts when `event_count` or `branch_count` exceeds one; raw cohort names are not
included. Exclude this
audit/optimizer pair to prevent self-generated work.

## Report

If `duplicate_report` is present, call `noop` with that URL. Otherwise create
exactly one issue with title `YYYY-MM-DD` using `create-issue`. The newest report
supersedes older audit reports, but never closes implementation recommendations.
Even an empty window gets a short report stating that no measurable successful
runs were found; missing measurements are unknown, not zero.

Include these visible identifiers, substituting values from the JSON. Do not hide
them in HTML comments; they must remain available after safe-output sanitization:

`Audit producer: workflow-runtime-auditor`

`Audit date: YYYY-MM-DD`

`Audit run ID: AUDIT_RUN_ID`

Use this compact body structure:

- `### Overview`: UTC window, sampling/measurement definitions and coverage,
  including any collection limits.
- `### Slowest Workflows`: top-ten table with rank, exact workflow
  path, workflow ID, successful sample count, mean/p50/p95 in seconds, total
  successful elapsed seconds, and representative run links (with attempt numbers).
  Preserve the provided ordering and numeric metrics.
- `### Optimization Candidates`: short evidence-based hypotheses for the highest
  impact targets, never invented bottlenecks or measured savings.
- `<details>`: failed/non-success counts, unmeasured runs, mixed cohorts, and
  secondary observations.

Keep the top-ten table visible: it is the runtime optimizer's handoff contract.
Also include a `### Runtime Audit Data` section containing a `json` fenced block
with only `audit_run_id`, `window_start`, `window_end`, and `candidates`. Each
candidate must contain `workflow_id`, `workflow_path`, `successful_runs`,
`mean_seconds`, `p50_seconds`, `p95_seconds`, `total_success_seconds`, and up to
three `evidence` records containing only `run_id`, `attempt`, and
`elapsed_seconds`. Preserve numeric values and exact workflow paths from the
provided report. Do not add names, prose, URLs, or extra fields to this block.
No code changes, workflow dispatches, cancellations, assignments, or PRs.

## Usage

Runs daily; `workflow_dispatch` permits a manual audit. One report per UTC date;
same-day reruns no-op. A successful audit triggers `workflow-runtime-optimizer`,
which looks for this run's report and proposes one focused implementation task.
