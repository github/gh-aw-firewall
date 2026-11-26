import { promises as fs } from 'fs';
import { HostExecutorInvocationDiagnostics, readHostExecutorInvocationDiagnostics } from '../enclave/host-executor-diagnostics';
import * as invocationResult from '../enclave/invocation-result';
import { CloudHypervisorHostEnclaveExecutorBackend } from './host-enclave-executor';
import { HostEnclaveInvocationResources } from './host-enclave-executor-cleanup';
import { HostEnclaveInvocationEvidence } from './host-enclave-executor-diagnostics';
import { scriptScenarios, staticStagingScenarios, useBackendFixture } from './host-enclave-executor.test-utils';

afterEach(() => { jest.restoreAllMocks(); });

describe.each(staticStagingScenarios.filter(scenario => scenario.publicDebug))(
  'host execution phase ordering ($role)',
  scenario => {
    const fixture = useBackendFixture(scenario);

    it('stops before reading results and retains evidence before removing journaled resources', async () => {
      const checks = jest.spyOn(HostExecutorInvocationDiagnostics.prototype, 'check');
      const milestones = jest.spyOn(HostExecutorInvocationDiagnostics.prototype, 'milestone');
      const published = jest.spyOn(HostExecutorInvocationDiagnostics.prototype, 'resourcePublished');
      const retain = jest.spyOn(HostEnclaveInvocationEvidence.prototype, 'retain');
      const remove = jest.spyOn(HostEnclaveInvocationResources.prototype, 'removeResources');
      const { backendOptions, plan, state, dependencies, preservePublicArtifacts } = fixture();
      let releasePreservation!: () => void;
      let reachPreservation!: () => void;
      const preservationBlocked = new Promise<void>(resolve => { releasePreservation = resolve; });
      const preservationReached = new Promise<void>(resolve => { reachPreservation = resolve; });
      preservePublicArtifacts.mockImplementationOnce(async () => {
        reachPreservation();
        await preservationBlocked;
      });
      const complete = jest.fn(async () => {
        expect(state.stopped && state.snapshotRemoved && state.unmounted).toBe(true);
        expect(preservePublicArtifacts).toHaveBeenCalled();
      });
      const originalJournal = dependencies.createResourceJournal!;
      const orderedBackend = new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, {
        ...dependencies,
        createResourceJournal: async (...args) => ({ ...await originalJournal(...args), complete }),
      });
      try {
        const execution = orderedBackend.execute(plan, new AbortController().signal);
        try {
          await preservationReached;
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(state.snapshotRemoved).toBe(false);
          expect(state.unmounted).toBe(false);
          expect(complete).not.toHaveBeenCalled();
        } finally {
          releasePreservation();
          await execution;
        }
        await expect(execution)
          .resolves.toEqual({ outcome: 'success', result: 'true' });
        expect(checks.mock.calls.map(([report, id]) => `${report.scope}/${id}`)).toEqual([
          ...['policy', 'filesystem', 'export-plan', 'snapshot', 'snapshot-digest', 'workload-profile',
            'input-staging', 'manager-create', 'manager-start', 'instance-start', 'guest-execute']
            .map(id => `host-invocation/${id}`),
          'host-invocation-cleanup/manager-stop',
          'host-invocation-cleanup/manager-record',
          'host-invocation/result-read',
          ...['pending-work', 'manager-record', 'snapshot-remove', 'filesystem-remove', 'storage-close', 'journal-complete']
            .map(id => `host-invocation-cleanup/${id}`),
        ]);
        expect(milestones.mock.calls.map(([phase]) => phase)).toEqual([
          'guest-complete', 'manager-stop-start', 'manager-stop-complete', 'result-read-start',
          'result-read-complete', 'work-complete', 'cleanup-start', 'cleanup-complete',
        ]);
        expect(published.mock.invocationCallOrder[0]).toBeLessThan(retain.mock.invocationCallOrder[0]);
        expect(retain.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
        expect(complete).toHaveBeenCalledTimes(1);
      } finally {
        await orderedBackend.close();
      }
    });
  },
);

describe('host execution phase exceptions', () => {
  const fixture = useBackendFixture(scriptScenarios[0]);

  it.each(['manager-create', 'manager-start', 'instance-start', 'guest-execute', 'result-read'] as const)(
    'preserves %s failure diagnostics, cleans resources, and permits another invocation',
    async phase => {
      const { backendOptions, dependencies, plan, state, runState, invocationHostDir } = fixture();
      let failPhase = true;
      const fail = async () => { throw new Error('fixture phase failure'); };
      if (phase === 'result-read') {
        jest.spyOn(invocationResult, 'readBoundedEnclaveResult').mockRejectedValueOnce(new Error('fixture result read failure'));
      }
      const backend = new CloudHypervisorHostEnclaveExecutorBackend(backendOptions, {
        ...dependencies,
        createManager: (...args) => {
          if (failPhase && phase === 'manager-create') throw new Error('fixture manager create failure');
          const manager = dependencies.createManager!(...args);
          return failPhase ? {
            ...manager,
            ...(phase === 'manager-start' ? { start: fail } : {}),
            ...(phase === 'instance-start' ? { startInstance: fail } : {}),
            ...(phase === 'guest-execute' ? { execute: fail } : {}),
          } : manager;
        },
      });
      try {
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'executor-failure' });
        expect(state.snapshotRemoved && state.unmounted).toBe(true);
        await expect(fs.lstat(invocationHostDir)).rejects.toMatchObject({ code: 'ENOENT' });
        const persisted = readHostExecutorInvocationDiagnostics(runState)
          .find(file => JSON.parse(file.contents).invocationId === plan.invocationId)!;
        expect(JSON.parse(persisted.contents)).toMatchObject({
          failure: { stage: `host-invocation/${phase}` },
        });
        failPhase = false;
        await expect(backend.execute(plan, new AbortController().signal))
          .resolves.toEqual({ outcome: 'success', result: 'true' });
      } finally {
        await backend.close();
      }
    },
  );
});
