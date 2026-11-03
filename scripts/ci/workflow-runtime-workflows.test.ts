import * as fs from 'fs';
import * as path from 'path';
import { Script } from 'vm';
import * as yaml from 'js-yaml';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const readSource = (id: string) => fs.readFileSync(path.join(workflowsDir, `${id}.md`), 'utf8');
const readLock = (id: string) => fs.readFileSync(path.join(workflowsDir, `${id}.lock.yml`), 'utf8');
const auditorSource = readSource('workflow-runtime-auditor');
const optimizerSource = readSource('workflow-runtime-optimizer');

interface WorkflowSource {
  name: string;
  steps: { name: string; with: { script: string } }[];
}

function frontmatter(source: string): WorkflowSource {
  return yaml.load(source.split('---')[1]) as WorkflowSource;
}

interface Run {
  id: number;
  workflow_id: number;
  path: string;
  name: string;
  run_attempt: number;
  conclusion: string;
  created_at: string;
  html_url: string;
  event: string;
  head_branch: string;
  head_sha: string;
}

interface Job {
  status: string;
  conclusion: string;
  started_at: string | null;
  completed_at: string | null;
}

interface Issue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  created_at: string;
  pull_request?: object;
}

const anchor = '2026-11-03T00:00:00.000Z';
const timestamp = (seconds: number) => new Date(Date.parse(anchor) - 3600000 + seconds * 1000).toISOString();
const makeRun = (id: number, workflow = 'slow', overrides: Partial<Run> = {}): Run => ({
  id, workflow_id: workflow === 'slow' ? 100 : 200,
  path: `.github/workflows/${workflow}.yml`, name: workflow,
  run_attempt: 1, conclusion: 'success', created_at: timestamp(0),
  html_url: `https://github.com/github/gh-aw-firewall/actions/runs/${id}`,
  event: 'push', head_branch: 'main', head_sha: 'abc123', ...overrides,
});
const makeJob = (start: number, end: number, overrides: Partial<Job> = {}): Job => ({
  status: 'completed', conclusion: 'success',
  started_at: timestamp(start), completed_at: timestamp(end), ...overrides,
});
const makeIssue = (number: number, body: string, overrides: Partial<Issue> = {}): Issue => ({
  number, title: 'Runtime issue', body, created_at: anchor,
  html_url: `https://github.com/github/gh-aw-firewall/issues/${number}`, ...overrides,
});

function harness(
  runs: Run[] = [],
  jobs: Record<number, Job[]> = {},
  reports: Issue[] = [],
  recommendations: Issue[] = [],
  total = runs.length,
) {
  const files = new Map<string, string>();
  const actions = {
    getWorkflowRun: jest.fn().mockResolvedValue({ data: { created_at: anchor } }),
    listWorkflowRunsForRepo: jest.fn(async ({ page }: { page: number }) => ({
      data: { total_count: total, workflow_runs: runs.slice((page - 1) * 100, page * 100) },
    })),
    listJobsForWorkflowRunAttempt: jest.fn(),
  };
  const issues = { listForRepo: jest.fn() };
  const paginate = jest.fn(async (method: unknown, params: { run_id?: number; labels?: string }) => {
    if (method === actions.listJobsForWorkflowRunAttempt) return jobs[params.run_id!] ?? [];
    if (method === issues.listForRepo) {
      return params.labels === 'workflow-runtime-report' ? reports : recommendations;
    }
    throw new Error('Unexpected paginated endpoint');
  });
  const github = { rest: { actions, issues }, paginate };
  const context = {
    repo: { owner: 'github', repo: 'gh-aw-firewall' },
    runId: 900, payload: {} as { workflow_run?: { id: number } },
  };
  const core = { warning: jest.fn() };
  const requireMock = (name: string) => {
    if (name !== 'fs') throw new Error(`Unexpected module: ${name}`);
    return {
      mkdirSync: jest.fn(),
      writeFileSync: (file: string, content: string) => files.set(file, content),
    };
  };
  const execute = async (source: string) => {
    const script = frontmatter(source).steps[0].with.script;
    const run = new Script(`(async (require, github, context, core) => { ${script} })`)
      .runInNewContext();
    await run(requireMock, github, context, core);
  };
  return { files, github, context, core, execute };
}

describe('runtime audit/optimizer workflow configuration', () => {
  it('audits daily and triggers the optimizer only after successful main audits', () => {
    expect(frontmatter(auditorSource)).toMatchObject({
      name: 'Daily Workflow Runtime Auditor',
      on: { schedule: 'daily', workflow_dispatch: null },
      tools: { github: false },
      'safe-outputs': {
        'create-issue': { labels: ['workflow-runtime-report'], 'close-older-issues': true, max: 1 },
      },
    });
    expect(frontmatter(optimizerSource)).toMatchObject({
      on: {
        workflow_run: {
          workflows: ['Daily Workflow Runtime Auditor'], types: ['completed'], branches: ['main'],
        },
        workflow_dispatch: null,
      },
      if: "${{ github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success' }}",
      tools: { github: { mode: 'gh-proxy', toolsets: ['actions', 'issues', 'pull_requests', 'repos'] } },
      'safe-outputs': { 'create-issue': { labels: ['workflow-runtime-optimization'], max: 1 } },
    });
    expect(optimizerSource).not.toContain('close-older-issues: true');
  });

  it.each(['workflow-runtime-auditor', 'workflow-runtime-optimizer'])(
    'compiles %s with read-only data access and required postprocessing',
    id => {
      const source = frontmatter(readSource(id));
      const lock = readLock(id);
      expect(source).toMatchObject({
        permissions: { contents: 'read', actions: 'read', issues: 'read', 'copilot-requests': 'write' },
        checkout: { ref: 'main' }, network: { allowed: [] }, strict: true,
      });
      expect(yaml.load(lock)).toMatchObject({
        jobs: { agent: { permissions: {
          contents: 'read', actions: 'read', issues: 'read', 'copilot-requests': 'write',
        } } },
      });
      expect(lock).not.toContain('contents: write');
      expect(lock).not.toContain('actions: write');
      expect(applyGeneralWorkflowPatches(lock, `${id}.lock.yml`).content).toBe(lock);
    },
  );

  it('requires source-level changes, critical-path evidence, safe validation, and no-op cases', () => {
    for (const requirement of [
      'exact auditor run', 'at least three successful', 'at most five representative runs',
      'critical path', 'not generated', 'run the repository workflow postprocessor',
      'cold-cache behavior', 'Do not remove tests', 'call `noop`',
      'workflow-runtime-target:EXACT_WORKFLOW_PATH', 'recheck open',
      'do not modify code',
    ]) {
      expect(optimizerSource.toLowerCase()).toContain(requirement.toLowerCase());
    }
    expect(auditorSource).toContain('workflow-runtime-audit-run:AUDIT_RUN_ID');
    expect(auditorSource).toContain('Never use\n`updated_at` as a completion timestamp');
  });
});

describe('runtime auditor data collection', () => {
  it('measures overlapping jobs as wall time, excludes failures from ranking, and uses nearest-rank percentiles', async () => {
    const runs = [
      makeRun(1), makeRun(2), makeRun(3, 'fast'), makeRun(4, 'fast'), makeRun(5, 'fast'),
      makeRun(6, 'slow', { conclusion: 'failure' }),
      makeRun(7, 'failed-only', { conclusion: 'timed_out' }),
    ];
    const h = harness(runs, {
      1: [makeJob(10, 110), makeJob(10, 90)],
      2: [makeJob(10, 20)],
      3: [makeJob(10, 70)], 4: [makeJob(10, 70)], 5: [makeJob(10, 70)],
      6: [makeJob(10, 3010)], 7: [makeJob(10, 4010)],
    });
    await h.execute(auditorSource);
    const report = JSON.parse(h.files.get('/tmp/gh-aw/runtime-audit/report.json')!);
    expect(report).toMatchObject({
      audit_run_id: 900, report_key: 'workflow-runtime-audit:2026-11-03',
      window_start: '2026-10-27T00:00:00.000Z', window_end: anchor,
      available_runs: 7, sampled_runs: 7, measured_runs: 7, truncated: false,
    });
    expect(report.candidates.map((candidate: { name: string }) => candidate.name)).toEqual(['fast', 'slow']);
    expect(report.candidates[1]).toMatchObject({
      successful_runs: 2, other_conclusions: 1, mean_seconds: 55,
      p50_seconds: 10, p95_seconds: 100, total_success_seconds: 110,
    });
    expect(report.workflows_without_success[0]).toMatchObject({
      name: 'failed-only', successful_runs: 0, mean_seconds: null, p95_seconds: null,
    });
    const measurements = JSON.parse(h.files.get('/tmp/gh-aw/runtime-audit/runs.json')!);
    expect(measurements[0]).toMatchObject({ elapsed_seconds: 100, initial_queue_seconds: 10 });
  });

  it('uses the latest attempt, treats missing measurements as unknown, and excludes its own pair', async () => {
    const h = harness([
      makeRun(1, 'slow', { run_attempt: 2 }),
      makeRun(2),
      makeRun(3),
      makeRun(4, 'workflow-runtime-auditor', { path: '.github/workflows/workflow-runtime-auditor.lock.yml' }),
      makeRun(5, 'workflow-runtime-optimizer', { path: '.github/workflows/workflow-runtime-optimizer.lock.yml' }),
      makeRun(6),
    ], {
      1: [makeJob(500, 530)],
      2: [makeJob(0, 0, { started_at: null, completed_at: null })],
      3: [makeJob(100, 90)],
      6: [makeJob(0, 0, { conclusion: 'skipped', started_at: null, completed_at: null })],
    });
    await h.execute(auditorSource);
    expect(h.github.paginate).toHaveBeenCalledWith(
      h.github.rest.actions.listJobsForWorkflowRunAttempt,
      expect.objectContaining({ run_id: 1, attempt_number: 2 }),
    );
    const report = JSON.parse(h.files.get('/tmp/gh-aw/runtime-audit/report.json')!);
    expect(report).toMatchObject({ measured_runs: 1, excluded_self_runs: 2 });
    expect(report.unmeasured_runs).toHaveLength(3);
    expect(report.candidates[0].evidence[0]).toMatchObject({
      elapsed_seconds: 30, attempt: 2, initial_queue_seconds: null,
    });
    expect(h.core.warning).toHaveBeenCalled();
  });

  it('paginates up to 500 runs, flags truncation, and preserves distinct paths with the same name', async () => {
    const runs = Array.from({ length: 600 }, (_, index) =>
      makeRun(index + 1, index % 2 ? 'slow' : 'different-path', { name: 'Shared Name' }));
    const jobs = Object.fromEntries(runs.map(run => [run.id, [makeJob(0, 20)]]));
    const h = harness(runs, jobs);
    await h.execute(auditorSource);
    expect(h.github.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledTimes(5);
    expect(h.github.rest.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ created: '2026-10-27T00:00:00.000Z..2026-11-03T00:00:00.000Z' }),
    );
    const report = JSON.parse(h.files.get('/tmp/gh-aw/runtime-audit/report.json')!);
    expect(report).toMatchObject({ available_runs: 600, sampled_runs: 500, truncated: true });
    expect(report.candidates).toHaveLength(2);
    expect(h.core.warning).toHaveBeenCalledWith(expect.stringContaining('500'));
  });

  it('handles empty windows and suppresses duplicate daily reports before collecting runs', async () => {
    const empty = harness();
    await empty.execute(auditorSource);
    expect(JSON.parse(empty.files.get('/tmp/gh-aw/runtime-audit/report.json')!)).toMatchObject({
      candidates: [], measured_runs: 0, available_runs: 0,
    });
    const duplicate = harness([], {}, [
      makeIssue(30, '<!-- workflow-runtime-audit:2026-11-03 -->'),
    ]);
    await duplicate.execute(auditorSource);
    expect(JSON.parse(duplicate.files.get('/tmp/gh-aw/runtime-audit/report.json')!)).toMatchObject({
      duplicate_report: 'https://github.com/github/gh-aw-firewall/issues/30',
    });
    expect(duplicate.github.rest.actions.listWorkflowRunsForRepo).not.toHaveBeenCalled();
  });

  it('surfaces API errors instead of fabricating empty data', async () => {
    const h = harness([makeRun(1)]);
    h.github.paginate.mockRejectedValueOnce(new Error('API permission denied'));
    await expect(h.execute(auditorSource)).rejects.toThrow('API permission denied');
    expect(h.files.has('/tmp/gh-aw/runtime-audit/report.json')).toBe(false);
  });
});

describe('runtime optimizer report handoff', () => {
  const reportBody = (id: number) =>
    `<!-- gh-aw-workflow-id: workflow-runtime-auditor -->\n<!-- workflow-runtime-audit-run:${id} -->`;

  it('selects the exact triggering audit, including closed reports, instead of a newer unrelated report', async () => {
    const h = harness([], {}, [
      makeIssue(40, reportBody(901)),
      makeIssue(39, reportBody(900)),
    ], [
      makeIssue(38, '<!-- workflow-runtime-target:.github/workflows/build.yml -->'),
      makeIssue(37, 'Not an issue', { pull_request: {} }),
    ]);
    h.context.payload.workflow_run = { id: 900 };
    await h.execute(optimizerSource);
    const data = JSON.parse(h.files.get('/tmp/gh-aw/runtime-optimization/context.json')!);
    expect(data.report.number).toBe(39);
    expect(data.open_recommendations).toHaveLength(1);
    expect(data.open_recommendations[0].number).toBe(38);
    expect(h.github.paginate).toHaveBeenCalledWith(
      h.github.rest.issues.listForRepo,
      expect.objectContaining({ state: 'all', labels: 'workflow-runtime-report' }),
    );
  });

  it('does not fall back when a successful audit produced no new report', async () => {
    const h = harness([], {}, [makeIssue(39, reportBody(899))]);
    h.context.payload.workflow_run = { id: 900 };
    await h.execute(optimizerSource);
    expect(JSON.parse(h.files.get('/tmp/gh-aw/runtime-optimization/context.json')!).report).toBeNull();
  });

  it('uses the latest genuine report on manual dispatch and ignores issues without the producer marker', async () => {
    const h = harness([], {}, [
      makeIssue(41, '<!-- workflow-runtime-audit-run:902 -->'),
      makeIssue(40, reportBody(901)),
      makeIssue(39, reportBody(900)),
    ]);
    await h.execute(optimizerSource);
    const data = JSON.parse(h.files.get('/tmp/gh-aw/runtime-optimization/context.json')!);
    expect(data.report.number).toBe(40);
    expect(data.triggering_audit_run_id).toBeNull();
  });
});
