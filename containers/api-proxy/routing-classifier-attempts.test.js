'use strict';

const {
  CLASSIFIER_ATTEMPT_TIMEOUT_MS, CLASSIFIER_MAX_ATTEMPTS, PURPOSE, ROUTER_PHASE_RESERVE_MS,
  computeRouterDeadline, runClassifierAttempts,
} = require('./routing-classifier-attempts');
const { buildRoutingCandidates } = require('./routing-candidates');
const { createSystemClock } = require('./routing-planner');

describe('routing classifier budgets', () => {
  it('preserves controller exports', () => {
    expect(require('./routing-controller')).toMatchObject({
      CLASSIFIER_ATTEMPT_TIMEOUT_MS, CLASSIFIER_MAX_ATTEMPTS, PURPOSE, ROUTER_PHASE_RESERVE_MS,
      ROUTING_BOOTSTRAP_TIMEOUT_MS: 90_000,
    });
  });

  it.each([
    [90_000, 85_000], [20_000, 15_000], [8_000, 6_000], [7, 6],
    [4, 3], [3, 2], [2, 1], [1, 1], [0, 0], [-1, -1],
  ])('reserves fallback time with %s ms remaining', (remaining, expected) => {
    expect(computeRouterDeadline(100, 100 + remaining)).toBe(100 + expected);
  });

  it('skips capacity exclusions without spending attempts and enforces a supplied retry budget', async () => {
    const pool = buildRoutingCandidates({ catalogue: {
      provider: 'copilot', configured: true, discovery: 'complete',
      models: ['0-tiny', 'a-test', 'b-test', 'c-test'].map(id => ({
        id, efforts: ['low'], protocols: ['responses'], contextWindow: id === '0-tiny' ? 8 : 128_000,
      })),
    } });
    const executor = { execute: jest.fn(async () => ({ statusCode: 503 })) };
    const onAttempt = jest.fn();
    const result = await runClassifierAttempts({
      classifierPlan: { system_prompt: 'classify', prompt: 'task', ranked_choices: pool.choices },
      pool, executor, observer: { record: jest.fn() }, eligibilityRequest: {},
      clock: createSystemClock(), deadline: Date.now() + 90_000,
      attemptTimeoutMs: CLASSIFIER_ATTEMPT_TIMEOUT_MS, maxAttempts: 1, purpose: PURPOSE, onAttempt,
    });
    expect(result).toEqual({
      classification: null, successfulClassifier: null,
      degradedReason: 'classifier_attempts_exhausted', actualAttempts: 1,
    });
    expect(onAttempt.mock.calls).toEqual([[1]]);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute.mock.calls[0][0].body.model).toBe('a-test');
  });
});
