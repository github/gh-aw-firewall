import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');

interface Step {
  name: string;
  uses?: string;
  run?: string;
  shell?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string | number>;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, {
    name: string;
    if: string;
    needs?: unknown;
    'runs-on': string;
    'timeout-minutes': number;
    steps: Step[];
  }>;
}

const workflow = yaml.load(fs.readFileSync(
  path.join(root, '.github/workflows/test-integration-suite.yml'), 'utf8',
)) as Workflow;
const originalPatterns: Record<string, string> = {
  'test-domain': '(blocked-domains|dns-servers|empty-domains|wildcard-patterns|no-docker|skip-pull|sudo-secure-path|git-operations)',
  'test-network': '(host-tcp-services|ipv6|localhost-access|network-security|topology-compose)',
  'test-protocol-security': '(protocol-support|credential-hiding|one-shot-tokens|token-unset)',
  'test-container-ops': '(compose-environment|container-workdir|environment-variables|error-handling|exit-code-propagation|filesystem-allowwrite|log-commands)',
  'test-api-proxy': '(api-proxy|volume-mounts)',
};

function step(job: string, name: string): Step {
  const found = workflow.jobs[job].steps.find(entry => entry.name === name);
  if (!found) throw new Error(`Missing ${job} step: ${name}`);
  return found;
}

describe('integration suite workflow', () => {
  it('preserves triggers, read-only permissions, parallel test jobs, and check names', () => {
    expect(workflow.on).toEqual({
      push: { branches: ['main'] },
      pull_request: { branches: ['main'], types: ['labeled'] },
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['build-images', ...Object.keys(originalPatterns)]);
    expect(Object.keys(originalPatterns).map(job => workflow.jobs[job].name)).toEqual([
      'Domain Tests', 'Network Tests', 'Protocol & Security Tests',
      'Container & Ops Tests', 'API Proxy Tests',
    ]);
    expect(workflow.jobs['build-images'].needs).toBeUndefined();
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (id !== 'build-images') {
        expect(job.needs).toBe('build-images');
        expect(job.if).toBe(
          "always() && (github.event_name != 'pull_request' || github.event.label.name == 'ready-for-aw')",
        );
        const failure = step(id, 'Fail if integration images were not built');
        expect(failure.if).toBe("always() && needs.build-images.result != 'success'");
        expect(failure.run).toContain('exit 1');
        expect(job.steps.indexOf(failure)).toBe(0);
      } else {
        expect(job.if).toBe("github.event_name != 'pull_request' || github.event.label.name == 'ready-for-aw'");
      }
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job['timeout-minutes']).toBe(45);
    }
  });

  it('configures authenticated Buildx once and only exports cache on main pushes', () => {
    const job = 'build-images';
    const steps = workflow.jobs[job].steps;
    const setup = step(job, 'Set up Docker Buildx');
    expect(setup.uses).toBe('docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069');
    const runtime = step(job, 'Expose GitHub Actions cache runtime for Buildx CLI');
    expect(runtime.uses).toBe('actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3');
    expect(runtime.with?.script).toContain("['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL']");
    expect(runtime.with?.script).toContain('core.setSecret(value)');
    expect(runtime.with?.script).toContain('core.exportVariable(name, value)');
    const build = step(job, 'Build local containers');
    expect(steps.indexOf(setup)).toBeLessThan(steps.indexOf(runtime));
    expect(steps.indexOf(runtime)).toBeLessThan(steps.indexOf(build));
    expect(build.env?.EXPORT_BUILD_CACHE).toBe(
      "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
    );
    expect(Object.values(workflow.jobs).flatMap(entry => entry.steps)
      .filter(entry => entry.run?.includes('docker buildx build'))).toEqual([build]);
  });

  it('saves all shared source-built tags in a single short-lived, already-compressed artifact', () => {
    const steps = workflow.jobs['build-images'].steps;
    const save = step('build-images', 'Save integration images');
    const upload = step('build-images', 'Upload integration images');
    expect(steps.indexOf(step('build-images', 'Build local containers'))).toBeLessThan(steps.indexOf(save));
    expect(steps.indexOf(save)).toBeLessThan(steps.indexOf(upload));
    expect(save.run).toContain(
      'docker save ghcr.io/github/gh-aw-firewall/squid:latest \\\n' +
      '  ghcr.io/github/gh-aw-firewall/agent:latest \\\n' +
      '  ghcr.io/github/gh-aw-firewall/api-proxy:latest',
    );
    expect(save.shell).toBe('bash');
    expect(save.run).toContain('gzip -1');
    expect(save.run).toContain('test -s "$RUNNER_TEMP/integration-images/images.tar.gz"');
    expect(save.run).toContain('Compressed bytes:');
    expect(upload.uses).toBe('actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
    expect(upload.with).toEqual({
      name: 'integration-images',
      path: '${{ runner.temp }}/integration-images/images.tar.gz',
      'compression-level': 0,
      'retention-days': 1,
      'if-no-files-found': 'error',
    });
  });

  it.each(Object.keys(originalPatterns))('%s loads shared images and retains cleanup, logs, and timings', job => {
    const steps = workflow.jobs[job].steps;
    expect(steps.some(entry => entry.name === 'Set up Docker Buildx')).toBe(false);
    expect(steps.some(entry => entry.name === 'Expose GitHub Actions cache runtime for Buildx CLI')).toBe(false);
    const download = step(job, 'Download integration images');
    const load = step(job, 'Load integration images');
    expect(download.uses).toBe('actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333');
    expect(download.with).toEqual({
      name: 'integration-images', path: '${{ runner.temp }}/integration-images',
    });
    expect(steps.indexOf(download)).toBeLessThan(steps.indexOf(load));
    expect(load.shell).toBe('bash');
    expect(load.run).toContain('gunzip -c "$RUNNER_TEMP/integration-images/images.tar.gz" | docker load');
    expect(load.run).toContain(
      'docker image inspect ghcr.io/github/gh-aw-firewall/squid:latest ' +
      'ghcr.io/github/gh-aw-firewall/agent:latest ghcr.io/github/gh-aw-firewall/api-proxy:latest',
    );
    expect(load.run).toContain('docker images');
    expect(steps.indexOf(load)).toBeLessThan(steps.indexOf(step(job, 'Pre-test cleanup')));
    const test = steps.find(entry => entry.run?.includes('--testPathPatterns'))!;
    const timings = step(job, 'Upload Jest timings');
    const output = `/tmp/awf-jest-${job.replace(/^test-/, '')}.json`;
    expect(test.run).toContain(`--json --outputFile=${output}`);
    expect(test.run).toContain(`--testPathPatterns="${originalPatterns[job]}"`);
    expect(test.env?.JEST_TIMEOUT).toBe(180000);
    expect(timings.if).toBe('always()');
    expect(timings.uses).toBe('actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9');
    expect(timings.with).toEqual({
      name: `jest-timings-${job.replace(/^test-/, '')}`, path: output, 'retention-days': 7,
    });
    expect(steps.indexOf(test)).toBeLessThan(steps.indexOf(timings));
    expect(steps.indexOf(timings)).toBeLessThan(steps.indexOf(step(job, 'Post-test cleanup')));
    expect(step(job, 'Post-test cleanup').if).toBe('always()');
    expect(step(job, 'Collect logs on failure').if).toBe('failure()');
    expect(step(job, 'Collect logs on failure').run).toContain('docker logs awf-squid');
    expect(step(job, 'Collect logs on failure').run).toContain('docker logs awf-agent');
  });

  it('keeps every previously selected test file in exactly one job', () => {
    const files = fs.readdirSync(path.join(root, 'tests/integration'))
      .filter(file => file.endsWith('.test.ts'));
    const original = files.filter(file =>
      Object.values(originalPatterns).some(pattern => new RegExp(pattern).test(file)));
    const selected: string[] = [];
    for (const job of Object.keys(originalPatterns)) {
      const run = workflow.jobs[job].steps.find(entry => entry.run?.includes('--testPathPatterns'))?.run;
      const pattern = run?.match(/--testPathPatterns="([^"]+)"/)?.[1];
      expect(pattern).toBeDefined();
      selected.push(...files.filter(file => new RegExp(pattern!).test(file)));
    }
    expect(selected.sort()).toEqual(original.sort());
    expect(new Set(selected).size).toBe(selected.length);
  });

  it('uses the same image loading script in all five jobs', () => {
    const scripts = Object.keys(originalPatterns).map(job => step(job, 'Load integration images').run);
    expect(new Set(scripts).size).toBe(1);
  });

  it('uses the shared source-built images instead of rebuilding selected suites', () => {
    for (const file of [
      'one-shot-tokens.test.ts',
      'token-unset.test.ts',
      'api-proxy.test.ts',
      'api-proxy-observability.test.ts',
      'api-proxy-rate-limit.test.ts',
    ]) {
      const source = fs.readFileSync(path.join(root, 'tests/integration', file), 'utf8');
      expect(source).not.toContain('buildLocal: true');
    }
  });

  it('keeps every inline shell script syntactically valid', () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const entry of job.steps.filter(entry => entry.run)) {
        const result = spawnSync('bash', ['-n'], { input: entry.run, encoding: 'utf8' });
        expect({ step: entry.name, status: result.status, stderr: result.stderr })
          .toEqual({ step: entry.name, status: 0, stderr: '' });
      }
    }
  });

  it.each([
    { exportCache: 'false', failures: 0, expectedBuilds: 3, status: 0 },
    { exportCache: 'true', failures: 0, expectedBuilds: 3, status: 0 },
    { exportCache: 'false', failures: 2, expectedBuilds: 5, status: 0 },
    { exportCache: 'false', failures: 3, expectedBuilds: 3, status: 1 },
  ])('builds images with bounded retries, pipeline failure propagation, and cache summaries: %j', scenario => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-workflow-'));
    const calls = path.join(dir, 'calls');
    try {
      const result = spawnSync('bash', ['-e', '-o', 'pipefail'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          EXPORT_BUILD_CACHE: scenario.exportCache,
          BUILD_CALLS: calls,
          FAIL_BUILDS: String(scenario.failures),
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
        },
        input: `
          docker() {
            printf '%s\\n' "$*" >> "$BUILD_CALLS"
            calls=$(grep -c '^buildx build' "$BUILD_CALLS")
            if [ "$EXPORT_BUILD_CACHE" = true ]; then
              printf '#1 importing cache manifest\\n#2 CACHED\\n#3 exporting cache\\n' >&2
            fi
            [ "$calls" -gt "$FAIL_BUILDS" ]
          }
          sleep() { printf 'sleep %s\\n' "$*" >> "$BUILD_CALLS"; }
          ${step('build-images', 'Build local containers').run}
        `,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(scenario.status);
      const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
      const builds = lines.filter(line => line.startsWith('buildx build'));
      expect(builds).toHaveLength(scenario.expectedBuilds);
      for (const build of builds) {
        const image = build.includes('containers/squid/') ? 'squid' :
          build.includes('containers/agent/') ? 'agent' : 'api-proxy';
        expect(build).toContain('--load');
        expect(build).toContain('--progress=plain');
        expect(build).toContain(`--cache-from type=gha,version=2,scope=it-${image}`);
        expect(build).toContain(`-t ghcr.io/github/gh-aw-firewall/${image}:latest containers/${image}/`);
        if (scenario.exportCache === 'true') {
          expect(build).toContain(`--cache-to type=gha,version=2,scope=it-${image},mode=max,ignore-error=true`);
        } else {
          expect(build).not.toContain('--cache-to');
        }
      }
      if (scenario.status === 0) {
        expect(builds[builds.length - 1]).toContain('containers/api-proxy/');
      }
      expect(lines.filter(line => line.startsWith('sleep'))).toEqual(
        scenario.failures === 0 ? [] : ['sleep 10', 'sleep 20'],
      );
      const summary = fs.readFileSync(path.join(dir, 'summary'), 'utf8');
      const count = scenario.exportCache === 'true' ? 1 : 0;
      expect(summary).toContain(`Cached steps: ${count}`);
      expect(summary).toContain(`Cache imports: ${count}`);
      expect(summary).toContain(`Cache exports: ${count}`);
      expect(summary).toContain(`exit status: ${scenario.status}`);
      expect(summary.match(/### /g)).toHaveLength(scenario.expectedBuilds);
      expect(step('build-images', 'Build local containers').shell).toBe('bash');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { saveStatus: 0, loadStatus: 0, inspectStatus: 0 },
    { saveStatus: 1, loadStatus: 0, inspectStatus: 0 },
    { saveStatus: 0, loadStatus: 1, inspectStatus: 0 },
    { saveStatus: 0, loadStatus: 0, inspectStatus: 1 },
  ])('round-trips the compressed archive and fails closed on Docker errors: %j', scenario => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-workflow-'));
    try {
      const run = (script: string, inspectStatus = 0) => spawnSync('bash', ['-e', '-o', 'pipefail'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          RUNNER_TEMP: dir,
          GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
          SAVE_STATUS: String(scenario.saveStatus),
          LOAD_STATUS: String(scenario.loadStatus),
          INSPECT_STATUS: String(inspectStatus),
        },
        input: `
          docker() {
            case "$1" in
              save) printf 'image archive fixture'; return "$SAVE_STATUS" ;;
              load) cat > "$RUNNER_TEMP/loaded"; return "$LOAD_STATUS" ;;
              image) return "$INSPECT_STATUS" ;;
              images) return 0 ;;
              *) return 1 ;;
            esac
          }
          ${script}
        `,
      });
      const save = run(step('build-images', 'Save integration images').run!);
      expect(save.status).toBe(scenario.saveStatus);
      if (save.status !== 0) return;
      expect(fs.statSync(path.join(dir, 'integration-images/images.tar.gz')).size).toBeGreaterThan(0);
      expect(fs.readFileSync(path.join(dir, 'summary'), 'utf8')).toContain('Compressed bytes:');
      const load = run(step('test-domain', 'Load integration images').run!, scenario.inspectStatus);
      expect(load.status).toBe(scenario.loadStatus || scenario.inspectStatus);
      expect(fs.readFileSync(path.join(dir, 'loaded'), 'utf8')).toBe('image archive fixture');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'empty', 'corrupt'])('rejects a %s image archive', archive => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-workflow-'));
    try {
      fs.mkdirSync(path.join(dir, 'integration-images'));
      if (archive !== 'missing') {
        fs.writeFileSync(path.join(dir, 'integration-images/images.tar.gz'), archive === 'empty' ? '' : 'not gzip');
      }
      const result = spawnSync('bash', ['-e', '-o', 'pipefail'], {
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: path.join(dir, 'summary') },
        input: `
          docker() {
            if [ "$1" = load ]; then cat > /dev/null; else touch "$RUNNER_TEMP/inspected"; fi
          }
          ${step('test-domain', 'Load integration images').run}
        `,
      });
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(path.join(dir, 'inspected'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
