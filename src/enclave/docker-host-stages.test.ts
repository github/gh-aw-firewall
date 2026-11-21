import { describeLinux, useDockerHostExecutorFixture, runId } from './docker-host-executor.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import {
  createDockerHostContext, type DockerHostEnclaveExecutorOptions, type InvocationAuthorityState,
} from './docker-host-context';
import { createDockerHostContainerOperations } from './docker-host-container';
import { createDockerHostRecoveryRecord } from './docker-host-recovery';
import { mountDockerHostStorage, ownDockerHostStorageFile } from './docker-host-storage';
import { PublicEnclaveOperationRecorder } from './public-debug-events';
import { prepareDockerHostStorage } from './docker-host-storage-stage';
import { prepareDockerHostRun, runDockerHostWorkload } from './docker-host-run-stage';
import { reclaimDockerHostOutput, finalizeDockerHostExecution } from './docker-host-cleanup-stage';

describeLinux('isolated Docker host stages', () => {
  const getFixture = useDockerHostExecutorFixture();

  function invocation(kind: 'script' | 'agent' = 'script', extras: Partial<DockerHostEnclaveExecutorOptions> = {}) {
    const { root, docker, plan, script, agent } = getFixture();
    const context = createDockerHostContext({
      runId, journalDir: path.join(root, 'journal'), entries: [kind === 'script' ? script : agent],
      dockerCommand: docker.command, publicDebug: true, ...extras,
    });
    const diagnostic = new PublicEnclaveOperationRecorder();
    const authorityState: InvocationAuthorityState = {
      attempted: false, resolved: false, prepared: true, resourcesPossible: false, diagnostic,
    };
    return {
      context, containers: createDockerHostContainerOperations(context), diagnostic,
      invocation: {
        plan: { ...plan, entryId: kind, executorKind: kind }, entry: context.entries.get(kind)!,
        signal: new AbortController().signal, authorityState, debugCheck: diagnostic.check.bind(diagnostic),
      },
    };
  }

  async function allocatedStage(kind: 'script' | 'agent' = 'script', mounted = false) {
    const fixture = invocation(kind);
    const { context, invocation: input } = fixture;
    const launch = await prepareDockerHostRun(context, input);
    if ('outcome' in launch) throw new Error('Invalid test launch');
    const record = createDockerHostRecoveryRecord(input.plan, input.entry, launch.storageTarget, context.owner, true);
    context.journal.write(record, true);
    if (mounted) {
      record.mount = await mountDockerHostStorage(record.storageTarget, record.storageSource, record.storageBytes);
      record.mountPending = false;
      fs.writeFileSync(path.join(record.storageTarget, 'seccomp.json'), input.entry.seccompProfile, { mode: 0o400 });
      context.journal.write(record);
    }
    return { ...fixture, launch, stage: { ...input, record } };
  }

  describe('storage stage', () => {
    test('returns verified mounted storage with no surviving probe identity', async () => {
      const { docker } = getFixture();
      const { context, containers, stage, launch, diagnostic } = await allocatedStage();
      await prepareDockerHostStorage(context, containers, stage, launch.args);
      expect(stage.record).toMatchObject({ mountPending: false, mount: { bytes: stage.entry.hostWritableBytes } });
      expect(stage.record.containerId).toBeUndefined();
      expect(stage.record.expected).toBeUndefined();
      expect(docker.containers.size).toBe(0);
      expect(fs.readdirSync(stage.record.storageTarget)).toEqual(['seccomp.json']);
      expect(diagnostic.events.filter(event => event.stage === 'storage-probe').map(event => event.status))
        .toEqual(['started', 'succeeded', 'started', 'succeeded']);
    });

    test('probe failure leaves its identity journaled for the cleanup stage', async () => {
      const { docker } = getFixture();
      docker.failProbe = true;
      const { context, containers, stage, launch, diagnostic } = await allocatedStage();
      await expect(prepareDockerHostStorage(context, containers, stage, launch.args))
        .rejects.toThrow('cannot see the verified invocation tmpfs');
      expect(context.journal.records()[0]).toMatchObject({
        mountPending: false, containerId: stage.record.containerId, expected: { name: expect.stringMatching(/-probe$/) },
      });
      expect(diagnostic.primaryFailure).toMatchObject({ stage: 'storage-probe' });
      expect(ownDockerHostStorageFile).not.toHaveBeenCalled();
    });
  });

  describe('run stage', () => {
    test('cancellation after authority resolution returns before storage allocation', async () => {
      const controller = new AbortController();
      const resolveAgentAuthority = jest.fn(async () => {
        controller.abort();
        return {};
      });
      const { context, invocation: input } = invocation('agent', { resolveAgentAuthority });
      input.signal = controller.signal;
      await expect(prepareDockerHostRun(context, input)).resolves.toEqual({ outcome: 'cancelled' });
      expect(input.authorityState.resolved).toBe(true);
      expect(context.journal.records()).toEqual([]);
      expect(mountDockerHostStorage).not.toHaveBeenCalled();
    });

    test.each(['script', 'agent'] as const)('stages %s input and records launch and exit without reclaiming output', async kind => {
      const { docker } = getFixture();
      docker.workloadExitCode = 23;
      const { context, containers, stage, launch, diagnostic } = await allocatedStage(kind, true);
      await expect(runDockerHostWorkload(context, containers, stage, launch)).resolves.toBe(23);
      expect(stage.authorityState.launchedAt).toEqual(expect.any(Number));
      expect(stage.authorityState.dockerState).toEqual({ running: false, exitCode: 23, oomKilled: null });
      expect(context.journal.records()[0].publicDebug).toMatchObject({
        stage: 'execution', failure: 'workload-exit', exitCode: 23,
      });
      expect(diagnostic.primaryFailure).toEqual({ stage: 'workload-exit', category: 'workload-exit' });
      expect(fs.readFileSync(path.join(stage.record.storageTarget, kind === 'script' ? 'script.py' : 'task.txt'), 'utf8'))
        .toBe(stage.plan.payload);
      expect(jest.mocked(ownDockerHostStorageFile).mock.calls.some(call => call[4] === true)).toBe(false);
      expect(docker.containers.size).toBe(1);
    });
  });

  describe('cleanup stage', () => {
    test.each(['script', 'agent'] as const)('removes the %s container before reclaiming its writable files', async kind => {
      const { docker } = getFixture();
      const { context, containers, stage, launch } = await allocatedStage(kind, true);
      fs.writeFileSync(path.join(stage.record.storageTarget, 'out'), '');
      if (kind === 'agent') fs.writeFileSync(path.join(stage.record.storageTarget, 'session.jsonl'), '');
      await containers.createContainer(stage.record, launch.args);
      jest.mocked(ownDockerHostStorageFile).mockImplementation(async () => {
        expect(docker.containers.size).toBe(0);
      });
      await reclaimDockerHostOutput(context, stage);
      expect(jest.mocked(ownDockerHostStorageFile).mock.calls.map(call => [call[1], call[4]]))
        .toEqual(kind === 'script' ? [['out', true]] : [['out', true], ['session.jsonl', true]]);
      expect(stage.authorityState.diagnostic?.cleanupFailure).toBeUndefined();
    });

    test('passes redaction secrets and diagnostics to cleanup and finalizes successful accounting', async () => {
      const { context, containers, stage, diagnostic } = await allocatedStage();
      const cleanup = jest.spyOn(containers, 'cleanup').mockResolvedValue();
      const result = { outcome: 'success' as const, result: 'true' };
      const secrets = ['redaction-test-value'];
      await expect(finalizeDockerHostExecution(context, containers, stage, result, secrets)).resolves.toEqual(result);
      expect(cleanup).toHaveBeenCalledWith(stage.record, secrets, diagnostic);
      expect(context.journal.records()[0].publicDebug).toMatchObject({ stage: 'complete', failure: 'none' });
    });

    test('cleanup failure preserves cancellation and records cleanup rather than primary failure', async () => {
      const { context, containers, stage, diagnostic } = await allocatedStage();
      jest.spyOn(containers, 'cleanup').mockRejectedValue(new Error('cleanup failed'));
      await expect(finalizeDockerHostExecution(context, containers, stage, { outcome: 'cancelled' }, []))
        .resolves.toEqual({ outcome: 'cancelled', cleanupComplete: false });
      expect(diagnostic.primaryFailure).toBeUndefined();
      expect(diagnostic.cleanupFailure).toEqual({ stage: 'cleanup', category: 'cleanup-failed' });
      expect(context.journal.records()).toHaveLength(1);
    });
  });
});
