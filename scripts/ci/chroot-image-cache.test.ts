import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/test-chroot.yml'), 'utf8')) as {
  permissions: Record<string, string>;
  jobs: Record<string, { 'timeout-minutes': number; steps: Step[]; strategy?: unknown }>;
};
const action = yaml.load(fs.readFileSync(path.join(root, '.github/actions/build-chroot-images/action.yml'), 'utf8')) as {
  runs: { using: string; steps: Step[] };
};

test('smoke chroot pre-agent cleanup preserves workflow prompts and test results', () => {
  const source = fs.readFileSync(path.join(root, '.github/workflows/smoke-chroot.md'), 'utf8');
  const smoke = yaml.load(source.split('---')[1]) as { steps: Step[] };
  const cleanup = smoke.steps.find(step => step.name === 'Cleanup test containers')!.run!;
  expect(cleanup).not.toContain('scripts/ci/cleanup.sh');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-chroot-cleanup-'));
  try {
    const evidence = ['prompt.txt', 'user.txt', 'results.env'];
    for (const file of evidence) fs.writeFileSync(path.join(temp, file), 'preserved');
    const result = spawnSync('/bin/bash', ['-euc', `docker() { printf '%s\\n' "$*"; }\n${cleanup}`], {
      cwd: temp,
      encoding: 'utf8',
      env: { PATH: temp },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('rm -f awf-squid awf-agent');
    expect(result.stdout).toContain('network rm awf-net');
    for (const file of evidence) expect(fs.readFileSync(path.join(temp, file), 'utf8')).toBe('preserved');
    const lock = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/smoke-chroot.lock.yml'), 'utf8')) as {
      jobs: { agent: { steps: Step[] } };
    };
    expect(lock.jobs.agent.steps.find(step => step.name === 'Cleanup test containers')!.run).toBe(cleanup);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

describe('chroot cached image wiring', () => {
  it('keeps every job, suite, timeout and cleanup while using the shared cache builder', () => {
    const expected = [
      ['test-chroot-browser', 'chroot-browser', 30],
      ['test-chroot-languages', 'chroot-languages', 30],
      ['test-chroot-package-managers', 'chroot-package-managers', 45],
      ['test-chroot-procfs', 'chroot-procfs', 30],
      ['test-chroot-edge-cases', 'chroot-edge-cases', 30],
    ] as const;
    expect(Object.keys(workflow.jobs)).toEqual(expected.map(([name]) => name));
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const [name, suite, minutes] of expected) {
      const job = workflow.jobs[name];
      expect(job['timeout-minutes']).toBe(minutes);
      const configure = job.steps.findIndex(step => step.name === 'Configure Docker Hub cache');
      const build = job.steps.findIndex(step => step.name === 'Build local containers');
      const test = job.steps.findIndex(step => step.run?.includes(`--testPathPatterns=${suite}`)
        || step.run?.includes(`--testPathPatterns="${suite}"`));
      expect(configure).toBeGreaterThan(0);
      expect(job.steps[configure].env).toEqual({ AWF_DOCKER_CONTAINERD_SNAPSHOTTER: 'true' });
      expect(configure).toBeLessThan(build);
      expect(build).toBeLessThan(test);
      expect(job.steps[build].uses).toBe('./.github/actions/build-chroot-images');
      expect(job.steps.some(step => step.name === 'Post-test cleanup')).toBe(true);
      expect(job.steps.some(step => step.run?.includes('docker build'))).toBe(false);
    }
    const browser = workflow.jobs['test-chroot-browser'];
    expect(browser.strategy).toEqual({
      'fail-fast': false, matrix: { os: ['ubuntu-22.04', 'ubuntu-24.04'] },
    });
    expect(browser.steps.find(step => step.name === 'Build local containers')?.with)
      .toEqual({ browser: 'true', 'runner-variant': '${{ matrix.os }}' });
  });

  it('uses the pinned Docker driver and masks cache credentials before export', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps[0].uses)
      .toBe('docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069');
    expect(action.runs.steps[0].with?.driver).toBe('docker');
    const runtime = action.runs.steps[1];
    expect(runtime.uses).toBe('actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3');
    expect(runtime.with?.script).toContain('core.setSecret(value)');
    expect(runtime.with?.script).toContain('throw new Error');
    expect(runtime.with?.script?.indexOf('core.setSecret(value)'))
      .toBeLessThan(runtime.with!.script.indexOf('core.exportVariable(name, value)'));
    expect(action.runs.steps[2].env?.CHROOT_CACHE_VARIANT)
      .toBe('${{ github.job }}-${{ inputs.runner-variant }}-${{ runner.arch }}');
  });
});

describe('cached chroot image builder', () => {
  let temp: string;
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-chroot-cache-'));
    fs.writeFileSync(path.join(temp, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TRACE"
if [[ "$*" == "buildx build"* && "$*" == *"/agent:latest"* && "\${FAILURE:-}" == build ]]; then exit 17; fi
if [[ "$*" == "image inspect"* && "\${FAILURE:-}" == inspect ]]; then exit 18; fi
if [[ "$*" == "builder prune"* && "\${FAILURE:-}" == prune ]]; then exit 19; fi
`, { mode: 0o755 });
    fs.writeFileSync(path.join(temp, 'date'), `#!/usr/bin/env bash
[[ "$*" == "-u +%F" ]] || exit 99
printf '%s\\n' "$FIXTURE_DAY"
`, { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  function run(extra: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [path.join(root, 'scripts/ci/build-chroot-images.sh')], {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${temp}${path.delimiter}${process.env.PATH}`,
        TRACE: path.join(temp, 'trace'),
        FIXTURE_DAY: '2026-11-04',
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Linux',
        ACTIONS_RUNTIME_TOKEN: 'fixture-token',
        ACTIONS_RESULTS_URL: 'https://cache.example/',
        CHROOT_CACHE_VARIANT: 'test-chroot-languages-ubuntu-latest-X64',
        CHROOT_BROWSER: 'false',
        ...extra,
      },
    });
  }
  function trace() {
    return fs.readFileSync(path.join(temp, 'trace'), 'utf8').trim().split('\n');
  }

  it.each(['2026-11-04', '2026-11-05'])('imports only %s layers and retains exact local tags', day => {
    const result = run({ FIXTURE_DAY: day });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('fixture-token');
    const calls = trace();
    expect(calls).toHaveLength(6);
    ['squid', 'agent'].forEach((image, index) => {
      const scope = `chroot-v1-test-chroot-languages-ubuntu-latest-X64-${image}-${day}`;
      expect(calls[index * 3]).toBe(
        'buildx build --load --pull --progress=plain '
        + `--cache-from type=gha,version=2,scope=${scope} `
        + `--cache-to type=gha,version=2,mode=max,scope=${scope} `
        + `--tag ghcr.io/github/gh-aw-firewall/${image}:latest containers/${image}/`,
      );
      expect(calls[index * 3 + 1]).toBe(`image inspect ghcr.io/github/gh-aw-firewall/${image}:latest`);
      expect(calls[index * 3 + 2]).toBe('builder prune --all --force');
    });
    expect(calls.join('\n')).not.toMatch(/image rm|image prune|system prune|ignore-error/);
  });

  it('includes the browser API proxy but no other unrelated images', () => {
    expect(run({ CHROOT_BROWSER: 'true' }).status).toBe(0);
    expect(trace().filter(call => call.startsWith('buildx build'))).toHaveLength(3);
    expect(trace()[7]).toBe('image inspect ghcr.io/github/gh-aw-firewall/api-proxy:latest');
  });

  it.each([
    ['build', 17], ['inspect', 18], ['prune', 19],
  ])('propagates %s failures instead of running tests on incomplete images', (failure, code) => {
    const result = run({ FAILURE: String(failure), CHROOT_BROWSER: 'true' });
    expect(result.status).toBe(code);
    const calls = trace();
    expect(calls.join('\n')).not.toContain('api-proxy');
    if (failure === 'build') {
      expect(result.stderr).toContain('::error::Chroot image build/cache export/inspection failed for agent');
      expect(calls.slice(-2)).toEqual([
        'image rm --force ghcr.io/github/gh-aw-firewall/agent:latest', 'builder prune --all --force',
      ]);
    }
    if (failure === 'inspect') {
      expect(calls.slice(-2)).toEqual([
        'image rm --force ghcr.io/github/gh-aw-firewall/squid:latest', 'builder prune --all --force',
      ]);
    }
  });

  it.each([
    { GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_OS: 'macOS' },
    { ACTIONS_RUNTIME_TOKEN: '' }, { ACTIONS_RESULTS_URL: '' }, { CHROOT_CACHE_VARIANT: '' },
    { CHROOT_CACHE_VARIANT: 'bad,scope=oops' }, { CHROOT_BROWSER: 'maybe' },
  ])('fails before Docker on unsupported environment %j', extra => {
    expect(run(extra).status).not.toBe(0);
    expect(fs.existsSync(path.join(temp, 'trace'))).toBe(false);
  });
});
