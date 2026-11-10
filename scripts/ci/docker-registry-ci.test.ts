import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts/ci/configure-docker-mirror.sh');
const syft = 'anchore/syft:v1.55.0@sha256:4cc92b64ca74ffca4c94d4c8fcc01f217731375300be14d0b6eeb2e82eaa110a';
const grype = 'ghcr.io/anchore/grype@sha256:fd4ab4d1042b522c896e73bdf09ab8bf384fa417df99d6dd0d6e1008c7e7c821';
const grant = 'ghcr.io/anchore/grant@sha256:172463611795f43b77302cdfbd7b3f81295492a7330e0820cfe41c3674920237';

interface Step {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: string;
  'continue-on-error'?: boolean;
}

interface Job {
  name?: string;
  'timeout-minutes'?: number | string;
  needs?: string[];
  if?: string;
  outputs?: Record<string, string>;
  strategy?: {
    'fail-fast': boolean;
    matrix: {
      include: {
        scan: string;
        'pr-images'?: boolean;
        images?: string[];
        timeout: number;
      }[];
    };
  };
  steps: Step[];
}

function jobs(file: string): Record<string, Job> {
  return (yaml.load(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8')) as {
    jobs: Record<string, Job>;
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

  const prShards = jobs('supply-chain-scan.yml')['image-scans'].strategy!.matrix.include
    .filter(shard => shard['pr-images']);

  it.each(prShards.flatMap(shard => [
    ['success', '2026-11-04'],
    ['success', '2026-11-05'],
    ...['cache-export', 'scan', 'save',
      ...(shard.scan === 'pr-toolchain' ? ['base-build', 'agent-build'] : [])]
      .map(failure => [failure, '2026-11-04']),
  ].map(([failure, day]) => [shard.scan, failure, day, shard.images!] as const)))(
    'retains exact bases and bounds disk use in %s on %s (%s)',
    (_shard, failure, day, images) => {
      const step = jobs('supply-chain-scan.yml')['image-scans'].steps.find(
        (entry) => entry.name?.startsWith('Build and scan PR container images'),
      )!;
      const python = step.run!.split("<<'PYEOF'\n")[1].split('\nPYEOF')[0];
      const result = spawnSync('python3', ['-c', `
import contextlib, datetime, io, json, os, subprocess, sys
from unittest.mock import patch
code = sys.stdin.read()
live = set()
archives = set()
cache = set()
calls = []
saves = []
failure = sys.argv[1]
selected = json.loads(sys.argv[3])
cache_failure_tag = 'awf-pr-scan-' + selected[0] + ':pr'
class Clock(datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls.fromisoformat(sys.argv[2]).replace(tzinfo=tz)
base = 'awf-pr-scan-build-tools:pr'
agent = 'awf-pr-scan-enclave-agent:pr'
def run(args, **kwargs):
    calls.append(args)
    rc = 0
    if args[:3] == ['docker', 'buildx', 'build']:
        tag = args[args.index('-t') + 1]
        if tag == agent and base not in live:
            raise AssertionError('base removed before enclave-agent build')
        cache.add(tag)
        if failure == 'cache-export':
            # Buildx may load the result before the remote cache exporter fails.
            live.add(tag)
        if ((failure == 'base-build' and tag == base) or (failure == 'agent-build' and tag == agent)
                or (failure == 'cache-export' and tag == cache_failure_tag)):
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
with patch('subprocess.run', run), patch('datetime.datetime', Clock), \\
     patch.dict(os.environ, {'GRYPE_DB': '/tmp/mock-db', 'PR_IMAGES': json.dumps(selected)}), \\
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
`, failure, day, JSON.stringify(images)], { cwd: root, input: python, encoding: 'utf8' });
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
        const base = images.includes('build-tools') && !['base-build', 'cache-export'].includes(failure)
          ? ['awf-pr-scan-build-tools:pr'] : [];
        expect(save.live).toEqual([...new Set([...base, save.tag])].sort());
      }
      if (failure === 'base-build' || (failure === 'cache-export' && images.length <= 2)) {
        expect(trace.saves).toHaveLength(0);
      } else {
        expect(trace.saves.length).toBeGreaterThan(0);
      }
      if (images.includes('enclave-agent') && (failure === 'success' || failure === 'scan')) {
        expect(trace.saves[trace.saves.length - 1]?.tag).toBe('awf-pr-scan-enclave-agent:pr');
      }
      expect(trace.exit).toBe(failure === 'success' ? 0 : failure === 'scan' ? 2 : 1);
      const agentBuild = trace.calls.find((args) =>
        args[1] === 'buildx' && args.includes('awf-pr-scan-enclave-agent:pr'));
      if (!images.includes('enclave-agent') || ['base-build', 'save', 'cache-export'].includes(failure)) {
        expect(agentBuild).toBeUndefined();
      } else {
        expect(agentBuild).toBeDefined();
      }
      const scans = trace.calls.filter((args) => args[1] === 'run');
      const builds = trace.calls.filter((args) => args[1] === 'buildx');
      expect(builds.length).toBeGreaterThan(0);
      if (failure === 'success' || failure === 'scan') {
        expect(builds.map(args => args[args.indexOf('-t') + 1]))
          .toEqual(images.map(name => `awf-pr-scan-${name}:pr`));
      }
      const scopes = new Set<string>();
      for (const args of builds) {
        const tag = args[args.indexOf('-t') + 1];
        const name = tag.slice('awf-pr-scan-'.length, -':pr'.length);
        const scope = `supply-chain-v1-${name}-${day}`;
        scopes.add(scope);
        expect(args).toContain('--load');
        expect(args[args.indexOf('--cache-from') + 1]).toBe(`type=gha,version=2,scope=${scope}`);
        expect(args[args.indexOf('--cache-to') + 1]).toBe(`type=gha,version=2,mode=max,scope=${scope}`);
        expect(args.includes('--pull')).toBe(name !== 'enclave-agent');
        expect(args.join(' ')).not.toMatch(/ignore-error|no-cache/);
      }
      expect(scopes.size).toBe(builds.length);
      if (agentBuild) {
        expect(agentBuild).toContain('BUILD_TOOLS_IMAGE=awf-pr-scan-build-tools:pr');
      }
      for (const args of scans) {
        expect(args).toContain(grype);
        expect(args.slice(args.indexOf('--fail-on'), args.indexOf('--fail-on') + 2))
          .toEqual(['--fail-on', 'high']);
      }
      if (failure === 'success' || failure === 'scan') {
        expect(scans).toHaveLength(images.length);
      }
      if (failure === 'cache-export') {
        expect(scans).toHaveLength(images.length - (images.includes('build-tools') ? 2 : 1));
        expect(scans.flat()).not.toContain(`docker-archive:/tmp/awf-pr-scan-${images[0]}.tar`);
      }
    },
  );

  it('sets up an external-cache-capable Docker driver before pulling scanners', () => {
    const workflow = jobs('supply-chain-scan.yml');
    const steps = workflow['image-scans'].steps;
    const mirror = steps.findIndex(step => step.name === 'Configure Docker Hub cache');
    expect(steps[mirror].env?.AWF_DOCKER_CONTAINERD_SNAPSHOTTER)
      .toBe("${{ matrix.pr-images == true && 'true' || 'false' }}");
    const setup = steps.findIndex(step => step.name === 'Set up Docker Buildx for cached PR builds');
    expect(setup).toBeGreaterThan(mirror);
    expect(setup).toBeLessThan(steps.findIndex(step => step.run?.startsWith('docker pull')));
    expect(steps[setup].uses)
      .toBe('docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069');
    expect(steps[setup].with?.driver).toBe('docker');
    expect(steps[setup].if).toBe('matrix.pr-images == true');
    expect(steps[setup]['continue-on-error']).toBeUndefined();
    expect(workflow.compile.steps.some(step => step.env?.AWF_DOCKER_CONTAINERD_SNAPSHOTTER))
      .toBe(false);
  });

  it.each(['complete', 'missing-token', 'missing-url'])(
    'masks the runtime token and fails closed on missing Buildx cache credentials (%s)',
    state => {
      const step = jobs('supply-chain-scan.yml')['image-scans'].steps.find(
        entry => entry.name === 'Expose GitHub Actions cache runtime for Buildx CLI',
      )!;
      expect(step.if).toBe('matrix.pr-images == true');
      expect(step.uses).toBe('actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3');
      const result = spawnSync(process.execPath, ['-e', `
const calls = [];
const core = {
  setSecret: value => calls.push(['mask', value]),
  exportVariable: (name, value) => calls.push(['export', name, value]),
};
const env = {
  ...(process.argv[1] === 'missing-token' ? {} : { ACTIONS_RUNTIME_TOKEN: 'fixture-token' }),
  ...(process.argv[1] === 'missing-url' ? {} : { ACTIONS_RESULTS_URL: 'https://cache.example/' }),
};
try {
  new Function('core', 'process', ${JSON.stringify(step.with?.script)})(core, { env });
} catch (error) {
  process.exitCode = 1;
}
console.log(JSON.stringify(calls));
`, state], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(state === 'complete' ? 0 : 1);
      const calls = JSON.parse(result.stdout) as string[][];
      if (state !== 'missing-token') {
        expect(calls.slice(0, 2)).toEqual([
          ['mask', 'fixture-token'],
          ['export', 'ACTIONS_RUNTIME_TOKEN', 'fixture-token'],
        ]);
      }
      if (state === 'complete') {
        expect(calls).toHaveLength(3);
        expect(calls[2]).toEqual(['export', 'ACTIONS_RESULTS_URL', 'https://cache.example/']);
      }
    },
  );

  it.each(['success', 'warm-failure', 'chown-failure'])(
    'repairs Grype cache ownership and traversal before saving (%s)',
    failure => {
      const steps = jobs('supply-chain-scan.yml')['image-scans'].steps;
      const warm = steps.findIndex(step => step.name === 'Warm Grype vulnerability DB');
      expect(steps[warm + 1].name).toBe('Save Grype vulnerability DB cache');
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-grype-cache-'));
      const db = path.join(temp, 'db');
      try {
        fs.writeFileSync(path.join(temp, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
echo docker >> "$TRACE"
[[ "$FAILURE" != warm-failure ]] || exit 100
mkdir -p "$GRYPE_DB/6"
echo fixture-db > "$GRYPE_DB/6/vulnerability.db"
chmod 0500 "$GRYPE_DB/6"
chmod 0400 "$GRYPE_DB/6/vulnerability.db"
`, { mode: 0o755 });
        fs.writeFileSync(path.join(temp, 'sudo'), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$TRACE"
[[ "$1" == chown && "$2" == -R && "$3" == "$(id -u):$(id -g)" && "$4" == "$GRYPE_DB" ]]
[[ "$FAILURE" != chown-failure ]] || exit 101
`, { mode: 0o755 });
        const result = spawnSync('bash', ['-e', '-c', steps[warm].run!], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${temp}${path.delimiter}${process.env.PATH}`,
            GRYPE_DB: db,
            TRACE: path.join(temp, 'trace'),
            FAILURE: failure,
          },
        });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(failure === 'success' ? 0 : failure === 'warm-failure' ? 100 : 101);
        const trace = fs.readFileSync(path.join(temp, 'trace'), 'utf8').trim().split('\n');
        expect(trace).toHaveLength(failure === 'warm-failure' ? 1 : 2);
        if (failure === 'success') {
          expect(trace[1]).toBe(`chown -R ${process.getuid!()}:${process.getgid!()} ${db}`);
          expect(fs.statSync(path.join(db, '6')).mode & 0o700).toBe(0o700);
          expect(fs.statSync(path.join(db, '6/vulnerability.db')).mode & 0o600).toBe(0o600);
          const archive = spawnSync('tar', ['-cf', path.join(temp, 'cache.tar'), '-C', db, '.']);
          expect(archive.status).toBe(0);
        }
      } finally {
        if (fs.existsSync(path.join(db, '6'))) fs.chmodSync(path.join(db, '6'), 0o700);
        fs.rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  const affected = [
    ...Object.keys(jobs('test-chroot.yml')).map((job) => ['test-chroot.yml', job]),
    ['test-examples.yml', 'test-examples'],
    ['test-cloud-hypervisor.yml', 'build-test-artifacts'],
    ['supply-chain-scan.yml', 'compile'],
    ['supply-chain-scan.yml', 'image-scans'],
  ];

  it.each(affected)('configures the runner mirror before Docker use in %s / %s', (file, job) => {
    const steps = jobs(file)[job].steps;
    const setup = steps.findIndex((step) => step.run === 'bash scripts/ci/configure-docker-mirror.sh');
    const docker = steps.findIndex((step) => step.run?.includes('docker ')
      || step.uses === './.github/actions/build-chroot-images');
    expect(setup).toBeGreaterThanOrEqual(0);
    expect(setup).toBeLessThan(docker);
    expect(steps[setup].if).toBeUndefined();
    expect(steps[setup]['continue-on-error']).toBeUndefined();
  });

  it('prepares exact scanners on their runners and retains the blocking scan', () => {
    const workflow = jobs('supply-chain-scan.yml');
    const compileSteps = workflow.compile.steps;
    const prepare = compileSteps.findIndex((step) => step.name === 'Prepare pinned Syft scanner');
    const compile = compileSteps.findIndex((step) => step.run?.includes('gh aw compile --syft'));
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(compile);
    expect(compileSteps[prepare].run).toContain(`docker pull ${syft}`);
    expect(compileSteps[prepare]['continue-on-error']).toBeUndefined();
    const steps = workflow['image-scans'].steps;
    for (const image of [grype, grant]) {
      expect(image).toMatch(/@sha256:[a-f0-9]{64}$/);
      expect(steps.some((step) => step.run?.includes(`docker pull ${image}`))).toBe(true);
    }
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
    expect(free).toBeLessThan(steps.findIndex((step) => step.run?.includes('docker pull')));
    expect(steps[free].if).toBe('matrix.pr-images == true');
    expect(steps[free].run).not.toContain('docker');
    expect(steps[free].run).not.toContain('hostedtoolcache/go');
    expect(steps.find((step) => step.run?.includes(`'${grant}'`))?.run).toContain(grant);
  });

  it('builds the reviewed prerelease compiler before scanning', () => {
    const steps = jobs('supply-chain-scan.yml').compile.steps;
    const install = steps.findIndex(
      (step) => step.name === 'Build gh-aw v1.2.1 and scoped acceptance compiler',
    );
    const compile = steps.findIndex((step) =>
      step.name === 'Compile + generate SBOMs (Syft)');
    const acceptanceCompile = steps.findIndex((step) =>
      step.name === 'Compile Copilot acceptance with scoped backport');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(compile).toBeGreaterThan(install);
    expect(steps[install - 2].name).toBe('Checkout gh-aw v1.2.1');
    expect(steps[install - 2].with?.ref).toBe('8f3224323bdfd3ae8574c99c5da8a65d450577bb');
    expect(steps[install].run).toContain('compiler-agent-acceptance-v0.28.66.patch');
    expect(steps[install].run).toContain('go test -C .tmp/gh-aw-compiler ./pkg/workflow');
    expect(steps[install].run).toContain('./pkg/parser');
    expect(steps[install].run).toContain('dev-v1.2.1-agent-acceptance-v0.28.66-budget131072');
    expect(steps[install].run).toContain('-ldflags="-X main.version=v1.2.1"');
    expect(steps[install].run).toContain('gh aw version');
    expect(steps[install].env?.GH_TOKEN).toBe('${{ github.token }}');
    expect(steps[compile].run).toContain("find .github/workflows -maxdepth 1 -type f -name '*.md'");
    expect(steps[compile].run)
      .toContain("! -name 'smoke-enclave-cloud-hypervisor-copilot.md'");
    expect(steps[compile].run)
      .toContain('gh aw compile --syft --action-mode action --action-tag v1.2.1 "${workflows[@]}"');
    for (const index of [install, compile]) {
      expect(steps[index].if).toBeUndefined();
      expect(steps[index]['continue-on-error']).toBeUndefined();
    }
    expect(acceptanceCompile).toBeGreaterThan(compile);
    expect(steps[acceptanceCompile].run).toContain('$RUNNER_TEMP/gh-aw-agent-acceptance" compile --syft');
    expect(steps[acceptanceCompile].run)
      .toContain('.github/workflows/smoke-enclave-cloud-hypervisor-copilot.md');
  });

  it('fans scans out after one compilation without cancelling sibling scans', () => {
    const workflow = jobs('supply-chain-scan.yml');
    const scans = workflow['image-scans'];
    expect(scans.needs).toEqual(['compile']);
    expect(scans.strategy).toEqual({
      'fail-fast': false,
      matrix: {
        include: [
          { scan: 'pr-toolchain', 'pr-images': true, images: ['build-tools', 'enclave-agent'], timeout: 60 },
          { scan: 'pr-agent', 'pr-images': true, images: ['agent'], timeout: 60 },
          {
            scan: 'pr-services', 'pr-images': true,
            images: ['api-proxy', 'router', 'cli-proxy', 'gh-aw-node', 'enclave-script', 'enclave-mcp-server'],
            timeout: 60,
          },
          { scan: 'published-cves', timeout: 40 },
          { scan: 'licenses', timeout: 40 },
        ],
      },
    });
    expect(scans['timeout-minutes']).toBe('${{ matrix.timeout }}');
    const images = prShards.flatMap(shard => shard.images!);
    expect([...images].sort()).toEqual([
      'agent', 'api-proxy', 'build-tools', 'cli-proxy', 'enclave-agent',
      'enclave-mcp-server', 'enclave-script', 'gh-aw-node', 'router',
    ]);
    expect(new Set(images).size).toBe(images.length);
    const selectors = [
      ['Build and scan PR container images', 'matrix.pr-images == true'],
      ['Scan published & third-party images', "matrix.scan == 'published-cves'"],
      ['Check image licenses', "matrix.scan == 'licenses'"],
    ];
    for (const [prefix, selector] of selectors) {
      const step = scans.steps.find((entry) => entry.name?.startsWith(prefix))!;
      expect(step.if).toBe(selector);
      expect(step['continue-on-error']).toBeUndefined();
      if (prefix === 'Build and scan PR container images') {
        expect(step.env?.PR_IMAGES).toBe('${{ toJSON(matrix.images) }}');
      } else {
        expect(step.env?.MANIFEST_IMAGES).toBe('${{ needs.compile.outputs.images }}');
        expect(step.run).toContain("json.loads(os.environ['MANIFEST_IMAGES'])");
        expect(step.run).toContain('sys.exit(0)');
      }
    }
    const databaseSteps = scans.steps.filter((step) => step.name?.includes('Grype vulnerability DB'));
    expect(databaseSteps).toHaveLength(3);
    for (const step of databaseSteps) {
      expect(step.if).toBe("matrix.scan != 'licenses'");
      if (step.with) {
        expect(step.with.key).toBe('grype-db-v6-${{ github.run_id }}-${{ matrix.scan }}');
      }
    }
    expect(workflow.compile.outputs?.images).toBe('${{ steps.inventory.outputs.images }}');
    expect(Object.values(workflow).flatMap((job) => job.steps)
      .filter((step) => step.run?.includes('gh aw compile --syft'))).toHaveLength(1);
  });

  it.each([[], ['unknown'], ['enclave-agent'], 'agent', null])(
    'rejects invalid PR image shard %j before any Docker command',
    images => {
      const step = jobs('supply-chain-scan.yml')['image-scans'].steps.find(
        entry => entry.name?.startsWith('Build and scan PR container images'),
      )!;
      const python = step.run!.split("<<'PYEOF'\n")[1].split('\nPYEOF')[0];
      const result = spawnSync('python3', ['-c', `
import os, sys
from unittest.mock import patch
with patch.dict(os.environ, {'GRYPE_DB': '/tmp/mock-db', 'PR_IMAGES': sys.argv[1]}), \\
     patch('subprocess.run', side_effect=AssertionError('unexpected Docker command')):
    exec(compile(sys.stdin.read(), '<workflow>', 'exec'))
`, JSON.stringify(images)], { cwd: root, input: python, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ValueError:');
      expect(result.stderr).not.toContain('unexpected Docker command');
    },
  );

  it.each([0, 1])('passes the compiled inventory to both report-only scans (scanner exit %i)', (scannerExit) => {
    const workflow = jobs('supply-chain-scan.yml');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-scan-inventory-'));
    try {
      const workflows = path.join(temp, '.github/workflows');
      fs.mkdirSync(workflows, { recursive: true });
      const pinned = 'example.com/agent@sha256:' + 'a'.repeat(64);
      fs.writeFileSync(path.join(workflows, 'first.lock.yml'), '# gh-aw-manifest: ' + JSON.stringify({
        containers: [{ image: 'example.com/agent:latest', pinned_image: pinned }],
      }));
      fs.writeFileSync(path.join(workflows, 'second.lock.yml'), '# gh-aw-manifest: ' + JSON.stringify({
        containers: [{ pinned_image: pinned }, { image: 'example.com/helper:v1' }],
      }));
      fs.writeFileSync(path.join(workflows, 'ordinary.lock.yml'), 'name: ordinary workflow\n');
      const inventory = workflow.compile.steps.find((step) => step.id === 'inventory')!;
      const output = path.join(temp, 'output');
      const result = spawnSync('bash', ['-e', '-c', inventory.run!], {
        cwd: temp,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const images = JSON.parse(fs.readFileSync(output, 'utf8').trim().slice('images='.length)) as string[];
      expect(images).toEqual([pinned, 'example.com/helper:v1']);
      for (const prefix of ['Scan published & third-party images', 'Check image licenses']) {
        const step = workflow['image-scans'].steps.find((entry) => entry.name?.startsWith(prefix))!;
        const python = step.run!.split("<<'PYEOF'\n")[1].split('\nPYEOF')[0];
        const scan = spawnSync('python3', ['-c', `
import contextlib, io, json, subprocess, sys
from unittest.mock import patch
calls = []
def run(args, **kwargs):
    calls.append(args)
    return subprocess.CompletedProcess(args, int(sys.argv[1]))
output = io.StringIO()
with patch('subprocess.run', run), contextlib.redirect_stdout(output):
    try:
        exec(compile(sys.stdin.read(), '<workflow>', 'exec'))
    except SystemExit as error:
        exit_code = error.code
print(json.dumps({'calls': calls, 'exit': exit_code, 'output': output.getvalue()}))
`, String(scannerExit)], {
          cwd: temp,
          input: python,
          encoding: 'utf8',
          env: { ...process.env, GRYPE_DB: '/tmp/mock-db', MANIFEST_IMAGES: JSON.stringify(images) },
        });
        expect(scan.stderr).toBe('');
        expect(scan.status).toBe(0);
        const trace = JSON.parse(scan.stdout) as { calls: string[][]; exit: number; output: string };
        expect(trace.exit).toBe(0);
        expect(trace.calls).toHaveLength(images.length);
        const isGrype = prefix.startsWith('Scan published');
        trace.calls.forEach((args, index) => {
          expect(args).toContain(isGrype ? grype : grant);
          expect(args).toContain(isGrype ? `registry:${images[index]}` : images[index]);
        });
        expect(trace.output.includes('::warning::')).toBe(scannerExit !== 0);
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it.each([
    ['success', 'success', 0],
    ['failure', 'success', 1],
    ['success', 'failure', 1],
    ['success', 'cancelled', 1],
    ['cancelled', 'skipped', 1],
  ])('preserves the required check for compile=%s scans=%s', (compile, scans, status) => {
    const gate = jobs('supply-chain-scan.yml').scan;
    expect(gate.name).toBe('Compile + Syft/Grype/Grant');
    expect(gate.needs).toEqual(['compile', 'image-scans']);
    expect(gate.if).toBe('always()');
    expect(gate.steps[0].env).toEqual({
      COMPILE_RESULT: '${{ needs.compile.result }}',
      SCANS_RESULT: '${{ needs.image-scans.result }}',
    });
    const result = spawnSync('bash', ['-e', '-c', gate.steps[0].run!], {
      env: { ...process.env, COMPILE_RESULT: compile, SCANS_RESULT: scans },
    });
    expect(result.status).toBe(status);
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
if [[ "$*" == *DriverStatus* ]]; then
  printf '%s\\n' "\${DRIVER_STATUS:-[[\\"driver-type\\",\\"io.containerd.snapshotter.v1\\"]]}"
else
  printf '%s\\n' "\${DOCKER_MIRRORS:-[\\"https://mirror.gcr.io/\\"]}"
fi
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

  it('opts into the containerd store without losing other daemon features', () => {
    fs.writeFileSync(path.join(temp, 'daemon.json'), JSON.stringify({
      features: { other: true, 'containerd-snapshotter': false },
    }));
    expect(run({ AWF_DOCKER_CONTAINERD_SNAPSHOTTER: 'true' }).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(temp, 'daemon.json'), 'utf8'))).toEqual({
      features: { other: true, 'containerd-snapshotter': true },
      'registry-mirrors': ['https://mirror.gcr.io'],
    });
    expect(fs.readFileSync(path.join(temp, 'trace'), 'utf8').trim().split('\n').slice(-2))
      .toEqual(['docker', 'docker']);
  });

  it('does not silently proceed with an unsupported external cache store', () => {
    expect(run({
      AWF_DOCKER_CONTAINERD_SNAPSHOTTER: 'true',
      DRIVER_STATUS: '[["Backing Filesystem","extfs"]]',
    }).status).not.toBe(0);
  });

  it('rejects invalid snapshotter settings before restarting Docker', () => {
    expect(run({ AWF_DOCKER_CONTAINERD_SNAPSHOTTER: 'yes' }).status).not.toBe(0);
    expect(fs.readFileSync(path.join(temp, 'trace'), 'utf8')).not.toContain('systemctl');
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
