import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execFileSync } from 'child_process';

const { budget, classify, fetchQueue, formatSummary, inspect, pages } = require('./pr-sous-chef.cjs');
const NOW = Date.parse('2026-10-30T12:00:00Z');
const OLD = '2026-10-30T11:00:00Z';
const HEAD = 'a'.repeat(40);
const repo = 'github/gh-aw-firewall';
const conn = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false } });
const reviewer = (body = 'Fix the edge case', date = OLD) => ({
  author: { login: 'reviewer' }, authorAssociation: 'MEMBER', body,
  createdAt: date, updatedAt: date, url: 'https://github.com/github/gh-aw-firewall/pull/42#discussion_r1',
});
const reply = (body = 'Fixed', date = '2026-10-30T11:10:00Z') => ({
  ...reviewer(body, date), author: { login: 'author' }, authorAssociation: 'NONE',
});
const thread = (id = 'thread-1', comments = [reviewer()]) => ({
  id, isResolved: false, comments: conn(comments),
});
const pr = () => ({
  number: 42, state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'feature',
  baseRefName: 'release/v1', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  author: { login: 'author' }, createdAt: OLD, updatedAt: OLD, labels: conn([{ name: 'sous-chef' }]),
  commits: conn([{ commit: { committedDate: OLD } }]),
  reviewThreads: conn([thread()]),
  reviews: conn([{ ...reviewer(), state: 'COMMENTED', submittedAt: OLD,
    author: { login: 'copilot-pull-request-reviewer' }, commit: { oid: HEAD } }]),
});
const details = () => ({
  ...pr(), comments: [] as ReturnType<typeof recorded>[],
  checks: [{ name: 'unit', status: 'completed', conclusion: 'success', url: 'https://github.com/check/1' }],
  runs: [] as { status: string; name: string; head_sha?: string }[],
});
function recorded(body: string) {
  return { user: { login: 'sous-chef[bot]' }, body, created_at: OLD, updated_at: OLD };
}
const healthy = () => ({
  resources: Object.fromEntries(['core', 'graphql', 'search'].map(name =>
    [name, { limit: 1000, remaining: 900, reset: NOW / 1000 + 100 }])),
});
function apiFixture() {
  return jest.fn(async (args: string[]) => {
    const endpoint = args[1];
    if (endpoint === 'rate_limit') return healthy();
    if (endpoint === 'graphql') return { data: { repository: { pullRequest: pr() } } };
    if (endpoint === `repos/${repo}/pulls/42`) return {
      state: 'open', draft: false, head: { sha: HEAD }, updated_at: OLD, labels: [{ name: 'sous-chef' }],
    };
    if (endpoint.includes('/pulls?')) return [[{ number: 42, draft: false, updated_at: OLD, labels: [{ name: 'sous-chef' }] }]];
    if (endpoint.includes('/comments?') || endpoint.includes('/statuses?')) return [[]];
    if (endpoint.includes('/check-runs?')) return [{ check_runs: [], total_count: 0 }];
    if (endpoint.includes('/actions/runs?')) return [{ workflow_runs: [], total_count: 0 }];
    throw new Error(`Unexpected API read: ${endpoint}`);
  });
}

describe('PR sous-chef deterministic classification', () => {
  it('generates only concrete work and preserves visible deduplication tokens', () => {
    const result = classify(pr(), details(), NOW, 'sous-chef');
    expect(result.status).toBe('implementation_blockers');
    expect(result.body).toContain('@copilot');
    expect(result.body).toContain('discussion_r1');
    expect(result.body).toContain(`Sous-chef head: ${HEAD}`);
    expect(result.body).toMatch(/Sous-chef work: [a-f0-9]{64}/);
    expect(result.body).not.toContain('Fix the edge case');
    expect(result.body).toContain('Do not apply ready-for-aw');
  });

  it.each([
    ['isDraft', true, 'closed_or_draft'],
    ['state', 'CLOSED', 'closed_or_draft'],
    ['author', { login: 'dependabot[bot]' }, 'dependency_bot'],
    ['author', { login: 'app/renovate' }, 'dependency_bot'],
    ['updatedAt', '2026-10-30T11:55:00Z', 'not_idle'],
    ['updatedAt', '2026-10-01T11:00:00Z', 'stale'],
    ['labels', conn([{ name: 'ready-for-aw' }]), 'already_authorized'],
    ['labels', conn([{ name: 'sous-chef-skip' }]), 'opted_out'],
    ['labels', conn([{ name: 'broccoli' }]), 'opted_out'],
  ])('skips %s=%j', (field, value, status) => {
    expect(classify({ ...pr(), [field]: value }, details(), NOW).status).toBe(status);
  });

  it('requires substantive activity despite repeated automation chatter', () => {
    const old = '2026-10-01T11:00:00Z';
    const data = details();
    data.commits = conn([{ commit: { committedDate: old } }]);
    data.reviews = conn([]);
    data.reviewThreads = conn([]);
    data.comments = [recorded('automation chatter')];
    expect(classify({ ...pr(), createdAt: old }, data, NOW, 'sous-chef').status).toBe('stale');
  });

  it.each(['queued', 'in_progress', 'pending', 'requested', 'waiting'])('blocks %s agents indefinitely', status => {
    const data = details();
    data.runs = [{ status, name: 'Copilot coding agent' }];
    expect(classify(pr(), data, NOW).status).toBe('agent_active');
  });

  it('recognizes dynamic agents, reviewer activity, and all running checks', () => {
    expect(classify(pr(), { ...details(), runs: [{ name: 'task', status: 'in_progress', path: 'dynamic/task' }] }, NOW).status).toBe('agent_active');
    expect(classify(pr(), { ...details(), reviews: conn([{ state: 'PENDING' }]) }, NOW).status).toBe('reviewer_active');
    expect(classify(pr(), { ...details(), checks: [{ name: 'unit', status: 'in_progress' }] }, NOW).status).toBe('checks_running');
    expect(classify(pr(), { ...details(), checks: [{ name: 'Copilot reviewer', status: 'queued' }] }, NOW).status).toBe('agent_active');
  });

  it.each(['author', 'copilot-swe-agent[bot]', 'Copilot'])('excludes feedback answered by %s', author => {
    const data = details();
    data.reviewThreads = conn([thread('t', [reviewer(), { ...reply(), author: { login: author } }])]);
    expect(classify(pr(), data, NOW).kind).toBe('handoff');
  });

  it('does not count empty replies and reopens new trusted feedback after a reply', () => {
    const data = details();
    data.reviewThreads = conn([thread('t', [reviewer(), reply('  ')])]);
    expect(classify(pr(), data, NOW).kind).toBe('nudge');
    data.reviewThreads = conn([thread('t', [reviewer(), reply(), reviewer('New issue', '2026-10-30T11:20:00Z')])]);
    expect(classify(pr(), data, NOW).body).toContain('discussion_r1');
    expect(classify(pr(), data, NOW).kind).toBe('nudge');
  });

  it('reopens newly posted trusted feedback even when its wording matches a previous request', () => {
    const data = details();
    const first = classify(pr(), data, NOW, 'sous-chef');
    data.comments = [recorded(first.body)];
    data.reviewThreads = conn([thread('thread-1', [reviewer(), reply(), {
      ...reviewer('Fix the edge case', '2026-10-30T11:20:00Z'),
      url: 'https://github.com/github/gh-aw-firewall/pull/42#discussion_r2',
    }])]);
    const next = classify(pr(), data, NOW, 'sous-chef');
    expect(next.kind).toBe('nudge');
    expect(next.body).toContain('discussion_r2');
    expect(next.fingerprint).not.toBe(first.fingerprint);
  });

  it('ignores resolved and untrusted feedback and stranger replies cannot clear trusted work', () => {
    const data = details();
    data.reviewThreads = conn([{ ...thread(), isResolved: true }]);
    expect(classify(pr(), data, NOW).kind).toBe('handoff');
    data.reviewThreads = conn([thread('t', [{ ...reviewer(), authorAssociation: 'NONE' }])]);
    expect(classify(pr(), data, NOW).kind).toBe('handoff');
    data.reviewThreads = conn([thread('t', [reviewer(), { ...reply(), author: { login: 'stranger' } }])]);
    expect(classify(pr(), data, NOW).kind).toBe('nudge');
  });

  it('excludes recent replies and comments from idle PRs', () => {
    const data = details();
    data.reviewThreads = conn([thread('t', [reviewer(), reply('Fixed', '2026-10-30T11:55:00Z')])]);
    expect(classify(pr(), data, NOW).status).toBe('not_idle');
    data.reviewThreads = conn([thread()]);
    data.comments = [{ ...recorded('chatter'), updated_at: '2026-10-30T11:55:00Z' }];
    expect(classify(pr(), data, NOW).status).toBe('not_idle');
  });

  it('does not repeat unchanged work after chatter, elapsed time, identical reruns or shrinking blockers', () => {
    const data = details();
    data.reviewThreads = conn([thread('one'), thread('two')]);
    data.checks[0].conclusion = 'failure';
    const first = classify(pr(), data, NOW, 'sous-chef');
    data.comments = [recorded(first.body), recorded('unrelated conversation')];
    expect(classify(pr(), data, NOW + 60 * 60_000, 'sous-chef').status).toBe('unchanged');
    data.reviewThreads = conn([thread('one')]);
    data.checks[0].url = 'https://github.com/check/rerun';
    expect(classify(pr(), data, NOW, 'sous-chef').status).toBe('unchanged');
    data.checks[0].conclusion = 'success';
    expect(classify(pr(), data, NOW, 'sous-chef').status).toBe('unchanged');
    data.reviewThreads = conn([thread('one'), thread('new')]);
    const next = classify(pr(), data, NOW, 'sous-chef');
    expect(next.kind).toBe('nudge');
    expect(next.body.match(/Address trusted review feedback/g)).toHaveLength(1);
    expect(classify({ ...pr(), headRefOid: 'b'.repeat(40) }, data, NOW, 'sous-chef').kind).toBe('nudge');
  });

  it('does not trust forged markers from other users', () => {
    const data = details();
    const body = classify(pr(), data, NOW, 'sous-chef').body;
    data.comments = [{ ...recorded(body), user: { login: 'attacker' } }];
    expect(classify(pr(), data, NOW, 'sous-chef').kind).toBe('nudge');
  });

  it('bounds tasks and leaves unrequested work eligible without repeating covered tokens', () => {
    const data = details();
    data.reviewThreads = conn(Array.from({ length: 30 }, (_, index) => thread(`thread-${index}`)));
    const first = classify(pr(), data, NOW, 'sous-chef');
    expect(first.body.match(/Address trusted review feedback/g)).toHaveLength(20);
    data.comments = [recorded(first.body)];
    const next = classify(pr(), data, NOW, 'sous-chef');
    expect(next.body.match(/Address trusted review feedback/g)).toHaveLength(10);
    data.comments.push(recorded(next.body));
    expect(classify(pr(), data, NOW, 'sous-chef').status).toBe('unchanged');
  });

  it.each(['CONFLICTING', 'BEHIND'])('bounds branch nudges and uses the actual base for %s', state => {
    const current = { ...pr(), mergeable: state === 'CONFLICTING' ? state : 'MERGEABLE', mergeStateStatus: state };
    const data = { ...details(), reviewThreads: conn([]) };
    const result = classify(current, data, NOW, 'sous-chef');
    expect(result.body).toContain('"release/v1"');
    expect(result.body).toContain('using a merge commit');
    data.comments = [recorded(result.body)];
    expect(classify(current, data, NOW, 'sous-chef').status).toBe('unchanged');
  });

  it('distinguishes a human label handoff from missing/approval/stale CI, never waking Copilot', () => {
    const data = { ...details(), reviewThreads: conn([]) };
    const ready = classify(pr(), data, NOW, 'sous-chef');
    expect(ready.status).toBe('ready_for_human_label');
    expect(ready.body).not.toContain('@copilot');
    expect(ready.body).toContain('not human review acceptance');
    expect(ready.body).toContain('not merge-ready certification');
    expect(classify(pr(), { ...data, checks: [] }, NOW).status).toBe('needs_human');
    expect(classify(pr(), { ...data, checks: [{ name: 'CI', status: 'completed', conclusion: 'action_required' }] }, NOW).reason).toContain('requires a human');
    expect(classify(pr(), { ...data, runs: [{ name: 'CI', status: 'waiting', head_sha: HEAD }] }, NOW).kind).toBe('handoff');
    expect(classify(pr(), { ...data, reviews: conn([]) }, NOW).status).toBe('needs_human');
    data.comments = [recorded(ready.body)];
    expect(classify(pr(), { ...data, checks: [] }, NOW, 'sous-chef').body).toBeUndefined();
  });

  it.each(['reviewThreads', 'reviews', 'labels'])('fails explicitly on truncated %s', field => {
    const data = details();
    expect(() => classify({ ...pr(), [field]: { nodes: [], pageInfo: { hasNextPage: true } } },
      { ...data, [field]: { nodes: [], pageInfo: { hasNextPage: true } } }, NOW)).toThrow('Incomplete');
  });

  it('fails on incomplete nested comments and invalid timestamps', () => {
    const data = details();
    data.reviewThreads.nodes[0].comments.pageInfo.hasNextPage = true;
    expect(() => classify(pr(), data, NOW)).toThrow('Incomplete thread comments');
    expect(() => classify({ ...pr(), updatedAt: 'garbage' }, details(), NOW)).toThrow('Invalid timestamp');
  });
});

describe('PR sous-chef reads, configuration and queue gates', () => {
  it('builds a dry-run preview without authorizing agent startup', async () => {
    const result = await fetchQueue({ repo, now: NOW }, apiFixture());
    expect(result.prs).toHaveLength(1);
    expect(result.mode).toBe('dry-run');
    expect(formatSummary(result)).toContain('Read-only preview; no agent or comments.');
  });

  it('requires a real configured writer with no auth fallback', async () => {
    await expect(fetchQueue({ repo, now: NOW, mode: 'pilot' }, apiFixture())).rejects.toThrow('no GITHUB_TOKEN fallback');
    await expect(fetchQueue({ repo, now: NOW, mode: 'pilot', writer: 'writer' }, apiFixture())).rejects.toThrow('requires');
    await expect(fetchQueue({ repo, now: NOW, mode: 'on' }, apiFixture())).rejects.toThrow('dry-run or pilot');
    await expect(fetchQueue({ repo: '../repo', now: NOW }, apiFixture())).rejects.toThrow('owner/repo');
  });

  it('scopes explicit requests but never bypasses the pilot label', async () => {
    const api = apiFixture();
    api.mockImplementationOnce(async () => healthy()).mockImplementationOnce(async () => healthy())
      .mockImplementationOnce(async () => ({ data: { repository: { pullRequest: { ...pr(), labels: conn([]) } } } }));
    const result = await fetchQueue({ repo, number: 42, now: NOW }, api);
    expect(result.prs).toEqual([]);
    expect(result.statuses[0].status).toBe('outside_pilot');
    expect(api.mock.calls.some(([args]) => args[1].includes('/pulls?'))).toBe(false);
  });

  it.each(['core', 'graphql', 'search'])('skips the whole queue at low %s budgets', async name => {
    const response = healthy();
    response.resources[name].remaining = 100;
    const api = jest.fn(async () => response);
    const result = await fetchQueue({ repo, now: NOW }, api);
    expect(result.prs).toEqual([]);
    expect(result.rate_limit.low).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(formatSummary(result)).toContain('API budget low');
  });

  it('rejects malformed budgets, GraphQL errors and incomplete reads instead of succeeding', async () => {
    await expect(budget(async () => ({}))).rejects.toThrow('Invalid core');
    await expect(fetchQueue({ repo, now: NOW }, async () => { throw new Error('HTTP 401 Bad credentials'); })).rejects.toThrow('401');
    await expect(inspect(repo, 42, async () => ({ errors: [{ message: 'denied' }] }), NOW, '', true)).rejects.toThrow('GraphQL read failed');
    await expect(inspect(repo, 42, async () => ({ data: {} }), NOW, '', true)).rejects.toThrow('Incomplete PR');
    await expect(pages(async () => [{ workflow_runs: [], total_count: 101 }], '/runs', 'workflow_runs')).rejects.toThrow('Truncated');
    await expect(pages(async () => [], '/comments')).rejects.toThrow('Incomplete');
    expect(await pages(async () => [[1], [2]], '/comments')).toEqual([1, 2]);
  });

  it('refreshes current HEAD and labels after collecting details before proposing a write', async () => {
    const api = apiFixture();
    const base = api.getMockImplementation()!;
    api.mockImplementation(async args => args[1] === `repos/${repo}/pulls/42`
      ? { state: 'open', draft: false, head: { sha: 'b'.repeat(40) }, updated_at: OLD, labels: [{ name: 'sous-chef' }] }
      : base(args));
    const result = await fetchQueue({ repo, number: 42, now: NOW }, api);
    expect(result.prs).toEqual([]);
    expect(result.statuses[0].status).toBe('changed_during_refresh');
  });

  it('limits detailed reads to 20 and comments to 2 with honest deferred counts', async () => {
    const api = apiFixture();
    const base = api.getMockImplementation()!;
    api.mockImplementation(async args => {
      if (args[1].includes('/pulls?')) return [Array.from({ length: 25 }, (_, index) =>
        ({ number: index + 1, draft: false, updated_at: OLD, labels: [{ name: 'sous-chef' }] }))];
      if (args[1] === 'graphql') {
        const number = Number(args[args.length - 1].split('=')[1]);
        return { data: { repository: { pullRequest: { ...pr(), number } } } };
      }
      if (/\/pulls\/\d+$/.test(args[1])) return { state: 'open', draft: false, head: { sha: HEAD }, updated_at: OLD, labels: [{ name: 'sous-chef' }] };
      if (args[1].includes('/comments?')) return [[]];
      return base(args);
    });
    const result = await fetchQueue({ repo, now: NOW }, api);
    expect(result.statuses).toHaveLength(20);
    expect(result.prs).toHaveLength(2);
    expect(result.deferred).toBe(23);
  });

  it('provides a runnable dependency-free CLI and rejects malformed scope', () => {
    expect(() => execFileSync(process.execPath, [path.join(__dirname, 'pr-sous-chef.cjs'), '42;echo unsafe'], { stdio: 'pipe' })).toThrow();
  });
});

describe('PR sous-chef workflow safety contract', () => {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, '.github/workflows/pr-sous-chef.md'), 'utf8');
  const config = yaml.load(source.split('---')[1]) as {
    on: { schedule: string };
    permissions: Record<string, string>;
    'safe-outputs': Record<string, unknown>;
    if: string;
    checkout: { ref: string };
    jobs: { prefilter: { if: string } };
    env: { PR_SOUS_CHEF_MODE: string };
  };

  it('keeps the coordinator read-only with one bounded comment-only write path', () => {
    expect(config.on.schedule).toBe('every 15m');
    expect(config.permissions).toEqual({ contents: 'read', issues: 'read', 'pull-requests': 'read', actions: 'read', 'copilot-requests': 'write' });
    expect(config['safe-outputs']['add-comment']).toEqual({
      max: 2, target: '*', 'required-labels': ['sous-chef'], discussions: false, issues: false,
      'github-token': '${{ secrets.PR_SOUS_CHEF_WRITER_TOKEN }}',
    });
    expect(config['safe-outputs']['github-token']).toBeUndefined();
    expect(Object.keys(config['safe-outputs']).sort()).toEqual([
      'add-comment', 'mentions', 'needs', 'noop', 'report-incomplete', 'report-missing-data', 'report-missing-tool',
    ]);
    expect(config.if).toBe('needs.prefilter.outputs.eligible_count > 0');
    expect(config.checkout.ref).toBe('${{ github.event.repository.default_branch }}');
    expect(config.jobs.prefilter.if).toContain('github.event.repository.default_branch');
    expect(config.env.PR_SOUS_CHEF_MODE).toContain("'dry-run'");
    expect(source).not.toContain('secrets.PR_SOUS_CHEF_WRITER_TOKEN ||');
  });

  it('requires exact freshly generated bodies and a human authorization boundary', () => {
    expect(source).toContain('copy the refreshed entry\'s `body` **exactly**');
    expect(source).toContain('report_incomplete');
    expect(source).toContain('Immediately before each comment');
    const skill = fs.readFileSync(path.join(root, '.github/skills/pr-finisher/SKILL.md'), 'utf8');
    expect(skill).toContain('Ready-for-aw preparation mode');
    expect(skill).toContain('containers/api-proxy');
    expect(skill).toContain('Docker/KVM/runner-only limitations');
  });

  it('compiles to no AI on empty queues, release AWF and a secret-free agent sandbox', () => {
    const lock = fs.readFileSync(path.join(root, '.github/workflows/pr-sous-chef.lock.yml'), 'utf8');
    const compiled = yaml.load(lock) as { jobs: Record<string, {
      if: string; permissions: Record<string, string>;
      steps: { name: string; env?: Record<string, string>; run?: string }[];
    }> };
    const agent = compiled.jobs.agent;
    expect(agent.if).toContain('needs.prefilter.outputs.eligible_count > 0');
    expect(agent.permissions['pull-requests']).toBe('read');
    expect(lock).not.toContain('--build-local');
    expect(lock).not.toContain('Build local AWF');
    expect(lock).toContain('install_awf_binary.sh" v0.29.0');
    const configStep = agent.steps.find(step => step.name === 'Generate Safe Outputs Config')!;
    expect(configStep.env!.GH_AW_SAFE_OUTPUTS_CONFIG).not.toContain('${{ secrets.');
    const modelSteps = agent.steps.filter(step => step.run?.includes('copilot_harness') || step.run?.includes('copilot --'));
    expect(modelSteps.length).toBeGreaterThan(0);
    for (const step of modelSteps) expect(JSON.stringify(step)).not.toContain('secrets.PR_SOUS_CHEF_WRITER_TOKEN');
    expect(agent.steps.find(step => step.env?.GH_TOKEN === '${{ secrets.PR_SOUS_CHEF_WRITER_TOKEN }}')).toBeUndefined();
    expect(lock).not.toContain('"create_report_incomplete_issue"');
  });
});
