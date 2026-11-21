import { describeLinux, useDockerHostExecutorFixture, runId } from './docker-host-executor.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import { createDockerHostContext, type DockerHostEnclaveExecutorOptions } from './docker-host-context';
import { createDockerHostContainerOperations } from './docker-host-container';
import { createDockerHostExecution } from './docker-host-execute';
import { initializeDockerHostRecovery } from './docker-host-recovery';
import { mountDockerHostStorage, ownDockerHostStorageFile, cleanupDockerHostStorage } from './docker-host-storage';
import { preservePublicEnclaveArtifacts } from './public-debug-artifacts';

describeLinux('Docker host execution stage boundaries', () => {
  const getFixture = useDockerHostExecutorFixture();

  function execution(extras: Partial<DockerHostEnclaveExecutorOptions> = {}) {
    const { root, script, docker } = getFixture();
    const context = createDockerHostContext({
      runId, journalDir: path.join(root, 'journal'), entries: [script],
      dockerCommand: docker.command, ...extras,
    });
    const containers = createDockerHostContainerOperations(context);
    const backend = createDockerHostExecution(context, containers,
      () => initializeDockerHostRecovery(context, containers));
    return { context, containers, backend };
  }

  describe('storage preparation', () => {
    test('journals mount intent before allocation and clears it even when mounting fails', async () => {
      const { plan, docker } = getFixture();
      const { context, backend } = execution();
      jest.mocked(mountDockerHostStorage).mockImplementation(async () => {
        expect(context.journal.records()[0]).toMatchObject({ mountPending: true });
        throw new Error('mount failed');
      });
      jest.mocked(cleanupDockerHostStorage).mockImplementation(async record => {
        expect(record.mountPending).toBe(false);
        expect(record.mount).toBeUndefined();
        expect(context.journal.records()[0].mountPending).toBe(false);
      });
      await expect(backend.execute(plan, new AbortController().signal))
        .resolves.toEqual({ outcome: 'executor-failure' });
      expect(context.journal.records()).toEqual([]);
      expect(docker.calls.some(call => call[0] === 'create')).toBe(false);
    });

    test('removes and forgets the probe before staging workload input', async () => {
      const { plan, docker } = getFixture();
      const { context, backend } = execution();
      const own = jest.mocked(ownDockerHostStorageFile).getMockImplementation()!;
      jest.mocked(ownDockerHostStorageFile).mockImplementation(async (...args) => {
        if (args[1] === 'out' && !args[4]) {
          expect(docker.containers.size).toBe(0);
          expect(docker.calls.filter(call => call[0] === 'create')).toHaveLength(1);
          const [record] = context.journal.records();
          expect(record.mountPending).toBe(false);
          expect(record.containerId).toBeUndefined();
          expect(record.expected).toBeUndefined();
          expect(fs.readFileSync(path.join(record.storageTarget, 'seccomp.json'), 'utf8'))
            .toBe('{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}');
        }
        return own(...args);
      });
      await expect(backend.execute(plan, new AbortController().signal))
        .resolves.toEqual({ outcome: 'success', result: 'true' });
    });

    test('probe removal uncertainty prevents handoff and preserves recovery intent', async () => {
      const { plan, docker } = getFixture();
      docker.failRemoval = true;
      const { context, backend } = execution({ publicDebug: true });
      await expect(backend.execute(plan, new AbortController().signal))
        .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
      expect(ownDockerHostStorageFile).not.toHaveBeenCalled();
      expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
      expect(docker.calls.filter(call => call[0] === 'create')).toHaveLength(1);
      expect(context.journal.records()[0].publicDebug).toMatchObject({
        cleanupFailure: { stage: 'cleanup' },
      });
      expect(context.cleanupIncomplete).toBe(true);
    });
  });

  describe('authority and workload', () => {
    test('authority resolution failure allocates no invocation resources', async () => {
      const { plan, agent, docker } = getFixture();
      const resolveAgentAuthority = jest.fn().mockRejectedValue(new Error('admission failed'));
      const { context, backend } = execution({ entries: [agent], resolveAgentAuthority });
      await expect(backend.execute({ ...plan, entryId: 'agent', executorKind: 'agent' },
        new AbortController().signal)).resolves.toEqual({ outcome: 'executor-failure' });
      expect(resolveAgentAuthority).toHaveBeenCalledTimes(1);
      expect(mountDockerHostStorage).not.toHaveBeenCalled();
      expect(docker.calls.some(call => call[0] === 'create')).toBe(false);
      expect(context.journal.records()).toEqual([]);
    });

    test('file handoff failure never reaches network verification or workload creation', async () => {
      const { plan, agent, docker } = getFixture();
      jest.mocked(ownDockerHostStorageFile).mockRejectedValueOnce(
        Object.assign(new Error('ownership failed'), { code: 'EPERM' }));
      const { backend } = execution({ entries: [agent], publicDebug: true });
      await expect(backend.execute({ ...plan, entryId: 'agent', executorKind: 'agent' },
        new AbortController().signal)).resolves.toEqual({ outcome: 'executor-failure' });
      expect(docker.calls.some(call => call[0] === 'network')).toBe(false);
      expect(docker.calls.filter(call => call[0] === 'create')).toHaveLength(1);
      expect(preservePublicEnclaveArtifacts).toHaveBeenCalledWith(expect.objectContaining({
        envelope: expect.objectContaining({
          primaryFailure: { stage: 'authority-handoff', category: 'operation-not-permitted', errno: 1 },
          workloadLaunched: false,
        }),
      }));
    });
  });

  describe('cleanup and result release', () => {
    test('does not reclaim output or release a result without workload removal proof', async () => {
      const { plan, docker } = getFixture();
      docker.onWorkloadStart = () => { docker.failRemoval = true; };
      const { context, backend } = execution();
      await expect(backend.execute(plan, new AbortController().signal))
        .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
      expect(jest.mocked(ownDockerHostStorageFile).mock.calls.some(call => call[4] === true)).toBe(false);
      expect(cleanupDockerHostStorage).not.toHaveBeenCalled();
      expect(fs.existsSync(plan.invocationHostDir)).toBe(true);
      expect(context.journal.records()).toHaveLength(1);
    });

    test('cleanup failure overrides a valid result and retains diagnostic provenance', async () => {
      const { plan } = getFixture();
      jest.mocked(cleanupDockerHostStorage).mockRejectedValueOnce(
        Object.assign(new Error('unmount failed'), { code: 'EIO' }));
      const { context, backend } = execution({ publicDebug: true });
      await expect(backend.execute(plan, new AbortController().signal))
        .resolves.toEqual({ outcome: 'executor-failure', cleanupComplete: false });
      expect(preservePublicEnclaveArtifacts).toHaveBeenLastCalledWith(expect.objectContaining({
        envelope: expect.objectContaining({
          stage: 'complete', failure: 'none',
          cleanupFailure: { stage: 'cleanup', category: 'io-error', errno: 5 },
        }),
      }));
      expect(context.journal.records()).toHaveLength(1);
    });
  });
});
