/* eslint-disable @typescript-eslint/no-require-imports */
const {
  createExecutorTelemetry,
  resolveTerminalOutcome,
} = require('../../containers/enclave/script-executor/executor-telemetry');
const { createExecutorSettlement } = require('../../containers/enclave/script-executor/executor-settlement');
/* eslint-enable @typescript-eslint/no-require-imports */

describe('executor telemetry', () => {
  function fixture() {
    const diagnosticAudit = { lifecycle: jest.fn() };
    const telemetry = { emit: jest.fn() };
    const helpers = createExecutorTelemetry({
      config: { primaryBackend: 'docker', executorBackend: 'gvisor' },
      clock: { nowMs: () => 100.6 },
      diagnosticAudit,
      executorKind: 'agent',
      exitCategories: { 23: 'enclave-runtime-failed' },
      telemetry,
    });
    return { ...helpers, diagnosticAudit, telemetry };
  }

  it('records rounded, nonnegative timing and backend telemetry independently of execution', () => {
    const f = fixture();
    f.timing('invocation', 100, { phase: 'work-start' });
    f.timing('invocation', 200, { phase: 'cleanup-start' });
    expect(f.diagnosticAudit.lifecycle.mock.calls).toEqual([
      ['invocation-timing', {
        invocationId: 'invocation', executorKind: 'agent', elapsedMs: 1, phase: 'work-start',
      }],
      ['invocation-timing', {
        invocationId: 'invocation', executorKind: 'agent', elapsedMs: 0, phase: 'cleanup-start',
      }],
    ]);
    f.emitInvocationTelemetry('success');
    expect(f.telemetry.emit).toHaveBeenCalledWith({
      primaryBackend: 'docker', executorBackend: 'gvisor', lifecycleClass: 'invocation',
      capabilityState: 'supported', category: 'success',
    });
  });

  it('caps diagnostics once per handler without sharing the cap across handlers', () => {
    const first = fixture();
    const second = fixture();
    for (let i = 0; i < 4100; i += 1) first.timing('first', 0, { phase: 'work-start' });
    expect(first.diagnosticAudit.lifecycle).toHaveBeenCalledTimes(4097);
    expect(first.diagnosticAudit.lifecycle).toHaveBeenLastCalledWith('invocation-timing', {
      phase: 'diagnostics', status: 'limit-reached',
    });
    second.timing('second', 0, { phase: 'work-start' });
    expect(second.diagnosticAudit.lifecycle).toHaveBeenCalledTimes(1);
  });

  it('allows timing diagnostics to be disabled', () => {
    const helpers = createExecutorTelemetry({ diagnosticAudit: undefined });
    expect(() => helpers.timing('invocation', 0, { phase: 'work-start' })).not.toThrow();
  });

  it('only emits allowlisted diagnostic reasons, including executor-specific exits', () => {
    const f = fixture();
    expect(f.diagnosticReason(undefined)).toBe('none');
    expect(f.diagnosticReason(['PRIVATE_ERROR'])).toBe('unknown');
    expect(f.diagnosticReason(['timeout'])).toBe('timeout');
    expect(f.diagnosticReason(['enclave-runtime-failed'])).toBe('enclave-runtime-failed');
  });

  it.each([
    ['true', ['timeout'], 'success'],
    [undefined, ['timeout'], 'timeout'],
    [undefined, ['nonconformant-output'], 'schema-failure'],
    [undefined, ['unreadable-output'], 'schema-failure'],
    [undefined, ['enclave-runtime-failed'], 'agent-failure'],
    [undefined, ['non-zero-exit'], 'agent-failure'],
    [undefined, ['cancelled'], 'broker-error'],
    [undefined, ['cleanup-failed'], 'broker-error'],
    [undefined, undefined, 'broker-error'],
  ])('maps result %s and failure %j to %s', (result, failure, outcome) => {
    expect(resolveTerminalOutcome(result, failure)).toBe(outcome);
  });
});

describe('executor settlement and cancellation', () => {
  function fixture(hostOwned = false) {
    const admission = { settle: jest.fn(async (_record: unknown) => ({ settled: true, revoked: true })) };
    const audit = { failure: jest.fn() };
    const workspace = { destroyInvocationWorkspace: jest.fn() };
    const state = { accepting: true };
    const helpers = createExecutorSettlement({
      admission, audit, config: { workDir: '/private/work' }, runner: { hostOwned }, workspace, state,
    });
    return { ...helpers, admission, audit, workspace, state };
  }

  it('settles an admitted invocation exactly once, including final bookkeeping', async () => {
    const f = fixture();
    await f.withCancellation(undefined, async (id: string) => {
      f.markAdmitted(id);
      await f.settleDynamic(id, 'success', 4, 1);
      await f.settleDynamic(id, 'broker-error', 0, 0);
    });
    expect(f.admission.settle).toHaveBeenCalledTimes(1);
    expect(f.admission.settle).toHaveBeenCalledWith({
      invocationId: expect.stringMatching(/^[a-f0-9]{24}$/),
      outcome: 'success', outputBytes: 4, executionSeconds: 1,
    });
  });

  it('settles unexpected pipeline errors only after admission', async () => {
    for (const admitted of [false, true]) {
      const f = fixture();
      await expect(f.withCancellation(undefined, async (id: string) => {
        if (admitted) f.markAdmitted(id);
        throw new Error('pipeline failed');
      })).rejects.toThrow('pipeline failed');
      expect(f.admission.settle).toHaveBeenCalledTimes(admitted ? 1 : 0);
      if (admitted) {
        expect(f.admission.settle).toHaveBeenCalledWith({
          invocationId: expect.any(String), outcome: 'broker-error', outputBytes: 0, executionSeconds: 0,
        });
      }
    }
  });

  it('treats settlement as a no-op without dynamic admission', async () => {
    const helpers = createExecutorSettlement({ admission: undefined });
    await expect(helpers.settleDynamic('invocation', 'success', 4, 1)).resolves.toEqual({
      settled: true, revoked: true,
    });
  });

  it('reports unresolved revocation without retrying a failed settlement in final bookkeeping', async () => {
    const f = fixture();
    f.admission.settle.mockRejectedValue(new Error('settlement failed'));
    await f.withCancellation(undefined, async (id: string) => {
      f.markAdmitted(id);
      await expect(f.settleDynamic(id, 'success', 4, 1)).resolves.toEqual({
        settled: false, revoked: false,
      });
    });
    expect(f.admission.settle).toHaveBeenCalledTimes(1);
    expect(f.audit.failure).toHaveBeenCalledWith(
      expect.any(String), 'dynamic-settlement-failed', 'settlement failed',
    );
  });

  it.each([false, true])('forwards external cancellation only for hostOwned=%s and removes listeners', async (hostOwned) => {
    const f = fixture(hostOwned);
    const controller = new AbortController();
    const add = jest.spyOn(controller.signal, 'addEventListener');
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    await f.withCancellation(controller.signal, async (_id: string, signal: AbortSignal) => {
      controller.abort();
      expect(signal.aborted).toBe(hostOwned);
    });
    expect(add).toHaveBeenCalledTimes(hostOwned ? 1 : 0);
    expect(remove).toHaveBeenCalledTimes(hostOwned ? 1 : 0);
    if (hostOwned) expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
  });

  it('honors an already aborted host signal', async () => {
    const f = fixture(true);
    const controller = new AbortController();
    controller.abort();
    await f.withCancellation(controller.signal, async (_id: string, signal: AbortSignal) => {
      expect(signal.aborted).toBe(true);
    });
  });

  it('cancels active invocations on close but leaves completed and other handlers untouched', async () => {
    const f = fixture();
    const other = fixture();
    let completedSignal: AbortSignal;
    await f.withCancellation(undefined, async (_id: string, signal: AbortSignal) => {
      completedSignal = signal;
    });
    await other.withCancellation(undefined, async (_otherId: string, otherSignal: AbortSignal) => {
      await f.withCancellation(undefined, async (_id: string, signal: AbortSignal) => {
        f.close();
        expect(signal.aborted).toBe(true);
        expect(completedSignal.aborted).toBe(false);
        expect(otherSignal.aborted).toBe(false);
      });
    });
    expect(f.state.accepting).toBe(false);
    expect(other.state.accepting).toBe(true);
  });

  it('destroys local workspaces and audits cleanup errors without throwing', () => {
    const f = fixture();
    expect(f.safeDestroy('invocation')).toBe(true);
    expect(f.workspace.destroyInvocationWorkspace).toHaveBeenCalledWith('/private/work', 'invocation');
    f.workspace.destroyInvocationWorkspace.mockImplementation(() => { throw new Error('cleanup failed'); });
    expect(f.safeDestroy('invocation')).toBe(false);
    expect(f.audit.failure).toHaveBeenCalledWith('invocation', 'cleanup-failed', 'cleanup failed');
  });

  it('leaves host-owned workspace teardown to the host', () => {
    const f = fixture(true);
    expect(f.safeDestroy('invocation')).toBe(true);
    expect(f.workspace.destroyInvocationWorkspace).not.toHaveBeenCalled();
  });
});
