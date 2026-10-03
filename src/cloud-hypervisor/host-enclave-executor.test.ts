import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_GITHUB_MCP_PORT,
} from '../enclave/network';
import { version as AWF_VERSION } from '../../package.json';
import * as artifactTrust from './artifact-trust';
import * as cloudHypervisorPreflight from './preflight';
import {
  CloudHypervisorHostEnclaveExecutorBackend,
  createCloudHypervisorHostEnclaveExecutor,
  preflightCloudHypervisorEnclaveArtifacts,
  readBoundedCloudHypervisorEnclaveResult,
} from './host-enclave-executor';
import type { FiniteSchemaNode } from '../bounded-execution/finite-schema';
import type {
  HostExecutorInvocationPlan,
  HostExecutorRunState,
} from '../enclave/host-executor-server';
import { startHostExecutorServer } from '../enclave/host-executor-server';
import type { CloudHypervisorOptions } from '../types/runtime-options';
import type { CloudHypervisorCleanupRegistry } from './cleanup-registry';
import type {
  CloudHypervisorHostToolPaths,
  CloudHypervisorPreflightResult,
} from './preflight';
import { cloudHypervisorManagerTestHelpers } from './manager';
import type {
  HostEnclaveExecutorDependencies,
  HostEnclaveExecutorManager,
  HostExecutorAgentPolicy,
  VerifiedCloudHypervisorEnclaveArtifacts,
} from './host-enclave-executor';
import type { CloudHypervisorWorkloadProfile } from './workload-profile';

describe('readBoundedCloudHypervisorEnclaveResult', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(process.cwd(), '.awf-enclave-result-'));
  });

  describe('CloudHypervisorHostEnclaveExecutorBackend', () => {
    it.each([
      { role: 'script', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success' },
      { role: 'agent', timeoutMs: 60_000, startupDelayMs: 0, expectedOutcome: 'success' },
      { role: 'script', timeoutMs: 1_000, startupDelayMs: 1_500, expectedOutcome: 'timeout' },
    ] as const)('stages a static $role invocation and enforces its $expectedOutcome deadline', async ({
      role,
      timeoutMs,
      startupDelayMs,
      expectedOutcome,
    }) => {
      const scratch = await fs.mkdtemp(path.join(process.cwd(), '.awf-host-backend-'));
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
        cloudHypervisorBinary: '/trusted/cloud-hypervisor',
        virtiofsdBinary: '/trusted/virtiofsd',
        kernelPath: '/trusted/vmlinux',
        rootfsPath: '/trusted/primary-rootfs',
        supervisorPath: '/trusted/supervisor',
        artifactSnapshotDirectory: '/trusted/preflight',
        artifactDigests: {
          cloudHypervisor: 'a'.repeat(64),
          virtiofsd: 'b'.repeat(64),
          kernel: 'c'.repeat(64),
          rootfs: 'd'.repeat(64),
          supervisor: 'e'.repeat(64),
        },
        tools,
      } as CloudHypervisorPreflightResult;
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
      };
      const config: CloudHypervisorOptions = {
        previewEnabled: true,
        mountPolicy: 'workspace-only',
        cloudHypervisorBinary: '/trusted/cloud-hypervisor',
        artifactReleaseTag: 'v0.23.1',
        vcpuCount: 1,
        memoryMib: 768,
        apiTimeoutMs: 30_000,
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
      let managerStopError = false;
      let managerResult = 'true';
      let managerExecutionResult = { exitCode: 0, signal: null as string | null, timedOut: false };
      let abortOnExecute: AbortController | undefined;
      let expectHandoffCredentials = true;
      let executionRequest: Parameters<HostEnclaveExecutorManager['execute']>[0] | undefined;
      let workloadProfile: CloudHypervisorWorkloadProfile | undefined;
      let stagedHandoff: { agentId: string; bearer: string } | undefined;
      const backendOptions = {
        runState,
        config,
        workDir: root,
        preflight,
        enclaveArtifacts: artifacts,
        ...(role === 'agent' ? { agentPolicies: { [entryId]: agentPolicy } } : {}),
      };
      const dependencies: Partial<HostEnclaveExecutorDependencies> = {
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
        createManager: (managerConfig, _workDir, profile) => {
          managerBinary = managerConfig.cloudHypervisorBinary;
          workloadProfile = profile;
          expect(profile.guest?.identity).toEqual({ uid: 65534, gid: 65534 });
          return {
            start: async () => {
              if (managerStartError) throw new Error('manager startup failed');
              if (startupDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
              }
            },
            startInstance: async () => undefined,
            execute: async (request) => {
              executionRequest = request;
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
              if (managerStopError) throw new Error('manager stop failed');
              const output = path.join(invocationHostDir, 'output', 'out');
              await fs.writeFile(output, managerResult);
            },
            completeCleanupRecord: async () => undefined,
          };
        },
      };
      const backend = new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, dependencies);

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
            AWF_ENCLAVE_AGENT_MAX_MODEL_REQUESTS: '5',
            AWF_ENCLAVE_AGENT_MAX_MODEL_TOKENS: '1000',
          });
          expect(executionRequest?.env.COPILOT_API_URL)
            .toBe(`http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`);
          expect(executionRequest?.env).toMatchObject({
            COPILOT_GITHUB_TOKEN: '******',
            COPILOT_TOKEN: '******',
          });
          expect(stagedHandoff).toEqual({
            agentId: 'agent_123\n',
            bearer: `${agentPolicy.githubBearer}\n`,
          });
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
          if (expectedOutcome === 'success') {
            expect(executionRequest?.argv).toEqual([scriptArtifact.entrypoint]);
            expect(executionRequest?.env).toEqual({});
          }
        }

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
            {
              policy: agentPolicy,
              plan: { ...plan, timeoutMs: 0 },
              error: 'Trusted host executor agent policy is invalid',
            },
          ];
          for (const invalid of invalidPolicies) {
            const invalidPolicyBackend = new CloudHypervisorHostEnclaveExecutorBackend({
              ...backendOptions,
              agentPolicies: { [entryId]: invalid.policy },
            }, dependencies);
            await expect(invalidPolicyBackend.execute(
              invalid.plan ?? plan,
              new AbortController().signal,
            )).rejects.toThrow(invalid.error);
            await invalidPolicyBackend.close();
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
            .resolves.toEqual({ outcome: 'executor-failure' });

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
        await fs.rm(scratch, { recursive: true, force: true });
      }
    });
  });

  it('requires staged and verified enclave artifacts before creating the executor', async () => {
    const options = {
      runState: {} as HostExecutorRunState,
      config: { artifactReleaseTag: 'v0.23.1' } as CloudHypervisorOptions,
      workDir: '/tmp/awf-enclave',
      environment: {},
    };
    await expect(createCloudHypervisorHostEnclaveExecutor(options))
      .rejects.toThrow('Cloud Hypervisor enclave artifacts have not been staged and verified');
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
      runState: {} as HostExecutorRunState,
      config: { artifactReleaseTag: `v${AWF_VERSION}` } as CloudHypervisorOptions,
      workDir: scratch,
      environment,
    };
    const preflight = {
      artifactSnapshotDirectory: path.join(scratch, 'preflight-snapshot'),
    } as CloudHypervisorPreflightResult;
    const runPreflight = jest.spyOn(
      cloudHypervisorPreflight,
      'runCloudHypervisorPreflight',
    ).mockResolvedValue(preflight);
    const trustedTool = jest.spyOn(
      artifactTrust,
      'assertTrustedHostTool',
    ).mockResolvedValue();
    const removeSnapshot = jest.fn(async () => undefined);

    try {
      await expect(createCloudHypervisorHostEnclaveExecutor({
        ...options,
        environment: { ...environment, PATH: '' },
      })).rejects.toThrow('A trusted GitHub CLI is required');
      await expect(createCloudHypervisorHostEnclaveExecutor(options, {
        removeArtifactSnapshot: removeSnapshot,
      })).rejects.toThrow();
      expect(runPreflight).toHaveBeenCalledTimes(1);
      expect(removeSnapshot).toHaveBeenCalledWith(preflight.artifactSnapshotDirectory);
    } finally {
      runPreflight.mockRestore();
      trustedTool.mockRestore();
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

  it('verifies a release-pinned artifact set and rejects a rootfs digest mismatch', async () => {
    const scratch = await fs.mkdtemp(path.join(process.cwd(), '.awf-enclave-preflight-'));
    const releaseTag = `v${AWF_VERSION}`;
    const hash = (contents: string) => createHash('sha256').update(contents).digest('hex');
    const writeTrustedFile = async (name: string, contents: string): Promise<string> => {
      const filePath = path.join(scratch, name);
      await fs.writeFile(filePath, contents, { mode: 0o400 });
      return filePath;
    };
    const scriptRootfs = 'script-rootfs-fixture';
    const agentRootfs = 'agent-rootfs-fixture';
    const scriptSbom = JSON.stringify({ name: 'enclave-script' });
    const agentSbom = JSON.stringify({ name: 'enclave-agent' });
    const artifacts = (role: 'script' | 'agent', rootfs: string, sbom: string) => {
      const digest = 'a'.repeat(64);
      return {
        file: `enclave-${role}-rootfs.ext4`,
        role,
        version: releaseTag,
        sha256: hash(rootfs),
        sizeBytes: Buffer.byteLength(rootfs),
        uid: 65534,
        gid: 65534,
        entrypoint: `/usr/local/bin/run-enclave-${role}`,
        sourceImage: `ghcr.io/github/gh-aw-firewall/enclave-${role}@sha256:${digest}`,
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
    const agentRootfsPath = await writeTrustedFile(agentArtifact.file, agentRootfs);
    await writeTrustedFile(scriptArtifact.sbom.file, scriptSbom);
    await writeTrustedFile(agentArtifact.sbom.file, agentSbom);
    const manifestBundlePath = await writeTrustedFile(
      'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
      '{"fixture":"signed"}\n',
    );
    const manifestBundle = '{"fixture":"signed"}\n';
    const attestationToolPath = await writeTrustedFile('gh', '#!/bin/sh\nexit 0\n');
    await fs.chmod(attestationToolPath, 0o700);
    const scriptProvenancePath = await writeTrustedFile(
      'enclave-script-rootfs.provenance.sigstore.jsonl',
      '{"fixture":"script"}\n',
    );
    await writeTrustedFile(
      'enclave-agent-rootfs.provenance.sigstore.jsonl',
      '{"fixture":"agent"}\n',
    );
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
      rootfs: { script: scriptArtifact, agent: agentArtifact },
    }), { mode: 0o400 });
    const toolTrust = jest.spyOn(artifactTrust, 'assertTrustedHostTool').mockResolvedValue();

    try {
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).resolves.toMatchObject({
        rootfs: {
          script: { path: scriptRootfsPath, artifact: scriptArtifact },
          agent: { path: agentRootfsPath, artifact: agentArtifact },
        },
      });

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

      await fs.chmod(scriptProvenancePath, 0o600);
      await fs.writeFile(scriptProvenancePath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
      await fs.chmod(scriptProvenancePath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('provenance or SBOM exceeds its size limit');

      await fs.chmod(scriptProvenancePath, 0o600);
      await fs.writeFile(scriptProvenancePath, '{"fixture":"script"}\n');
      await fs.chmod(scriptProvenancePath, 0o400);
      const agentSbomPath = path.join(scratch, agentArtifact.sbom.file);
      await fs.chmod(agentSbomPath, 0o600);
      await fs.writeFile(agentSbomPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
      await fs.chmod(agentSbomPath, 0o400);
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('provenance or SBOM exceeds its size limit');

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
      await expect(preflightCloudHypervisorEnclaveArtifacts({
        releaseTag,
        manifestPath,
        manifestBundlePath,
        scriptRootfsPath,
        agentRootfsPath,
        attestationToolPath,
      })).rejects.toThrow('SBOM does not match its trusted manifest digest');

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
  });

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
