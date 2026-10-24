import { createHash } from 'crypto';

/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('../../containers/enclave/mcp-server/host-executor-client', () => ({
  createHostExecutorClient: jest.fn(),
}));
const { createHostExecutorClient } = require('../../containers/enclave/mcp-server/host-executor-client');
const { createHostExecutorRunner } = require('../../containers/enclave/mcp-server/host-executor-runner');
/* eslint-enable @typescript-eslint/no-require-imports */

type Role = 'script' | 'agent';
type Outcome = 'timeout' | 'cancelled';

describe('broker and host deadline ownership', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function fixture(role: Role, options: {
    hostDeadlineMs?: number;
    cleanupMs?: number;
    cleanupHangs?: boolean;
  } = {}) {
    let state: 'running' | 'cancelling' | 'terminal' = 'running';
    let outcome: Outcome | undefined;
    let cancelGeneration = 0;
    const audit = { lifecycle: jest.fn() };
    const digest = () => createHash('sha256')
      .update(JSON.stringify([outcome, null])).digest('hex');
    const view = () => ({
      ok: true, state, cancelGeneration,
      ...(state === 'terminal' ? { outcome, resultDigest: digest() } : {}),
    });
    const interrupt = (reason: Outcome) => {
      if (state !== 'running') return;
      state = 'cancelling';
      outcome = reason;
      if (!options.cleanupHangs) {
        setTimeout(() => { state = 'terminal'; }, options.cleanupMs ?? 0);
      }
    };
    const client = {
      invoke: jest.fn(async () => {
        if (options.hostDeadlineMs !== undefined) {
          setTimeout(() => interrupt('timeout'), options.hostDeadlineMs);
        }
        return view();
      }),
      status: jest.fn(async () => view()),
      cancel: jest.fn(async () => {
        cancelGeneration = 1;
        interrupt('cancelled');
        return view();
      }),
      settle: jest.fn(async () => ({ ...view(), state: 'settled' })),
    };
    createHostExecutorClient.mockReturnValue(client);
    const runner = createHostExecutorRunner({
      executorBackend: 'cloud-hypervisor', entryId: `${role}-entry`,
    }, { nowMs: () => Date.now(), pollMs: 10, requestTimeoutMs: 20, drainMs: 100, audit });
    const run = (signal?: AbortSignal, deadlineMs = 1000) => runner.runInvocation({
      invocationId: 'a'.repeat(24), seedId: 'b'.repeat(32),
      admissionId: 'a'.repeat(24), executorKind: role,
      payload: 'fixture', schema: { type: 'boolean' }, deadlineMs, signal,
    });
    return { runner, run, client, audit };
  }

  it.each((['script', 'agent'] as const).flatMap(role =>
    [-1, 1].flatMap(offset => [0, 25].map(cleanupMs => ({ role, offset, cleanupMs }))),
  ))('settles $role as timeout with host offset $offset ms and cleanup $cleanupMs ms',
    async ({ role, offset, cleanupMs }) => {
      const f = fixture(role, { hostDeadlineMs: 1000 + offset, cleanupMs });
      const pending = f.run();
      await jest.advanceTimersByTimeAsync(1000 + offset + cleanupMs + 20);

      expect(await pending).toEqual({ status: 'completed', timedOut: true, exitCode: 1 });
      expect(f.client.cancel).not.toHaveBeenCalled();
      expect(f.client.settle).toHaveBeenCalledTimes(1);
      expect(f.audit.lifecycle).toHaveBeenCalledWith('host-executor', expect.objectContaining({
        phase: 'settle', status: 'passed', outcome: 'timeout',
      }));
      await expect(f.runner.reconcileRun()).resolves.toBeUndefined();
    });

  it.each(['script', 'agent'] as const)('preserves early explicit %s cancellation', async role => {
    const f = fixture(role, { hostDeadlineMs: 1001 });
    const controller = new AbortController();
    const pending = f.run(controller.signal);
    setTimeout(() => controller.abort(), 500);
    await jest.advanceTimersByTimeAsync(520);

    expect(await pending).toEqual({ status: 'cancelled', timedOut: false, exitCode: 1 });
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
    expect(f.audit.lifecycle).toHaveBeenCalledWith('host-executor', expect.objectContaining({
      phase: 'settle', status: 'passed', outcome: 'cancelled',
    }));
  });

  it.each([-1, 1])('preserves the host interruption reason when caller abort has offset %s ms',
    async offset => {
      const f = fixture('script', { hostDeadlineMs: 1000, cleanupMs: 25 });
      const controller = new AbortController();
      const pending = f.run(controller.signal);
      setTimeout(() => controller.abort(), 1000 + offset);
      await jest.advanceTimersByTimeAsync(1050);

      expect(await pending).toMatchObject({ status: 'cancelled', timedOut: true, exitCode: 1 });
      expect(f.client.cancel).toHaveBeenCalledTimes(1);
      expect(f.audit.lifecycle).toHaveBeenCalledWith('host-executor', expect.objectContaining({
        phase: 'settle', status: 'passed', outcome: offset < 0 ? 'cancelled' : 'timeout',
      }));
    });

  it.each(['script', 'agent'] as const)('closes %s admissions when the host deadline is unresolved',
    async role => {
      const f = fixture(role);
      const rejected = expect(f.run()).rejects.toThrow('Host executor lifecycle is unresolved');
      await jest.advanceTimersByTimeAsync(1120);
      await rejected;

      expect(f.client.cancel).toHaveBeenCalledTimes(1);
      expect(f.client.settle).not.toHaveBeenCalled();
      expect(f.audit.lifecycle).toHaveBeenCalledWith('host-executor', expect.objectContaining({
        status: 'failed', reason: 'deadline-drain-timeout',
      }));
      expect(f.client.status.mock.calls.length).toBeLessThanOrEqual(110);
      await expect(f.runner.reconcileRun()).rejects.toThrow('Host executor lifecycle is unresolved');
      await expect(f.run()).rejects.toThrow('Host executor admissions are closed');
      expect(f.client.invoke).toHaveBeenCalledTimes(1);
    });

  it('does not settle or reopen admissions when host timeout cleanup hangs', async () => {
    const f = fixture('script', { hostDeadlineMs: 1001, cleanupHangs: true });
    const rejected = expect(f.run()).rejects.toThrow('Host executor lifecycle is unresolved');
    await jest.advanceTimersByTimeAsync(1120);
    await rejected;

    expect(f.client.cancel).toHaveBeenCalledTimes(1);
    expect(f.client.settle).not.toHaveBeenCalled();
    await expect(f.runner.reconcileRun()).rejects.toThrow('Host executor lifecycle is unresolved');
  });

  it('retains the bounded drain for explicit cancellation with unresolved cleanup', async () => {
    const f = fixture('script', { hostDeadlineMs: 1001, cleanupHangs: true });
    const controller = new AbortController();
    const rejected = expect(f.run(controller.signal)).rejects.toThrow('Host executor lifecycle is unresolved');
    setTimeout(() => controller.abort(), 500);
    await jest.advanceTimersByTimeAsync(620);
    await rejected;

    expect(f.client.cancel).toHaveBeenCalledTimes(1);
    expect(f.client.settle).not.toHaveBeenCalled();
    expect(f.audit.lifecycle).toHaveBeenCalledWith('host-executor', expect.objectContaining({
      status: 'failed', reason: 'cancel-drain-timeout',
    }));
  });

  it('does not invoke a host after the broker deadline has already expired', async () => {
    const f = fixture('script', { hostDeadlineMs: 1001 });
    await expect(f.run(undefined, 0)).resolves.toEqual({
      status: 'cancelled', timedOut: true, exitCode: 1,
    });
    expect(f.client.invoke).not.toHaveBeenCalled();
    expect(f.client.cancel).not.toHaveBeenCalled();
  });
});
