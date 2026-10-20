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
  uses?: string;
  with?: Record<string, unknown>;
  if?: string;
  'continue-on-error'?: boolean;
}

function jobs(file: string): Record<string, { steps: Step[] }> {
  return (yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')) as {
    jobs: Record<string, { steps: Step[] }>;
  }).jobs;
}

describe('CI registry retrieval', () => {
  it('uses the reviewed patched gh build and removes the unused inherited service manager', () => {
    const buildTools = fs.readFileSync(path.join(root, 'containers/build-tools/Dockerfile'), 'utf8');
    const agent = fs.readFileSync(path.join(root, 'containers/agent/Dockerfile'), 'utf8');
    const ghStage = (dockerfile: string) => dockerfile.slice(
      dockerfile.indexOf('FROM golang:'),
      dockerfile.indexOf('\nFROM ubuntu:'),
    ).trim();
    expect(ghStage(buildTools)).toBe(ghStage(agent));
    expect(buildTools).toContain('COPY --from=gh-build /tmp/cli-*/bin/gh /usr/bin/gh');
    expect(buildTools).not.toContain('gnupg gh');
    for (const dockerfile of [buildTools, agent]) {
      expect(dockerfile).toContain('rm -f /usr/bin/pebble');
    }
    expect(buildTools).toContain('test "$(gosu nobody id -u)" = 65534');
  });

  it.each(['success', 'base-build', 'agent-build', 'scan', 'save'])(
    'retains the shared PR base through dependent builds and cleans up on %s',
    (failure) => {
      const step = jobs('supply-chain-scan.yml').scan.steps.find(
        (entry) => entry.name?.startsWith('Build and scan PR container images'),
      )!;
      const python = step.run!.split("<<'PYEOF'\n")[1].split('\nPYEOF')[0];
      const result = spawnSync('python3', ['-c', `
import contextlib, io, json, os, subprocess, sys
from unittest.mock import patch
code = sys.stdin.read()
live = set()
archives = set()
cache = set()
calls = []
saves = []
failure = sys.argv[1]
base = 'awf-pr-scan-build-tools:pr'
agent = 'awf-pr-scan-enclave-agent:pr'
def run(args, **kwargs):
    calls.append(args)
    rc = 0
    if args[:2] == ['docker', 'build']:
        tag = args[args.index('-t') + 1]
        if tag == agent and base not in live:
            raise AssertionError('base removed before enclave-agent build')
        cache.add(tag)
        if (failure == 'base-build' and tag == base) or (failure == 'agent-build' and tag == agent):
            rc = 1
        else:
            live.add(tag)
    elif args[:2] == ['docker', 'save']:
        # Disk-lifetime invariant: only the retained base and the image being saved
        # may remain, with no builder cache or earlier archive on the runner.
        saves.append({'tag': args[4], 'live': sorted(live), 'cache': sorted(cache),
                      'archives': sorted(archives)})
        archives.add(args[3])
        if failure == 'save':
            raise subprocess.CalledProcessError(1, args)
    elif args[:2] == ['docker', 'run'] and failure == 'scan':
        rc = 2
    elif args[:3] == ['docker', 'image', 'rm']:
        live.discard(args[-1])
    elif args[:3] == ['docker', 'builder', 'prune']:
        if args != ['docker', 'builder', 'prune', '--all', '--force']:
            raise AssertionError(args)
        cache.clear()
    elif 'prune' in args:
        raise AssertionError('unexpected image/system prune: ' + ' '.join(args))
    return subprocess.CompletedProcess(args, rc)
exit_code = 0
with patch('subprocess.run', run), patch.dict(os.environ, {'GRYPE_DB': '/tmp/mock-db'}), \\
     patch('os.path.exists', lambda file: file in archives), patch('os.remove', archives.remove):
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            exec(compile(code, '<workflow>', 'exec'))
        except SystemExit as error:
            exit_code = error.code
        except subprocess.CalledProcessError as error:
            exit_code = error.returncode
print(json.dumps({'live': sorted(live), 'archives': sorted(archives), 'cache': sorted(cache),
                  'saves': saves, 'calls': calls, 'exit': exit_code}))
`, failure], { cwd: root, input: python, encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const trace = JSON.parse(result.stdout) as {
        live: string[]; archives: string[]; cache: string[]; calls: string[][]; exit: number;
        saves: { tag: string; live: string[]; cache: string[]; archives: string[] }[];
      };
      expect(trace.live).toEqual([]);
      expect(trace.archives).toEqual([]);
      expect(trace.cache).toEqual([]);
      for (const save of trace.saves) {
        expect(save.cache).toEqual([]);
        expect(save.archives).toEqual([]);
        const base = failure === 'base-build' ? [] : ['awf-pr-scan-build-tools:pr'];
        expect(save.live).toEqual([...new Set([...base, save.tag])].sort());
      }
      expect(trace.saves.length).toBeGreaterThan(0);
      if (failure === 'success' || failure === 'scan') {
        expect(trace.saves[trace.saves.length - 2]?.tag).toBe('awf-pr-scan-enclave-agent:pr');
      }
      expect(trace.exit).toBe(failure === 'success' ? 0 : failure === 'scan' ? 2 : 1);
      const agentBuild = trace.calls.find((args) =>
        args[1] === 'build' && args.includes('awf-pr-scan-enclave-agent:pr'));
      if (failure === 'base-build' || failure === 'save') {
        expect(agentBuild).toBeUndefined();
      } else {
        expect(agentBuild).toBeDefined();
      }
      const scans = trace.calls.filter((args) => args[1] === 'run');
      for (const args of scans) {
        expect(args).toContain(grype);
        expect(args.slice(args.indexOf('--fail-on'), args.indexOf('--fail-on') + 2))
          .toEqual(['--fail-on', 'high']);
      }
      if (failure === 'success' || failure === 'scan') {
        expect(scans).toHaveLength(9);
      }
    },
  );

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
    expect(blocking?.run).toContain('finally:');
    expect(blocking?.run).toContain('os.remove(tar)');
    expect(blocking?.run).toContain("'docker', 'image', 'rm', '--force', tag");
    expect(blocking?.run).toContain("['docker', 'builder', 'prune', '--all', '--force']");
    expect(blocking?.run).not.toMatch(/image', 'prune|system', 'prune/);
    expect(blocking?.['continue-on-error']).toBeUndefined();
    const free = steps.findIndex((step) => step.name === 'Free unused hosted-runner disk space');
    expect(free).toBeGreaterThanOrEqual(0);
    expect(free).toBeLessThan(prepare);
    expect(steps[free].run).not.toContain('docker');
    expect(steps[free].run).not.toContain('hostedtoolcache/go');
    expect(steps.find((step) => step.run?.includes(`'${grant}'`))?.run).toContain(grant);
  });

  it('builds the pinned NVX-aware compiler before scanning', () => {
    const steps = jobs('supply-chain-scan.yml').scan.steps;
    const checkout = steps.findIndex((step) => step.with?.repository === 'github/gh-aw');
    const install = steps.findIndex(
      (step) => step.name === 'Install patched gh-aw v0.92.6',
    );
    const compile = steps.findIndex((step) =>
      step.run === 'gh aw compile --syft --action-mode action --action-tag v0.92.6 .github/workflows/*.md');
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(checkout);
    expect(compile).toBeGreaterThan(install);
    expect(steps[checkout].uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
    expect(steps[checkout].with).toEqual({
      repository: 'github/gh-aw',
      ref: '7363a87ff2483635af62f490b52c25a757a50221',
      path: '.tmp/gh-aw-compiler',
      'persist-credentials': false,
    });
    expect(steps[install].run).toContain('-C .tmp/gh-aw-compiler');
    const build = steps[install].run!;
    const localPatch = '${GITHUB_WORKSPACE}/scripts/ci/compiler-agent-acceptance-v0.28.66.patch';
    expect(build).toContain(`"${localPatch}"`);
    expect(build).toContain('git -C .tmp/gh-aw-compiler apply --unidiff-zero');
    expect(build.indexOf(localPatch)).toBeLessThan(build.indexOf('go test'));
    expect(build).not.toContain('gh-aw-agent-acceptance.patch');
    expect(build).not.toContain('sha256sum --check --strict');
    const patch = fs.readFileSync(path.join(root, 'scripts/ci/compiler-agent-acceptance-v0.28.66.patch'), 'utf8');
    expect(patch).toContain('cloudHypervisorAgentAcceptanceAWFVersion       = "v0.28.66"');
    expect(patch).toContain('cloudHypervisorAgentAcceptanceMaxModelTokens   = 131072');
    expect(patch).toContain('pkg/parser/schemas/main_workflow_schema.json');
    expect(patch).toContain('"maximum": 131072');
    expect(patch).toContain('"maximum": 32768');
    expect(patch).toContain('{"old token budget"');
    expect(patch).toContain('{"previous schema ceiling"');
    expect(patch).toContain('{"previous acceptance version"');
    expect(patch).toContain('{"future version"');
    const source = yaml.load(fs.readFileSync(path.join(
      root, '.github/workflows/smoke-enclave-cloud-hypervisor-copilot.md',
    ), 'utf8').split('---')[1]) as { sandbox: { agent: { version: string } } };
    expect(source.sandbox.agent.version).toBe('v0.28.66');
    expect(patch).toContain(
      `cloudHypervisorAgentAcceptanceAWFVersion       = "${source.sandbox.agent.version}"`);
    expect(build).toContain('TestValidateCloudHypervisorAgentAcceptance|TestCompileCloudHypervisorAgentAcceptance');
    expect(build.indexOf('go test')).toBeLessThan(build.indexOf('go build'));
    expect(build).toContain('dev-v0.92.6-agent-acceptance-v0.28.66-budget131072');
    for (const index of [checkout, install, compile]) {
      expect(steps[index].if).toBeUndefined();
      expect(steps[index]['continue-on-error']).toBeUndefined();
    }
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
