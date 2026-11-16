import { createHash } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from '../enclave/host-executor-server';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import {
  CloudHypervisorHostEnclaveExecutorBackend,
  type HostEnclaveExecutorDependencies,
  type HostEnclaveExecutorManager,
  type HostExecutorAgentPolicy,
  type VerifiedCloudHypervisorEnclaveArtifacts,
} from './host-enclave-executor';
import { readEnclaveSessionDiagnostics } from './enclave-session-diagnostics';
import type { CloudHypervisorCommonPreflightResult, CloudHypervisorHostToolPaths } from './preflight';
import type { CloudHypervisorWorkloadProfile } from './workload-profile';
import { GuestTransportError } from '../microvm/execution-diagnostics';

export interface StaticStagingScenario {
  role: 'script' | 'agent';
  timeoutMs: 60_000;
  startupDelayMs: 0;
  expectedOutcome: 'success';
  publicDebug: boolean;
  shared: boolean;
}

export interface DeadlineScenario {
  role: 'script';
  timeoutMs: 1_000;
  startupDelayMs: 1_500 | 2_500;
  expectedOutcome: 'success' | 'timeout';
  publicDebug: false;
  shared: false;
}

export type BackendScenario = StaticStagingScenario | DeadlineScenario;

export const staticStagingScenarios = [
  { role: 'script', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: false, shared: false },
  { role: 'agent', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: false, shared: false },
  { role: 'script', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: true, shared: false },
  { role: 'agent', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: true, shared: false },
  { role: 'script', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: false, shared: true },
  { role: 'agent', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: false, shared: true },
] as const satisfies readonly StaticStagingScenario[];

export const deadlineScenarios = [
  { role: 'script', timeoutMs: 1_000, startupDelayMs: 1_500, expectedOutcome: 'success', publicDebug: false, shared: false },
  { role: 'script', timeoutMs: 1_000, startupDelayMs: 2_500, expectedOutcome: 'timeout', publicDebug: false, shared: false },
] as const satisfies readonly DeadlineScenario[];

export const agentScenarios = staticStagingScenarios.filter(scenario => scenario.role === 'agent');
export const scriptScenarios = staticStagingScenarios.filter(scenario => scenario.role === 'script');

export async function createExecutorScratchDirectory(prefix = '.awf-enclave-result-'): Promise<string> {
  return fs.mkdtemp(path.join(process.cwd(), prefix));
}

export function useExecutorScratchDirectory(): { directory: string } {
  const scratch = { directory: '' };
  beforeEach(async () => {
    scratch.directory = await createExecutorScratchDirectory();
  });
  afterEach(async () => {
    await fs.rm(scratch.directory, { recursive: true, force: true });
  });
  return scratch;
}

interface BackendFixtureState {
  stopped: boolean;
  unmounted: boolean;
  snapshotRemoved: boolean;
  mountedIdentity?: { uid: number; gid: number };
  managerBinary?: string;
  snapshotNumber: number;
  managerStartError: boolean;
  managerExecuteError: boolean;
  managerStopError: boolean;
  managerResult: string;
  managerExecutionResult: { exitCode: number; signal: string | null; timedOut: boolean };
  abortOnExecute?: AbortController;
  expectHandoffCredentials: boolean;
  executionRequest?: Parameters<HostEnclaveExecutorManager['execute']>[0];
  workloadProfile?: CloudHypervisorWorkloadProfile;
  stagedHandoff?: { bearer: string };
}

export async function createBackendFixture(scenario: BackendScenario) {
  const { role, timeoutMs, startupDelayMs, publicDebug, shared } = scenario;
  // Invocation trust rejects /tmp; the home fixture also keeps Unix sockets short.
  const scratch = await fs.mkdtemp(path.join(os.homedir(), '.awf-backend-'));
  const root = await fs.realpath(scratch);
  const seedsDir = path.join(root, 'seeds');
  const invocationsDir = path.join(root, 'invocations');
  const seedId = 'c'.repeat(32);
  const entryId = `${role}-entry`;
  const invocationId = 'd'.repeat(32);
  await fs.mkdir(path.join(seedsDir, seedId), { recursive: true, mode: 0o700 });
  await fs.mkdir(invocationsDir, { mode: 0o700 });

  const runState: HostExecutorRunState = {
    runId: 'a'.repeat(32),
    seedsDir,
    invocationsDir,
    journalDir: path.join(root, 'journal'),
    entries: [{
      entryId,
      executorKind: role,
      timeoutMs,
      staticSeedIds: [seedId],
      dynamicAgents: false,
    }],
  };
  const invocationHostDir = path.join(invocationsDir, entryId, invocationId);
  const plan: HostExecutorInvocationPlan = {
    runId: runState.runId,
    entryId,
    invocationId,
    executorKind: role,
    timeoutMs,
    requestHash: 'e'.repeat(64),
    admissionId: 'f'.repeat(32),
    schemaHash: '1'.repeat(64),
    schema: { type: 'boolean' },
    payload: role === 'script' ? 'print(True)' : 'Return whether the task succeeded.',
    invocationHostDir,
    seedId,
    seedHostPath: path.join(seedsDir, seedId),
  };
  const tools = {
    rsync: '/usr/bin/rsync',
    mount: '/usr/bin/mount',
    umount: '/usr/bin/umount',
  } as CloudHypervisorHostToolPaths;
  const preflight = {
    version: '53.0',
    cloudHypervisorBinary: '/trusted/cloud-hypervisor',
    virtiofsdBinary: '/trusted/virtiofsd',
    kernelPath: '/trusted/vmlinux',
    supervisorPath: '/trusted/supervisor',
    artifactSnapshotDirectory: '/trusted/preflight',
    artifactDigests: {
      cloudHypervisor: 'a'.repeat(64),
      virtiofsd: 'b'.repeat(64),
      kernel: 'c'.repeat(64),
      supervisor: 'e'.repeat(64),
    },
    tools,
    cgroupVersion: 2,
    kvmGid: 978,
  } satisfies CloudHypervisorCommonPreflightResult;
  const makeArtifact = (artifactRole: 'script' | 'agent') => ({
    file: `enclave-${artifactRole}-rootfs.ext4`,
    role: artifactRole,
    version: 'v0.23.1',
    sha256: createHash('sha256').update('fixture-rootfs').digest('hex'),
    sizeBytes: Buffer.byteLength('fixture-rootfs'),
    uid: 65534,
    gid: 65534,
    entrypoint: `/usr/local/bin/run-enclave-${artifactRole}`,
    sourceImage: `ghcr.io/github/gh-aw-firewall/enclave-${artifactRole}@sha256:${'a'.repeat(64)}`,
    sourceImageDigest: 'a'.repeat(64),
    sbom: { file: `enclave-${artifactRole}-rootfs.sbom.spdx.json`, sha256: 'b'.repeat(64) },
  });
  const scriptArtifact = makeArtifact('script');
  const agentArtifact = makeArtifact('agent');
  const artifacts = {
    manifest: {
      schemaVersion: shared ? 2 : 1,
      release: { tag: 'v0.23.1' },
      rootfs: {
        script: { entrypoint: scriptArtifact.entrypoint },
        agent: { entrypoint: agentArtifact.entrypoint },
      },
    },
    manifestPath: '/trusted/manifest.json',
    manifestBundlePath: '/trusted/manifest.sigstore.jsonl',
    rootfs: {
      script: { path: '/trusted/enclave-script-rootfs.ext4', artifact: scriptArtifact },
      agent: { path: '/trusted/enclave-agent-rootfs.ext4', artifact: agentArtifact },
    },
  } as unknown as VerifiedCloudHypervisorEnclaveArtifacts;
  const agentPolicy: HostExecutorAgentPolicy = {
    model: 'gpt-4.1',
    profile: 'openai',
    maxOutputBytes: 4096,
    maxModelRequests: 5,
    maxModelTokens: 1000,
    githubBearer: `ghs_${'a'.repeat(40)}`,
    githubExpiresAt: Date.now() + 3_600_000,
    githubAllowedTools: ['issue_read', 'list_issues'],
  };
  const config: CloudHypervisorOptions = {
    previewEnabled: true,
    mountPolicy: 'workspace-only',
    cloudHypervisorBinary: '/trusted/cloud-hypervisor',
    artifactReleaseTag: 'v0.23.1',
    vcpuCount: 1,
    memoryMib: 768,
    apiTimeoutMs: 30_000,
    ...(publicDebug ? { enclaveDebugPublic: true } : {}),
  };
  const uid = process.getuid?.() || 1000;
  const gid = process.getgid?.() || 1000;
  const state: BackendFixtureState = {
    stopped: false,
    unmounted: false,
    snapshotRemoved: false,
    snapshotNumber: 0,
    managerStartError: false,
    managerExecuteError: false,
    managerStopError: false,
    managerResult: 'true',
    managerExecutionResult: { exitCode: 0, signal: null, timedOut: false },
    expectHandoffCredentials: true,
  };
  const chownedPaths: string[] = [];
  const sessionReads: Array<{ stopped: boolean; unmounted: boolean }> = [];
  const preservePublicSession = jest.fn().mockResolvedValue(undefined);
  const preservePublicArtifacts = jest.fn().mockResolvedValue(undefined);
  const backendOptions = {
    runState,
    config,
    workDir: root,
    preflight,
    enclaveArtifacts: artifacts,
    ...(publicDebug ? {
      publicDebugArtifactDirectory: '/protected/cloud-hypervisor',
      publicDebugArtifactProtectedRoot: '/protected',
    } : {}),
    ...(role === 'agent' ? { agentPolicies: { [entryId]: agentPolicy } } : {}),
  };
  const dependencies: Partial<HostEnclaveExecutorDependencies> = {
    preservePublicSession,
    preservePublicArtifacts,
    readSessionDiagnostics: async (directory, _uid, _gid, retain) => {
      const runtime = path.join(directory, 'session-state');
      const dir = await fs.stat(runtime);
      sessionReads.push({ stopped: state.stopped, unmounted: state.unmounted });
      // chown is intentionally mocked in this unprivileged backend fixture.
      return readEnclaveSessionDiagnostics(directory, dir.uid, dir.gid, retain);
    },
    createResourceJournal: async () => ({
      captureDirectory: async () => undefined,
      captureMount: async () => undefined,
      captureSnapshot: async () => undefined,
      prepareSnapshot: async () => undefined,
      verifyMount: async () => undefined,
      verifyDirectory: async () => undefined,
      verifySnapshot: async () => undefined,
      complete: async () => undefined,
    }),
    createArtifactSnapshot: async (_sources, _copy, onDirectoryCreated) => {
      expect(_sources.supervisorPath).toBe(preflight.supervisorPath);
      expect(_sources.rootfsPath).toBe(shared
        ? '/trusted/enclave-script-rootfs.ext4'
        : `/trusted/enclave-${role}-rootfs.ext4`);
      const directory = path.join(root, `snapshot-${++state.snapshotNumber}`);
      await fs.mkdir(directory, { mode: 0o700 });
      expect(typeof onDirectoryCreated).toBe('function');
      await onDirectoryCreated?.(directory);
      const rootfsPath = path.join(directory, 'rootfs.ext4');
      await fs.writeFile(rootfsPath, 'fixture-rootfs', { mode: 0o400 });
      return {
        directory,
        cloudHypervisorBinary: '/snapshot/cloud-hypervisor',
        virtiofsdBinary: '/snapshot/virtiofsd',
        kernelPath: '/snapshot/vmlinux',
        rootfsPath,
        supervisorPath: '/snapshot/supervisor',
      };
    },
    copySparseFile: async () => undefined,
    removeArtifactSnapshot: async (directory) => {
      state.snapshotRemoved = true;
      await fs.rm(directory, { recursive: true, force: true });
    },
    mountTmpfs: async (_directory, _size, mountUid, mountGid) => {
      state.mountedIdentity = { uid: mountUid, gid: mountGid };
    },
    verifyStorage: jest.fn().mockResolvedValue(undefined),
    unmount: async () => { state.unmounted = true; },
    chown: async (filePathValue) => { chownedPaths.push(filePathValue.toString()); },
    resolveIdentity: () => ({ uid, gid }),
    createManager: (managerConfig, _workDir, profile, _runId, _artifacts, managerDependencies, launchReport) => {
      expect(launchReport?.scope).toBe('vm-launch');
      state.managerBinary = managerConfig.cloudHypervisorBinary;
      state.workloadProfile = profile;
      expect(profile.guest?.identity).toEqual({ uid: 65534, gid: 65534 });
      expect(profile.artifact).toBe('enclave');
      expect(profile.rawOutput).toBe(publicDebug ? 'capture' : 'discard');
      if (publicDebug) {
        expect(managerDependencies?.enclaveDebugArtifactDirectory).toMatch(
          /^\/protected\/cloud-hypervisor\/[a-f0-9]+\/[a-f0-9]+$/,
        );
        expect(managerDependencies?.enclaveDebugArtifactProtectedRoot).toBe('/protected');
        expect(profile.guest?.exports.every((entry) => !entry.source.startsWith('/protected'))).toBe(true);
      }
      return {
        start: async () => {
          if (state.managerStartError) throw Object.assign(new Error('PRIVATE_LAUNCH_SENTINEL \u0042earer token'), { code: 'EPERM' });
          if (startupDelayMs > 0) {
            if (timeoutMs === 1000) {
              await jest.advanceTimersByTimeAsync(startupDelayMs);
            } else {
              await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
            }
          }
        },
        startInstance: async () => undefined,
        execute: async (request) => {
          state.executionRequest = request;
          expect(request.argv).toEqual([`/usr/local/bin/run-enclave-${role}`]);
          if (role === 'script') expect(request.env).toEqual(
            publicDebug ? { AWF_ENCLAVE_SCRIPT_DEBUG_PROGRESS: 'true' } : {},
          );
          request.onDiagnostics?.({
            phase: 'sending', elapsedMs: 0, framesReceived: 0, stdoutBytes: 0,
            stderrBytes: 0, pendingFrameBytes: 0, resultReceived: false,
          });
          if (role === 'agent') {
            for (let index = 0; index < 250; index++) {
              request.stderr?.write(Buffer.from(JSON.stringify({
                event: 'progress', stage: 'engine-started', padding: 'é'.repeat(80),
              }) + '\n'));
            }
            request.stderr?.write(Buffer.concat([
              Buffer.from('{"event":"progress","stage":"engine-started","padding":"'),
              Buffer.alloc(20 * 1024, 0x78),
              Buffer.from('"}\n'),
            ]));
            const fragmented = Buffer.from('{"event":"operation-error","operation":"session-log-close",'
              + '"category":"no-space","errno":28,"fatal":false,"note":"€"}\n');
            const split = fragmented.indexOf(Buffer.from('€')) + 1;
            request.stderr?.write(fragmented.subarray(0, split));
            request.stderr?.write(fragmented.subarray(split));
            request.stderr?.write('{"event":"failure","category":"result-empty","message":"PRIVATE_SESSION_TOKEN"}\n');
            const sessionPath = path.join(invocationHostDir, 'session-state', 'session.jsonl');
            await fs.writeFile(sessionPath,
              '{"event":"progress","stage":"engine-started","secret":"PRIVATE_SESSION_TOKEN"}\n');
            await fs.chmod(sessionPath, 0o600);
          }
          if (state.managerExecuteError) throw new GuestTransportError('guest-disconnected');
          if (role === 'agent' && state.expectHandoffCredentials) {
            state.stagedHandoff = {
              bearer: await fs.readFile(
                path.join(invocationHostDir, 'session-handoff', 'github-bearer'),
                'utf8',
              ),
            };
            expect(existsSync(path.join(invocationHostDir, 'session-handoff', 'github-agent-id')))
              .toBe(false);
          }
          const output = profile.guest?.exports.find(({ tag }) => tag === 'enclave-output')?.source;
          if (!output) throw new Error('expected the trusted output export');
          const outputStat = await fs.stat(path.join(output, 'out'));
          expect(outputStat.isFile()).toBe(true);
          expect(outputStat.mode & 0o777).toBe(0o600);
          await fs.writeFile(path.join(output, 'out'), 'false');
          state.abortOnExecute?.abort();
          return state.managerExecutionResult;
        },
        cancel: async () => undefined,
        stop: async () => {
          state.stopped = true;
          if (state.managerStopError) throw Object.assign(new Error('PRIVATE_CLEANUP_SENTINEL /private/repository'), { code: 'EIO' });
          const output = path.join(invocationHostDir, 'output', 'out');
          await fs.writeFile(output, state.managerResult);
        },
        completeCleanupRecord: async () => undefined,
      };
    },
  };
  const backend = new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, dependencies);
  if (timeoutMs === 1000) {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'hrtime', 'performance'] });
  }
  return {
    ...scenario,
    root, directory: root, seedId, entryId, invocationId, invocationHostDir,
    runState, plan, tools, preflight, scriptArtifact, agentArtifact, agentPolicy, config,
    state, chownedPaths, sessionReads, preservePublicSession, preservePublicArtifacts,
    backendOptions, dependencies, backend,
    close: async () => {
      try {
        await backend.close();
      } finally {
        if (timeoutMs === 1000) jest.useRealTimers();
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

export type BackendFixture = Awaited<ReturnType<typeof createBackendFixture>>;

export function useBackendFixture(scenario: BackendScenario): () => BackendFixture {
  let fixture: BackendFixture;
  beforeEach(async () => {
    fixture = await createBackendFixture(scenario);
  });
  afterEach(async () => {
    await fixture?.close();
  });
  return () => fixture;
}
