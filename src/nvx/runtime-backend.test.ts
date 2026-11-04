import type { WrapperConfig } from '../types';
import fs from 'fs';
import os from 'os';
import path from 'path';
import execa from 'execa';
import { harnessContext, observeHarness, prepareHarnessObservation } from '../harness-observation';
import { validateCopilotModel } from '../copilot-model';
import * as copilotModels from '../copilot-model';
import { buildNvxKernelCommandLine } from './one-shot-arguments';
import type { MicrovmInfrastructureSnapshot } from '../microvm/infrastructure';
import type { NvxOneShotExecutionResult } from './one-shot-adapter';
import { withInputPreflight } from '../input-preflight';
import { shellSingleQuote } from '../cloud-hypervisor/backend-utils';
import {
  nvxRuntimeTestHelpers,
  type NvxRuntimeBackendDependencies,
} from './runtime-backend';

const originalPlatform = process.platform;
const originalArch = process.arch;

function nvxConfig(): WrapperConfig {
  return {
    containerRuntime: 'nvx',
    workDir: '/tmp/awf-work',
    agentCommand: 'echo hello',
    networkIsolation: true,
    legacySecurity: false,
    enableApiProxy: true,
    enableDind: false,
    enableHostAccess: false,
    tty: false,
    nvx: {
      previewEnabled: true,
      mountPolicy: 'workspace-only',
      layerPath: '/opt/nvx/distro.layer',
      artifactManifestPath: '/opt/nvx/manifest.json',
      artifactManifestBundlePath: '/opt/nvx/manifest.sigstore.jsonl',
      openvmmPath: '/opt/nvx/openvmm',
      kernelPath: '/opt/nvx/kernel',
      initramfsPath: '/opt/nvx/initramfs',
      memoryMib: 512,
      memoryMaxBytes: 512 * 1024 * 1024,
      pidsMax: 128,
    },
  } as WrapperConfig;
}

function infrastructureSnapshot(): MicrovmInfrastructureSnapshot {
  return {
    networkId: 'awf-nvx-net',
    bridgeName: 'awf-nvx0',
    subnet: '172.31.0.0/24',
    gateway: '172.31.0.1',
    squidIp: '172.31.0.10',
    apiProxyIp: '172.31.0.30',
    topologyPeerIps: {},
    revalidate: jest.fn().mockResolvedValue(undefined),
  };
}

function harness(overrides: Partial<NvxRuntimeBackendDependencies> = {}) {
  const executeMock = jest.fn<Promise<NvxOneShotExecutionResult>, []>().mockResolvedValue({
    exitCode: 0,
    category: 'success',
    signal: null,
    timedOut: false,
    rawStdoutTail: Buffer.alloc(0),
    rawStderrTail: Buffer.alloc(0),
  } as NvxOneShotExecutionResult);
  const manager = { execute: executeMock };
  const createManager = jest.fn().mockReturnValue(manager) as unknown as
    NvxRuntimeBackendDependencies['createManager'];

  const dependencies: NvxRuntimeBackendDependencies = {
    startInfrastructure: jest.fn().mockResolvedValue(undefined),
    resolveTrustedIpTool: jest.fn().mockResolvedValue('/usr/sbin/ip'),
    resolveInfrastructure: jest.fn().mockResolvedValue(infrastructureSnapshot()),
    createManager,
    identity: jest.fn().mockReturnValue({ uid: 1000, gid: 1000 }),
    resolveExports: jest.fn().mockResolvedValue([
      { tag: 'workspace', source: '/home/runner/work/repo', target: '/workspace', mode: 'rw' },
    ]),
    planLiveMounts: jest.fn().mockResolvedValue({
      mounts: [{
        tag: 'workspace',
        guestTarget: '/workspace',
        hostPath: '/home/runner/work/repo',
        mode: 'rw',
        deniedPaths: [],
        allowedPaths: [],
        writablePaths: [],
      }],
      writePlan: {},
    }),
    createGuestConfigLayer: jest.fn().mockReturnValue({
      stage: jest.fn().mockResolvedValue('/tmp/awf-work/nvx-guest-layer/custom-layer'),
      cleanup: jest.fn().mockResolvedValue(undefined),
    }) as unknown as NvxRuntimeBackendDependencies['createGuestConfigLayer'],
    randomRunId: jest.fn().mockReturnValue('a'.repeat(32)),
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
    ...overrides,
  };

  return { dependencies, executeMock, createManager, manager };
}

describe('NvxRuntimeBackend', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
  });

  describe('NVX one-shot selected-harness shell transport fixture (not live NVX)', () => {
    let directory: string;
    let config: WrapperConfig;
    let backend: ReturnType<typeof nvxRuntimeTestHelpers.createBackendWithDependencies>;
    let guestScript: string;
    let child: execa.ExecaChildProcess<string> | undefined;
    let managerConfig: Parameters<NvxRuntimeBackendDependencies['createManager']>[0];
    let createManager: jest.Mock;

    beforeEach(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-nvx-observation-test-'));
      for (const name of ['bin', 'workspace', 'api-proxy-logs']) fs.mkdirSync(path.join(directory, name));
      config = {
        ...nvxConfig(), workDir: directory, allowedDomains: [], logLevel: 'error', keepContainers: false,
        agentCommand: 'copilot --fixture',
        additionalEnv: {
          FIXTURE_DIRECTORY: directory, FIXTURE_ENV: 'command-env',
        },
      };
      writeHarness('copilot', 'printf "1.2.3\\n"');
      createManager = jest.fn(options => {
        managerConfig = options;
        return {
          execute: async () => {
            let script = guestScript.split('/tmp/awf-home').join(`${directory}/home`)
              .split('/home/awf').join(`${directory}/seed`)
              .split("cd '/workspace'").join(`cd '${directory}/workspace'`);
            // Map distro-installed fixture binaries onto the generated guest PATH.
            script = script.replace("export PATH='", `export PATH='${directory}/bin:`);
            for (const mount of options.execution.mounts) {
              if (mount.tag.startsWith('harness-')) {
                script = script.split(mount.guestTarget).join(mount.hostPath);
              }
            }
            child = execa('/bin/sh', ['-c', script], {
              env: {}, extendEnv: false, reject: false, detached: true,
            });
            const abort = () => { if (child?.pid) process.kill(-child.pid, 'SIGTERM'); };
            options.execution.abortSignal.addEventListener('abort', abort, { once: true });
            if (options.execution.abortSignal.aborted) abort();
            try {
              const result = await child;
              return {
                exitCode: result.signal ? 130 : result.exitCode,
                category: result.signal ? 'cancelled' : 'success', signal: result.signal,
                timedOut: false, rawStdoutTail: Buffer.from(result.stdout),
                rawStderrTail: Buffer.from(result.stderr),
              };
            } finally {
              options.execution.abortSignal.removeEventListener('abort', abort);
            }
          },
        };
      });
      const { dependencies } = harness({
        identity: () => ({ uid: process.getuid!(), gid: process.getgid!() }),
        createManager: createManager as NvxRuntimeBackendDependencies['createManager'],
        createGuestConfigLayer: options => {
          guestScript = options.runScript;
          return { stage: async () => '', cleanup: async () => undefined } as never;
        },
      });
      backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);
    });

    afterEach(async () => {
      await backend.stop();
      jest.restoreAllMocks();
      fs.rmSync(directory, { recursive: true, force: true });
      child = undefined;
    });

    function writeHarness(binary: string, version: string): void {
      fs.writeFileSync(path.join(directory, 'bin', binary), `#!/bin/sh
  if [ "$1" = --version ]; then phase=probe; else phase=command; fi
  { id -u; id -g; printf '%s\\n' "$PWD" "$PATH" "$FIXTURE_ENV"; } >"$FIXTURE_DIRECTORY/$phase-context"
  if [ "$phase" = probe ]; then
    ${version}
  else
    printf 'command-output\\n'
    exit 23
  fi
  `, { mode: 0o700 });
    }
    function report() {
      return JSON.parse(fs.readFileSync(`${directory}/api-proxy-logs/harness-observation.json`, 'utf8'));
    }
    async function observe() {
      prepareHarnessObservation(config);
      await backend.start(directory, []);
      return observeHarness(config, backend.probeHarness);
    }
    function assertCleaned() {
      for (const mount of managerConfig.execution.mounts!.filter(m => m.tag.startsWith('harness-'))) {
        expect(fs.existsSync(path.dirname(mount.hostPath))).toBe(false);
      }
    }

    it.each([
      ['copilot', 'copilot-cli', '1.2.3'],
      ['claude', 'claude-code', '2.1.3 (Claude Code)'],
      ['codex', 'codex-cli', 'codex-cli 0.89.0'],
    ])('observes only selected %s before release, matching identity/env/PATH/non-login shell/cwd', async (binary, name, version) => {
      config.agentCommand = `${binary} --fixture`;
      writeHarness(binary, `printf '%s\\n' '${version}'`);
      const observed = await observe();
      expect(observed).toMatchObject({ ...harnessContext(config), name, status: 'observed' });
      expect(report()).toEqual(observed);
      expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
      expect(createManager).toHaveBeenCalledTimes(1);
      expect(managerConfig.execution.mounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ tag: 'harness-probe', mode: 'rw' }),
        expect.objectContaining({ tag: 'harness-release', mode: 'ro' }),
      ]));
      // Adding the rendezvous must still fit the attested guest's x86 boot ABI.
      expect(() => buildNvxKernelCommandLine({
        ...managerConfig.execution,
        filesystem: { layers: [{ role: 'distro', uuid: '0'.repeat(36) }] },
      } as never)).not.toThrow();
      await backend.releaseHarness!();
      expect(await backend.exec(directory, [])).toEqual({ exitCode: 23 });
      expect(createManager).toHaveBeenCalledTimes(1);
      expect((await child!).stdout).toBe('command-output');
      expect(fs.readFileSync(`${directory}/probe-context`, 'utf8'))
        .toBe(fs.readFileSync(`${directory}/command-context`, 'utf8'));
      assertCleaned();
    });

    it.each([
      ['printf "malformed-secret\\n"; printf "stderr-secret\\n" >&2', 'probe_output_invalid'],
      ['exit 7', 'probe_failed'],
      ['printf "%5000s" x', 'probe_output_limit'],
    ])('sanitizes failed probes and preserves unconstrained legacy admission: %s', async (version, reason) => {
      writeHarness('copilot', version);
      await observe();
      expect(report()).toMatchObject({ status: 'unavailable', reason });
      expect(JSON.stringify(report())).not.toContain('secret');
      await backend.releaseHarness!();
      expect(await backend.exec(directory, [])).toEqual({ exitCode: 23 });
      assertCleaned();
    });

    it.each([
      ['printf "1.2.3\\n"', true, ''],
      ['printf "1.0.0\\n"', false, 'harness_incompatible'],
      ['printf "malformed\\n"', false, 'harness_unverified'],
    ])('enforces only test-owned host requirements before releasing the real command: %s', async (version, admitted, error) => {
      config.additionalEnv!.COPILOT_MODEL = 'gpt-6-sol';
      config.copilotGithubToken = 'fixture-token';
      const actualValidation = validateCopilotModel;
      jest.spyOn(copilotModels, 'validateCopilotModel').mockImplementation((model, evidence) =>
        actualValidation(model, {
          ...evidence, harnesses: [{
            scope: { provider: 'copilot', channel: 'copilot-cli' }, name: 'copilot-cli',
            minimum: '1.2.0', scheme: 'semver', reason: 'Test-owned NVX fixture requirement',
            provenance: { authority: 'maintained' },
          }],
        }));
      writeHarness('copilot', version);
      if (admitted) {
        await observe();
        await backend.releaseHarness!();
        expect(await backend.exec(directory, [])).toEqual({ exitCode: 23 });
      } else {
        await expect(observe()).rejects.toThrow(error);
        expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
        await backend.stop();
      }
      assertCleaned();
    });

    it('bounds the guest version pipeline at ten seconds, then keeps legacy admission', async () => {
      writeHarness('copilot', `trap '' TERM
printf '%s\\n' "$$" >"$FIXTURE_DIRECTORY/probe-pid"
sleep 30
printf "1.2.3\\n"`);
      const started = Date.now();
      await observe();
      expect(Date.now() - started).toBeGreaterThanOrEqual(9900);
      expect(Date.now() - started).toBeLessThan(13000);
      expect(report()).toMatchObject({ status: 'unavailable', reason: 'probe_timed_out' });
      const pid = Number(fs.readFileSync(`${directory}/probe-pid`, 'utf8'));
      // A killed child can briefly remain as a zombie until the fixture's init reaps it.
      const stat = fs.existsSync(`/proc/${pid}/stat`) ? fs.readFileSync(`/proc/${pid}/stat`, 'utf8') : '';
      expect(stat === '' || stat.split(' ')[2] === 'Z').toBe(true);
      await backend.releaseHarness!();
      expect(await backend.exec(directory, [])).toEqual({ exitCode: 23 });
      assertCleaned();
    }, 15000);

    it('collects an early startup exit without waiting for a persistent ready guest or releasing user code', async () => {
      createManager.mockImplementation(() => ({
        execute: async () => ({ exitCode: 42, category: 'failure', signal: null }),
      }));
      await observe();
      expect(report()).toMatchObject({ status: 'unavailable', reason: 'probe_failed' });
      await backend.releaseHarness!();
      expect(await backend.exec(directory, [])).toEqual({ exitCode: 42 });
      expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
    });

    it('cancels a guest waiting at the gate and collects its final exit and channel cleanup', async () => {
      await observe();
      await backend.stop();
      expect(await backend.exec(directory, [])).toEqual({ exitCode: 130 });
      expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
      assertCleaned();
    });

    it('does not execute a second guest when startup rejects', async () => {
      createManager.mockImplementation(() => ({ execute: async () => { throw new Error('startup failed'); } }));
      await observe();
      expect(report()).toMatchObject({ status: 'unavailable', reason: 'probe_failed' });
      await backend.releaseHarness!();
      await expect(backend.exec(directory, [])).rejects.toThrow('startup failed');
      expect(createManager).toHaveBeenCalledTimes(1);
    });

    it('kills background probe helpers even when version execution succeeds', async () => {
      writeHarness('copilot', `( trap '' TERM; exec sleep 30 ) >/dev/null 2>&1 &
printf '%s\\n' "$!" >"$FIXTURE_DIRECTORY/helper-pid"
printf '1.2.3\\n'`);
      await observe();
      expect(report()).toMatchObject({ status: 'observed' });
      const pid = Number(fs.readFileSync(`${directory}/helper-pid`, 'utf8'));
      const stat = fs.existsSync(`/proc/${pid}/stat`) ? fs.readFileSync(`/proc/${pid}/stat`, 'utf8') : '';
      expect(stat === '' || stat.split(' ')[2] === 'Z').toBe(true);
      await backend.releaseHarness!();
      expect(await backend.exec(directory, [])).toEqual({ exitCode: 23 });
      assertCleaned();
    });

    it('cancels during version execution without waiting for the readiness deadline', async () => {
      writeHarness('copilot', 'sleep 30');
      const observation = observe();
      while (!fs.existsSync(`${directory}/probe-context`)) await new Promise(resolve => setTimeout(resolve, 10));
      await backend.stop();
      await observation;
      expect(report()).toMatchObject({ status: 'unavailable', reason: 'probe_failed' });
      expect(await backend.exec(directory, [])).toEqual({ exitCode: 130 });
      expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
      assertCleaned();
    });

    it('treats a missing binary as unverified, never substituting another harness', async () => {
      config.agentCommand = './copilot --fixture';
      await observe();
      expect(report()).toMatchObject({ status: 'unavailable', reason: 'binary_missing' });
      await backend.releaseHarness!();
      expect(await backend.exec(directory, [])).toEqual({ exitCode: 127 });
      assertCleaned();
    });

    it('resolves a relative selected executable in the command cwd', async () => {
      fs.copyFileSync(`${directory}/bin/copilot`, `${directory}/workspace/copilot`);
      config.agentCommand = './copilot --fixture';
      await observe();
      expect(report()).toMatchObject({ status: 'observed', resolvedBinary: './copilot' });
      await backend.releaseHarness!();
      expect(await backend.exec(directory, [])).toEqual({ exitCode: 23 });
      assertCleaned();
    });

    it('never releases on an invalid run binding and cleans up the waiting guest', async () => {
      createManager.mockImplementation(options => {
        managerConfig = options;
        const probe = options.execution.mounts.find((mount: { tag: string }) => mount.tag === 'harness-probe');
        fs.writeFileSync(`${probe.hostPath}/result`, 'wrong-environment\n0\n/bin/copilot\n1.2.3\n');
        return {
          execute: () => new Promise(resolve => options.execution.abortSignal.addEventListener('abort',
            () => resolve({ exitCode: 130 }), { once: true })),
        };
      });
      await observe();
      expect(report()).toMatchObject({ status: 'unavailable', reason: 'probe_failed' });
      await expect(backend.releaseHarness!()).rejects.toThrow('not ready');
      await backend.stop();
      expect(fs.existsSync(`${directory}/command-context`)).toBe(false);
      assertCleaned();
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
  });

  it('includes declared input checks in the privilege-dropped guest run script', async () => {
    const config = { ...nvxConfig(), inputDirs: ['/workspace/inputs'] };
    const { dependencies } = harness();
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);
    await backend.start(config.workDir, ['example.com']);
    await backend.exec(config.workDir, ['example.com']);
    expect(dependencies.createGuestConfigLayer).toHaveBeenCalledWith(expect.objectContaining({
      runScript: expect.stringContaining(shellSingleQuote(withInputPreflight(config.agentCommand, config.inputDirs))),
    }));
  });

  it('starts host infrastructure and resolves microVM infrastructure using a trusted ip tool before executing', async () => {
    const { dependencies } = harness();
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(nvxConfig(), dependencies);

    const onNetworkReady = jest.fn();
    const onInfrastructureReady = jest.fn();
    await backend.start(
      '/tmp/awf-work',
      ['example.com'],
      '/tmp/awf-work/logs',
      false,
      onNetworkReady,
      onInfrastructureReady,
    );

    expect(dependencies.startInfrastructure).toHaveBeenCalledWith(
      '/tmp/awf-work',
      ['example.com'],
      '/tmp/awf-work/logs',
      false,
      onNetworkReady,
      onInfrastructureReady,
    );
    expect(dependencies.resolveTrustedIpTool).toHaveBeenCalled();
    expect(dependencies.resolveInfrastructure).toHaveBeenCalledWith(true, '/usr/sbin/ip', undefined);
  });


  it('rejects preflight when the preview flag is not set, without falling back', async () => {
    const { dependencies } = harness();
    const config = nvxConfig();
    config.nvx = { ...config.nvx!, previewEnabled: false };
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);

    await expect(backend.preflight()).rejects.toThrow(/explicit --nvx-preview opt-in/);
    expect(dependencies.startInfrastructure).not.toHaveBeenCalled();
  });

  it('rejects an agent timeout beyond the supported maximum', async () => {
    const { dependencies } = harness();
    const config = nvxConfig();
    config.agentTimeout = 60 * 24 * 2; // two days, in minutes
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);

    await expect(backend.preflight()).rejects.toThrow(/--agent-timeout values up to/);
  });

  it('constructs the NvxManager with preserved command, identity, and limits, and returns the exit code unchanged', async () => {
    const { dependencies, createManager, executeMock } = harness();
    const createGuestConfigLayer = dependencies.createGuestConfigLayer as unknown as jest.Mock;
    const snapshot = infrastructureSnapshot();
    (snapshot as { topologyPeerIps: Record<string, string> }).topologyPeerIps = {
      gateway: '172.31.0.40',
    };
    (dependencies.resolveInfrastructure as jest.Mock).mockResolvedValue(snapshot);
    executeMock.mockResolvedValue({
      exitCode: 42,
      category: 'success',
      signal: null,
      timedOut: false,
      rawStdoutTail: Buffer.alloc(0),
      rawStderrTail: Buffer.alloc(0),
    } as NvxOneShotExecutionResult);
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(nvxConfig(), dependencies);

    await backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn());
    const result = await backend.exec('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', 10);

    expect(result).toEqual({ exitCode: 42 });
    expect(snapshot.revalidate).toHaveBeenCalled();
    expect(createManager).toHaveBeenCalledTimes(1);
    const [managerConfig] = (createManager as unknown as jest.Mock).mock.calls[0];
    expect(managerConfig.execution.entrypoint).toBe('/etc/awf/nvx-run.sh');
    expect(managerConfig.execution.args).toEqual([]);
    expect(managerConfig.execution.workloadUid).toBe(1000);
    expect(managerConfig.execution.workloadGid).toBe(1000);
    expect(managerConfig.execution.memoryMib).toBe(512);
    expect(managerConfig.execution.memoryMaxBytes).toBe(512 * 1024 * 1024);
    expect(managerConfig.execution.pidsMax).toBe(128);
    expect(managerConfig.execution.mounts).toEqual([
      expect.objectContaining({
        guestTarget: '/workspace',
        hostPath: '/home/runner/work/repo',
        mode: 'rw',
      }),
    ]);
    expect(managerConfig.execution.timeoutMs).toBe(10 * 60_000);
    expect(managerConfig.filesystem.layers).toEqual([
      { role: 'distro', sourcePath: '/opt/nvx/distro.layer' },
    ]);
    expect(managerConfig.filesystem.scratchUid).toBe(1000);
    expect(managerConfig.filesystem.scratchGid).toBe(1000);
    expect(managerConfig.filesystem.maxScratchBytes).toBeUndefined();
    expect(managerConfig.preflight.manifestPath).toBe('/opt/nvx/manifest.json');
    expect(managerConfig.network.infrastructureBridge).toBe('awf-nvx0');
    expect(managerConfig.network.controlPeers).toEqual([
      { ip: '172.31.0.40', ports: [8080] },
    ]);
    expect(createGuestConfigLayer).toHaveBeenCalledWith(expect.objectContaining({
      hostAliases: {
        'api-proxy': '172.31.0.30',
        gateway: '172.31.0.40',
      },
    }));
  });

  it('rejects TTY execution before touching any resources', async () => {
    const { dependencies } = harness();
    const config = nvxConfig();
    config.tty = true;
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);

    await expect(
      backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn()),
    ).rejects.toThrow(/does not support --tty/);
    expect(dependencies.startInfrastructure).not.toHaveBeenCalled();
  });

  it('aborts an in-flight execution on stop() and does not throw', async () => {
    const { dependencies, executeMock } = harness();
    let capturedSignal: AbortSignal | undefined;
    executeMock.mockImplementation(() => new Promise((resolve, reject) => {
      // Simulate the manager reacting to abort by rejecting.
      const check = () => {
        if (capturedSignal?.aborted) {
          reject(new Error('aborted'));
        }
      };
      capturedSignal?.addEventListener('abort', check);
    }));
    const createManager = jest.fn((cfg: { execution: { abortSignal?: AbortSignal } }) => {
      capturedSignal = cfg.execution.abortSignal;
      return { execute: executeMock };
    }) as unknown as NvxRuntimeBackendDependencies['createManager'];
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(
      nvxConfig(),
      { ...dependencies, createManager },
    );

    await backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn());
    const execPromise = backend.exec('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', undefined);
    // The adapter resolves exports and plans the workspace write policy before
    // it constructs the manager, so yield until the abort signal is captured.
    while (!capturedSignal) await new Promise((resolve) => setImmediate(resolve));
    await expect(backend.stop()).resolves.toBeUndefined();
    await expect(execPromise).rejects.toThrow('aborted');
  });

  it('does not launch when stop occurs while live mounts are being planned', async () => {
    let releasePlanning!: () => void;
    const planning = new Promise<void>((resolve) => {
      releasePlanning = resolve;
    });
    const { dependencies, createManager } = harness({
      planLiveMounts: jest.fn(async () => {
        await planning;
        return {
          mounts: [],
          writePlan: {},
        } as never;
      }),
    });
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(
      nvxConfig(),
      dependencies,
    );

    await backend.start(
      '/tmp/awf-work',
      ['example.com'],
      '/tmp/awf-work/logs',
      false,
      jest.fn(),
      jest.fn(),
    );
    const execution = backend.exec(
      '/tmp/awf-work',
      ['example.com'],
      '/tmp/awf-work/logs',
      undefined,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await expect(backend.stop()).resolves.toBeUndefined();
    releasePlanning();

    await expect(execution).rejects.toThrow(/aborted by shutdown/);
    expect(createManager).not.toHaveBeenCalled();
  });

  it('is a no-op diagnostics collector since NvxManager owns durable cleanup', async () => {
    const { dependencies } = harness();
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(nvxConfig(), dependencies);
    await expect(backend.collectDiagnostics()).resolves.toBeUndefined();
  });

  it('refuses to launch a new microVM if stop() was already called', async () => {
    const { dependencies, createManager } = harness();
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(nvxConfig(), dependencies);

    await backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn());
    await backend.stop();

    await expect(backend.exec('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', undefined))
      .rejects.toThrow(/aborted by shutdown/);
    expect(createManager).not.toHaveBeenCalled();
  });

  it('threads configured topology peers into infrastructure discovery', async () => {
    const { dependencies } = harness();
    const config = nvxConfig();
    config.topologyAttach = ['awf-enclave-github-mcp'];
    const backend = nvxRuntimeTestHelpers.createBackendWithDependencies(config, dependencies);

    await backend.start('/tmp/awf-work', ['example.com'], '/tmp/awf-work/logs', false, jest.fn(), jest.fn());

    expect(dependencies.resolveInfrastructure).toHaveBeenCalledWith(
      true,
      '/usr/sbin/ip',
      ['awf-enclave-github-mcp'],
    );
  });
});
