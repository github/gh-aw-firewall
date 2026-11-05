import * as fs from 'fs';
import * as path from 'path';
import { Script } from 'vm';
import * as yaml from 'js-yaml';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const report = require('./report-agent-regression-failures.cjs');

const repository = { owner: 'github', repo: 'gh-aw-firewall' };
const runUrl = 'https://github.com/github/gh-aw-firewall/actions/runs/123';
const sourceSha = 'a'.repeat(40);
const workflowSha = 'b'.repeat(40);
const marker = '<!-- awf-agent-runtime-regression:github/gh-aw-firewall:123 -->';
interface Job {
  name: string;
  html_url: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string }[];
}
interface Issue {
  number: number;
  body: string | null;
  state?: string;
  pull_request?: object;
}
const job = (name: string, conclusion = 'failure'): Job => ({
  name, conclusion, html_url: `${runUrl}/job/456`,
  steps: [{ name: 'Run real regression', conclusion }],
});

function harness(jobs: Job[], existing: Issue[] = []) {
  const actions = {
    getWorkflowRun: jest.fn().mockResolvedValue({
      data: { html_url: runUrl, head_sha: workflowSha, created_at: '2026-11-05T06:37:00Z' },
    }),
    listJobsForWorkflowRun: jest.fn(),
  };
  const issues = {
    listForRepo: jest.fn(),
    create: jest.fn().mockResolvedValue({ data: { number: 42 } }),
    update: jest.fn().mockResolvedValue({ data: { number: 42 } }),
  };
  const github = {
    rest: { actions, issues },
    paginate: jest.fn(async (endpoint: unknown) => {
      if (endpoint === actions.listJobsForWorkflowRun) return jobs;
      if (endpoint === issues.listForRepo) return existing;
      throw new Error('Unexpected paginated endpoint');
    }),
  };
  const options = {
    github,
    context: { repo: repository, runId: 123, serverUrl: 'https://github.com' },
    core: { info: jest.fn() },
    sourceSha,
    runAttempt: 1,
  };
  return { options, github, actions, issues };
}

describe('agent regression failure reporting', () => {
  it('aggregates all fifteen failing matrix cells into one metadata-only issue', async () => {
    const jobs = ['copilot', 'codex', 'claude'].flatMap(agent =>
      ['docker', 'cloud-hypervisor', 'nvx', 'enclave-docker', 'enclave-cloud-hypervisor']
        .map(runtime => job(`${agent} / ${runtime}`)));
    jobs.push(job('Build AWF', 'success'), job('Skipped runtime', 'skipped'), job('Cancelled runtime', 'cancelled'));
    const h = harness(jobs);
    await report(h.options);
    expect(h.issues.create).toHaveBeenCalledTimes(1);
    const issue = h.issues.create.mock.calls[0][0];
    expect(issue).toMatchObject({ ...repository, title: 'Daily agent/runtime regression failed (run 123)' });
    expect(issue.body).toContain(marker);
    expect(issue.body).toContain('15 failed build or regression job(s)');
    expect(issue.body).toContain(`${runUrl}/attempts/1`);
    expect(issue.body).toContain(`/commit/${sourceSha}`);
    expect(issue.body).toContain(`Workflow revision: \`${workflowSha}\``);
    for (const cell of jobs.slice(0, 15)) {
      expect(issue.body).toContain(`[${cell.name}](${cell.html_url})`);
    }
    expect(issue.body).toContain('Run real regression');
    expect(issue.body).not.toMatch(/Build AWF|Skipped runtime|Cancelled runtime/);
    expect(h.github.paginate).toHaveBeenCalledWith(h.actions.listJobsForWorkflowRun, {
      ...repository, run_id: 123, filter: 'latest', per_page: 100,
    });
    expect(h.issues.update).not.toHaveBeenCalled();
  });

  it.each(['failure', 'timed_out', 'startup_failure', 'action_required'])(
    'reports a shared build %s even when downstream cells were skipped',
    async conclusion => {
      const h = harness([job('Build AWF', conclusion), job('copilot / docker', 'skipped')]);
      await report({ ...h.options, sourceSha: '' });
      expect(h.issues.create.mock.calls[0][0].body).toContain('| [Build AWF]');
      expect(h.issues.create.mock.calls[0][0].body).toContain('Unavailable: the shared build');
      expect(h.issues.create.mock.calls[0][0].body).not.toContain(`/commit/${workflowSha}`);
    },
  );

  it.each(['success', 'cancelled', 'skipped', 'neutral', null])(
    'does not create or update an issue for only %s jobs',
    async conclusion => {
      const h = harness([{ ...job('No failure'), conclusion }], [{ number: 42, body: marker }]);
      await report(h.options);
      expect(h.issues.create).not.toHaveBeenCalled();
      expect(h.issues.update).not.toHaveBeenCalled();
      expect(h.github.paginate).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['open', 'closed'])('updates the same %s issue on a failing partial rerun', async state => {
    const h = harness([job('codex / docker'), job('claude / docker', 'success')], [
      { number: 99, body: marker, pull_request: {} },
      { number: 98, body: '<!-- awf-agent-runtime-regression:github/gh-aw-firewall:1234 -->' },
      { number: 97, body: null },
      { number: 42, body: marker, state },
    ]);
    await report({ ...h.options, runAttempt: 2 });
    expect(h.issues.create).not.toHaveBeenCalled();
    expect(h.issues.update).toHaveBeenCalledWith({
      ...repository, issue_number: 42,
      title: 'Daily agent/runtime regression failed (run 123)',
      body: expect.stringContaining(`${runUrl}/attempts/2`),
    });
    expect(h.issues.update.mock.calls[0][0].body).not.toContain('claude / docker');
    expect(h.github.paginate).toHaveBeenCalledWith(h.issues.listForRepo, {
      ...repository, state: 'all', creator: 'github-actions[bot]',
      since: '2026-11-05T06:37:00Z', sort: 'created', direction: 'desc', per_page: 100,
    });
  });

  it('does not reuse another run or repository report', async () => {
    const h = harness([job('Build AWF')], [
      { number: 1, body: marker.replace(':123 -->', ':12 -->') },
      { number: 2, body: marker.replace('github/gh-aw-firewall', 'other/repository') },
    ]);
    await report(h.options);
    expect(h.issues.create).toHaveBeenCalledTimes(1);
  });

  it('escapes job and step formatting and never copies arbitrary metadata or logs', async () => {
    const h = harness([{
      ...job('bad | [link](url)\n@team <tag>'),
      steps: [{ name: 'step | @team <tag>', conclusion: 'failure' }],
      ...{ logs: 'SECRET RAW LOG', output: 'SECRET PROMPT' },
    }, { name: 'Failed before steps', conclusion: 'failure', html_url: `${runUrl}/job/789` }]);
    await report(h.options);
    const body = h.issues.create.mock.calls[0][0].body;
    expect(body).toContain('bad \\| \\[link\\]\\(url\\) &#64;team &lt;tag&gt;');
    expect(body).toContain('step \\| &#64;team &lt;tag&gt;');
    expect(body).toContain('Not available');
    expect(body).not.toMatch(/SECRET|@team|<tag>/);
  });

  it.each(['create', 'update'] as const)('surfaces issue %s API failures', async method => {
    const h = harness([job('Build AWF')], method === 'update' ? [{ number: 42, body: marker }] : []);
    h.issues[method].mockRejectedValue(new Error('Issue API unavailable'));
    await expect(report(h.options)).rejects.toThrow('Issue API unavailable');
  });

  it('does not silently ignore failures to read the run or paginated jobs', async () => {
    const h = harness([job('Build AWF')]);
    h.actions.getWorkflowRun.mockRejectedValueOnce(new Error('Run API unavailable'));
    await expect(report(h.options)).rejects.toThrow('Run API unavailable');
    h.github.paginate.mockRejectedValueOnce(new Error('Jobs API unavailable'));
    await expect(report(h.options)).rejects.toThrow('Jobs API unavailable');
    expect(h.issues.create).not.toHaveBeenCalled();
  });
});

interface WorkflowJob {
  needs?: string[];
  if?: string;
  permissions?: Record<string, string>;
  steps: {
    uses?: string; env?: Record<string, string>; with?: Record<string, unknown>;
  }[];
}
const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname,
  '../../.github/workflows/daily-agent-runtime-regression.yml'), 'utf8')) as {
    permissions: Record<string, string>;
    jobs: Record<string, WorkflowJob>;
  };

describe('regression reporting workflow wiring', () => {
  const reporter = workflow.jobs['report-failures'];

  it('waits for every build and matrix even after prerequisite failures', () => {
    expect(reporter.needs?.slice().sort())
      .toEqual(Object.keys(workflow.jobs).filter(name => name !== 'report-failures').sort());
    expect(reporter.if).toBe("${{ always() && contains(needs.*.result, 'failure') }}");
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== 'report-failures') expect(job).not.toHaveProperty('continue-on-error');
    }
  });

  it('limits reporting permissions and checks out workflow code without inference or dependencies', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(reporter.permissions).toEqual({ contents: 'read', actions: 'read', issues: 'write' });
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== 'report-failures') {
        expect(job.permissions?.issues).toBeUndefined();
        expect(job.permissions?.actions).toBeUndefined();
      }
    }
    expect(reporter.steps).toHaveLength(2);
    expect(reporter.steps[0]).toMatchObject({
      uses: expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/),
      with: { ref: '${{ github.sha }}', 'persist-credentials': false },
    });
    expect(reporter.steps[1]).toMatchObject({
      uses: expect.stringMatching(/^actions\/github-script@[a-f0-9]{40}$/),
      env: { SOURCE_SHA: '${{ needs.build.outputs.source_sha }}' },
    });
  });

  it('executes the tested reporter with the pinned source and current run attempt', async () => {
    const invoke = jest.fn().mockResolvedValue(undefined);
    const options = { github: {}, context: {}, core: {} };
    const execute = new Script(`(async (require, github, context, core, process) => {
      ${reporter.steps[1].with?.script}
    })`).runInNewContext();
    await execute((file: string) => {
      expect(file).toBe('./scripts/ci/report-agent-regression-failures.cjs');
      return invoke;
    }, options.github, options.context, options.core, {
      env: { SOURCE_SHA: sourceSha, GITHUB_RUN_ATTEMPT: '3' },
    });
    expect(invoke).toHaveBeenCalledWith({ ...options, sourceSha, runAttempt: 3 });
  });
});
