import * as fs from 'fs';
import * as path from 'path';
import { Script } from 'vm';
import * as yaml from 'js-yaml';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const collect = require('./collect-agent-regression-triage.cjs');

const repo = { owner: 'github', repo: 'gh-aw-firewall' };
const repository = 'github/gh-aw-firewall';
const serverUrl = 'https://github.com';
const sha = 'a'.repeat(40);
const workflowPath = '.github/workflows/daily-agent-runtime-regression.yml';
const jobMarker = '<!-- awf-regression-job:github/gh-aw-firewall:123:456 -->';
const reportIssue = () => ({
  number: 10,
  state: 'open',
  title: 'Daily agent/runtime regression failed (run 123)',
  user: { login: 'github-actions[bot]', type: 'Bot' },
  html_url: `${serverUrl}/${repository}/issues/10`,
  body: `<!-- awf-agent-runtime-regression:${repository}:123 -->\n` +
    `Tested source revision: [\`${sha}\`](${serverUrl}/${repository}/commit/${sha})\n`,
});
const failedJob = () => ({
  id: 456, name: 'codex / enclave-docker', run_attempt: 1,
  status: 'completed', conclusion: 'failure',
  steps: [{ number: 4, name: 'Run real coding agent inside enclave', conclusion: 'failure' }],
});

function harness() {
  const actions = {
    getWorkflow: jest.fn().mockResolvedValue({
      data: { id: 77, path: workflowPath, name: 'Daily Agent Runtime Regression' },
    }),
    getWorkflowRun: jest.fn().mockResolvedValue({
      data: {
        id: 123, workflow_id: 77, path: workflowPath, status: 'completed',
        run_attempt: 2, head_sha: 'b'.repeat(40), head_branch: 'main', event: 'schedule',
        repository: { full_name: repository }, head_repository: { full_name: repository },
      },
    }),
    listJobsForWorkflowRun: jest.fn().mockResolvedValue({
      data: { jobs: [failedJob(), {
        ...failedJob(), id: 789, name: 'claude / docker', run_attempt: 2, conclusion: 'success',
      }] },
    }),
    listWorkflowRunArtifacts: jest.fn().mockResolvedValue({ data: { artifacts: [{
      id: 55, name: 'agent-enclave-codex-docker', size_in_bytes: 4096,
      expired: false, created_at: '2026-11-06T08:00:00Z',
    }] } }),
  };
  const issues = { listForRepo: jest.fn().mockResolvedValue({ data: [reportIssue()] }) };
  const core = { info: jest.fn(), warning: jest.fn() };
  return {
    actions, issues, core,
    options: { github: { rest: { actions, issues } }, context: { repo, serverUrl }, core },
  };
}

describe('regression triage metadata collection', () => {
  it('pins detector provenance, tested SHA and latest per-job attempts, not the old report table', async () => {
    const h = harness();
    const data = await collect(h.options);
    expect(h.actions.getWorkflow).toHaveBeenCalledWith({
      ...repo, workflow_id: 'daily-agent-runtime-regression.yml',
    });
    expect(h.actions.listJobsForWorkflowRun).toHaveBeenCalledWith({
      ...repo, run_id: 123, filter: 'latest', page: 1, per_page: 100,
    });
    expect(data.reports).toHaveLength(1);
    expect(data.reports[0]).toMatchObject({
      number: 10, tested_sha: sha, workflow_sha: 'b'.repeat(40),
      attempt: 2, disposition: 'triage',
      failures: [{ id: 456, attempt: 1, marker: jobMarker }],
      artifacts: [{ eligible: true, id: 55 }],
    });
    expect(data.reports[0].run_url).toBe(`${serverUrl}/${repository}/actions/runs/123/attempts/2`);
    expect(data.reports[0].failures).toHaveLength(1);
  });

  it.each([
    { state: 'closed' },
    { pull_request: {} },
    { user: { login: 'contributor', type: 'User' } },
    { user: { login: 'github-actions[bot]', type: 'User' } },
    { body: '<!-- awf-agent-runtime-regression:other/repo:123 -->\n' },
    { body: '> <!-- awf-agent-runtime-regression:github/gh-aw-firewall:123 -->\n' },
    { body: '<!-- awf-agent-runtime-regression:github/gh-aw-firewall:9007199254740993 -->\n' },
    { body: 'Same title but no detector marker' },
  ])('does not trust an arbitrary or non-open report: %j', async patch => {
    const h = harness();
    h.issues.listForRepo.mockResolvedValue({ data: [{ ...reportIssue(), ...patch }] });
    expect((await collect(h.options)).reports).toEqual([]);
    expect(h.actions.getWorkflowRun).not.toHaveBeenCalled();
  });

  it.each([
    { workflow_id: 99 }, { path: '.github/workflows/other.yml' },
    { repository: { full_name: 'other/repo' } },
    { head_repository: { full_name: 'fork/repo' } },
    { head_branch: 'feature' }, { event: 'pull_request' },
  ])('rejects mismatched run provenance: %j', async patch => {
    const h = harness();
    const run = (await h.actions.getWorkflowRun()).data;
    h.actions.getWorkflowRun.mockResolvedValue({ data: { ...run, ...patch } });
    expect((await collect(h.options)).reports).toEqual([]);
    expect(h.core.warning).toHaveBeenCalledWith(expect.stringContaining('provenance'));
    expect(h.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
  });

  it('fails closed if the workflow path resolves to another detector identity', async () => {
    const h = harness();
    h.actions.getWorkflow.mockResolvedValue({ data: { id: 77, path: 'other.yml' } });
    await expect(collect(h.options)).rejects.toThrow('workflow identity');
  });

  it.each(['queued', 'in_progress'])('defers a %s rerun without consulting old failures', async status => {
    const h = harness();
    const run = (await h.actions.getWorkflowRun()).data;
    h.actions.getWorkflowRun.mockResolvedValue({ data: { ...run, status } });
    expect((await collect(h.options)).reports[0].disposition).toBe('defer-in-progress');
    expect(h.actions.listJobsForWorkflowRun).not.toHaveBeenCalled();
  });

  it('defers a race with jobs still in progress', async () => {
    const h = harness();
    h.actions.listJobsForWorkflowRun.mockResolvedValue({
      data: { jobs: [{ ...failedJob(), status: 'in_progress', conclusion: null }] },
    });
    expect((await collect(h.options)).reports[0].disposition).toBe('defer-in-progress');
    expect(h.actions.listWorkflowRunArtifacts).not.toHaveBeenCalled();
  });

  it('classifies missing job metadata as unknown rather than successful recovery', async () => {
    const h = harness();
    h.actions.listJobsForWorkflowRun.mockResolvedValue({ data: { jobs: [] } });
    expect((await collect(h.options)).reports[0]).toMatchObject({
      disposition: 'evidence-unavailable', reason: 'no-job-metadata',
    });
    expect(h.core.warning).toHaveBeenCalledWith(expect.stringContaining('no job metadata'));
    expect(h.actions.listWorkflowRunArtifacts).not.toHaveBeenCalled();
  });

  it('does not reuse stale report failures after successful, cancelled, or skipped jobs', async () => {
    const h = harness();
    h.actions.listJobsForWorkflowRun.mockResolvedValue({
      data: { jobs: ['success', 'cancelled', 'skipped'].map(conclusion => ({ ...failedJob(), conclusion })) },
    });
    const report = (await collect(h.options)).reports[0];
    expect(report.disposition).toBe('no-current-failures');
    expect(report.failures).toEqual([]);
    expect(h.actions.listWorkflowRunArtifacts).not.toHaveBeenCalled();
  });

  it('recovers partially published remediation issues without a source-report comment', async () => {
    const h = harness();
    h.issues.listForRepo.mockResolvedValue({ data: [reportIssue(), {
      ...reportIssue(), number: 11, user: { login: 'maintainer', type: 'User' },
      body: `${jobMarker}\n${'x'.repeat(9000)}`,
    }] });
    const data = await collect(h.options);
    expect(data.existing_remediation_issues).toMatchObject([{
      number: 11, job_markers: [jobMarker], body_truncated: true,
    }]);
    expect(data.existing_remediation_issues[0].body).toHaveLength(8000);
    expect(h.issues.listForRepo.mock.calls[0][0]).toMatchObject({
      state: 'open', sort: 'created', direction: 'asc',
    });
  });

  it('makes snapshot identity independent of job order but sensitive to reruns and changed results', async () => {
    const h = harness();
    const first = (await collect(h.options)).reports[0].snapshot_marker;
    const jobs = (await h.actions.listJobsForWorkflowRun()).data.jobs;
    h.actions.listJobsForWorkflowRun.mockResolvedValue({ data: { jobs: [...jobs].reverse() } });
    expect((await collect(h.options)).reports[0].snapshot_marker).toBe(first);
    h.actions.listJobsForWorkflowRun.mockResolvedValue({
      data: { jobs: [{ ...failedJob(), id: 999, run_attempt: 2 }] },
    });
    expect((await collect(h.options)).reports[0].snapshot_marker).not.toBe(first);
  });

  it.each([
    'Unavailable: the shared build did not publish its pinned source revision.',
    `[\`${sha}\`](https://example.com/commit/${sha})`,
  ])('never substitutes the workflow revision for missing or invalid tested source', async source => {
    const h = harness();
    h.issues.listForRepo.mockResolvedValue({
      data: [{ ...reportIssue(), body: reportIssue().body.split('\n')[0] + `\nTested source revision: ${source}\n` }],
    });
    expect((await collect(h.options)).reports[0].tested_sha).toBeNull();
  });

  it('collects additional issue pages rather than silently dropping old open reports', async () => {
    const h = harness();
    h.issues.listForRepo.mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => ({
      number: i + 100, body: '', state: 'open',
    })) }).mockResolvedValueOnce({ data: [reportIssue()] });
    expect((await collect(h.options)).reports).toHaveLength(1);
    expect(h.issues.listForRepo).toHaveBeenCalledTimes(2);
  });

  it('fails explicitly instead of presenting a truncated collection as an empty backlog', async () => {
    const h = harness();
    h.actions.listJobsForWorkflowRun.mockResolvedValue({
      data: { jobs: Array.from({ length: 100 }, () => failedJob()) },
    });
    await expect(collect(h.options)).rejects.toThrow('collection limit');
    expect(h.actions.listJobsForWorkflowRun).toHaveBeenCalledTimes(3);
  });

  it('bounds the number of reports before fetching job evidence', async () => {
    const h = harness();
    h.issues.listForRepo.mockResolvedValue({ data: Array.from({ length: 21 }, (_, i) => ({
      ...reportIssue(), number: i + 1,
    })) });
    await expect(collect(h.options)).rejects.toThrow('report limit');
    expect(h.actions.getWorkflowRun).not.toHaveBeenCalled();
  });

  it.each([404, 410])('warns when run provenance is unavailable (%s)', async status => {
    const h = harness();
    h.actions.getWorkflowRun.mockRejectedValue({ status });
    const data = await collect(h.options);
    expect(data.reports).toEqual([]);
    expect(data.unavailable_reports).toEqual([{
      number: 10, run_id: 123, reason: 'run-unavailable-provenance-unverified',
    }]);
    expect(h.core.warning).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it.each([403, 429, 500])('surfaces API errors (%s), not a success-shaped empty backlog', async status => {
    const h = harness();
    h.actions.getWorkflowRun.mockRejectedValue({ status });
    await expect(collect(h.options)).rejects.toEqual({ status });
  });

  it.each([
    ['agent-enclave-codex-docker', 5 * 1024 * 1024, false, null],
    ['agent-enclave-claude-cloud-hypervisor', 5 * 1024 * 1024 + 1, false, 'oversized'],
    ['agent-runtime-copilot-nvx', 100, true, 'expired'],
    ['agent-runtime-awf-build', 1, false, 'not-diagnostic'],
    ['agent-runtime-cloud-hypervisor', 1, false, 'not-diagnostic'],
    ['agent-runtime-nvx', 1, false, 'not-diagnostic'],
    ['agent-enclave-codex-docker/../../secret', 1, false, 'not-diagnostic'],
    ['agent-runtime-codex-docker', undefined, false, 'unknown-size'],
  ])('bounds diagnostic eligibility for %s (%s bytes)', (name, size, expired, exclusion) => {
    expect(collect.artifactMetadata({
      id: 55, name, size_in_bytes: size, expired, raw: 'SECRET',
    })).toMatchObject({ eligible: exclusion === null, exclusion });
    expect(collect.artifactMetadata({ name, raw: 'SECRET' })).not.toHaveProperty('raw');
  });
});

describe('daily regression triage workflow contract', () => {
  const root = path.resolve(__dirname, '../..');
  const file = 'daily-agent-runtime-triage';
  const markdown = fs.readFileSync(path.join(root, '.github/workflows', `${file}.md`), 'utf8');
  const frontmatter = markdown.split('---')[1];
  const source = yaml.load(frontmatter) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    steps: { with: { script: string } }[];
    'safe-outputs': Record<string, unknown>;
  };

  it('runs daily/manually with read-only collection and safe-output-only bounded writes', () => {
    expect(source.on).toHaveProperty('schedule');
    expect(source.on).toHaveProperty('workflow_dispatch');
    expect(source.permissions).toEqual({
      'copilot-requests': 'write', contents: 'read', issues: 'read', actions: 'read', 'pull-requests': 'read',
    });
    expect(source['safe-outputs']['create-issue']).toMatchObject({
      max: 5, 'deduplicate-by-title': true,
    });
    expect(source['safe-outputs']['add-comment']).toMatchObject({
      max: 20, target: '*', 'pull-requests': false,
      'required-title-prefix': 'Daily agent/runtime regression failed (run ',
    });
    expect(source['safe-outputs']).not.toHaveProperty('close-issue');
    expect(source['safe-outputs']).not.toHaveProperty('update-issue');
    expect(source['safe-outputs']['create-issue']).not.toHaveProperty('expires');
    expect(source['safe-outputs']['create-issue']).not.toHaveProperty('close-older-issues');
    expect(() => new Script(`(async () => { ${source.steps[0].with.script} })()`)).not.toThrow();
    expect(source.steps[0].with.script).toContain('/tmp/gh-aw/agent/regression-triage.json');
  });

  it('compiles the read-only collector and keeps published AWF postprocessing idempotent', () => {
    const lockPath = path.join(root, '.github/workflows', `${file}.lock.yml`);
    const lockText = fs.readFileSync(lockPath, 'utf8');
    const lock = yaml.load(lockText) as { jobs: Record<string, {
      permissions?: Record<string, string>;
      steps?: { name?: string; with?: { script?: string } }[];
    }> };
    const agent = Object.values(lock.jobs).find(job => job.steps?.some(step =>
      step.name === 'Collect verified regression report metadata'));
    expect(agent).toBeDefined();
    expect(agent?.permissions).toMatchObject(source.permissions);
    expect(lock.jobs.safe_outputs.permissions).toEqual({ issues: 'write' });
    expect(agent?.steps?.find(step => step.name === 'Collect verified regression report metadata')
      ?.with?.script).toContain('collect-agent-regression-triage.cjs');
    expect(lockText).toContain('start_cli_proxy.sh');
    expect(lockText).toContain('--difc-proxy-host awmg-cli-proxy:18443');
    expect(lockText).not.toContain('Build local AWF');
    expect(applyGeneralWorkflowPatches(lockText, lockPath).content).toBe(lockText);
  });
});
