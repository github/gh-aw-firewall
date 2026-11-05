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
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, {
    name: string;
    if: string;
    needs?: unknown;
    steps: Step[];
  }>;
}

const workflow = yaml.load(fs.readFileSync(
  path.join(root, '.github/workflows/test-integration-suite.yml'), 'utf8',
)) as Workflow;
const originalPatterns: Record<string, string> = {
  'test-domain': '(blocked-domains|dns-servers|empty-domains|wildcard-patterns)',
  'test-network': '(host-tcp-services|ipv6|localhost-access|network-security|topology-compose)',
  'test-protocol-security': '(protocol-support|credential-hiding|one-shot-tokens|token-unset|git-operations)',
  'test-container-ops': '(compose-environment|container-workdir|environment-variables|error-handling|exit-code-propagation|filesystem-allowwrite|log-commands|no-docker|volume-mounts|skip-pull|sudo-secure-path)',
  'test-api-proxy': 'api-proxy',
};

function step(job: string, name: string): Step {
  const found = workflow.jobs[job].steps.find(entry => entry.name === name);
  if (!found) throw new Error(`Missing ${job} step: ${name}`);
  return found;
}

describe('integration suite workflow', () => {
  it('preserves triggers, read-only permissions, parallel jobs, and check names', () => {
    expect(workflow.on).toEqual({
      push: { branches: ['main'] },
      pull_request: { branches: ['main'], types: ['labeled'] },
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(Object.keys(originalPatterns));
    expect(Object.values(workflow.jobs).map(job => job.name)).toEqual([
      'Domain Tests', 'Network Tests', 'Protocol & Security Tests',
      'Container & Ops Tests', 'API Proxy Tests',
    ]);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.needs).toBeUndefined();
      expect(job.if).toBe("github.event_name != 'pull_request' || github.event.label.name == 'ready-for-aw'");
    }
  });

  it.each(Object.keys(originalPatterns))('%s configures authenticated Buildx before building and retains cleanup and logs', job => {
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
    expect(build.env?.EXPORT_BUILD_CACHE).toBe(job === 'test-domain'
      ? "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}"
      : 'false');
    expect(steps.indexOf(build)).toBeLessThan(steps.indexOf(step(job, 'Pre-test cleanup')));
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

  it('uses the same retrying build script in all five jobs', () => {
    const scripts = Object.keys(originalPatterns).map(job => step(job, 'Build local containers').run);
    expect(new Set(scripts).size).toBe(1);
  });

  it.each([
    { exportCache: 'false', failures: 0, expectedBuilds: 2, status: 0 },
    { exportCache: 'true', failures: 0, expectedBuilds: 2, status: 0 },
    { exportCache: 'false', failures: 2, expectedBuilds: 4, status: 0 },
    { exportCache: 'false', failures: 3, expectedBuilds: 3, status: 1 },
  ])('builds and loads images with bounded retries: %j', scenario => {
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
        },
        input: `
          calls=0
          docker() {
            printf '%s\\n' "$*" >> "$BUILD_CALLS"
            calls=$((calls + 1))
            [ "$calls" -gt "$FAIL_BUILDS" ]
          }
          sleep() { printf 'sleep %s\\n' "$*" >> "$BUILD_CALLS"; }
          ${step('test-domain', 'Build local containers').run}
        `,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(scenario.status);
      const lines = fs.readFileSync(calls, 'utf8').trim().split('\n');
      const builds = lines.filter(line => line.startsWith('buildx build'));
      expect(builds).toHaveLength(scenario.expectedBuilds);
      for (const build of builds) {
        const image = build.endsWith('containers/squid/') ? 'squid' : 'agent';
        expect(build).toContain('--load');
        expect(build).toContain(`--cache-from type=gha,version=2,scope=it-${image}`);
        expect(build).toContain(`-t ghcr.io/github/gh-aw-firewall/${image}:latest containers/${image}/`);
        if (scenario.exportCache === 'true') {
          expect(build).toContain(`--cache-to type=gha,version=2,scope=it-${image},mode=max,ignore-error=true`);
        } else {
          expect(build).not.toContain('--cache-to');
        }
      }
      if (scenario.status === 0) {
        expect(builds[builds.length - 1]).toContain('containers/agent/');
      }
      expect(lines.filter(line => line.startsWith('sleep'))).toEqual(
        scenario.failures === 0 ? [] : ['sleep 10', 'sleep 20'],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
