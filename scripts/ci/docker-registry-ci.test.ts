import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts/ci/configure-docker-mirror.sh');
const syft = 'anchore/syft:v1.52.0@sha256:500e2d872ac019436926e8322b4fc1f39441d94d21f6f4046c6ff29b30e8cb02';
const grype = 'ghcr.io/anchore/grype@sha256:fd4ab4d1042b522c896e73bdf09ab8bf384fa417df99d6dd0d6e1008c7e7c821';
const grant = 'ghcr.io/anchore/grant@sha256:172463611795f43b77302cdfbd7b3f81295492a7330e0820cfe41c3674920237';

interface Step {
  name?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
}

function jobs(file: string): Record<string, { steps: Step[] }> {
  return (yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  }).jobs;
}

describe('CI registry retrieval', () => {
  const affected = [
    ...Object.keys(jobs('test-chroot.yml')).map((job) => ['test-chroot.yml', job]),
    ['test-examples.yml', 'test-examples'],
    ['test-cloud-hypervisor.yml', 'build-test-artifacts'],
    ['supply-chain-scan.yml', 'scan'],
  ];

  it.each(affected)('configures the runner mirror before Docker use in %s / %s', (file, job) => {
    const steps = jobs(file)[job].steps;
    const setup = steps.findIndex((step) => step.run === 'bash scripts/ci/configure-docker-mirror.sh');
    const docker = steps.findIndex((step) => step.run?.includes('docker '));
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(setup).toBeLessThan(docker);
    expect(steps[setup].if).toBeUndefined();
    expect(steps[setup]['continue-on-error']).toBeUndefined();
  });

  it('prepares exact scanners once before compilation and retains the blocking scan', () => {
    const steps = jobs('supply-chain-scan.yml').scan.steps;
    const prepare = steps.findIndex((step) => step.name === 'Prepare pinned scanners');
    const compile = steps.findIndex((step) => step.run?.includes('gh aw compile --syft'));
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(compile);
    for (const image of [syft, grype, grant]) {
      expect(steps[prepare].run).toContain(`docker pull ${image}`);
    }
    expect(steps[prepare]['continue-on-error']).toBeUndefined();
    const blocking = steps.find((step) => step.name?.startsWith('Build and scan PR container images'));
    expect(blocking?.run).toContain(grype);
    expect(blocking?.run).toContain("'--fail-on', 'high'");
    expect(blocking?.run).toContain('sys.exit(rc)');
    expect(blocking?.['continue-on-error']).toBeUndefined();
    expect(steps.find((step) => step.run?.includes(`'${grant}'`))?.run).toContain(grant);
  });
});

describe('Docker daemon mirror configuration', () => {
  let temp: string;

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-ci-mirror-'));
    fs.writeFileSync(path.join(temp, 'sudo'), `#!/usr/bin/env bash
set -euo pipefail
echo "$1" >> "$TRACE"
case "$1" in
  test) test -f "$DAEMON_CONFIG" ;;
  cat) cat "$DAEMON_CONFIG" ;;
  dockerd) [[ "\${VALIDATE_FAILURE:-}" != true ]] ;;
  install) cp "$4" "$DAEMON_CONFIG" ;;
  systemctl) [[ "\${RESTART_FAILURE:-}" != true ]] ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(temp, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
echo docker >> "$TRACE"
printf '%s\\n' "\${DOCKER_MIRRORS:-[\\"https://mirror.gcr.io/\\"]}"
`, { mode: 0o755 });
  });

  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  function run(extra: NodeJS.ProcessEnv = {}) {
    return spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temp}${path.delimiter}${process.env.PATH}`,
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        RUNNER_OS: 'Linux',
        DAEMON_CONFIG: path.join(temp, 'daemon.json'),
        TRACE: path.join(temp, 'trace'),
        ...extra,
      },
    });
  }

  it('preserves settings, prioritizes the cache, and validates before restart', () => {
    fs.writeFileSync(path.join(temp, 'daemon.json'), JSON.stringify({
      'log-driver': 'journald',
      'registry-mirrors': ['https://existing.example', 'https://mirror.gcr.io'],
    }));
    const result = run();
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(temp, 'daemon.json'), 'utf8'))).toEqual({
      'log-driver': 'journald',
      'registry-mirrors': ['https://mirror.gcr.io', 'https://existing.example'],
    });
    expect(fs.readFileSync(path.join(temp, 'trace'), 'utf8').trim().split('\n')).toEqual([
      'test', 'cat', 'dockerd', 'install', 'systemctl', 'docker',
    ]);
  });

  it('creates a minimal config when the runner has none', () => {
    expect(run().status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(temp, 'daemon.json'), 'utf8'))).toEqual({
      'registry-mirrors': ['https://mirror.gcr.io'],
    });
  });

  it.each(['not-json', '[]', '{"registry-mirrors":42}'])('rejects invalid config %s without restarting', (config) => {
    fs.writeFileSync(path.join(temp, 'daemon.json'), config);
    expect(run().status).not.toBe(0);
    expect(fs.readFileSync(path.join(temp, 'daemon.json'), 'utf8')).toBe(config);
    expect(fs.readFileSync(path.join(temp, 'trace'), 'utf8')).not.toContain('systemctl');
  });

  it.each([
    { GITHUB_ACTIONS: 'false' },
    { RUNNER_ENVIRONMENT: 'self-hosted' },
    { RUNNER_OS: 'macOS' },
  ])('refuses non-ephemeral Linux CI environments %j', (env) => {
    expect(run(env).status).not.toBe(0);
    expect(fs.existsSync(path.join(temp, 'trace'))).toBe(false);
  });

  it.each([
    { VALIDATE_FAILURE: 'true' },
    { RESTART_FAILURE: 'true' },
    { DOCKER_MIRRORS: '[]' },
  ])('fails when setup or readiness fails %j', (env) => {
    expect(run(env).status).not.toBe(0);
  });
});
