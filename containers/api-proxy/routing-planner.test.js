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
});
