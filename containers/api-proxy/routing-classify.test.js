'use strict';

const { classifyRouting } = require('./routing-classify');
const { buildRoutingCandidates } = require('./routing-candidates');
const { createRoutingError } = require('./routing-errors');
const { createSystemClock } = require('./routing-planner');
const { CLASSIFIER_ATTEMPT_TIMEOUT_MS, CLASSIFIER_MAX_ATTEMPTS, PURPOSE } = require('./routing-controller');

const CLASSIFICATION = {
  labels: { task_type: 'implement', scope: 'local', task_complexity: 'easy' }, mode: 'balanced',
};

function harness(overrides = {}) {
  const models = ['a-test', 'b-test', 'c-test'].map(id => ({
    id, efforts: ['low'], protocols: ['responses'], contextWindow: 128_000,
  }));
  const pool = buildRoutingCandidates({ catalogue: {
    provider: 'copilot', configured: true, discovery: 'complete', models: overrides.models || models,
  } });
  const options = {
    conversation: [{ role: 'user', parts: [{ text: 'private task' }] }],
    planner: { classify: jest.fn(async request => ({
      system_prompt: 'classify', prompt: 'private prompt', ranked_choices: request.models,
    })) },
    executor: { execute: jest.fn(async () => ({
      statusCode: 200, body: Buffer.from(JSON.stringify({ output_text: JSON.stringify(CLASSIFICATION) })),
    })) },
    observer: { record: jest.fn() },
    eligibilityRequest: { awfEligibility: {}, awfEligibilityScope: Object.freeze({ provider: 'copilot' }) },
    callPlanner: operation => operation({ signal: new AbortController().signal, timeoutMs: 5_000 }),
    clock: createSystemClock(),
    deadline: Date.now() + 90_000,
    attemptTimeoutMs: CLASSIFIER_ATTEMPT_TIMEOUT_MS,
    maxAttempts: CLASSIFIER_MAX_ATTEMPTS,
    purpose: PURPOSE,
    ...overrides,
    pool,
  };
  return { options, run: () => classifyRouting(options) };
}

describe('routing classification stage', () => {
  afterEach(() => jest.useRealTimers());

  it('builds an immutable planner request and shares pinned eligibility with availability retries', async () => {
    const { run, options } = harness();
    options.executor.execute.mockResolvedValueOnce({ statusCode: 503 });
    await expect(run()).resolves.toEqual({
      classification: CLASSIFICATION, successfulClassifier: { model: 'github-copilot/b-test', effort: 'low' },
      degradedReason: null, actualAttempts: 2,
    });
    const request = options.planner.classify.mock.calls[0][0];
    expect(Object.keys(request).sort()).toEqual(['conversation', 'models']);
    expect(Object.isFrozen(request.conversation[0].parts[0])).toBe(true);
    for (const [attempt] of options.executor.execute.mock.calls) {
      expect(attempt.awfEligibility).toBe(options.eligibilityRequest.awfEligibility);
      expect(attempt.awfEligibilityScope).toBe(options.eligibilityRequest.awfEligibilityScope);
      expect(attempt.purpose).toBe(PURPOSE);
    }
    expect(options.observer.record.mock.calls.map(([record]) => record.attempt)).toEqual([1, 2]);
  });

  it('does not spend attempts on capacity exclusions or retry invalid output', async () => {
    const { run, options } = harness({ models: [
      { id: 'a-tiny', efforts: ['low'], protocols: ['responses'], contextWindow: 8 },
      { id: 'b-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
      { id: 'c-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
    ] });
    options.executor.execute.mockResolvedValue({ statusCode: 200, body: Buffer.from('{"output_text":"invalid"}') });
    await expect(run()).resolves.toEqual({
      classification: null, successfulClassifier: null, degradedReason: 'invalid_classifier_output', actualAttempts: 1,
    });
    expect(options.executor.execute).toHaveBeenCalledTimes(1);
    expect(options.executor.execute.mock.calls[0][0].body.model).toBe('b-test');
  });

  it('stops at the attempt limit when every provider attempt is unavailable', async () => {
    const { run, options } = harness();
    options.executor.execute.mockResolvedValue({ availabilityFailure: true });
    await expect(run()).resolves.toMatchObject({ degradedReason: 'classifier_attempts_exhausted', actualAttempts: 2 });
    expect(options.executor.execute).toHaveBeenCalledTimes(CLASSIFIER_MAX_ATTEMPTS);
  });

  it('reports capacity exhaustion without executing a classifier', async () => {
    const { run, options } = harness({ models: [{ id: 'unknown', efforts: ['low'], protocols: ['responses'] }] });
    await expect(run()).resolves.toMatchObject({ degradedReason: 'classifier_capacity_exhausted', actualAttempts: 0 });
    expect(options.executor.execute).not.toHaveBeenCalled();
    expect(options.observer.record).not.toHaveBeenCalled();
  });

  it('retries an attempt timeout but treats the shared deadline as terminal', async () => {
    jest.useFakeTimers();
    const first = harness();
    first.options.executor.execute.mockImplementationOnce(() => new Promise(() => {}));
    const success = expect(first.run()).resolves.toMatchObject({ classification: CLASSIFICATION, actualAttempts: 2 });
    await jest.advanceTimersByTimeAsync(CLASSIFIER_ATTEMPT_TIMEOUT_MS);
    await success;
    expect(first.options.executor.execute.mock.calls[0][1].signal.aborted).toBe(true);

    const second = harness({ deadline: Date.now() + 25 });
    second.options.executor.execute.mockImplementation(() => new Promise(() => {}));
    const failure = expect(second.run()).rejects.toMatchObject({ code: 'routing_timeout' });
    await jest.advanceTimersByTimeAsync(25);
    await failure;
    expect(second.options.executor.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ terminal: { code: 'model_policy_violation', detail: 'guard veto' } }, 'model_policy_violation'],
    [{ statusCode: 403 }, 'provider_unavailable'],
  ])('does not retry a terminal provider result', async (result, code) => {
    const { run, options } = harness();
    options.executor.execute.mockResolvedValue(result);
    await expect(run()).rejects.toMatchObject({ code });
    expect(options.executor.execute).toHaveBeenCalledTimes(1);
  });

  it('preserves routing cancellation from the executor', async () => {
    const { run, options } = harness();
    const error = createRoutingError('routing_cancelled', 'cancelled');
    options.executor.execute.mockRejectedValue(error);
    await expect(run()).rejects.toBe(error);
    expect(options.executor.execute).toHaveBeenCalledTimes(1);
  });
});
