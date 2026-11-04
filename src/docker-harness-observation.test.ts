import fs from 'fs';
import os from 'os';
import path from 'path';
import execa from 'execa';
import {
  createDockerHarnessObservation, dockerHarnessTmpfs,
  supportsDockerHarnessObservation, withDockerHarnessObservation,
} from './docker-harness-observation';
import { harnessContext, observeHarness, prepareHarnessObservation } from './harness-observation';
import { parseProbe, probeCommand, selectHarness } from './model-information-contract/harness-observation';
import { setAwfDockerHost } from './docker-host';
import type { WrapperConfig } from './types';

jest.mock('execa', () => ({ __esModule: true, default: jest.fn() }));
const actualExeca: typeof execa = jest.requireActual('execa');
type DockerExec = (file: string, args: string[], options: execa.Options) =>
  Promise<{ stdout: string; exitCode: number }>;
const docker = jest.mocked<DockerExec>(execa);

describe('Docker pre-command observation (deterministic shell transport fixture)', () => {
  let directory: string;
  let config: WrapperConfig;
  let fixtureEnv: NodeJS.ProcessEnv;
  const processes: execa.ExecaChildProcess<string>[] = [];
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-docker-harness-'));
    for (const name of ['control', 'bin', 'workspace', 'api-proxy-logs']) {
      fs.mkdirSync(path.join(directory, name));
    }
    fs.mkdirSync(path.join(directory, 'control/probe'));
    config = {
      workDir: directory, allowedDomains: [], logLevel: 'error', keepContainers: false,
      enableApiProxy: true, agentCommand: 'copilot --fixture',
    };
    fixtureEnv = {
      ...process.env, PATH: `${directory}/bin:${process.env.PATH}`,
      AWF_CHROOT_ENABLED: 'false', FIXTURE_DIRECTORY: directory, FIXTURE_ENV: 'command-environment',
    };
    fs.writeFileSync(path.join(directory, 'shell-startup'), 'export FIXTURE_ENV="$FIXTURE_ENV:startup"\n');
    fixtureEnv.BASH_ENV = path.join(directory, 'shell-startup');
    // macOS has no GNU timeout. This test-only process-group supervisor exercises
    // the same 10s/1s bounds; it is not evidence of live Linux/container execution.
    fs.writeFileSync(path.join(directory, 'bin/timeout'), `#!${process.execPath}
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const child = spawn(args[3], args.slice(4), { stdio: 'inherit', detached: true });
let expired = false;
let kill;
const timer = setTimeout(() => {
  expired = true;
  process.kill(-child.pid, 'SIGTERM');
  kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
}, 10000);
child.on('exit', code => {
  clearTimeout(timer);
  if (kill) clearTimeout(kill);
  process.exit(expired ? 124 : (code === null ? 137 : code));
});
`, { mode: 0o700 });
    writeHarness('printf "1.2.3\\n"');
    docker.mockImplementation((_file, args, options) => {
      if (!Array.isArray(args)) throw new Error('Expected Docker argv');
      if (args[0] === 'inspect') return Promise.resolve({ stdout: 'true', exitCode: 0 });
      expect(args.slice(0, 9)).toEqual([
        'exec', '--user', '0:0', 'awf-agent', '/bin/bash', '--noprofile', '--norc', '-p', '-c',
      ]);
      return actualExeca('/bin/bash', [
        '--noprofile', '--norc', '-p', '-c', translate(args[9]), ...args.slice(10),
      ], { ...options, env: { ...options?.env, ...fixtureEnv } });
    });
  });
  afterEach(async () => {
    for (const child of processes.splice(0)) {
      if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, 'SIGTERM');
      await child.catch(() => undefined);
    }
    setAwfDockerHost(undefined);
    jest.clearAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function translate(script: string): string {
    return script.split('/host/run/awf-harness').join(`${directory}/control`)
      .split('/run/awf-harness').join(`${directory}/control`)
      .split('/usr/bin/timeout').join(`${directory}/bin/timeout`);
  }
  function writeHarness(version: string): void {
    fs.writeFileSync(path.join(directory, 'bin/copilot'), `#!/bin/bash
if [ "$1" = --version ]; then
  phase=probe
else
  phase=command
fi
{ id -u; id -g; printf '%s\\n' "$PWD" "$PATH" "$FIXTURE_ENV"; } >"$FIXTURE_DIRECTORY/$phase-context"
if [ "$phase" = probe ]; then
  ${version}
else
  printf 'command-output\\n'
  exit 23
fi
`, { mode: 0o700 });
  }
  function launch(transform: (script: string) => string = script => script) {
    const script = transform(translate(withDockerHarnessObservation(
      config, harnessContext(config), config.agentCommand,
    )));
    const child = actualExeca('/bin/bash', ['-c', script], {
      env: fixtureEnv, cwd: `${directory}/workspace`, reject: false, detached: true,
    });
    processes.push(child);
    return child;
  }
  function controller() {
    return createDockerHarnessObservation(config, harnessContext(config))!;
  }
  function report() {
    return JSON.parse(fs.readFileSync(`${directory}/api-proxy-logs/harness-observation.json`, 'utf8'));
  }

  it.each(['standard', 'arc-dind'] as const)(
    'publishes before release with matching command identity/env/PATH/cwd and exit/output on %s',
    async runnerTopology => {
      config.runnerTopology = runnerTopology;
      if (runnerTopology === 'arc-dind') {
        config.dockerHostPathPrefix = '/daemon-runner';
        setAwfDockerHost('tcp://127.0.0.1:2375');
      }
      // Transport itself must not use a host bind mount or runner path.
      const observation = controller();
      const child = launch();
      prepareHarnessObservation(config);
      expect(report()).toMatchObject({ status: 'unavailable', reason: 'probe_pending' });
      await observeHarness(config, observation.probeHarness);
      expect(report()).toMatchObject({
        ...harnessContext(config), status: 'observed', version: '1.2.3',
        resolvedBinary: `${directory}/bin/copilot`,
      });
      expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
      await observation.releaseHarness();
      const result = await child;
      expect(result.exitCode).toBe(23);
      expect(result.stdout).toBe('command-output');
      expect(fs.readFileSync(`${directory}/probe-context`, 'utf8'))
        .toBe(fs.readFileSync(`${directory}/command-context`, 'utf8'));
      expect(fs.readFileSync(`${directory}/probe-context`, 'utf8'))
        .toContain(`${directory}/workspace\n`);
      expect(docker.mock.calls[0][2]?.env?.DOCKER_HOST)
        .toBe(runnerTopology === 'arc-dind' ? 'tcp://127.0.0.1:2375' : process.env.DOCKER_HOST);
      expect(docker.mock.calls[0][1]?.join(' ')).not.toContain('/daemon-runner');
    },
  );
  it.each([
    ['printf "malformed-secret\\n"; printf "stderr-secret\\n" >&2', 'probe_output_invalid'],
    ['exit 7', 'probe_failed'],
    ['printf "%5000s" x', 'probe_output_limit'],
  ])('keeps bad evidence unverified and allows unconstrained legacy execution: %s', async (version, reason) => {
    writeHarness(version);
    const observation = controller();
    const child = launch();
    await observeHarness(config, observation.probeHarness);
    expect(report()).toMatchObject({ status: 'unavailable', reason });
    expect(JSON.stringify(report())).not.toContain('secret');
    if (reason === 'probe_output_limit') {
      expect(fs.statSync(`${directory}/control/probe/stdout`).size).toBe(4097);
    }
    await observation.releaseHarness();
    expect((await child).exitCode).toBe(23);
  });
  it('classifies a missing selected binary without substituting a host executable', async () => {
    config.agentCommand = `${directory}/missing/copilot`;
    const observation = controller();
    const child = launch();
    const value = await observeHarness(config, observation.probeHarness);
    expect(value).toMatchObject({ status: 'unavailable', reason: 'binary_missing' });
    await observation.releaseHarness();
    expect((await child).exitCode).toBe(127);
  });
  it('bounds the actual probe at ten seconds before permitting unconstrained execution', async () => {
    writeHarness('sleep 30; printf "1.2.3\\n"');
    const observation = controller();
    const child = launch();
    const start = Date.now();
    await observeHarness(config, observation.probeHarness);
    expect(Date.now() - start).toBeGreaterThanOrEqual(9900);
    expect(Date.now() - start).toBeLessThan(13000);
    expect(report()).toMatchObject({ status: 'unavailable', reason: 'probe_timed_out' });
    expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
    await observation.releaseHarness();
    expect((await child).exitCode).toBe(23);
  }, 15000);
  it('fails closed on a missing release, and cleanup can stop a waiting command', async () => {
    const observation = controller();
    const child = launch(script => script.replace('n<1200', 'n<2'));
    await observeHarness(config, observation.probeHarness);
    expect((await child).exitCode).toBe(125);
    expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
    expect((await child).stderr).toContain('release timed out');
    const waiting = launch();
    await observeHarness(config, controller().probeHarness);
    process.kill(-waiting.pid!, 'SIGTERM');
    await waiting;
    expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
  });
  it('rejects readiness failure, malformed/wrong-run evidence and cancellation without release', async () => {
    for (const stdout of ['', 'other-run\n0\n/path/copilot\n1.2.3\n', `${harnessContext(config).environment}\nbad\n`]) {
      docker.mockResolvedValueOnce({ stdout, exitCode: 0 });
      const observation = controller();
      expect(await observeHarness(config, observation.probeHarness))
        .toMatchObject({ status: 'unavailable', reason: 'probe_failed' });
      await expect(observation.releaseHarness()).rejects.toThrow('not ready');
    }
    docker.mockResolvedValueOnce({ stdout: '', exitCode: 124 });
    const notReady = controller();
    await expect(notReady.probeHarness('ignored')).rejects.toThrow('readiness failed');
    await expect(notReady.releaseHarness()).rejects.toThrow('not ready');
    const observation = controller();
    docker.mockResolvedValueOnce({
      stdout: `${harnessContext(config).environment}\n0\n/path/copilot\n1.2.3\n`, exitCode: 0,
    });
    await observation.probeHarness('ignored');
    docker.mockRejectedValueOnce(new Error('backend-secret'));
    await expect(observation.releaseHarness()).rejects.toThrow(
      'Docker harness observation release failed; command not started.',
    );
  });
  it('does not gate opaque selections, external backends or historical non-product runtimes', () => {
    for (const agentCommand of ['bash -c copilot', 'env copilot', 'copilot | tee output']) {
      const candidate = { ...config, agentCommand };
      expect(withDockerHarnessObservation(candidate, harnessContext(candidate), agentCommand)).toBe(agentCommand);
      expect(createDockerHarnessObservation(candidate, harnessContext(candidate))).toBeUndefined();
    }
    for (const containerRuntime of ['nvx', 'cloud-hypervisor', 'sbx', 'gvisor', 'kata']) {
      expect(supportsDockerHarnessObservation({ ...config, containerRuntime })).toBe(false);
    }
    expect(dockerHarnessTmpfs('1001', '1002')).toEqual([
      '/run/awf-harness:rw,noexec,nosuid,nodev,size=64k,mode=0711,uid=0,gid=0',
      '/run/awf-harness/probe:rw,noexec,nosuid,nodev,size=64k,mode=0700,uid=1001,gid=1002',
      '/host/run/awf-harness:rw,noexec,nosuid,nodev,size=64k,mode=0711,uid=0,gid=0',
      '/host/run/awf-harness/probe:rw,noexec,nosuid,nodev,size=64k,mode=0700,uid=1001,gid=1002',
    ]);
  });
  it('preserves entrypoint/preflight exit collection only for this run and an already stopped agent', async () => {
    for (const state of ['true', 'false other-run', `false ${harnessContext(config).environment}`]) {
      const observation = controller();
      docker.mockResolvedValueOnce({ stdout: '', exitCode: 1 });
      await observeHarness(config, observation.probeHarness);
      docker.mockResolvedValueOnce({ stdout: state, exitCode: 0 });
      if (state === `false ${harnessContext(config).environment}`) {
        await expect(observation.releaseHarness()).resolves.toBeUndefined();
      } else {
        await expect(observation.releaseHarness()).rejects.toThrow('not ready');
      }
      expect(docker.mock.calls[docker.mock.calls.length - 1][1][0]).toBe('inspect');
      expect(fs.existsSync(`${directory}/control/allow`)).toBe(false);
    }
  });
  it.each([
    ['claude', '2.1.3 (Claude Code)', '2.1.3'],
    ['codex', 'codex-cli 0.89.0', '0.89.0'],
    ['./copilot', '1.2.3', '1.2.3'],
  ])('uses the canonical parser for direct %s in the command cwd', async (binary, output, version) => {
    const filename = path.resolve(`${directory}/workspace`, binary);
    fs.writeFileSync(filename, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o700 });
    config.agentCommand = binary;
    fixtureEnv.PATH = `${directory}/workspace:${fixtureEnv.PATH}`;
    const observation = controller();
    const child = launch();
    const result = await observation.probeHarness(probeCommand(selectHarness(binary)!));
    expect(parseProbe(harnessContext(config), result)).toMatchObject({ status: 'observed', version });
    await observation.releaseHarness();
    expect((await child).exitCode).toBe(0);
  });
});
