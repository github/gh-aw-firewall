import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ENCLAVE_AGENT_API_PROXY_IP, ENCLAVE_GITHUB_MCP_PORT } from '../enclave/network';
import {
  CloudHypervisorHostEnclaveExecutorBackend,
  type HostEnclaveExecutorDependencies,
  type HostExecutorAgentPolicy,
} from './host-enclave-executor';
import { preservePublicEnclaveSession } from './diagnostics';
import { preservePublicEnclaveArtifacts } from '../enclave/public-debug-artifacts';
import * as publicDebugArtifacts from '../enclave/public-debug-artifacts';
import { expectPublicEnclaveAdapterConformance } from '../enclave/public-debug-conformance.test-utils';
import { startHostExecutorServer, type HostExecutorInvocationPlan } from '../enclave/host-executor-server';
import * as hostExecutorDiagnostics from '../enclave/host-executor-diagnostics';
import type { CloudHypervisorCleanupRegistry } from './cleanup-registry';
import { cloudHypervisorManagerTestHelpers, resolveCloudHypervisorManagerDependencies } from './manager';
import { HOST_EXECUTOR_TIMEOUT_GRACE_MS } from '../enclave/host-executor-protocol';
import {
  agentScenarios,
  deadlineScenarios,
  scriptScenarios,
  staticStagingScenarios,
  useBackendFixture,
} from './host-enclave-executor.test-utils';

describe('CloudHypervisorHostEnclaveExecutorBackend', () => {
  describe.each([...staticStagingScenarios, ...deadlineScenarios])(
    'static $role staging (publicDebug=$publicDebug, shared=$shared, startupDelayMs=$startupDelayMs)',
    scenario => {
      const fixture = useBackendFixture(scenario);

      const title = scenario.timeoutMs === 1000
        ? `enforces a ${scenario.expectedOutcome} deadline after ${scenario.startupDelayMs}ms startup`
        : 'stages a trusted static invocation with isolated ownership and cleanup';
      it(title, async () => {
        const {
          role, expectedOutcome, publicDebug, backend, backendOptions, config, dependencies,
          plan, preservePublicArtifacts, chownedPaths, invocationHostDir, state,
        } = fixture();
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
        if (publicDebug) {
          const envelope = preservePublicArtifacts.mock.calls[preservePublicArtifacts.mock.calls.length - 1][0].envelope;
          expectPublicEnclaveAdapterConformance(envelope, 'cloud-hypervisor');
          expect(envelope).toMatchObject({ exitCode: 0, failure: 'none' });
        } else expect(preservePublicArtifacts).not.toHaveBeenCalled();
        expect(state.mountedIdentity).toEqual({ uid: 65534, gid: 65534 });
        expect(state.managerBinary).toBe('/snapshot/cloud-hypervisor');
        if (expectedOutcome === 'success') {
          expect(chownedPaths).toContain(path.join(invocationHostDir, 'output'));
          expect(chownedPaths).toContain(path.join(invocationHostDir, 'output', 'out'));
          expect(chownedPaths).toContain(path.join(
            invocationHostDir,
            'request',
            role === 'script' ? 'query-script.py' : 'task.txt',
          ));
        }
        expect(state.stopped).toBe(true);
        expect(state.snapshotRemoved).toBe(true);
        expect(state.unmounted).toBe(true);
        await expect(fs.lstat(invocationHostDir)).rejects.toMatchObject({ code: 'ENOENT' });
      }, 30_000);
    },
  );

  describe.each(scriptScenarios)(
    'script storage and lifecycle (publicDebug=$publicDebug, shared=$shared)',
    scenario => {
      const fixture = useBackendFixture(scenario);

      it('rejects unverifiable storage and exports no agent credentials or network', async () => {
        const { backend, plan, state, backendOptions, dependencies, invocationHostDir, scriptArtifact, publicDebug } = fixture();
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'success', result: 'true' });
        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
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
        expect(state.unmounted).toBe(true);
        expect(state.snapshotRemoved).toBe(false);
        expect(await fs.lstat(invocationHostDir).catch(() => undefined)).toBeUndefined();
        await invalidStorageBackend.close();

        expect(state.workloadProfile?.kind).toBe('script-enclave');
        expect(state.workloadProfile?.network).toEqual({ mode: 'none' });
        expect(state.workloadProfile?.guest?.exports.some(({ tag }) => tag === 'enclave-session-handoff'))
          .toBe(false);
        expect(state.executionRequest?.argv).toEqual([scriptArtifact.entrypoint]);
        expect(state.executionRequest?.env).toEqual(
          publicDebug ? { AWF_ENCLAVE_SCRIPT_DEBUG_PROGRESS: 'true' } : {},
        );
      });

      it('handles default mount, unmount and manager failures, workload timeouts and cancellation', async () => {
        const {
          backendOptions, preflight, tools, preservePublicArtifacts, preservePublicSession,
          plan, dependencies, invocationHostDir, state, backend,
        } = fixture();
        const mountFailureBackend = new CloudHypervisorHostEnclaveExecutorBackend({
          ...backendOptions,
          preflight: {
            ...preflight,
            tools: { ...tools, mount: '/usr/bin/false' },
          },
        }, { preservePublicArtifacts, preservePublicSession });
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
          config: { ...backendOptions.config, enclaveDebugPublic: false },
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

        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
        state.managerExecutionResult = { exitCode: 1, signal: null, timedOut: false };
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: true, recoverableFailure: true });

        state.managerExecutionResult = { exitCode: 0, signal: null, timedOut: true };
        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'timeout' });

        state.managerExecutionResult = { exitCode: 0, signal: null, timedOut: false };
        const abortDuringExecution = new AbortController();
        state.abortOnExecute = abortDuringExecution;
        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
        await expect(backend.execute(plan, abortDuringExecution.signal))
          .resolves.toEqual({ outcome: 'cancelled' });
        state.abortOnExecute = undefined;
      }, 30_000);

      it('revalidates every captured invocation artifact before creating a manager', async () => {
        const { preflight, dependencies, root, backendOptions, state, plan } = fixture();
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
        state.stopped = false;
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
          state.snapshotRemoved = false;
          await expect(boundedBackend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure' });
          expect(boundedManager).not.toHaveBeenCalled();
          expect(storageClose).toHaveBeenCalledTimes(1);
          expect(state.snapshotRemoved).toBe(true);
        }
        await boundedBackend.close();
      });

      it('settles broker results only after stopping, unmounting and removing invocation artifacts', async () => {
        const {
          state, root, runState, backendOptions, dependencies, entryId, invocationId, plan, role, seedId, invocationHostDir,
        } = fixture();
        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
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
          expect(state.unmounted).toBe(true);
          expect(state.stopped).toBe(true);
          expect(state.snapshotRemoved).toBe(true);
          expect(await fs.lstat(invocationHostDir).catch(() => undefined)).toBeUndefined();
          const settled = await broker.settle({ entryId, invocationId, resultDigest: status.resultDigest });
          expect(settled).toEqual(expect.objectContaining({ ok: true, state: 'settled', outcome: 'success' }));
          expect(settled.result).toBeUndefined();
        } finally {
          await server.close();
        }
      });

      it('keeps interrupted mount, input-write and snapshot staging unsettled until cleanup completes', async () => {
        const {
          dependencies, invocationHostDir, runState, root, backendOptions, state,
          entryId, invocationId, plan, role, seedId,
        } = fixture();
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
            state.unmounted = false;
            state.snapshotRemoved = false;
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
            expect(state.unmounted).toBe(false);
            release();
            let status = await broker.status({ entryId, invocationId });
            for (let attempt = 0; attempt < 100 && status.state !== 'terminal'; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              status = await broker.status({ entryId, invocationId });
            }
            expect(status).toEqual(expect.objectContaining({ state: 'terminal', outcome: 'cancelled' }));
            expect(state.unmounted).toBe(true);
            if (stage !== 'mount') expect(state.snapshotRemoved).toBe(true);
            expect(await fs.lstat(invocationHostDir).catch(() => undefined)).toBeUndefined();
            expect(await broker.settle({ entryId, invocationId, resultDigest: status.resultDigest }))
              .toEqual(expect.objectContaining({ state: 'settled', outcome: 'cancelled' }));
          } finally {
            release();
            await interruptedServer.close();
          }
        }
      }, 30_000);

      it('preserves primary and cleanup failure ordering and reads diagnostics through the same open descriptor after close', async () => {
        const { state, backend, plan, backendOptions, dependencies, runState, invocationHostDir } = fixture();
        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
        state.managerStartError = true;
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure' });
        expect(state.stopped).toBe(true);
        expect(state.snapshotRemoved).toBe(true);
        expect(state.unmounted).toBe(true);

        state.managerStartError = false;
        state.managerResult = 'not-json';
        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'schema-failure' });

        state.managerStopError = true;
        state.managerStartError = true;
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
        state.managerStartError = false;
        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure' });
        state.managerStopError = false;
      });
    },
  );

  describe.each(staticStagingScenarios)(
    '$role recovery and ownership (publicDebug=$publicDebug, shared=$shared)',
    scenario => {
      const fixture = useBackendFixture(scenario);

      it('waits for cleanup before exposing recoverable failures and permits a later invocation', async () => {
        const {
          role, timeoutMs, publicDebug, shared, state, backendOptions, dependencies, plan,
          preservePublicArtifacts, invocationHostDir, backend, runState, root, entryId, seedId,
        } = fixture();
        for (const execution of [
          { exitCode: 23, signal: null, timedOut: false },
          { exitCode: 0, signal: 'SIGKILL', timedOut: false },
        ]) {
          state.managerExecutionResult = execution;
          state.stopped = false;
          state.unmounted = false;
          state.snapshotRemoved = false;
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
            expect(state.stopped && state.unmounted && state.snapshotRemoved).toBe(true);
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
        if (publicDebug) {
          const envelope = preservePublicArtifacts.mock.calls[preservePublicArtifacts.mock.calls.length - 1][0].envelope;
          expectPublicEnclaveAdapterConformance(envelope, 'cloud-hypervisor');
          expect(envelope.cleanupFailure).toMatchObject({ stage: 'cleanup', category: 'host-exception' });
          expect(envelope.primaryFailure).toMatchObject({ stage: 'workload-exit', category: 'workload-exit' });
        }
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

        state.managerExecutionResult = { exitCode: 0, signal: null, timedOut: false };
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'success', result: 'true' });
        state.managerExecuteError = true;
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure' });
        state.managerExecuteError = false;

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
                return { ...manager, stop: async () => { await fs.writeFile(path.join(output, 'out'), state.managerResult); } };
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
              state.managerExecutionResult = { exitCode, signal: null, timedOut: false };
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
      }, 30_000);

      it('rejects use after close and removes an owned preflight snapshot idempotently', async () => {
        const { backend, plan, state, root, backendOptions, preflight } = fixture();
        await backend.close();
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure' });
        state.snapshotRemoved = false;
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
      });
    },
  );

  describe.each(agentScenarios)(
    'agent diagnostics and authority (publicDebug=$publicDebug, shared=$shared)',
    scenario => {
      const fixture = useBackendFixture(scenario);

      it('stages scoped credentials and captures bounded, redacted session and transport diagnostics', async () => {
        const {
          backend, plan, state, agentArtifact, agentPolicy, publicDebug, preservePublicSession,
          runState, sessionReads, preservePublicArtifacts, invocationHostDir,
        } = fixture();
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'success', result: 'true' });
        expect(state.workloadProfile?.kind).toBe('agent-enclave');
        expect(state.workloadProfile?.network).toMatchObject({
          mode: 'enclave-agent',
          githubDataPlane: { port: ENCLAVE_GITHUB_MCP_PORT },
        });
        expect(state.workloadProfile?.guest?.exports.find(
          ({ tag }) => tag === 'enclave-session-handoff',
        )).toMatchObject({ mode: 'ro' });
        expect(state.executionRequest?.argv).toEqual([agentArtifact.entrypoint]);
        expect(state.executionRequest?.env).toMatchObject({
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
        expect(state.executionRequest?.env.AWF_ENCLAVE_AGENT_GITHUB_PROFILE).toBeUndefined();
        expect(state.executionRequest?.env.AWF_ENCLAVE_AGENT_DEBUG_RAW_SESSION_LOGS)
          .toBe(publicDebug ? 'true' : undefined);
        if (publicDebug) {
          expect(preservePublicSession).toHaveBeenCalledWith(
            expect.stringMatching(/^\/protected\/cloud-hypervisor\/[a-f0-9]+\/[a-f0-9]+$/),
            '/protected',
            expect.not.stringContaining('PRIVATE_SESSION_TOKEN'),
            expect.arrayContaining([agentPolicy.githubBearer]),
            expect.anything(),
          );
          expect(JSON.parse(preservePublicSession.mock.calls[0][2])).toMatchObject({
            status: 'captured',
          });
        } else {
          expect(preservePublicSession).not.toHaveBeenCalled();
        }
        expect(state.executionRequest?.env.COPILOT_API_URL)
          .toBe(`http://${ENCLAVE_AGENT_API_PROXY_IP}:10002`);
        expect(state.executionRequest?.env).toMatchObject({
          COPILOT_GITHUB_TOKEN: '******',
          COPILOT_TOKEN: '******',
          COPILOT_PROVIDER_BEARER_TOKEN: '******',
        });
        expect(state.stagedHandoff).toEqual({
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
        state.managerExecuteError = true;
        state.stopped = false;
        state.unmounted = false;
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure' });
        const failed = JSON.parse(hostExecutorDiagnostics.readHostExecutorInvocationDiagnostics(runState)[0].contents);
        expect(failed.failure).toMatchObject({
          stage: 'host-invocation/guest-execute', reason: 'guest-disconnected',
        });
        expect(failed.milestones).not.toContainEqual(expect.objectContaining({ phase: 'guest-complete' }));
        expect(failed.guestSession).toMatchObject({ status: 'captured' });
        expect(preservePublicSession).toHaveBeenCalledTimes(publicDebug ? 2 : 0);
        if (publicDebug) {
          const envelope = preservePublicArtifacts.mock.calls[preservePublicArtifacts.mock.calls.length - 1][0].envelope;
          expectPublicEnclaveAdapterConformance(envelope, 'cloud-hypervisor');
          expect(envelope).toMatchObject({ exitCode: null, failure: 'execution-exception' });
          expect(envelope.primaryFailure).toMatchObject({ stage: 'workload-exit', category: 'host-exception' });
        }
        await expect(fs.stat(invocationHostDir)).rejects.toMatchObject({ code: 'ENOENT' });
        state.managerExecuteError = false;
      });

      it('rejects invalid policies before snapshots and rechecks capability lifetime after startup', async () => {
        const {
          agentPolicy, plan, state, backendOptions, dependencies, entryId, publicDebug, preservePublicArtifacts,
        } = fixture();
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
            policy: { ...agentPolicy, githubBearer: undefined },
            error: 'Trusted Cloud Hypervisor GitHub capability must include tools and cover the invocation deadline',
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
          const snapshotsBefore = state.snapshotNumber;
          const invalidPolicyBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions,
            agentPolicies: { [entryId]: invalid.policy },
          }, dependencies);
          const execution = invalidPolicyBackend.execute(
            invalid.plan ?? plan,
            new AbortController().signal,
          );
          if (publicDebug) {
            await expect(execution).resolves.toEqual({ outcome: 'executor-failure' });
            expect(preservePublicArtifacts).toHaveBeenLastCalledWith(expect.objectContaining({
              envelope: expect.objectContaining({
                workloadLaunched: false, exitCode: null, failure: 'setup-failed',
                primaryFailure: expect.objectContaining({ stage: 'authority-handoff' }),
              }),
            }));
          } else await expect(execution).rejects.toThrow(invalid.error);
          expect(state.snapshotNumber).toBe(snapshotsBefore);
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
      });

      it('cleans up a missing policy, permits GitHub-free agents, and fails closed on session retention errors', async () => {
        const {
          backendOptions, dependencies, state, plan, entryId, publicDebug,
          preservePublicSession, backend, invocationHostDir,
        } = fixture();
        const missingPolicyBackend = new CloudHypervisorHostEnclaveExecutorBackend({
          ...backendOptions,
          agentPolicies: undefined,
        }, dependencies);
        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
        await expect(missingPolicyBackend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure' });
        expect(state.snapshotRemoved).toBe(true);
        expect(state.unmounted).toBe(true);
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
        state.expectHandoffCredentials = false;
        state.stopped = false;
        state.unmounted = false;
        state.snapshotRemoved = false;
        await expect(noGithubBackend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'success', result: 'true' });
        expect(state.workloadProfile?.network).toMatchObject({ mode: 'enclave-agent' });
        expect(state.workloadProfile?.network).not.toHaveProperty('githubDataPlane');
        expect(state.executionRequest?.env.AWF_ENCLAVE_AGENT_GITHUB_ENABLED).toBe('false');
        await noGithubBackend.close();

        if (publicDebug) {
          preservePublicSession.mockRejectedValueOnce(new Error('protected session write failed'));
          state.stopped = false;
          state.unmounted = false;
          state.snapshotRemoved = false;
          await expect(backend.execute(plan, new AbortController().signal))
            .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
          expect(state.stopped).toBe(true);
          expect(state.unmounted).toBe(false);
          expect(state.snapshotRemoved).toBe(false);
          await expect(fs.stat(path.join(invocationHostDir, 'session-state', 'session.jsonl')))
            .resolves.toBeDefined();
        }
      });

      if (scenario.publicDebug) {
        it('retains real public diagnostics with safe missing-session fallback and stream bounds', async () => {
          const {
            directory, runState, invocationId, backendOptions, dependencies, invocationHostDir, agentPolicy, plan,
          } = fixture();
          const publicRoot = path.join(directory, 'public');
          const publicDirectory = path.join(publicRoot, runState.runId, invocationId);
          let fallbackStatus: 'captured' | 'unsafe' | 'oversized' | undefined;
          const summary = {
            event: 'progress', stage: 'claude-stream-summary', stdoutObserved: true,
            stderrObserved: false, outputState: 'empty',
          };
          const realRetentionBackend = new CloudHypervisorHostEnclaveExecutorBackend({
            ...backendOptions,
            publicDebugArtifactDirectory: publicRoot,
            publicDebugArtifactProtectedRoot: directory,
            managerDependencies: resolveCloudHypervisorManagerDependencies({
              resolveIdentity: () => ({ uid: process.getuid!(), gid: process.getgid!() }),
              // Emulate root ownership only; the retention sinks and file writes are real.
              lstat: (async (...args: Parameters<typeof fs.lstat>) =>
                Object.assign(await fs.lstat(...args), { uid: 0 })) as typeof fs.lstat,
              open: async (...args: Parameters<typeof fs.open>) => {
                const handle = await fs.open(...args);
                handle.chown = async () => undefined;
                const stat = handle.stat.bind(handle);
                handle.stat = (async () => Object.assign(await stat(), { uid: 0 })) as typeof handle.stat;
                return handle;
              },
            }),
          }, {
            ...dependencies,
            resolveIdentity: () => ({ uid: process.getuid!(), gid: process.getgid!() }),
            preservePublicSession: preservePublicEnclaveSession,
            preservePublicArtifacts: preservePublicEnclaveArtifacts,
            createManager: (...args) => {
              const manager = dependencies.createManager!(args[0], args[1], args[2], args[3], args[4], {
                ...resolveCloudHypervisorManagerDependencies(args[5]),
                enclaveDebugArtifactDirectory: `/protected/cloud-hypervisor/${runState.runId}/${invocationId}`,
                enclaveDebugArtifactProtectedRoot: '/protected',
              }, args[6]);
              return {
                ...manager,
                execute: async request => {
                  const result = await manager.execute(request);
                  if (fallbackStatus) {
                    await fs.rm(path.join(invocationHostDir, 'session-state', 'session.jsonl'));
                    await fs.mkdir(publicDirectory, { recursive: true, mode: 0o700 });
                    const stderr = path.join(publicDirectory, 'stderr.log');
                    await fs.writeFile(stderr, `${JSON.stringify({
                      event: 'operation-error', operation: 'preflight-session-log',
                      category: 'permission-denied', errno: 13, path: '/private/session.jsonl',
                      raw: `PRIVATE_SESSION_TOKEN ${agentPolicy.githubBearer}`,
                    })}\n`, { mode: 0o600 });
                    if (fallbackStatus === 'oversized') {
                      await fs.truncate(stderr, publicDebugArtifacts.PUBLIC_ENCLAVE_CAPTURE_BYTES + 1);
                    }
                    return { exitCode: 1, signal: null, timedOut: false };
                  }
                  await fs.writeFile(path.join(invocationHostDir, 'session-state', 'session.jsonl'), [
                    ...Array.from({ length: 40 }, () => JSON.stringify({
                      event: 'progress', stage: 'engine-started', secret: 'PRIVATE_SESSION_TOKEN',
                    })),
                    JSON.stringify({ event: 'failure', category: 'result-empty', raw: 'PRIVATE_SESSION_TOKEN' }),
                    JSON.stringify({ ...summary, raw: 'PRIVATE_SESSION_TOKEN' }),
                    '',
                  ].join('\n'));
                  return result;
                },
              };
            },
          });
          try {
            await expect(realRetentionBackend.execute(plan, new AbortController().signal))
              .resolves.toEqual({ outcome: 'success', result: 'true' });
            const sessionText = await fs.readFile(path.join(publicDirectory, 'enclave-session.log'), 'utf8');
            const session = JSON.parse(sessionText);
            const diagnosticsText = await fs.readFile(path.join(publicDirectory, 'diagnostics.json'), 'utf8');
            const diagnostics = JSON.parse(diagnosticsText);
            expect(session).toMatchObject({
              status: 'captured', failure: { event: 'failure', category: 'result-empty' },
              claudeStreamSummary: summary,
            });
            expect(session.events).toHaveLength(32);
            expect(diagnostics.session).toEqual(session);
            expect(diagnostics.stages).toContainEqual(expect.objectContaining({
              stage: 'entrypoint-initialization', status: 'succeeded',
            }));
            expect(sessionText + diagnosticsText).not.toContain('PRIVATE_SESSION_TOKEN');
            // Only translate the fixture's mocked root ownership. All fixed-file,
            // mode, device, link and byte-bound checks use the production reader.
            const readPublicFile = publicDebugArtifacts.readPublicEnclaveFile;
            const reader = jest.spyOn(publicDebugArtifacts, 'readPublicEnclaveFile').mockImplementation(
              (directory, name, expectedUid, expectedGid) => {
                expect(expectedUid).toBe(0);
                expect(expectedGid).toBe(0);
                return readPublicFile(directory, name, process.getuid!(),
                  fallbackStatus === 'unsafe' && name === 'stderr.log' ? process.getgid!() + 1 : process.getgid!());
              },
            );
            try {
              for (const status of ['captured', 'unsafe', 'oversized'] as const) {
                fallbackStatus = status;
                await expect(realRetentionBackend.execute(plan, new AbortController().signal))
                  .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: true, recoverableFailure: true });
                const text = await fs.readFile(path.join(publicDirectory, 'diagnostics.json'), 'utf8');
                const diagnostics = JSON.parse(text);
                expect(diagnostics).toMatchObject({
                  exitCode: 1, failure: 'workload-exit', workloadStopped: true,
                  streams: { session: 'missing', stderr: status }, session: { status: 'missing' },
                });
                expect(diagnostics.stages).toContainEqual(status === 'captured' ? {
                  stage: 'entrypoint-initialization', status: 'failed', category: 'permission-denied', errno: 13,
                  operation: 'preflight-session-log',
                } : { stage: 'entrypoint-initialization', status: 'unavailable' });
                expect(diagnostics.primaryFailure).toMatchObject(status === 'captured'
                  ? {
                    stage: 'entrypoint-initialization', category: 'permission-denied', errno: 13,
                    operation: 'preflight-session-log',
                  }
                  : { stage: 'workload-exit', category: 'workload-exit' });
                const sessionText = await fs.readFile(path.join(publicDirectory, 'enclave-session.log'), 'utf8');
                expect(sessionText).toBe('');
                const stderrText = await fs.readFile(path.join(publicDirectory, 'stderr.log'), 'utf8');
                expect(text + sessionText).not.toContain('/private/session.jsonl');
                expect(text + sessionText + stderrText).not.toContain(agentPolicy.githubBearer);
                if (status !== 'captured') expect(stderrText).toBe('');
              }
            } finally {
              reader.mockRestore();
            }
          } finally {
            await realRetentionBackend.close();
          }
        }, 30_000);
      }
    },
  );
});
