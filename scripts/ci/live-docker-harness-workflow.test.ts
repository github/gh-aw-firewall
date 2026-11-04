import fs from 'fs';
import os from 'os';
import path from 'path';
import execa from 'execa';
import yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const fixtures = path.join(root, 'tests/fixtures/harness-observation');
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  name: string;
  'runs-on': string;
  'timeout-minutes': number;
  steps: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}
const workflow = yaml.load(fs.readFileSync(
  path.join(root, '.github/workflows/test-docker-harness-observation.yml'), 'utf8',
)) as Workflow;

describe('provider-free live Docker harness workflow contract (deterministic, not live proof)', () => {
  it('runs two bounded automatic jobs without credential inputs or manual dispatch', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['native', 'split-dind']);
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).toHaveProperty('push');
    expect(workflow.on).not.toHaveProperty('workflow_dispatch');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(workflow.jobs)) {
      expect(job['runs-on']).toBe('ubuntu-24.04');
      expect(job['timeout-minutes']).toBeLessThanOrEqual(30);
      expect(JSON.stringify(job)).not.toMatch(/secrets\.|env-all|workflow_dispatch|cleanup\.sh|system prune/);
      expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with)
        .toEqual({ 'persist-credentials': false });
      expect(job.steps.filter(step => step.uses).every(step => /@[a-f0-9]{40}$/.test(step.uses!))).toBe(true);
      expect(job.steps.some(step => step.run?.includes('-t awf-harness-agent:local containers/agent'))).toBe(true);
      const upload = job.steps.find(step => step.name === 'Upload sanitized live evidence')!;
      expect(upload.if).toBe('always()');
      expect(upload.with?.path).toMatch(/^artifacts\/harness-live\/.*\/\*\.json$/);
      expect(upload.with?.['retention-days']).toBe(7);
    }
    expect(workflow.jobs['split-dind'].name).toContain('not Kubernetes ARC');
    const nativeCommands = workflow.jobs.native.steps.map(step => step.run || '').join('\n');
    expect(nativeCommands).toContain('node scripts/ci/live-docker-harness.cjs');
    expect(nativeCommands).toContain('node release/awf-bundle.js --version');
    expect(nativeCommands).toContain('src/services/enclave-agent-service.test.ts');
    expect(nativeCommands).toContain('artifacts/harness-deterministic/results.json');
  });

  it('uses separate roots with explicitly translated temporary paths, not same-path shared /tmp', () => {
    interface Service {
      image: string;
      volumes: string[];
      environment: Record<string, string>;
      networks: string[];
      ports?: string[];
      privileged?: boolean;
      mem_limit: string;
      pids_limit: number;
      command?: string[];
    }
    const outer = yaml.load(fs.readFileSync(path.join(fixtures, 'split-dind.compose.yml'), 'utf8')) as {
      services: { runner: Service; daemon: Service };
      networks: { control: { internal: boolean } };
    };
    const { runner, daemon } = outer.services;
    expect(runner.environment.AWF_LIVE_TOPOLOGY).toBe('split-dind');
    expect(runner.environment.DOCKER_HOST).toBe('tcp://daemon:2375');
    expect(runner.volumes).toContain('runner-root:/staged');
    expect(runner.volumes).toContain('runner-tmp:/tmp');
    expect(daemon.volumes).toContain('runner-root:/runner:ro');
    expect(daemon.volumes).toContain('runner-tmp:/runner/tmp:rw');
    expect(daemon.volumes).not.toContain('runner-tmp:/tmp');
    expect(daemon.privileged).toBe(true);
    expect(daemon.ports).toBeUndefined();
    expect(outer.networks.control.internal).toBe(true);
    for (const service of [runner, daemon]) {
      expect(service.mem_limit).toMatch(/^[1-4]g$/);
      expect(service.pids_limit).toBeGreaterThan(0);
    }
    const launch = fs.readFileSync(path.join(root, 'scripts/ci/live-docker-harness-split.sh'), 'utf8');
    expect(launch).toContain('RUNNER_ENVIRONMENT');
    expect(launch).toContain('github-hosted');
    expect(launch).toContain('docker save awf-harness-agent:local');
    expect(launch.indexOf('run --rm --no-deps runner')).toBeLessThan(launch.indexOf('up -d --wait daemon'));
    expect(launch).toContain('mkdir -p /staged/tmp');
    expect(launch).toContain('down -v --timeout 5');
    expect(launch).not.toMatch(/prune|cleanup\.sh|docker rm/);
  });

  it('supplies the mandatory host CA store without bypassing the production trust preflight', async () => {
    const harness = fs.readFileSync(path.join(root, 'scripts/ci/live-docker-harness.cjs'), 'utf8');
    expect(harness).toContain("'/etc/ssl/certs:/host/etc/ssl/certs:ro'");
    expect(fs.readFileSync(path.join(fixtures, 'Dockerfile.runner'), 'utf8'))
      .toContain('libcap2-bin ca-certificates');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-live-ca-unit-'));
    try {
      const source = fs.readFileSync(path.join(root, 'containers/agent/entrypoint.sh'), 'utf8');
      const start = source.indexOf('copy_system_ca_bundle() {');
      const end = source.indexOf('\ncheck_chroot_prereqs()', start);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      // Reproduce the original missing-store refusal without touching /host or
      // requiring Docker/root. Positive mount/trust behavior belongs to live CI.
      const definition = source.slice(start, end).split('/host').join(directory);
      const result = await execa('/bin/bash', ['-c', `${definition}\ncopy_system_ca_bundle`], {
        reject: false, timeout: 5000, env: { PATH: process.env.PATH }, extendEnv: false,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe('[entrypoint][ERROR] No CA store available for AWF trust policy');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  describe('executable fixtures (local shells only)', () => {
    let directory: string;
    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-live-fixture-unit-'));
      for (const binary of ['copilot', 'claude', 'codex']) {
        fs.copyFileSync(path.join(fixtures, 'executable.sh'), path.join(directory, binary));
        fs.chmodSync(path.join(directory, binary), 0o700);
      }
    });
    afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
    function run(binary: string, version: string, mode: string, args: string[]) {
      return execa(path.join(directory, binary), args, {
        reject: false, timeout: 5000, cwd: directory,
        env: {
          PATH: process.env.PATH, HOME: directory, USER: 'fixture', LOGNAME: 'fixture',
          FIXTURE_DIRECTORY: directory, FIXTURE_ENV: 'controlled', FIXTURE_VERSION: version, FIXTURE_MODE: mode,
        },
        extendEnv: false,
      });
    }
    it.each([
      ['copilot', 'GitHub Copilot CLI 1.2.3'],
      ['claude', '2.1.3 (Claude Code)'],
      ['codex', 'codex-cli 0.89.0'],
    ])('%s separates version metadata from normal output and exit', async (binary, version) => {
      const probe = await run(binary, version, 'valid', ['--version']);
      expect(probe.exitCode).toBe(0);
      expect(probe.stdout).toBe(`${version}\ntoken=discard-this-fixture-metadata`);
      const command = await run(binary, version, 'valid', ['--fixture']);
      expect(command.exitCode).toBe(23);
      expect(command.stdout).toBe('fixture-command-output');
      expect(command.stderr).toBe('fixture-command-stderr');
      expect(fs.readFileSync(`${directory}/command-context`, 'utf8'))
        .toBe(fs.readFileSync(`${directory}/probe-context`, 'utf8'));
    });
    it.each([
      ['malformed', 0], ['failed', 7], ['overflow', 0],
    ])('produces real %s process output for the canonical parser', async (mode, code) => {
      const result = await run('copilot', '1.2.3', mode as string, ['--version']);
      expect(result.exitCode).toBe(code);
      if (mode === 'overflow') expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(4096);
      expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
    });
    it('produces the exact 4097-byte sentinel payload including a trailing newline', async () => {
      const result = await run('copilot', '1.2.3', 'overflow-newline', ['--version']);
      // Execa's default strips one final newline; reconstruct the producer payload.
      expect(Buffer.byteLength(`${directory}/copilot\n${result.stdout}\n`)).toBe(4097);
    });
  });
});
