'use strict';

const {
  countCatalogueOverlap, createRoutingStages, mapPlannerFailure, validateRoutingDependencies,
} = require('./routing-stages');
const { createRoutingError } = require('./routing-errors');
const { createSystemClock } = require('./routing-planner');

const OBJECTIVE = { goal: 'cost', mode: 'balanced' };
const CONVERSATION = [{ role: 'user', parts: [{ text: 'private task' }] }];

function stages(options = {}) {
  return createRoutingStages({
    clock: createSystemClock(), deadline: Date.now() + 90_000, random: () => 0, ...options,
  });
}

describe('routing stages', () => {
  afterEach(() => jest.useRealTimers());

  it('checks health before validating capabilities without narrowing the candidate pool', async () => {
    const capabilities = {
      name: 'router', version: '1.0.0', routing_profiles: [OBJECTIVE],
      execution_catalogue: { models: [{ model: 'github-copilot/other', efforts: ['low'] }] },
    };
    const order = [];
    const planner = {
      health: jest.fn(async () => { order.push('health'); return 204; }),
      capabilities: jest.fn(async () => { order.push('capabilities'); return capabilities; }),
    };
    const runtime = stages();
    await expect(runtime.getCapabilities(planner, { objective: OBJECTIVE }, {})).resolves.toBe(capabilities);
    expect(order).toEqual(['health', 'capabilities']);
    expect(planner.health.mock.calls[0][0]).toMatchObject({ signal: expect.any(AbortSignal), timeoutMs: 5_000 });

    const scope = Object.freeze({ provider: 'copilot', channel: 'copilot-api' });
    const catalogue = { getSnapshot: jest.fn(async () => ({
      provider: 'copilot', configured: true, discovery: 'complete',
      models: [{ id: 'gpt-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 }],
    })) };
    const pool = await runtime.getCandidates(catalogue, {}, {}, { awfEligibilityScope: scope });
    expect(catalogue.getSnapshot.mock.calls[0][0].scope).toBe(scope);
    expect(catalogue.getSnapshot.mock.calls[0][0].provider).toBe('copilot');
    expect(pool.choices).toHaveLength(1);
    expect(countCatalogueOverlap(capabilities, pool.choices)).toBe(0);

    planner.health.mockResolvedValue(200);
    await expect(runtime.getCapabilities(planner, { objective: OBJECTIVE }, {}))
      .rejects.toMatchObject({ code: 'routing_contract_error' });
    expect(planner.capabilities).toHaveBeenCalledTimes(1);
  });

  it('validates, copies and deeply freezes the loaded conversation', async () => {
    const loaded = JSON.parse(JSON.stringify(CONVERSATION));
    const loader = jest.fn(async () => loaded);
    const conversation = await stages().getConversation(loader, '/tmp/conversation.json');
    expect(loader.mock.calls[0]).toEqual(['/tmp/conversation.json', { signal: expect.any(AbortSignal) }]);
    expect(conversation).toEqual(loaded);
    expect(conversation).not.toBe(loaded);
    expect(Object.isFrozen(conversation[0].parts[0])).toBe(true);
    loaded[0].parts[0].text = 'changed';
    expect(conversation).toEqual(CONVERSATION);
    await expect(stages().getConversation(async () => [], '/tmp/conversation.json'))
      .rejects.toMatchObject({ code: 'routing_contract_error' });
  });

  it.each([null, { mode: 'balanced', labels: { task_type: 'implement', scope: 'local', task_complexity: 'easy' } }])(
    'builds an immutable route request and validates selections before tracing them', async classification => {
      const runtime = stages();
      const pool = await runtime.getCandidates({ getSnapshot: async () => ({
        provider: 'copilot', configured: true, discovery: 'complete',
        models: [{ id: 'gpt-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 }],
      }) }, {}, {}, {});
      const response = { ranked_choices: pool.choices };
      const planner = { route: jest.fn(async () => response) };
      const result = await runtime.getRoute(planner, { objective: OBJECTIVE, topK: 2 }, pool, CONVERSATION, classification);
      expect(result.route).toEqual(response);
      expect(result.resolvedTopKRank).toEqual(pool.choices);
      const [request, { trace }] = planner.route.mock.calls[0];
      expect(Object.isFrozen(request.models[0])).toBe(true);
      expect(Object.isFrozen(request.conversation[0].parts[0])).toBe(true);
      if (classification === null) expect(request).not.toHaveProperty('classification');
      else expect(request.classification).toBe(classification);
      expect(trace.attributes['gh_aw_router.classification.present']).toBe(classification !== null);
      expect(trace.describeResult(response)).toEqual({
        'gh_aw_router.selected.model': 'github-copilot/gpt-test', 'gh_aw_router.selected.effort': 'low',
      });
      expect(() => trace.describeResult({ ranked_choices: [] }))
        .toThrow(expect.objectContaining({ code: 'routing_contract_error' }));
    },
  );

  it('bounds snapshot loading by the shared deadline and aborts the underlying operation', async () => {
    jest.useFakeTimers();
    let signal;
    const catalogue = { getSnapshot: ({ signal: phaseSignal }) => {
      signal = phaseSignal;
      return new Promise(() => {});
    } };
    const pending = stages({ deadline: Date.now() + 25 }).getCandidates(catalogue, {}, {}, {});
    const rejected = expect(pending).rejects.toMatchObject({ code: 'routing_timeout' });
    await jest.advanceTimersByTimeAsync(25);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels conversation loading even when the loader ignores the signal', async () => {
    const controller = new AbortController();
    const pending = stages({ signal: controller.signal }).getConversation(
      () => new Promise(() => {}), '/tmp/conversation.json',
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'routing_cancelled' });
  });

  it.each(['classify', 'route'])('preserves public errors and maps %s planner failures', phase => {
    const terminal = createRoutingError('routing_timeout', 'deadline');
    expect(() => mapPlannerFailure(terminal, phase)).toThrow(terminal);
    for (const [error, code] of [
      [{ statusCode: 422, body: { code: 'no_route' } }, 'no_route'],
      [{ statusCode: 400 }, 'routing_contract_error'],
      [{ code: 'ENOTFOUND' }, 'routing_configuration_error'],
      [new Error('private planner detail'), 'routing_contract_error'],
    ]) {
      expect(() => mapPlannerFailure(error, phase)).toThrow(expect.objectContaining({ code }));
    }
  });

  it('requires the final guard and conversation loader before any stage runs', () => {
    const dependencies = {
      planner: { health() {}, capabilities() {}, classify() {}, route() {} },
      catalogue: { getSnapshot() {} }, executor: { execute() {}, checkBeforePrimary() {} },
      loadConversation() {},
    };
    expect(() => validateRoutingDependencies(dependencies)).not.toThrow();
    expect(() => validateRoutingDependencies({ ...dependencies, executor: { execute() {} } }))
      .toThrow(expect.objectContaining({ code: 'routing_configuration_error' }));
    expect(() => validateRoutingDependencies({ ...dependencies, loadConversation: null }))
      .toThrow(expect.objectContaining({ code: 'routing_configuration_error' }));
  });
});
