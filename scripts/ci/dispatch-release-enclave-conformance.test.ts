import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const { REQUIRED_ASSETS, dispatchReleaseConformance } = require('./dispatch-release-enclave-conformance');
const source = 'a'.repeat(40);
const commit = 'b'.repeat(40);
const tag = 'v0.28.69';
const repository = 'github/gh-aw-firewall';
const endpoint = `repos/${repository}/actions/workflows/test-cloud-hypervisor-enclaves.yml`;

function fixture() {
  const environment = {
    GITHUB_REPOSITORY: repository,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_TYPE: 'branch',
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/heads/main`,
    GITHUB_SHA: source,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    AWF_RELEASE_TAG: tag,
  };
  const git = jest.fn((...args: string[]) => {
    const command = args.join(' ');
    if (command === 'rev-parse HEAD' || command === `rev-parse refs/tags/${tag}^`) return source;
    if (command === `rev-parse refs/tags/${tag}^{commit}`) return commit;
    if (command === `show refs/tags/${tag}:package.json`) return JSON.stringify({ version: tag.slice(1) });
    if (command === `show refs/tags/${tag}:src/cloud-hypervisor/artifact-compatibility.json`) {
      return JSON.stringify({ releaseTag: tag });
    }
    throw new Error(`Unexpected git command: ${command}`);
  });
  const release = { id: 456, tag_name: tag, draft: false, published_at: '2026-10-20T00:00:00Z' };
  const assets = REQUIRED_ASSETS.map((name: string) => ({ name, state: 'uploaded', size: 100 }));
  const runs = { total_count: 0, workflow_runs: [] as unknown[] };
  const jobs: unknown[] = [];
  const api = jest.fn((method: string, url: string, _body?: unknown): unknown => {
    if (method === 'GET' && url === `repos/${repository}/releases/tags/${tag}`) return release;
    if (method === 'GET' && url.startsWith(`repos/${repository}/releases/456/assets?`)) return assets;
    if (method === 'GET' && url.startsWith(`${endpoint}/runs?`)) return runs;
    if (method === 'GET' && url.includes('/jobs?')) return { jobs };
    if (method === 'POST' && url === `${endpoint}/dispatches`) return undefined;
    throw new Error(`Unexpected API command: ${method} ${url}`);
  });
  return { environment, git, api, release, assets, runs, jobs };
}

describe('release enclave conformance handoff', () => {
  it('dispatches only the fixed native workflow on the exact release tag with all gates and full source SHA', () => {
    const f = fixture();
    expect(dispatchReleaseConformance(f.environment, f)).toEqual({ tag, source, commit });
    expect(f.api.mock.calls.filter(call => call[0] === 'POST')).toEqual([[
      'POST', `${endpoint}/dispatches`, {
        ref: tag,
        inputs: {
          run_host_probes: 'true', run_live_kvm: 'true', run_environment_probe: 'true',
          acceptance_commit: source,
        },
      },
    ]]);
    expect(f.api.mock.calls.slice(-2)[0]).toEqual([
      'GET', `${endpoint}/runs?event=workflow_dispatch&head_sha=${commit}&per_page=1`,
    ]);
    expect(f.git).toHaveBeenCalledWith('rev-parse', `refs/tags/${tag}^`);
  });

  it.each([
    ['GITHUB_REPOSITORY', 'attacker/fork'],
    ['GITHUB_EVENT_NAME', 'release'],
    ['GITHUB_REF_TYPE', 'tag'],
    ['GITHUB_WORKFLOW_REF', `${repository}/.github/workflows/other.yml@refs/heads/main`],
    ['GITHUB_SHA', 'main'],
    ['GITHUB_RUN_ID', '../123'],
    ['GITHUB_RUN_ATTEMPT', '0'],
    ['AWF_RELEASE_TAG', 'latest'],
    ['AWF_RELEASE_TAG', 'v1.2.3;echo unsafe'],
  ])('rejects invalid %s before git or API access', (key, value) => {
    const f = fixture();
    expect(() => dispatchReleaseConformance({ ...f.environment, [key]: value }, f)).toThrow();
    expect(f.git).not.toHaveBeenCalled();
    expect(f.api).not.toHaveBeenCalled();
  });

  it.each([
    [`rev-parse refs/tags/${tag}^`, 'c'.repeat(40)],
    ['rev-parse HEAD', 'c'.repeat(40)],
    [`rev-parse refs/tags/${tag}^{commit}`, 'main'],
    [`show refs/tags/${tag}:package.json`, '{"version":"0.0.0"}'],
    [`show refs/tags/${tag}:src/cloud-hypervisor/artifact-compatibility.json`, '{"releaseTag":"v0.0.0"}'],
  ])('rejects mismatched release source/package identity: %s', (command, value) => {
    const f = fixture();
    const original = f.git.getMockImplementation()!;
    f.git.mockImplementation((...args: string[]) => args.join(' ') === command ? value : original(...args));
    expect(() => dispatchReleaseConformance(f.environment, f)).toThrow();
    expect(f.api).not.toHaveBeenCalled();
  });

  it.each(['draft', 'wrong-tag', 'unpublished', 'missing', 'uploading', 'empty', 'duplicate'])(
    'refuses %s release/assets before submission', failure => {
      const f = fixture();
      if (failure === 'draft') f.release.draft = true;
      if (failure === 'wrong-tag') f.release.tag_name = 'v0.0.0';
      if (failure === 'unpublished') f.release.published_at = '';
      if (failure === 'missing') f.assets.pop();
      if (failure === 'uploading') f.assets[0].state = 'new';
      if (failure === 'empty') f.assets[0].size = 0;
      if (failure === 'duplicate') f.assets.push({ ...f.assets[0] });
      expect(() => dispatchReleaseConformance(f.environment, f)).toThrow();
      expect(f.api.mock.calls.some(call => call[0] === 'POST')).toBe(false);
    },
  );

  it('reads all release asset pages before deciding readiness', () => {
    const f = fixture();
    const original = f.api.getMockImplementation()!;
    f.api.mockImplementation((method, url, body) => {
      if (url.includes('/assets?') && url.endsWith('page=1')) {
        return Array.from({ length: 100 }, (_, i) => ({ name: `unrelated-${i}` }));
      }
      return original(method, url, body);
    });
    dispatchReleaseConformance(f.environment, f);
    expect(f.api).toHaveBeenCalledWith('GET', `repos/${repository}/releases/456/assets?per_page=100&page=2`);
  });

  it.each([0, 1])('rejects existing or inconsistent downstream run evidence (%s)', count => {
    const f = fixture();
    f.runs.total_count = count;
    f.runs.workflow_runs.push({ id: 789 });
    expect(() => dispatchReleaseConformance(f.environment, f)).toThrow(/already exists/);
    expect(f.api.mock.calls.some(call => call[0] === 'POST')).toBe(false);
  });

  it('allows first publication on a rerun when earlier dispatch steps were skipped', () => {
    const f = fixture();
    f.environment.GITHUB_RUN_ATTEMPT = '2';
    f.jobs.push({
      name: `Dispatch full release enclave conformance (${tag})`, run_attempt: 1,
      steps: [{ name: 'Dispatch exact published tag once', conclusion: 'skipped' }],
    });
    dispatchReleaseConformance(f.environment, f);
    expect(f.api.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(1);
  });

  it.each(['success', 'failure', 'cancelled', null])(
    'rejects a prior reached dispatch step (%s), even before its run becomes visible', conclusion => {
      const f = fixture();
      f.environment.GITHUB_RUN_ATTEMPT = '2';
      f.jobs.push({
        name: `Dispatch full release enclave conformance (${tag})`, run_attempt: 1,
        steps: [{ name: 'Dispatch exact published tag once', conclusion }],
      });
      expect(() => dispatchReleaseConformance(f.environment, f)).toThrow(/prior attempt/);
      expect(f.api.mock.calls.some(call => call[0] === 'POST')).toBe(false);
    },
  );

  it('checks all historical job pages and binds evidence to this tag and prior attempts', () => {
    const f = fixture();
    f.environment.GITHUB_RUN_ATTEMPT = '3';
    const name = `Dispatch full release enclave conformance (${tag})`;
    f.jobs.push({ name, run_attempt: 1, steps: [{ name: 'Dispatch exact published tag once', conclusion: 'failure' }] });
    const original = f.api.getMockImplementation()!;
    f.api.mockImplementation((method, url, body) => {
      if (url.includes('/jobs?') && url.endsWith('page=1')) {
        return { jobs: Array.from({ length: 100 }, (_, i) => ({
          name: i === 0 ? name : 'another tag', run_attempt: 3,
          steps: [{ name: 'Dispatch exact published tag once', conclusion: null }],
        })) };
      }
      return original(method, url, body);
    });
    expect(() => dispatchReleaseConformance(f.environment, f)).toThrow(/prior attempt/);
    expect(f.api).toHaveBeenCalledWith('GET',
      `repos/${repository}/actions/runs/123/jobs?filter=all&per_page=100&page=2`);
  });

  it.each(['metadata', 'history', 'POST'])('surfaces %s API failures without retries', failure => {
    const f = fixture();
    f.environment.GITHUB_RUN_ATTEMPT = '2';
    const original = f.api.getMockImplementation()!;
    f.api.mockImplementation((method, url, body) => {
      if ((failure === 'metadata' && url.includes('/releases/tags/')) ||
          (failure === 'history' && url.includes('/jobs?')) ||
          (failure === 'POST' && method === 'POST')) throw new Error('transport failure');
      return original(method, url, body);
    });
    expect(() => dispatchReleaseConformance(f.environment, f)).toThrow('transport failure');
    expect(f.api.mock.calls.filter(call => call[0] === 'POST')).toHaveLength(failure === 'POST' ? 1 : 0);
  });
});

interface Workflow {
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, {
    name?: string;
    needs?: string | string[];
    permissions?: Record<string, string>;
    'timeout-minutes'?: number;
    if?: string;
    steps: Array<{ name: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }>;
  }>;
}

describe('release publication DAG and permissions', () => {
  const workflow = yaml.load(fs.readFileSync(
    path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8',
  )) as Workflow;

  it('waits for release publication/uploads and all signed artifact producers', () => {
    const job = workflow.jobs['enclave-conformance'];
    expect(job.needs).toEqual(['bump-version', 'release']);
    expect(job.if).toBeUndefined();
    expect(workflow.jobs.release.needs).toEqual(expect.arrayContaining([
      'build-cloud-hypervisor-test-artifacts', 'build-cloud-hypervisor-profiles',
      'build-cloud-hypervisor-guest-base', 'build-enclaves',
    ]));
    const publish = workflow.jobs.release.steps.find(step => step.name === 'Create GitHub Release')!;
    expect(publish.with?.draft).toBe(false);
    expect(publish.with?.tag_name).toBe('${{ needs.bump-version.outputs.version }}');
    for (const name of REQUIRED_ASSETS) expect(publish.with?.files).toContain(`release/${name}\n`);
    expect(workflow.jobs['build-cloud-hypervisor-test-artifacts'].steps.some(step =>
      step.uses?.startsWith('actions/attest-build-provenance@'))).toBe(true);
  });

  it('uses only a job-local dispatch token and pinned original source, with serialized launchers', () => {
    const job = workflow.jobs['enclave-conformance'];
    expect(job.name).toBe('Dispatch full release enclave conformance (${{ needs.bump-version.outputs.version }})');
    expect(job.permissions).toEqual({ contents: 'read', actions: 'write' });
    expect(job['timeout-minutes']).toBe(5);
    expect(job.steps[0].with).toEqual({
      ref: '${{ github.sha }}', 'fetch-depth': 0, 'fetch-tags': true, 'persist-credentials': false,
    });
    const dispatch = job.steps.find(step => step.name === 'Dispatch exact published tag once')!;
    expect(dispatch.env).toEqual({
      GH_TOKEN: '${{ github.token }}', AWF_RELEASE_TAG: '${{ needs.bump-version.outputs.version }}',
    });
    expect(dispatch.run).toBe('node scripts/ci/dispatch-release-enclave-conformance.js');
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|sudo|npm ci|workflow_dispatch:/);
    expect(workflow.concurrency).toEqual({ group: 'release', 'cancel-in-progress': false });
  });
});
