import { HostExecutorInvocationLifecycle } from './host-executor-invocation-lifecycle';
import { HostExecutorInvocationRegistry } from './host-executor-invocation-registry';
import { HOST_EXECUTOR_TIMEOUT_GRACE_MS, hostExecutorResultDigest } from './host-executor-protocol';
import type { HostExecutorJournal } from './host-executor-journal';
import type { HostExecutorBackendResult, HostExecutorInvocationPlan } from './host-executor-server';

describe('host executor invocation lifecycle', () => {
  const plan: HostExecutorInvocationPlan = {
    runId: 'run', entryId: 'script', invocationId: 'invocation', admissionId: 'admission', executorKind: 'script',
    timeoutMs: 1_000, requestHash: 'hash', schemaHash: 'schema-hash', schema: { type: 'boolean' },
    payload: 'print(True)', invocationHostDir: '/private/invocation',
  };
  let registry: HostExecutorInvocationRegistry;
  let lifecycle: HostExecutorInvocationLifecycle;
  let journal: { record: jest.Mock<void, Parameters<HostExecutorJournal['record']>> };
  let execute: jest.Mock<Promise<HostExecutorBackendResult>, [HostExecutorInvocationPlan, AbortSignal]>;
  let complete: (result: HostExecutorBackendResult) => void;

  beforeEach(() => {
    jest.useFakeTimers();
    registry = new HostExecutorInvocationRegistry();
    journal = { record: jest.fn() };
    execute = jest.fn<Promise<HostExecutorBackendResult>, [HostExecutorInvocationPlan, AbortSignal]>(
      () => new Promise((resolve) => { complete = resolve; }),
    );
    lifecycle = new HostExecutorInvocationLifecycle({
      registry, backend: { execute }, statusLeaseMs: 10_000, journal, diagnostics: { record: jest.fn() },
    });
  });

  afterEach(() => { jest.useRealTimers(); });

  it('journals and registers before backend execution, then publishes terminal only after persistence', async () => {
    const record = lifecycle.launch(plan);
    expect(registry.get(plan.entryId, plan.invocationId)).toBe(record);
    expect(journal.record).toHaveBeenCalledWith(expect.objectContaining({ state: 'running', requestHash: 'hash' }));
    expect(execute).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(execute).toHaveBeenCalledWith(plan, record.controller.signal);
    journal.record.mockImplementation(({ state }) => {
      if (state === 'terminal') expect(record.state).toBe('running');
    });
    complete({ outcome: 'success', result: 'true', cleanupComplete: true });
    await record.completion;
    expect(registry.view(record)).toEqual({
      state: 'terminal', cancelGeneration: 0, outcome: 'success', result: 'true',
      resultDigest: hostExecutorResultDigest('success', 'true'),
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not register or start a backend when admission persistence fails', () => {
    journal.record.mockImplementation(() => { throw new Error('Persistence failed'); });
    expect(() => lifecycle.launch(plan)).toThrow('Persistence failed');
    expect([...registry.values()]).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits for cleanup after a deadline and discards a late successful result', async () => {
    const record = lifecycle.launch(plan);
    await Promise.resolve();
    jest.advanceTimersByTime(plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS - 1);
    expect(record.state).toBe('running');
    jest.advanceTimersByTime(1);
    expect(record.state).toBe('cancelling');
    expect(record.controller.signal.aborted).toBe(true);
    lifecycle.interrupt(record, 'cancelled');
    complete({ outcome: 'success', result: 'true', cleanupComplete: true });
    await record.completion;
    expect(registry.view(record)).toEqual({
      state: 'terminal', cancelGeneration: 0, outcome: 'timeout',
      resultDigest: hostExecutorResultDigest('timeout', undefined),
    });
  });

  it('renews the status lease only while running without extending the execution deadline', async () => {
    const record = lifecycle.launch({ ...plan, timeoutMs: 30_000 });
    await Promise.resolve();
    jest.advanceTimersByTime(9_000);
    lifecycle.renewLease(record);
    jest.advanceTimersByTime(9_000);
    expect(record.state).toBe('running');
    jest.advanceTimersByTime(1_000);
    expect(record.interruptedOutcome).toBe('cancelled');
    const lease = record.lease;
    lifecycle.renewLease(record);
    expect(record.lease).toBe(lease);
    complete({ outcome: 'success', result: 'true', cleanupComplete: true });
    await record.completion;
    expect(record.outcome).toBe('cancelled');

    const next = lifecycle.launch({ ...plan, invocationId: 'next', admissionId: 'next-admission' });
    await Promise.resolve();
    jest.advanceTimersByTime(1_000);
    lifecycle.renewLease(next);
    jest.advanceTimersByTime(HOST_EXECUTOR_TIMEOUT_GRACE_MS);
    expect(next.interruptedOutcome).toBe('timeout');
    complete({ outcome: 'success', result: 'true', cleanupComplete: true });
    await next.completion;
  });

  it('still aborts and closes admissions when cancellation persistence fails', async () => {
    const record = lifecycle.launch(plan);
    await Promise.resolve();
    journal.record.mockImplementation(({ state }) => {
      if (state === 'cancelling') throw new Error('Persistence failed');
    });
    lifecycle.interrupt(record, 'cancelled');
    expect(record.controller.signal.aborted).toBe(true);
    expect(() => registry.assertCanAdmit('other', 'other')).toThrow('closed');
    complete({ outcome: 'success', result: 'true', cleanupComplete: true });
    await record.completion;
    expect(record.outcome).toBe('cancelled');
  });

  it.each(['incomplete-cleanup', 'backend-rejection', 'terminal-persistence'] as const)(
    'retains a nonterminal tombstone and cancels peers on %s',
    async (failure) => {
      let finishPeer!: (result: HostExecutorBackendResult) => void;
      if (failure === 'backend-rejection') execute.mockRejectedValueOnce(new Error('Backend failed'));
      else execute.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
      execute.mockImplementationOnce(() => new Promise((resolve) => { finishPeer = resolve; }));
      const record = lifecycle.launch(plan);
      const peer = lifecycle.launch({ ...plan, invocationId: 'peer', admissionId: 'peer-admission' });
      if (failure === 'terminal-persistence') {
        journal.record.mockImplementation(({ state, invocationId }) => {
          if (state === 'terminal' && invocationId === plan.invocationId) throw new Error('Persistence failed');
        });
      }
      await Promise.resolve();
      if (failure !== 'backend-rejection') {
        complete({ outcome: 'success', result: 'true', cleanupComplete: failure !== 'incomplete-cleanup' });
      }
      await record.completion;
      expect(registry.view(record)).toEqual({ state: 'cancelling', cancelGeneration: 0 });
      expect(record.controller.signal.aborted).toBe(true);
      expect(peer.controller.signal.aborted).toBe(true);
      expect(() => registry.assertCanAdmit('other', 'other')).toThrow('closed');
      finishPeer({ outcome: 'success', result: 'true', cleanupComplete: true });
      await peer.completion;
      expect(peer.outcome).toBe('cancelled');
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each([true, false])('keeps admissions open on executor failure only with verified cleanup: %s', async (verified) => {
    const record = lifecycle.launch(plan);
    await Promise.resolve();
    lifecycle.interrupt(record, 'timeout');
    complete({ outcome: 'executor-failure', recoverableFailure: true, cleanupComplete: verified ? true : undefined });
    await record.completion;
    expect(record.outcome).toBe('executor-failure');
    if (verified) expect(() => registry.assertCanAdmit('other', 'other')).not.toThrow();
    else expect(() => registry.assertCanAdmit('other', 'other')).toThrow('closed');
  });
});
