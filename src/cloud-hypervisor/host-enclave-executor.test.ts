import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_GITHUB_MCP_PORT,
} from '../enclave/network';
import { CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG } from './artifact-manifest';
import * as artifactTrust from './artifact-trust';
import { HostPreflightReporter, type HostPreflightCheck, type HostPreflightProgress } from './host-preflight-progress';
import * as cloudHypervisorPreflight from './preflight';
import {
  CloudHypervisorHostEnclaveExecutorBackend,
  createCloudHypervisorHostEnclaveExecutor,
  preflightCloudHypervisorEnclaveArtifacts,
  readBoundedCloudHypervisorEnclaveResult,
} from './host-enclave-executor';
import { agentEnvironment, stageInvocationInputs } from './enclave-invocation-staging';
import { readEnclaveSessionDiagnostics } from './enclave-session-diagnostics';
import {
  assertEnclaveStartupChecklistComplete, getEnclaveStartupProgress, updateEnclaveStartupProgress,
} from '../enclave/startup-progress';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import type { WrapperConfig } from '../types';
import { schema as preflightSchema } from './host-preflight-schema';
import { GuestTransportError } from '../microvm/execution-diagnostics';
import type { FiniteSchemaNode } from '../bounded-execution/finite-schema';
import type {
  HostExecutorInvocationPlan,
  HostExecutorRunState,
} from '../enclave/host-executor-server';
import { startHostExecutorServer } from '../enclave/host-executor-server';
import * as hostExecutorDiagnostics from '../enclave/host-executor-diagnostics';
import * as hostExecutorResourceJournal from '../enclave/host-executor-resource-journal';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { CloudHypervisorCleanupRegistry } from './cleanup-registry';
import type {
  CloudHypervisorCommonPreflightResult,
  CloudHypervisorHostToolPaths,
} from './preflight';
import { cloudHypervisorManagerTestHelpers } from './manager';
import type {
  HostEnclaveExecutorDependencies,
  HostEnclaveExecutorManager,
  HostExecutorAgentPolicy,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from './host-enclave-executor';
import type { CloudHypervisorWorkloadProfile } from './workload-profile';
import { HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
/* eslint-disable @typescript-eslint/no-require-imports */
const { decodeCapability } = require('../../containers/api-proxy/enclave-model-budget');
/* eslint-enable @typescript-eslint/no-require-imports */

describe('readBoundedCloudHypervisorEnclaveResult', () => {
  let directory: string;

  it('rejects the host GitHub token in the enclave bearer file before staging inputs', async () => {
    const previousToken = process.env.GITHUB_PAT;
    const token = 'host-github-token-value';
    process.env.GITHUB_PAT = token;
    const writeFile = jest.fn();
    const plan: HostExecutorInvocationPlan = {
      runId: 'a'.repeat(32),
      entryId: 'agent-entry',
      invocationId: 'b'.repeat(32),
      executorKind: 'agent',
      timeoutMs: 1000,
      requestHash: 'c'.repeat(64),
      admissionId: 'd'.repeat(32),
      schemaHash: 'e'.repeat(64),
      schema: { type: 'boolean' },
      payload: 'test',
      invocationHostDir: '/tmp/awf-enclave-invocation',
      seedId: 'f'.repeat(32),
      seedHostPath: '/tmp/awf-enclave-seed',
    };
    const policy: HostExecutorAgentPolicy = {
      model: 'trusted-model',
      profile: 'openai',
      maxOutputBytes: 4096,
      githubAgentId: 'trusted-agent-id',
      githubBearer: token,
      githubExpiresAt: Date.now() + 300_000,
      githubAllowedTools: ['issue_read', 'list_issues'],
    };

    try {
      await expect(stageInvocationInputs(plan, 'agent', policy, {
        writeFile,
        chown: jest.fn(),
        chmod: jest.fn(),
      })).rejects.toThrow(/host GitHub token through Cloud Hypervisor enclave GitHub bearer file/);
      expect(writeFile).not.toHaveBeenCalled();
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_PAT;
      else process.env.GITHUB_PAT = previousToken;
    }
  });

  it('rejects a host GitHub token copied into the enclave guest environment', () => {
    const previousToken = process.env.GITHUB_PAT;
    const token = 'host-github-token-value';
    process.env.GITHUB_PAT = token;
    const policy: HostExecutorAgentPolicy = {
      model: token,
      profile: 'openai',
      maxOutputBytes: 4096,
    };
    const plan: HostExecutorInvocationPlan = {
      runId: 'a'.repeat(32),
      entryId: 'agent-entry',
      invocationId: 'b'.repeat(32),
      executorKind: 'agent',
      timeoutMs: 1000,
      requestHash: 'c'.repeat(64),
      admissionId: 'd'.repeat(32),
      schemaHash: 'e'.repeat(64),
      schema: { type: 'boolean' },
      payload: 'test',
      invocationHostDir: '/tmp/awf-enclave-invocation',
      seedId: 'f'.repeat(32),
      seedHostPath: '/tmp/awf-enclave-seed',
    };

    try {
      expect(() => agentEnvironment(policy, plan)).toThrow(
        /host GitHub token through Cloud Hypervisor enclave variable COPILOT_MODEL/,
      );
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_PAT;
      else process.env.GITHUB_PAT = previousToken;
    }
  });

  it('hands the guest only an invocation-scoped signed model-budget capability', () => {
    const secret = 'a'.repeat(64);
    const policy: HostExecutorAgentPolicy = {
      model: 'trusted-model',
      profile: 'openai',
      maxOutputBytes: 4096,
      maxModelRequests: 2,
      maxModelTokens: 128,
      modelBudgetSecret: secret,
    };
    const plan: HostExecutorInvocationPlan = {
      runId: 'a'.repeat(32),
      entryId: 'agent-entry',
      invocationId: 'b'.repeat(32),
      executorKind: 'agent',
      timeoutMs: 1000,
      requestHash: 'c'.repeat(64),
      admissionId: 'd'.repeat(32),
      schemaHash: 'e'.repeat(64),
      schema: { type: 'boolean' },
      payload: 'test',
      invocationHostDir: '/tmp/awf-enclave-invocation',
      seedId: 'f'.repeat(32),
      seedHostPath: '/tmp/awf-enclave-seed',
    };

    const environment = agentEnvironment(policy, plan);
    expect(environment.COPILOT_GITHUB_TOKEN).toBe('******');
    expect(environment.COPILOT_TOKEN).not.toContain(secret);
    expect(decodeCapability(environment.COPILOT_TOKEN, secret)).toEqual({
      v: 1,
      invocationId: plan.invocationId,
      maxRequests: 2,
      maxTokens: 128,
    });
    expect(environment.COPILOT_PROVIDER_BEARER_TOKEN).not.toMatch(/^Bearer /);
    expect(decodeCapability(`Bearer ${environment.COPILOT_PROVIDER_BEARER_TOKEN}`, secret)).toEqual({
      v: 1,
      invocationId: plan.invocationId,
      maxRequests: 2,
      maxTokens: 128,
    });
    expect(environment.COPILOT_PROVIDER_BEARER_TOKEN).not.toContain(secret);
  });

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(process.cwd(), '.awf-enclave-result-'));
  });

  describe('CloudHypervisorHostEnclaveExecutorBackend', () => {
    it.each([
      { role: 'script', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: false, shared: false },
      { role: 'agent', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: false, shared: false },
      { role: 'script', timeoutMs: 1_000, startupDelayMs: 1_500, expectedOutcome: 'success', publicDebug: false, shared: false },
      { role: 'script', timeoutMs: 1_000, startupDelayMs: 2_500, expectedOutcome: 'timeout', publicDebug: false, shared: false },
      { role: 'script', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: true, shared: false },
      { role: 'agent', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: true, shared: false },
      { role: 'script', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: false, shared: true },
      { role: 'agent', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success', publicDebug: false, shared: true },
    ] as const)('stages a static $role invocation and enforces its $expectedOutcome deadline', async ({
      role,
      timeoutMs,
      startupDelayMs,
      expectedOutcome,
      publicDebug,
      shared,
    }) => {
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
        githubAgentId: 'agent_123',
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
      let stopped = false;
      let unmounted = false;
      let snapshotRemoved = false;
      let mountedIdentity: { uid: number; gid: number } | undefined;
      let managerBinary: string | undefined;
      const chownedPaths: string[] = [];
      let snapshotNumber = 0;
      let managerStartError = false;
      let managerExecuteError = false;
      let managerStopError = false;
      let managerResult = 'true';
      let managerExecutionResult = { exitCode: 0, signal: null as string | null, timedOut: false };
      let abortOnExecute: AbortController | undefined;
      let expectHandoffCredentials = true;
      let executionRequest: Parameters<HostEnclaveExecutorManager['execute']>[0] | undefined;
      let workloadProfile: CloudHypervisorWorkloadProfile | undefined;
      let stagedHandoff: { agentId: string; bearer: string } | undefined;
      const sessionReads: Array<{ stopped: boolean; unmounted: boolean }> = [];
      const preservePublicSession = jest.fn().mockResolvedValue(undefined);
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
        readSessionDiagnostics: async (directory, _uid, _gid, retain) => {
          const runtime = path.join(directory, 'runtime');
          const dir = await fs.stat(runtime);
          sessionReads.push({ stopped, unmounted });
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
          const directory = path.join(root, `snapshot-${++snapshotNumber}`);
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
          snapshotRemoved = true;
          await fs.rm(directory, { recursive: true, force: true });
        },
        mountTmpfs: async (_directory, _size, mountUid, mountGid) => {
          mountedIdentity = { uid: mountUid, gid: mountGid };
        },
        verifyStorage: jest.fn().mockResolvedValue(undefined),
        unmount: async () => { unmounted = true; },
        chown: async (filePathValue) => { chownedPaths.push(filePathValue.toString()); },
        resolveIdentity: () => ({ uid, gid }),
        createManager: (managerConfig, _workDir, profile, _runId, _artifacts, managerDependencies, launchReport) => {
          expect(launchReport?.scope).toBe('vm-launch');
          managerBinary = managerConfig.cloudHypervisorBinary;
          workloadProfile = profile;
          expect(profile.guest?.identity).toEqual({ uid: 65534, gid: 65534 });
          expect(profile.artifact).toBe('enclave');
          expect(profile.rawOutput).toBe(publicDebug ? 'capture' : 'discard');
          if (publicDebug) {
            expect(managerDependencies?.enclaveDebugArtifactDirectory).toMatch(
              /^\/protected\/cloud-hypervisor\/[a-f0-9]+$/,
            );
            expect(managerDependencies?.enclaveDebugArtifactProtectedRoot).toBe('/protected');
            expect(profile.guest?.exports.every((entry) => !entry.source.startsWith('/protected'))).toBe(true);
          }
          return {
            start: async () => {
              if (managerStartError) throw Object.assign(new Error('PRIVATE_LAUNCH_SENTINEL Bearer token'), { code: 'EPERM' });
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
              executionRequest = request;
              expect(request.argv).toEqual([`/usr/local/bin/run-enclave-${role}`]);
              if (role === 'script') expect(request.env).toEqual({});
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
                await fs.writeFile(path.join(invocationHostDir, 'runtime', 'session.jsonl'),
                  '{"event":"progress","stage":"engine-started","secret":"PRIVATE_SESSION_TOKEN"}\n');
              }
              if (managerExecuteError) throw new GuestTransportError('guest-disconnected');
              if (role === 'agent' && expectHandoffCredentials) {
                stagedHandoff = {
                  agentId: await fs.readFile(
                    path.join(invocationHostDir, 'session-handoff', 'github-agent-id'),
                    'utf8',
                  ),
                  bearer: await fs.readFile(
                    path.join(invocationHostDir, 'session-handoff', 'github-bearer'),
                    'utf8',
                  ),
                };
              }
              const output = profile.guest?.exports.find(({ tag }) => tag === 'enclave-output')?.source;
              if (!output) throw new Error('expected the trusted output export');
              const outputStat = await fs.stat(path.join(output, 'out'));
              expect(outputStat.isFile()).toBe(true);
              expect(outputStat.mode & 0o777).toBe(0o600);
              await fs.writeFile(path.join(output, 'out'), 'false');
              abortOnExecute?.abort();
              return managerExecutionResult;
            },
            cancel: async () => undefined,
            stop: async () => {
              stopped = true;
              if (managerStopError) throw Object.assign(new Error('PRIVATE_CLEANUP_SENTINEL /private/repository'), { code: 'EIO' });
              const output = path.join(invocationHostDir, 'output', 'out');
              await fs.writeFile(output, managerResult);
            },
            completeCleanupRecord: async () => undefined,
          };
        },
      };
      const backend = new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, dependencies);

      if (timeoutMs === 1000) {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'hrtime', 'performance'] });
      }
      try {
        expect(() => new CloudHypervisorHostEnclaveExecutorBackend({
          ...backendOptions,
          config: { ...config, previewEnabled: false },
        }, dependencies)).toThrow('matching trusted Cloud Hypervisor release');
        expect(() => new CloudHypervisorHostEnclaveExecutorBackend({
          ...backendOptions,
          config: { ...config, developmentAllowUnattestedArtifacts: true },
        }, dependencies)).toThrow('matching trusted Cloud Hypervisor release');
        expect(() => new CloudHypervisorHostEnclaveExecutorBackend({
          ...backendOptions,
          config: { ...config, artifactReleaseTag: 'v0.0.0' },
        }, dependencies)).toThrow('matching trusted Cloud Hypervisor release');
        await expect(backend.execute({ ...plan, selector: 'owner/repo' }, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure' });
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await expect(backend.execute(plan, alreadyAborted.signal))
          .resolves.toEqual({ outcome: 'cancelled' });
        await expect(backend.execute(plan, new AbortController().signal)).resolves.toEqual(
          expectedOutcome === 'success'
            ? { outcome: 'success', result: 'true' }
            : { outcome: 'timeout' },
        );
        expect(mountedIdentity).toEqual({ uid: 65534, gid: 65534 });
        expect(managerBinary).toBe('/snapshot/cloud-hypervisor');
        if (expectedOutcome === 'success') {
          expect(chownedPaths).toContain(path.join(invocationHostDir, 'output'));
          expect(chownedPaths).toContain(path.join(invocationHostDir, 'output', 'out'));
          expect(chownedPaths).toContain(path.join(
            invocationHostDir,
            'request',
            role === 'script' ? 'query-script.py' : 'task.txt',
          ));
        }
        expect(stopped).toBe(true);
        expect(snapshotRemoved).toBe(true);
        expect(unmounted).toBe(true);
        await expect(fs.lstat(invocationHostDir)).rejects.toMatchObject({ code: 'ENOENT' });
        if (timeoutMs === 1000) return;
        const verifyRecoveryContract = async () => {
          for (const execution of [
            { exitCode: 23, signal: null, timedOut: false },
            { exitCode: 0, signal: 'SIGKILL', timedOut: false },
          ]) {
            managerExecutionResult = execution;
            stopped = false;
            unmounted = false;
            snapshotRemoved = false;
            let releaseCleanup!: () => void;
            let reachedCleanup!: () => void;
            const cleanupReached = new Promise<void>(resolve => { reachedCleanup = resolve; });
            const cleanupReleased = new Promise<void>(resolve => { releaseCleanup = resolve; });
            const recoveringBackend = new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, {
              ...dependencies,
              createResourceJournal: async (...args) => ({
                ...await dependencies.createResourceJournal!(...args),
                complete: async () => { reachedCleanup(); await cleanupReleased; },
              }),
            });
            let returned = false;
            const pending = recoveringBackend.execute(plan, new AbortController().signal).then(result => {
              returned = true;
              return result;
            });
            try {
              await cleanupReached;
              expect(stopped && unmounted && snapshotRemoved).toBe(true);
              expect(returned).toBe(false);
            } finally {
              releaseCleanup();
            }
            await expect(pending).resolves.toEqual({
              outcome: 'executor-failure', cleanupComplete: true, recoverableFailure: true,
            });
            await recoveringBackend.close();
          }

          const failingCleanupBackend = new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, {
            ...dependencies,
            unmount: async () => { throw new Error('fixture unmount failed'); },
          });
          await expect(failingCleanupBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
          await failingCleanupBackend.close();
          await fs.rm(invocationHostDir, { recursive: true, force: true });

          const milestone = hostExecutorDiagnostics.HostExecutorInvocationDiagnostics.prototype.milestone;
          const persistenceFailure = jest.spyOn(
            hostExecutorDiagnostics.HostExecutorInvocationDiagnostics.prototype, 'milestone',
          ).mockImplementation(function (this: hostExecutorDiagnostics.HostExecutorInvocationDiagnostics, ...args) {
            milestone.apply(this, args);
            if (args[0] === 'cleanup-complete') this.persistenceFailed = true;
          });
          try {
            const failingDiagnosticsBackend = new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, dependencies);
            await expect(failingDiagnosticsBackend.execute(plan, new AbortController().signal))
              .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
            await failingDiagnosticsBackend.close();
          } finally {
            persistenceFailure.mockRestore();
          }

          managerExecutionResult = { exitCode: 0, signal: null, timedOut: false };
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'success', result: 'true' });
          managerExecuteError = true;
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure' });
          managerExecuteError = false;

          if (role === 'script' && timeoutMs === 60_000 && !publicDebug && !shared) {
            const recoveryRun = { ...runState, runId: 'f'.repeat(32) };
            const server = await startHostExecutorServer({
              runtimeDir: path.join(root, 'recovery'),
              runState: recoveryRun,
              backend: new CloudHypervisorHostEnclaveExecutorBackend({ ...backendOptions, runState: recoveryRun }, {
                ...dependencies,
                createManager: (...args) => {
                  const manager = dependencies.createManager!(...args);
                  const output = args[2].guest!.exports.find(entry => entry.tag === 'enclave-output')!.source;
                  return { ...manager, stop: async () => { await fs.writeFile(path.join(output, 'out'), managerResult); } };
                },
              }),
            });
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { createHostExecutorClient } = require('../../containers/enclave/mcp-server/host-executor-client.js');
              const { finiteSchemaHash } = await import('../bounded-execution/schema-hash');
              const broker = createHostExecutorClient({
                socketPath: server.socketPath, capabilityPath: server.capabilityPath, runId: recoveryRun.runId,
              });
              for (const [id, exitCode, outcome] of [
                ['2'.repeat(32), 23, 'executor-failure'],
                ['3'.repeat(32), 0, 'success'],
              ] as const) {
                managerExecutionResult = { exitCode, signal: null, timedOut: false };
                expect(await broker.invoke({
                  entryId, invocationId: id, admissionId: id, executorKind: role, seedId,
                  payload: plan.payload, schema: plan.schema, schemaHash: finiteSchemaHash(plan.schema),
                })).toMatchObject({ ok: true, state: 'running' });
                let status = await broker.status({ entryId, invocationId: id });
                for (let attempt = 0; attempt < 100 && status.state !== 'terminal'; attempt += 1) {
                  await new Promise(resolve => setTimeout(resolve, 5));
                  status = await broker.status({ entryId, invocationId: id });
                }
                expect(status).toMatchObject({ state: 'terminal', outcome });
                expect(status).not.toHaveProperty('recoverableFailure');
                expect(await broker.settle({ entryId, invocationId: id, resultDigest: status.resultDigest }))
                  .toMatchObject({ state: 'settled', outcome });
              }
            } finally {
              await server.close();
            }
          }
        };

        if (role === 'agent' && expectedOutcome === 'success') {
          expect(workloadProfile?.kind).toBe('agent-enclave');
          expect(workloadProfile?.network).toMatchObject({
            mode: 'enclave-agent',
            githubDataPlane: { port: ENCLAVE_GITHUB_MCP_PORT },
          });
          expect(workloadProfile?.guest?.exports.find(
            ({ tag }) => tag === 'enclave-session-handoff',
          )).toMatchObject({ mode: 'ro' });
          expect(executionRequest?.argv).toEqual([agentArtifact.entrypoint]);
          expect(executionRequest?.env).toMatchObject({
            AWF_ENCLAVE_AGENT_ENGINE: 'copilot',
            AWF_ENCLAVE_AGENT_PROFILE: 'openai',
            AWF_ENCLAVE_AGENT_MODEL: 'gpt-4.1',
            AWF_ENCLAVE_AGENT_GITHUB_ENABLED: 'true',
            AWF_ENCLAVE_AGENT_GITHUB_AUTH_MODE: 'scoped-bearer',
            AWF_ENCLAVE_AGENT_GITHUB_ALLOWED_TOOLS: JSON.stringify(agentPolicy.githubAllowedTools),
            AWF_ENCLAVE_AGENT_MAX_MODEL_REQUESTS: '5',
            AWF_ENCLAVE_AGENT_MAX_MODEL_TOKENS: '1000',
            AWF_ENCLAVE_AGENT_DEADLINE_SECONDS: '61',
          });
          expect(executionRequest?.env.AWF_ENCLAVE_AGENT_DEBUG_RAW_SESSION_LOGS)
            .toBe(publicDebug ? 'true' : undefined);
          if (publicDebug) {
            expect(preservePublicSession).toHaveBeenCalledWith(
              expect.stringMatching(/^\/protected\/cloud-hypervisor\/[a-f0-9]+$/),
              '/protected',
              expect.stringContaining('PRIVATE_SESSION_TOKEN'),
              expect.arrayContaining([agentPolicy.githubBearer]),
              expect.anything(),
            );
          } else {
            expect(preservePublicSession).not.toHaveBeenCalled();
          }
          expect(executionRequest?.env.COPILOT_API_URL)
            .toBe(`http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`);
          expect(executionRequest?.env).toMatchObject({
            COPILOT_GITHUB_TOKEN: '******',
            COPILOT_TOKEN: '******',
            COPILOT_PROVIDER_BEARER_TOKEN: '******',
          });
          expect(stagedHandoff).toEqual({
            agentId: 'agent_123\n',
            bearer: `${agentPolicy.githubBearer}\n`,
          });
          const [file] = hostExecutorDiagnostics.readHostExecutorInvocationDiagnostics(runState);
          const evidence = JSON.parse(file.contents);
          expect(evidence).not.toHaveProperty('developmentSupervisor');
          expect(sessionReads).toEqual([{ stopped: true, unmounted: false }]);
          expect(evidence.guestSession).toMatchObject({
            status: 'captured', lastEvent: { event: 'progress', stage: 'engine-started' },
          });
          expect(evidence.guestFileOperations).toEqual([{
            event: 'operation-error', operation: 'session-log-close', category: 'no-space', errno: 28, fatal: false,
          }]);
          expect(evidence.guestWrapperFailure).toEqual({ event: 'failure', category: 'result-empty' });
          expect(file.contents).not.toContain('PRIVATE_SESSION_TOKEN');
          expect(evidence.guestExecution).toMatchObject({ phase: 'sending', resultReceived: false });
          managerExecuteError = true;
          stopped = false;
          unmounted = false;
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure' });
          const failed = JSON.parse(hostExecutorDiagnostics.readHostExecutorInvocationDiagnostics(runState)[0].contents);
          expect(failed.failure).toMatchObject({
            stage: 'host-invocation/guest-execute', reason: 'guest-disconnected',
          });
          expect(failed.milestones).not.toContainEqual(expect.objectContaining({ phase: 'guest-complete' }));
          expect(failed.guestSession).toMatchObject({ status: 'captured' });
          expect(preservePublicSession).toHaveBeenCalledTimes(publicDebug ? 2 : 0);
          await expect(fs.stat(invocationHostDir)).rejects.toMatchObject({ code: 'ENOENT' });
          managerExecuteError = false;
        } else if (expectedOutcome === 'success') {
          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          const invalidStorageBackend = new CloudHypervisorHostEnclaveExecutorBackend(
            backendOptions,
            {
              ...dependencies,
              verifyStorage: async () => { throw new Error('Unverifiable bounded storage'); },
              createManager: () => { throw new Error('VM must not be created'); },
            },
          );
          await expect(invalidStorageBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure' });
          expect(unmounted).toBe(true);
          expect(snapshotRemoved).toBe(false);
          expect(await fs.lstat(invocationHostDir).catch(() => undefined)).toBeUndefined();
          await invalidStorageBackend.close();

          expect(workloadProfile?.kind).toBe('script-enclave');
          expect(workloadProfile?.network).toEqual({ mode: 'none' });
          expect(workloadProfile?.guest?.exports.some(({ tag }) => tag === 'enclave-session-handoff'))
            .toBe(false);
          if (expectedOutcome === 'success') {
            expect(executionRequest?.argv).toEqual([scriptArtifact.entrypoint]);
            expect(executionRequest?.env).toEqual({});
          }
        }

        await verifyRecoveryContract();

        if (role === 'agent' && expectedOutcome === 'success') {
          const invalidPolicies: Array<{
            policy: HostExecutorAgentPolicy;
            plan?: HostExecutorInvocationPlan;
            error: string;
          }> = [
            {
              policy: { ...agentPolicy, model: '' },
              error: 'Trusted host executor agent policy is invalid',
            },
            {
              policy: { ...agentPolicy, model: 'invalid\u0000model' },
              error: 'Trusted host executor agent policy is invalid',
            },
            {
              policy: {
                ...agentPolicy,
                profile: 'invalid' as HostExecutorAgentPolicy['profile'],
              },
              error: 'Trusted host executor agent policy is invalid',
            },
            {
              policy: { ...agentPolicy, maxOutputBytes: Number.MAX_SAFE_INTEGER },
              error: 'Trusted host executor agent policy is invalid',
            },
            {
              policy: { ...agentPolicy, maxModelRequests: 0 },
              error: 'Trusted host executor agent policy is invalid',
            },
            {
              policy: { ...agentPolicy, maxModelTokens: 0 },
              error: 'Trusted host executor agent policy is invalid',
            },
            {
              policy: { ...agentPolicy, githubAgentId: undefined },
              error: 'Trusted GitHub agent identity and bearer must be configured together',
            },
            {
              policy: { ...agentPolicy, githubBearer: 'invalid' },
              error: 'Trusted host executor GitHub credentials are invalid',
            },
            ...[
              { githubExpiresAt: undefined },
              { githubExpiresAt: Date.now() + plan.timeoutMs },
              { githubAllowedTools: undefined },
              { githubAllowedTools: [] },
              { githubAllowedTools: ['unknown_tool'] },
              { githubAllowedTools: ['issue_read', 'issue_read'] },
            ].map((fields) => ({
              policy: { ...agentPolicy, ...fields },
              error: 'Trusted Cloud Hypervisor GitHub capability must include tools and cover the invocation deadline',
            })),
            {
              policy: agentPolicy,
              plan: { ...plan, timeoutMs: 0 },
              error: 'Trusted host executor agent policy is invalid',
            },
          ];
          for (const invalid of invalidPolicies) {
            const snapshotsBefore = snapshotNumber;
            const invalidPolicyBackend = new CloudHypervisorHostEnclaveExecutorBackend({
              ...backendOptions,
              agentPolicies: { [entryId]: invalid.policy },
            }, dependencies);
            await expect(invalidPolicyBackend.execute(
              invalid.plan ?? plan,
              new AbortController().signal,
            )).rejects.toThrow(invalid.error);
            expect(snapshotNumber).toBe(snapshotsBefore);
            await invalidPolicyBackend.close();
          }

          const now = Date.now();
          const delayedExecution = jest.fn();
          let clock: jest.SpyInstance | undefined;
          const deadlineBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions,
            agentPolicies: { [entryId]: {
              ...agentPolicy, githubExpiresAt: now + plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS + 1000,
            } },
          }, {
            ...dependencies,
            createManager: (...args) => {
              const manager = dependencies.createManager!(...args);
              return {
                ...manager,
                startInstance: async () => {
                  await manager.startInstance();
                  clock = jest.spyOn(Date, 'now').mockReturnValue(now + 1001);
                },
                execute: delayedExecution,
              };
            },
          });
          try {
            await expect(deadlineBackend.execute(plan, new AbortController().signal))
              .resolves.toEqual({ outcome: 'executor-failure' });
            expect(delayedExecution).not.toHaveBeenCalled();
          } finally {
            clock?.mockRestore();
            await deadlineBackend.close();
          }

          const missingPolicyBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions,
            agentPolicies: undefined,
          }, dependencies);
          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          await expect(missingPolicyBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure' });
          expect(snapshotRemoved).toBe(true);
          expect(unmounted).toBe(true);
          await missingPolicyBackend.close();

          const agentPolicyWithoutGitHub: HostExecutorAgentPolicy = {
            model: 'gpt-4.1',
            profile: 'openai',
            maxOutputBytes: 4096,
          };
          const noGithubBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions,
            agentPolicies: { [entryId]: agentPolicyWithoutGitHub },
          }, dependencies);
          expectHandoffCredentials = false;
          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          await expect(noGithubBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'success', result: 'true' });
          expect(workloadProfile?.network).toMatchObject({ mode: 'enclave-agent' });
          expect(workloadProfile?.network).not.toHaveProperty('githubDataPlane');
          expect(executionRequest?.env.AWF_ENCLAVE_AGENT_GITHUB_ENABLED).toBe('false');
          await noGithubBackend.close();

          if (publicDebug) {
            preservePublicSession.mockRejectedValueOnce(new Error('protected session write failed'));
            stopped = false;
            unmounted = false;
            snapshotRemoved = false;
            await expect(backend.execute(plan, new AbortController().signal))
              .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
            expect(stopped).toBe(true);
            expect(unmounted).toBe(false);
            expect(snapshotRemoved).toBe(false);
            await expect(fs.stat(path.join(invocationHostDir, 'runtime', 'session.jsonl')))
              .resolves.toBeDefined();
          }
        } else if (expectedOutcome === 'success') {
          const mountFailureBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions,
            preflight: {
              ...preflight,
              tools: { ...tools, mount: '/usr/bin/false' },
            },
          });
          await expect(mountFailureBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure' });
          await mountFailureBackend.close();

          const {
            mountTmpfs: _mountTmpfs,
            resolveIdentity: _resolveIdentity,
            ...defaultMountDependencies
          } = dependencies;
          void _mountTmpfs;
          void _resolveIdentity;
          const defaultMountBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions,
            preflight: {
              ...preflight,
              tools: { ...tools, mount: '/usr/bin/true' },
            },
          }, defaultMountDependencies);
          await expect(defaultMountBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'success', result: 'true' });
          await defaultMountBackend.close();

          const { unmount: _unmount, ...defaultUnmountDependencies } = defaultMountDependencies;
          void _unmount;
          const defaultUnmountBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions,
            preflight: {
              ...preflight,
              tools: { ...tools, mount: '/usr/bin/true', umount: '/usr/bin/false' },
            },
          }, defaultUnmountDependencies);
          await expect(defaultUnmountBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
          await defaultUnmountBackend.close();
          await fs.rm(invocationHostDir, { recursive: true, force: true });

          const cleanupRegistry: CloudHypervisorCleanupRegistry = {
            hasPendingRecord: async () => false,
            reapPending: async () => { throw new Error('fixture startup failure'); },
            createPending: async () => { throw new Error('unexpected cleanup record creation'); },
            create: async () => { throw new Error('unexpected cleanup record creation'); },
          };
          const { createManager: _createManager, ...defaultManagerDependencies } = dependencies;
          void _createManager;
          const defaultManagerBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions,
            config: { ...config, enclaveDebugPublic: false },
            publicDebugArtifactDirectory: undefined,
            publicDebugArtifactProtectedRoot: undefined,
            managerDependencies: {
              ...cloudHypervisorManagerTestHelpers.defaultDependencies,
              cleanupRegistry,
            },
          }, defaultManagerDependencies);
          await expect(defaultManagerBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure' });
          await defaultManagerBackend.close();

          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          managerExecutionResult = { exitCode: 1, signal: null, timedOut: false };
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: true, recoverableFailure: true });

          managerExecutionResult = { exitCode: 0, signal: null, timedOut: true };
          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'timeout' });

          managerExecutionResult = { exitCode: 0, signal: null, timedOut: false };
          const abortDuringExecution = new AbortController();
          abortOnExecute = abortDuringExecution;
          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          await expect(backend.execute(plan, abortDuringExecution.signal))
            .resolves.toEqual({ outcome: 'cancelled' });
          abortOnExecute = undefined;
        }

        if (role === 'script' && expectedOutcome === 'success') {
          const digest = createHash('sha256').update('verified-binary').digest('hex');
          const boundedPreflight = {
            ...preflight,
            artifactDigests: { ...preflight.artifactDigests,
              cloudHypervisor: digest, virtiofsd: digest, kernel: digest, supervisor: digest },
          };
          const boundedManager = jest.fn(dependencies.createManager!);
          const storageClose = jest.fn(async () => undefined);
          let replacement: 'cloudHypervisorBinary' | 'virtiofsdBinary' | 'kernelPath' | 'supervisorPath' | 'rootfsPath' | undefined;
          const boundedSnapshot: HostEnclaveExecutorDependencies['createArtifactSnapshot'] = async (...args) => {
            const created = await dependencies.createArtifactSnapshot!(...args);
            const files = {
              cloudHypervisorBinary: path.join(created.directory, 'cloud-hypervisor'),
              virtiofsdBinary: path.join(created.directory, 'virtiofsd'),
              kernelPath: path.join(created.directory, 'vmlinux.bin'),
              supervisorPath: path.join(created.directory, 'awf-supervisor'),
            };
            await Promise.all(Object.values(files).map((file) => fs.writeFile(file, 'verified-binary')));
            const snapshot = { ...created, ...files };
            if (replacement) {
              const replacedFile = replacement === 'rootfsPath'
                ? ('rootfsPath' in snapshot && typeof snapshot.rootfsPath === 'string'
                  ? snapshot.rootfsPath : undefined)
                : files[replacement];
              if (!replacedFile) throw new Error('Invocation rootfs snapshot is missing');
              await fs.chmod(replacedFile, 0o600);
              await fs.writeFile(replacedFile, 'source-replaced-after-attestation');
            }
            return snapshot;
          };
          const boundedBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions, preflight: boundedPreflight,
          }, {
            ...dependencies,
            prepareInvocationStorage: async () => ({
              workDir: root,
              managerDependencies: cloudHypervisorManagerTestHelpers.defaultDependencies,
              dependencies: { createArtifactSnapshot: boundedSnapshot },
              close: storageClose,
            }),
            createManager: boundedManager,
          });
          stopped = false;
          await expect(boundedBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'success', result: 'true' });
          expect(boundedManager).toHaveBeenCalledWith(expect.objectContaining({
            cloudHypervisorBinary: expect.stringContaining('/snapshot-'),
          }), root, expect.anything(), expect.anything(), expect.anything(), expect.anything(),
          expect.objectContaining({ scope: 'vm-launch' }),
          expect.objectContaining({ scope: 'host-invocation' }));
          for (const file of ['cloudHypervisorBinary', 'virtiofsdBinary', 'kernelPath', 'supervisorPath', 'rootfsPath'] as const) {
            replacement = file;
            boundedManager.mockClear();
            storageClose.mockClear();
            snapshotRemoved = false;
            await expect(boundedBackend.execute(plan, new AbortController().signal))
              .resolves.toEqual({ outcome: 'executor-failure' });
            expect(boundedManager).not.toHaveBeenCalled();
            expect(storageClose).toHaveBeenCalledTimes(1);
            expect(snapshotRemoved).toBe(true);
          }
          await boundedBackend.close();
          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          const server = await startHostExecutorServer({
            runtimeDir: path.join(root, 'h'),
            runState,
            backend: new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, dependencies),
          });
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { createHostExecutorClient } = require('../../containers/enclave/mcp-server/host-executor-client.js');
            const broker = createHostExecutorClient({
              socketPath: server.socketPath, capabilityPath: server.capabilityPath, runId: runState.runId,
            });
            const { finiteSchemaHash } = await import('../bounded-execution/schema-hash');
            const accepted = await broker.invoke({
              entryId, invocationId, admissionId: plan.admissionId, executorKind: role, seedId,
              payload: plan.payload, schema: plan.schema, schemaHash: finiteSchemaHash(plan.schema),
            });
            expect(accepted).toEqual(expect.objectContaining({ ok: true, state: 'running' }));
            let status = accepted;
            for (let attempt = 0; attempt < 100 && status.state !== 'terminal'; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              status = await broker.status({ entryId, invocationId });
            }
            expect(status).toEqual(expect.objectContaining({
              ok: true, state: 'terminal', outcome: 'success', result: 'true',
            }));
            expect(unmounted).toBe(true);
            expect(stopped).toBe(true);
            expect(snapshotRemoved).toBe(true);
            expect(await fs.lstat(invocationHostDir).catch(() => undefined)).toBeUndefined();
            const settled = await broker.settle({ entryId, invocationId, resultDigest: status.resultDigest });
            expect(settled).toEqual(expect.objectContaining({ ok: true, state: 'settled', outcome: 'success' }));
            expect(settled.result).toBeUndefined();
          } finally {
            await server.close();
          }

          for (const [index, stage] of ['mount', 'write', 'snapshot'].entries()) {
            let release!: () => void;
            let entered!: () => void;
            const blocked = new Promise<void>((resolve) => { release = resolve; });
            const reached = new Promise<void>((resolve) => { entered = resolve; });
            let delayedDependencies: Partial<HostEnclaveExecutorDependencies>;
            if (stage === 'mount') {
              delayedDependencies = {
                ...dependencies,
                mountTmpfs: async (...args) => {
                  entered();
                  await blocked;
                  await dependencies.mountTmpfs!(...args);
                },
              };
            } else if (stage === 'write') {
              delayedDependencies = {
                ...dependencies,
                writeFile: async (file, contents, options) => {
                  if (file.toString() === path.join(invocationHostDir, 'request', 'query-script.py')) {
                    entered();
                    await blocked;
                  }
                  await fs.writeFile(file, contents, options);
                },
              };
            } else {
              delayedDependencies = {
                ...dependencies,
                createArtifactSnapshot: async (...args) => {
                  const created = await dependencies.createArtifactSnapshot!(...args);
                  entered();
                  await blocked;
                  return created;
                },
              };
            }
            const interruptionRun = { ...runState, runId: String(index + 1).repeat(32) };
            const interruptedServer = await startHostExecutorServer({
              runtimeDir: path.join(root, 'h'),
              runState: interruptionRun,
              backend: new CloudHypervisorHostEnclaveExecutorBackend({
                ...backendOptions, runState: interruptionRun,
              }, delayedDependencies),
            });
            try {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { createHostExecutorClient } = require('../../containers/enclave/mcp-server/host-executor-client.js');
              const broker = createHostExecutorClient({
                socketPath: interruptedServer.socketPath,
                capabilityPath: interruptedServer.capabilityPath,
                runId: interruptionRun.runId,
              });
              const { finiteSchemaHash } = await import('../bounded-execution/schema-hash');
              unmounted = false;
              snapshotRemoved = false;
              await broker.invoke({
                entryId, invocationId, admissionId: plan.admissionId, executorKind: role, seedId,
                payload: plan.payload, schema: plan.schema, schemaHash: finiteSchemaHash(plan.schema),
              });
              await reached;
              await broker.cancel({ entryId, invocationId, cancelGeneration: 1 });
              expect(await broker.status({ entryId, invocationId }))
                .toEqual(expect.objectContaining({ state: 'cancelling' }));
              expect(await broker.settle({ entryId, invocationId, resultDigest: 'f'.repeat(64) }))
                .toEqual(expect.objectContaining({ ok: false, error: 'invalid-state' }));
              expect(unmounted).toBe(false);
              release();
              let status = await broker.status({ entryId, invocationId });
              for (let attempt = 0; attempt < 100 && status.state !== 'terminal'; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 5));
                status = await broker.status({ entryId, invocationId });
              }
              expect(status).toEqual(expect.objectContaining({ state: 'terminal', outcome: 'cancelled' }));
              expect(unmounted).toBe(true);
              if (stage !== 'mount') expect(snapshotRemoved).toBe(true);
              expect(await fs.lstat(invocationHostDir).catch(() => undefined)).toBeUndefined();
              expect(await broker.settle({ entryId, invocationId, resultDigest: status.resultDigest }))
                .toEqual(expect.objectContaining({ state: 'settled', outcome: 'cancelled' }));
            } finally {
              release();
              await interruptedServer.close();
            }
          }

          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          managerStartError = true;
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure' });
          expect(stopped).toBe(true);
          expect(snapshotRemoved).toBe(true);
          expect(unmounted).toBe(true);

          managerStartError = false;
          managerResult = 'not-json';
          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'schema-failure' });

          managerStopError = true;
          managerStartError = true;
          const combinedFailureBackend = new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, {
            ...dependencies,
            createManager: (...args) => {
              const failingManager = dependencies.createManager!(...args);
              return {
                ...failingManager,
                stop: async () => {
                  const persisted = hostExecutorDiagnostics.readHostExecutorInvocationDiagnostics(runState)
                    .find(file => JSON.parse(file.contents).invocationId === plan.invocationId)!;
                  expect(JSON.parse(persisted.contents)).toMatchObject({
                    failure: { stage: 'host-invocation/manager-start', code: 'EPERM' },
                    checks: { 'host-invocation/instance-start': ['not-attempted', 'none'] },
                  });
                  return failingManager.stop();
                },
              };
            },
          });
          await expect(combinedFailureBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
          const persisted = hostExecutorDiagnostics.readHostExecutorInvocationDiagnostics(runState)
            .find(file => JSON.parse(file.contents).invocationId === plan.invocationId)!;
          const diagnostic = JSON.parse(persisted.contents);
          expect(diagnostic).toMatchObject({
            schemaVersion: 1,
            failure: { stage: 'host-invocation/manager-start', reason: 'EPERM', code: 'EPERM', errorType: 'Error' },
            cleanupFailure: { stage: 'host-invocation-cleanup/manager-stop', reason: 'EIO', code: 'EIO', errorType: 'Error' },
            checks: {
              'host-invocation/instance-start': ['not-attempted', 'none'],
              'host-invocation-cleanup/snapshot-remove': ['not-attempted', 'none'],
            },
          });
          expect(diagnostic.failure.sequence).toBeLessThan(diagnostic.cleanupFailure.sequence);
          expect(persisted.contents).not.toMatch(/PRIVATE_|Bearer|token|\/private\/|print\(True\)/);
          const diagnosticPath = path.join(runState.journalDir!, 'diagnostics', persisted.name);
          const diagnosticFile = await fs.open(diagnosticPath, 'r');
          try {
            expect((await diagnosticFile.stat()).mode & 0o777).toBe(0o600);
            await combinedFailureBackend.close();
            expect(await diagnosticFile.readFile('utf8')).toBe(persisted.contents);
          } finally {
            await diagnosticFile.close();
          }
          await fs.rm(invocationHostDir, { recursive: true, force: true });
          managerStartError = false;
          stopped = false;
          unmounted = false;
          snapshotRemoved = false;
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure' });
          managerStopError = false;
        }
        await backend.close();
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure' });
        snapshotRemoved = false;
        const ownedSnapshotPath = path.join(root, 'owned-preflight-snapshot');
        await fs.mkdir(ownedSnapshotPath, { mode: 0o700 });
        const ownedSnapshotBackend = new CloudHypervisorHostEnclaveExecutorBackend({
          ...backendOptions,
          preflight: { ...preflight, artifactSnapshotDirectory: ownedSnapshotPath },
          ownsPreflightSnapshot: true,
        });
        await ownedSnapshotBackend.close();
        await ownedSnapshotBackend.close();
        await expect(fs.lstat(ownedSnapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await backend.close();
        if (timeoutMs === 1000) jest.useRealTimers();
        await fs.rm(scratch, { recursive: true, force: true });
      }
    }, 30_000);
  });

  it('requires staged and verified enclave artifacts before creating the executor', async () => {
    const onPreflightStage = jest.fn();
    const options = {
      runState: {} as HostExecutorRunState,
      config: { artifactReleaseTag: 'v0.23.1' } as CloudHypervisorOptions,
      workDir: '/tmp/awf-enclave',
      environment: {},
      onPreflightStage,
    };
    await expect(createCloudHypervisorHostEnclaveExecutor(options))
      .rejects.toThrow('Cloud Hypervisor enclave artifacts have not been staged and verified');
    expect(onPreflightStage.mock.calls).toEqual([['artifact-preflight']]);
  });

  it('resolves the trusted CLI and removes preflight artifacts when artifact verification fails', async () => {
    const scratch = await fs.mkdtemp(path.join(process.cwd(), '.awf-enclave-factory-'));
    const environment = {
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST: '/missing/manifest.json',
      AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST_BUNDLE:
        '/missing/cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
      AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS: '/missing/enclave-script-rootfs.ext4',
      AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS: '/missing/enclave-agent-rootfs.ext4',
      PATH: scratch,
    };
    await fs.writeFile(path.join(scratch, 'gh'), '', { mode: 0o700 });
    const options = {
      runState: { journalDir: path.join(scratch, 'journal') } as HostExecutorRunState,
      config: { artifactReleaseTag: CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG } as CloudHypervisorOptions,
      workDir: scratch,
      managerDependencies: {
        ...cloudHypervisorManagerTestHelpers.defaultDependencies,
        cleanupRegistry: {
          reapPending: async () => undefined,
          hasPendingRecord: async () => false,
          create: async () => { throw new Error('unexpected cleanup creation'); },
          createPending: async () => { throw new Error('unexpected cleanup creation'); },
        },
      },
      environment,
    };
    const preflight = {
      version: '53.0',
      cloudHypervisorBinary: '/trusted/cloud-hypervisor',
      virtiofsdBinary: '/trusted/virtiofsd',
      kernelPath: '/trusted/vmlinux.bin',
      supervisorPath: '/trusted/awf-supervisor',
      artifactSnapshotDirectory: path.join(scratch, 'preflight-snapshot'),
      artifactDigests: {
        cloudHypervisor: 'a'.repeat(64), virtiofsd: 'b'.repeat(64),
        kernel: 'c'.repeat(64), supervisor: 'd'.repeat(64),
      },
      tools: { ip: '/trusted/ip', umount: '/trusted/umount' } as CloudHypervisorHostToolPaths,
      cgroupVersion: 2,
      kvmGid: 978,
    } satisfies CloudHypervisorCommonPreflightResult;
    const runPreflight = jest.spyOn(
      cloudHypervisorPreflight,
      'runCloudHypervisorCommonPreflight',
    ).mockResolvedValue(preflight);
    const trustedTool = jest.spyOn(
      artifactTrust,
      'assertTrustedHostTool',
    ).mockResolvedValue();
    const removeSnapshot = jest.fn(async () => undefined);
    const reap = jest.spyOn(hostExecutorResourceJournal, 'reapHostExecutorResources').mockResolvedValue();
    const published: HostPreflightProgress[] = [];

    try {
      await expect(createCloudHypervisorHostEnclaveExecutor({
        ...options,
        environment: { ...environment, PATH: '' },
      })).rejects.toThrow('A trusted GitHub CLI is required');
      await expect(createCloudHypervisorHostEnclaveExecutor({
        ...options, onHostPreflight: (value) => { published.push(value); },
      }, {
        removeArtifactSnapshot: removeSnapshot,
      })).rejects.toThrow();
      expect(runPreflight).toHaveBeenCalledTimes(1);
      expect(removeSnapshot).toHaveBeenCalledWith(preflight.artifactSnapshotDirectory);
      const artifactFailure = published.find((value) => value.scope === 'bounded-artifacts' &&
        value.checks.some((check) => check.id === 'manifest-trust' && check.result === 'failed'));
      expect(artifactFailure).toMatchObject({
        schemaVersion: 2, phase: 'preflight', profile: 'common',
      });
      expect(artifactFailure?.checks.find((check) => check.id === 'manifest-trust'))
        .toMatchObject({ result: 'failed', reason: 'ENOENT' });
      const boundedArtifactPreflight = jest.fn().mockRejectedValue(new Error('bounded artifact gate'));
      const onPreflightStage = jest.fn();
      await expect(createCloudHypervisorHostEnclaveExecutor({ ...options, onPreflightStage }, {
        preflight: async () => preflight,
        preflightEnclaveArtifacts: boundedArtifactPreflight,
        removeArtifactSnapshot: removeSnapshot,
      })).rejects.toThrow('bounded artifact gate');
      expect(onPreflightStage.mock.calls).toEqual([
        ['artifact-preflight'], ['host-preflight'], ['recovery'], ['artifact-preflight'],
      ]);
      expect(boundedArtifactPreflight).toHaveBeenCalledWith(expect.objectContaining({
        manifestPath: environment.AWF_CLOUD_HYPERVISOR_ENCLAVE_MANIFEST,
      }), undefined, undefined, expect.any(HostPreflightReporter));
      onPreflightStage.mockClear();
      await expect(createCloudHypervisorHostEnclaveExecutor({ ...options, onPreflightStage }, {
        preflight: jest.fn().mockRejectedValue(new Error('PRIVATE_HOST_PREFLIGHT')),
      })).rejects.toThrow('PRIVATE_HOST_PREFLIGHT');
      expect(onPreflightStage.mock.calls).toEqual([['artifact-preflight'], ['host-preflight']]);
    } finally {
      runPreflight.mockRestore();
      trustedTool.mockRestore();
      reap.mockRestore();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it('rejects artifact preflight when the attestation tool is not trusted', async () => {
    await expect(preflightCloudHypervisorEnclaveArtifacts({
      releaseTag: 'v0.23.1',
      manifestPath: '/trusted/cloud-hypervisor-enclave-rootfs-x86_64.manifest.json',
      manifestBundlePath: '/trusted/cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
      scriptRootfsPath: '/trusted/enclave-script-rootfs.ext4',
      agentRootfsPath: '/trusted/enclave-agent-rootfs.ext4',
      attestationToolPath: '/missing/gh',
    })).rejects.toThrow();
  });

  it.each([true, false])('verifies a release-pinned artifact set and rejects a rootfs digest mismatch (shared=%s)', async (shared) => {
    const scratch = await fs.mkdtemp(path.join(process.cwd(), '.awf-enclave-preflight-'));
    const releaseTag = CLOUD_HYPERVISOR_ARTIFACT_RELEASE_TAG;
    const hash = (contents: string) => createHash('sha256').update(contents).digest('hex');
    const writeTrustedFile = async (name: string, contents: string): Promise<string> => {
      const filePath = path.join(scratch, name);
      await fs.writeFile(filePath, contents, { mode: 0o400 });
      return filePath;
    };
    const scriptRootfs = shared ? 'shared-rootfs-fixture' : 'script-rootfs-fixture';
    const agentRootfs = shared ? scriptRootfs : 'agent-rootfs-fixture';
    const scriptSbom = JSON.stringify({ name: 'enclave-script' });
    const agentSbom = JSON.stringify({ name: 'enclave-agent' });
    const artifacts = (role: 'script' | 'agent', rootfs: string, sbom: string) => {
      const digest = 'a'.repeat(64);
      return {
        file: shared ? 'enclave-rootfs.ext4' : `enclave-${role}-rootfs.ext4`,
        role,
        version: releaseTag,
        sha256: hash(rootfs),
        sizeBytes: Buffer.byteLength(rootfs),
        uid: 65534,
        gid: 65534,
        entrypoint: `/usr/local/bin/run-enclave-${role}`,
        sourceImage: `ghcr.io/github/gh-aw-firewall/${shared ? 'cloud-hypervisor-enclave' : `enclave-${role}`}@sha256:${digest}`,
        sourceImageDigest: digest,
        sbom: {
          file: `enclave-${role}-rootfs.sbom.spdx.json`,
          sha256: hash(sbom),
        },
      };
    };
    const scriptArtifact = artifacts('script', scriptRootfs, scriptSbom);
    const agentArtifact = artifacts('agent', agentRootfs, agentSbom);
    const manifestPath = path.join(scratch, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json');
    const scriptRootfsPath = await writeTrustedFile(scriptArtifact.file, scriptRootfs);
    const agentRootfsPath = shared ? scriptRootfsPath : await writeTrustedFile(agentArtifact.file, agentRootfs);
    await writeTrustedFile(scriptArtifact.sbom.file, scriptSbom);
    await writeTrustedFile(agentArtifact.sbom.file, agentSbom);
    const manifestBundlePath = await writeTrustedFile(
      'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
      '{"fixture":"signed"}\n',
    );
    const manifestBundle = '{"fixture":"signed"}\n';
    const attestationTracePath = path.join(scratch, 'attestation-arguments');
    const attestationToolPath = await writeTrustedFile('gh',
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${attestationTracePath}'\nprintf '\\n' >> '${attestationTracePath}'\n`);
    await fs.chmod(attestationToolPath, 0o700);
    const rootfsProvenancePath = await writeTrustedFile(
      shared ? 'enclave-rootfs.provenance.sigstore.jsonl' : 'enclave-script-rootfs.provenance.sigstore.jsonl',
      '{"fixture":"shared"}\n',
    );
    if (!shared) await writeTrustedFile('enclave-agent-rootfs.provenance.sigstore.jsonl', '{"fixture":"agent"}\n');
    await fs.writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      artifactType: 'awf-cloud-hypervisor-enclave-rootfs-set',
      architecture: 'x86_64',
      release: {
        repository: 'github/gh-aw-firewall',
        workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
        tag: releaseTag,
        sourceCommit: 'b'.repeat(40),
      },
      compatibility: {
        cloudHypervisorVersion: '53.0',
        kernelVersion: '6.1.141',
        supervisorVersion: releaseTag,
      },
      ...(shared ? { guestBase: {
        image: `ghcr.io/github/gh-aw-firewall/cloud-hypervisor-guest-base@sha256:${'a'.repeat(64)}`,
        imageId: `sha256:${'a'.repeat(64)}`,
      } } : {}),
      rootfs: { script: scriptArtifact, agent: agentArtifact },
    }), { mode: 0o400 });
    const toolTrust = jest.spyOn(artifactTrust, 'assertTrustedHostTool').mockResolvedValue();

    const artifactChecks = [
      'operator-identity', 'tool-gh', 'verification-directory', 'enclave-artifacts',
      'manifest-bundle-path', 'manifest-trust', 'bundle-trust', 'manifest-read', 'bundle-read',
      'manifest-parse', 'manifest-attestation', 'rootfs-configuration',
      'rootfs-trust', 'rootfs-provenance-trust', 'rootfs-digest', 'rootfs-attestation',
      'sbom-trust', 'sbom-digest', 'sbom-contents',
    ];
    const wrapper = { enclaves: normalizeEnclavesConfig([{ script: {}, repos: [] }]) } as WrapperConfig;
    const publish = (hostPreflight: HostPreflightProgress) =>
      updateEnclaveStartupProgress(wrapper, { hostPreflight });
    const admission = new HostPreflightReporter('bounded-artifacts', publish, undefined,
      { phase: 'preflight', profile: 'common' });
    for (const id of Object.keys(preflightSchema.scopes['bounded-artifacts']) as HostPreflightCheck[]) {
      // Storage admission is a fixture here; artifact verification below uses real files.
      if (!artifactChecks.includes(id)) await admission.check(id, () => undefined);
    }
    const assertArtifactsComplete = async (version: 1 | 2) => {
      const checks = getEnclaveStartupProgress(wrapper)!.startupChecks!.checks;
      for (const id of artifactChecks) {
        expect(checks[`bounded-artifacts/${id}`]).toEqual([
          id === 'sbom-contents' && version === 1 ? 'not-required' : 'passed', 'none',
        ]);
      }
      expect(Object.values(checks).every(([result]) => result === 'passed' || result === 'not-required')).toBe(true);
      const startup = new HostPreflightReporter('startup', publish);
      for (const id of Object.keys(preflightSchema.scopes.startup) as HostPreflightCheck[]) {
        if (id !== 'readiness') await startup.check(id, () => undefined);
      }
      await startup.check('readiness', () => assertEnclaveStartupChecklistComplete(wrapper, true));
      expect(() => assertEnclaveStartupChecklistComplete(wrapper)).not.toThrow();
    };
    try {
      await expect(admission.check('enclave-artifacts', () => preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      }, undefined, undefined, admission))).resolves.toMatchObject({
        rootfs: {
          script: { path: scriptRootfsPath, artifact: scriptArtifact },
          agent: { path: agentRootfsPath, artifact: agentArtifact },
        },
      });
      await assertArtifactsComplete(1);
      const verifications = (await fs.readFile(attestationTracePath, 'utf8')).trim().split('\n\n')
        .map((invocation) => invocation.split('\n'));
      expect(verifications).toHaveLength(shared ? 2 : 3);
      for (const args of verifications) {
        expect(args.slice(0, 2)).toEqual(['attestation', 'verify']);
        expect(args.slice(3)).toEqual([
          '--repo', 'github/gh-aw-firewall',
          '--bundle', expect.any(String),
          '--signer-workflow', 'github/gh-aw-firewall/.github/workflows/release.yml',
          '--deny-self-hosted-runners',
        ]);
      }
      expect(verifications[1][2]).toBe(scriptRootfsPath);
      expect(verifications[1][6]).toBe(rootfsProvenancePath);
      const progress = jest.fn();
      const report = new HostPreflightReporter('bounded-artifacts', progress, undefined,
        { phase: 'preflight', profile: 'common' });
      const cleanupError = Object.assign(new Error('cleanup PRIVATE_SENTINEL'), { code: 'EIO' });
      const remove = fs.rm.bind(fs);
      const cleanup = jest.spyOn(fs, 'rm').mockImplementation(async (destination, options) => {
        if (String(destination).includes('awf-enclave-attestation-')) throw cleanupError;
        return remove(destination, options);
      });
      try {
        await expect(preflightCloudHypervisorEnclaveArtifacts({
          releaseTag, manifestPath, manifestBundlePath, scriptRootfsPath, agentRootfsPath,
          rootfsPath: path.join(scratch, 'wrong-rootfs'), attestationToolPath,
        }, scratch, undefined, report)).rejects.toMatchObject({
          cause: expect.any(Error), cleanupError,
        });
        const record = progress.mock.calls.map(([value]) => value)
          .find((value) => value.checks.some((check: { id: string; result: string }) =>
            check.id === 'rootfs-configuration' && check.result === 'failed'));
        expect(record).toMatchObject({
          schemaVersion: 2, phase: 'preflight', profile: 'common',
        });
        expect(record.checks.find((check: { id: string }) => check.id === 'rootfs-configuration').reason)
          .toBe('requirement-not-met');
        expect(JSON.stringify(progress.mock.calls)).not.toContain('PRIVATE_SENTINEL');
      } finally {
        cleanup.mockRestore();
      }
      if (shared) {
        const originalManifest = await fs.readFile(manifestPath, 'utf8');
        const v2 = JSON.parse(originalManifest) as Record<string, unknown>;
        const sharedArtifact: Record<string, unknown> = { ...scriptArtifact };
        delete sharedArtifact.role;
        delete sharedArtifact.entrypoint;
        const inventory = JSON.stringify({
          spdxVersion: 'SPDX-2.3',
          packages: [{ SPDXID: 'SPDXRef-Rootfs', checksums: [
            { algorithm: 'SHA256', checksumValue: hash(scriptRootfs) },
          ] }],
          files: [{ fileName: './etc/passwd' }],
        });
        await writeTrustedFile('enclave-rootfs.sbom.spdx.json', inventory);
        v2.schemaVersion = 2;
        v2.entrypoints = {
          script: '/usr/local/bin/run-enclave-script',
          agent: '/usr/local/bin/run-enclave-agent',
        };
        v2.rootfs = {
          ...sharedArtifact, sourceImageId: `sha256:${'c'.repeat(64)}`,
          sbom: { file: 'enclave-rootfs.sbom.spdx.json', sha256: hash(inventory) },
        };
        await fs.chmod(manifestPath, 0o600);
        await fs.writeFile(manifestPath, JSON.stringify(v2));
        await fs.chmod(manifestPath, 0o400);
        const canonical = {
          releaseTag, manifestPath, manifestBundlePath,
          rootfsPath: scriptRootfsPath, attestationToolPath,
        };
        await expect(admission.check('enclave-artifacts', () =>
          preflightCloudHypervisorEnclaveArtifacts(canonical, undefined, undefined, admission)))
          .resolves.toMatchObject({
            rootfs: {
              script: { path: scriptRootfsPath },
              agent: { path: scriptRootfsPath },
            },
          });
        await assertArtifactsComplete(2);
        await expect(preflightCloudHypervisorEnclaveArtifacts({
          ...canonical, rootfsPath: undefined,
          scriptRootfsPath, agentRootfsPath,
        })).rejects.toThrow('Canonical enclave rootfs path is required');
        await expect(preflightCloudHypervisorEnclaveArtifacts({
          ...canonical, agentRootfsPath: path.join(scratch, 'wrong-rootfs'),
        })).rejects.toThrow('does not match the trusted manifest path');
        await fs.chmod(manifestPath, 0o600);
        await fs.writeFile(manifestPath, originalManifest);
        await fs.chmod(manifestPath, 0o400);
      } else {
        await expect(preflightCloudHypervisorEnclaveArtifacts({
          releaseTag, manifestPath, manifestBundlePath,
          rootfsPath: scriptRootfsPath, scriptRootfsPath, agentRootfsPath, attestationToolPath,
        })).rejects.toThrow('does not match the trusted manifest path');
      }

      const verificationRoot = path.join(scratch, 'bounded');
      await fs.mkdir(verificationRoot, { mode: 0o700 });
      await fs.writeFile(attestationTracePath, '');
      const contentTrace = path.join(scratch, 'attested-content');
      await fs.writeFile(attestationToolPath,
        `#!/bin/sh\nprintf '%s\\n' "$@" >> '${attestationTracePath}'\nprintf '\\n' >> '${attestationTracePath}'\ncat "$3" >> '${contentTrace}'\n`);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag, manifestPath, manifestBundlePath, scriptRootfsPath, agentRootfsPath, attestationToolPath,
      }, verificationRoot, async (source, destination) => {
        await fs.copyFile(source, destination);
        // Replace the operator source after capture but before hashing/attestation.
        await fs.chmod(source, 0o600);
        await fs.writeFile(source, 'replaced-after-capture');
        await fs.chmod(source, 0o400);
      })).resolves.toMatchObject({
        rootfs: { script: { artifact: scriptArtifact }, agent: { artifact: agentArtifact } },
      });
      const capturedAttestations = (await fs.readFile(attestationTracePath, 'utf8')).trim().split('\n\n')
        .map((invocation) => invocation.split('\n'));
      for (const args of capturedAttestations) {
        expect(args[2].startsWith(`${verificationRoot}/`)).toBe(true);
        expect(args[6].startsWith(`${verificationRoot}/`)).toBe(true);
      }
      const attestedContent = await fs.readFile(contentTrace, 'utf8');
      expect(attestedContent).toContain(scriptRootfs);
      expect(attestedContent).toContain(agentRootfs);
      expect(attestedContent).not.toContain('replaced-after-capture');
      expect(await fs.readdir(verificationRoot)).toEqual([]);
      await fs.chmod(scriptRootfsPath, 0o600);
      await fs.writeFile(scriptRootfsPath, scriptRootfs);
      await fs.chmod(scriptRootfsPath, 0o400);
      if (!shared) {
        await fs.chmod(agentRootfsPath, 0o600);
        await fs.writeFile(agentRootfsPath, agentRootfs);
        await fs.chmod(agentRootfsPath, 0o400);
      }

      await fs.chmod(manifestBundlePath, 0o600);
      await fs.writeFile(manifestBundlePath, '');
      await fs.chmod(manifestBundlePath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('Trusted enclave artifact has invalid file metadata');
      await fs.chmod(manifestBundlePath, 0o600);
      await fs.writeFile(manifestBundlePath, manifestBundle);
      await fs.chmod(manifestBundlePath, 0o400);

      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath: path.join(scratch, 'wrong-bundle'),
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('must use its fixed release filename');
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath: path.join(scratch, 'wrong-rootfs'),
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('does not match the trusted manifest path');

      await fs.chmod(rootfsProvenancePath, 0o600);
      await fs.truncate(rootfsProvenancePath, 8 * 1024 * 1024 + 1);
      await fs.chmod(rootfsProvenancePath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('provenance exceeds its size limit');

      await fs.chmod(rootfsProvenancePath, 0o600);
      await fs.writeFile(rootfsProvenancePath, '{"fixture":"shared"}\n');
      await fs.chmod(rootfsProvenancePath, 0o400);
      const agentSbomPath = path.join(scratch, agentArtifact.sbom.file);
      await fs.chmod(agentSbomPath, 0o600);
      await fs.truncate(agentSbomPath, 16 * 1024 * 1024 + 1);
      await fs.chmod(agentSbomPath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('SBOM exceeds its size limit');

      await fs.writeFile(attestationToolPath, '#!/bin/sh\nexit 1\n');
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('attestation verification failed');
      await fs.writeFile(attestationToolPath, '#!/bin/sh\nexit 0\n');

      await fs.chmod(agentSbomPath, 0o600);
      await fs.writeFile(agentSbomPath, 'tampered-sbom');
      await fs.chmod(agentSbomPath, 0o400);
      await expect(admission.check('enclave-artifacts', () => preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      }, undefined, undefined, admission))).rejects.toThrow('SBOM does not match its trusted manifest digest');
      expect(getEnclaveStartupProgress(wrapper)!.startupChecks).toMatchObject({
        ready: false,
        checks: {
          'bounded-artifacts/sbom-digest': ['failed', 'digest-mismatch'],
          'bounded-artifacts/enclave-artifacts': ['failed', 'digest-mismatch'],
        },
      });
      expect(() => assertEnclaveStartupChecklistComplete(wrapper)).toThrow(/incomplete required checks/);

      await fs.chmod(scriptRootfsPath, 0o600);
      await fs.writeFile(scriptRootfsPath, 'tampered-rootfs');
      await fs.chmod(scriptRootfsPath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('does not match its trusted manifest digest and size');
    } finally {
      toolTrust.mockRestore();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }, 15_000);

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('returns canonical schema-validated JSON within the byte bound', async () => {
    const output = path.join(directory, 'out');
    await fs.writeFile(output, '{"count":2,"ok":true}');
    const schema: FiniteSchemaNode = {
      type: 'object',
      fields: [
        { name: 'ok', schema: { type: 'boolean' } },
        { name: 'count', schema: { type: 'integer', minimum: 0, maximum: 4 } },
      ],
    };

    await expect(readBoundedCloudHypervisorEnclaveResult(output, schema, 64))
      .resolves.toBe('{"ok":true,"count":2}');
  });

  it.each([
    ['invalid JSON', '{'],
    ['schema mismatch', '{"ok":"yes"}'],
    ['empty result', ''],
  ])('rejects %s', async (_label, contents) => {
    const output = path.join(directory, 'out');
    await fs.writeFile(output, contents);
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      64,
    )).resolves.toBeUndefined();
  });

  it('rejects oversized, invalid UTF-8, and symlinked results', async () => {
    const output = path.join(directory, 'out');
    await fs.writeFile(output, 'true ');
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      4,
    )).resolves.toBeUndefined();

    await fs.writeFile(output, Buffer.from([0xff]));
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      64,
    )).resolves.toBeUndefined();

    const target = path.join(directory, 'target');
    await fs.writeFile(target, 'true');
    await fs.rm(output);
    await fs.symlink(target, output);
    await expect(readBoundedCloudHypervisorEnclaveResult(
      output,
      { type: 'boolean' },
      64,
    )).resolves.toBeUndefined();
  });
});
