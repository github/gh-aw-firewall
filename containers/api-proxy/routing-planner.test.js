'use strict';

const {
  PLANNER_ATTEMPT_TIMEOUT_MS,
  callPlannerWithRetry,
  isRetryablePlannerError,
  runBoundedOperation,
} = require('./routing-planner');

describe('routing planner', () => {
  it('retries transient failures exactly three times and preserves terminal failures', async () => {
    let calls = 0;
    await expect(callPlannerWithRetry(() => {
      calls++;
      const error = new Error('down');
      error.code = 'ECONNREFUSED';
      return Promise.reject(error);
    }, { deadline: Date.now() + 10_000, random: () => 0 })).rejects.toMatchObject({ code: 'router_unavailable' });
    expect(calls).toBe(3);
    await expect(callPlannerWithRetry(() => Promise.reject(Object.assign(new Error('bad'), { statusCode: 400 })), {
      deadline: Date.now() + 10_000,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('aborts an operation which ignores cancellation and recognizes only declared retry errors', async () => {
    const controller = new AbortController();
    const pending = runBoundedOperation(() => new Promise(() => {}), {
      signal: controller.signal, deadline: Date.now() + 10_000, timeoutMs: PLANNER_ATTEMPT_TIMEOUT_MS,
      timeoutError: () => new Error('timeout'),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'routing_cancelled' });
    expect(isRetryablePlannerError({ code: 'EACCES' })).toBe(false);
    expect(isRetryablePlannerError({ statusCode: 503 })).toBe(true);
  });

  it('aborts a timed-out attempt with a TimeoutError reason and a cancelled one without', async () => {
    const signals = [];
    const hang = ({ signal }) => { signals.push(signal); return new Promise(() => {}); };
    await expect(runBoundedOperation(hang, {
      deadline: Date.now() + 10_000, timeoutMs: 20,
      timeoutError: () => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    })).rejects.toMatchObject({ code: 'ETIMEDOUT' });

    const controller = new AbortController();
    const cancelled = runBoundedOperation(hang, {
      signal: controller.signal, deadline: Date.now() + 10_000, timeoutMs: PLANNER_ATTEMPT_TIMEOUT_MS,
      timeoutError: () => new Error('timeout'),
    });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'routing_cancelled' });

    expect(signals.map(signal => [signal.aborted, signal.reason?.name])).toEqual([
      [true, 'TimeoutError'],
      [true, 'AbortError'],
    ]);
  });

  it('retries transient transport codes and keeps router name resolution terminal', async () => {
    for (const code of ['EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT']) {
      expect(isRetryablePlannerError({ code })).toBe(true);
    }
    // The router is reached through a fixed internal alias, so a missing name means
    // configuration drift and must not be retried.
    expect(isRetryablePlannerError({ code: 'ENOTFOUND' })).toBe(false);

    for (const code of ['EPIPE', 'EAI_AGAIN']) {
      let calls = 0;
      await expect(callPlannerWithRetry(() => {
        calls++;
        return Promise.reject(Object.assign(new Error('transport'), { code }));
      }, { deadline: Date.now() + 10_000, random: () => 0 })).rejects.toMatchObject({ code: 'router_unavailable' });
      expect(calls).toBe(3);
    }

    let notFoundCalls = 0;
    await expect(callPlannerWithRetry(() => {
      notFoundCalls++;
      return Promise.reject(Object.assign(new Error('no such host'), { code: 'ENOTFOUND' }));
    }, { deadline: Date.now() + 10_000, random: () => 0 })).rejects.toThrow('no such host');
    expect(notFoundCalls).toBe(1);
  });
});
