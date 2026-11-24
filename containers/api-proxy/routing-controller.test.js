'use strict';

const { MAX_SUMMARY_BYTES } = require('./adaptive-select');
const {
  CLASSIFIER_ATTEMPT_TIMEOUT_MS,
  CLASSIFIER_MAX_ATTEMPTS,
  PURPOSE,
  ROUTING_BOOTSTRAP_TIMEOUT_MS,
  createRoutingController,
} = require('./routing-controller');
const rankFixture = require('./fixtures/routing-options/three-efforts.json');
const { createRoutingError } = require('./routing-errors');

const CONVERSATION = [{ role: 'user', parts: [{ text: 'add a test' }] }];

function capabilities(models = []) {
  return {
    name: 'gh-aw-router',
    version: '1.0.0',
    routing_profiles: [
      { goal: 'cost', mode: 'economy' },
      { goal: 'cost', mode: 'balanced' },
      { goal: 'cost', mode: 'robust' },
    ],
    execution_catalogue: { models },
  };
}

function snapshot(models, provider = 'copilot') {
  return { provider, configured: true, discovery: 'complete', models };
}

function classifierBody(text) {
  return Buffer.from(JSON.stringify({ output_text: text }), 'utf8');
}

const VALID_CLASSIFICATION = {
  labels: { task_type: 'implement', scope: 'local', task_complexity: 'easy' },
  mode: 'balanced',
};

function createHarness(overrides = {}) {
  const models = overrides.models || [
    { id: 'gpt-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
  ];
  const calls = { classify: [], route: [], execute: [], checkBeforePrimary: [] };
  const records = [];
  const planner = {
    health: jest.fn(async () => 204),
    capabilities: jest.fn(async () => capabilities(overrides.catalogueModels || [])),
    classify: jest.fn(async request => {
      calls.classify.push(request);
      return overrides.classifyResponse
        ? overrides.classifyResponse(request)
        : {
          system_prompt: 'classify the task',
          prompt: 'add a test',
          ranked_choices: request.models.map(choice => ({ ...choice })),
        };
    }),
    route: jest.fn(async request => {
      calls.route.push(request);
      if (overrides.routeResponse) return overrides.routeResponse(request);
      return { ranked_choices: [{ ...request.models[0], context_window: undefined }].map(choice => {
        const copy = { id: choice.id, model: choice.model };
        if (Object.hasOwn(choice, 'effort')) copy.effort = choice.effort;
        return copy;
      }) };
    }),
    ...overrides.planner,
  };
  const executor = {
    execute: jest.fn(async request => {
      calls.execute.push(request);
      return overrides.executeResult
        ? overrides.executeResult(calls.execute.length)
        : { statusCode: 200, body: classifierBody(JSON.stringify(VALID_CLASSIFICATION)) };
    }),
    checkBeforePrimary: jest.fn(async request => {
      calls.checkBeforePrimary.push(request);
      if (overrides.checkBeforePrimary) return overrides.checkBeforePrimary(request);
      return undefined;
    }),
    ...overrides.executor,
  };
  const controller = createRoutingController({
    config: {
      provider: overrides.provider || 'copilot',
      objective: { goal: 'cost', mode: 'balanced' },
      task: { conversationFile: '/tmp/conversation.json' },
      ...overrides.config,
    },
    planner,
    catalogue: { getSnapshot: jest.fn(async () => snapshot(models, overrides.provider || 'copilot')) },
    loadConversation: overrides.loadConversation || jest.fn(async () => JSON.parse(JSON.stringify(CONVERSATION))),
    executor,
    observer: { record: record => records.push(record) },
    routerIdentity: overrides.routerIdentity || {},
    ...overrides.dependencies,
  });
  return { controller, planner, executor, calls, records };
}

function replayRank(overrides = {}) {
  const model = (id, efforts) => ({ id, efforts, protocols: ['responses'], contextWindow: 128_000 });
  return createHarness({
    models: [model('model-a', ['low', 'medium', 'high']), model('model-b', ['high']),
      model('model-c', ['medium']), model('outside', ['high'])],
    routeResponse: () => ({ ranked_choices: rankFixture.fullRank }),
    ...overrides,
    config: { candidateModels: ['model-*'], ...overrides.config },
  });
}

describe('routing controller', () => {
  it('replays the ordinary route without opt-in: same pick, calls, planning bodies and log shape', async () => {
    const { controller, calls, records } = replayRank();
    const result = await controller.run();
    const selected = rankFixture.fullRank[0];
    expect(result).toEqual({
      ok: true, degradedClassification: false,
      selection: {
        schema: 'awf-routing-selection/v1', engine: 'copilot', provider: 'copilot',
        choice: selected, wire_model: 'model-a', endpoint: '/responses',
        selection_source: 'router', fallback_reason: null, fallback_tier: null,
      },
    });
    const offered = [...rankFixture.fullRank].sort((a, b) => a.id.localeCompare(b.id));
    expect(calls.classify).toEqual([{ conversation: CONVERSATION, models: offered }]);
    expect(calls.route).toEqual([{
      conversation: CONVERSATION, classification: VALID_CLASSIFICATION, objective: { goal: 'cost', mode: 'balanced' },
      models: offered.map(choice => ({ ...choice, context_window: 128_000 })),
    }]);
    expect(calls.execute).toHaveLength(1);
    expect(calls.checkBeforePrimary).toHaveLength(1);
    expect(calls.checkBeforePrimary[0].selection).toEqual(result.selection);
    expect(records).toEqual([
      { stage: 'classification', purpose: PURPOSE, attempt: 1, classifier_model: offered[0].model, classifier_effort: 'high' },
      {
        stage: 'selection', objective: { goal: 'cost', mode: 'balanced' }, provider: 'copilot',
        selected_provider: 'copilot', wire_model: 'model-a', endpoint: '/responses',
        selection_source: 'router', fallback_reason: null, fallback_tier: null,
        labels: VALID_CLASSIFICATION.labels, mode: 'balanced', classifier_model: offered[0].model, classifier_effort: 'high',
        router: { name: 'gh-aw-router', version: '1.0.0' },
        ranked_choices: rankFixture.fullRank.map(({ model, effort }) => ({ model, effort })),
        selected_id: selected.id, selected_model: selected.model, selected_effort: selected.effort,
        degraded_classification: false, degraded_reason: null, classifier_attempts: 1, eligible_choices: 5,
        conversation_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), catalogue_overlap: 0, latency_ms: expect.any(Number),
      },
    ]);
  });

  it.each(rankFixture.cases)('reports top $topK from the same rank without changing routing', async ({
    topK, options,
  }) => {
    const { controller, calls, records } = replayRank({ config: { topK } });
    const { selection, routeOptions } = await controller.run();
    expect(routeOptions).toEqual({ ordinaryPick: rankFixture.ordinaryPick, options });
    expect(selection.choice).toEqual(rankFixture.fullRank[0]);
    expect(calls.checkBeforePrimary).toHaveLength(1);
    expect(calls.checkBeforePrimary[0].selection).toBe(selection);
    const offered = [...rankFixture.fullRank].sort((a, b) => a.id.localeCompare(b.id));
    expect(calls.classify).toHaveLength(1);
    expect(calls.classify[0].models).toEqual(offered);
    expect(calls.route).toHaveLength(1);
    expect(calls.route[0].models).toEqual(offered.map(c => ({ ...c, context_window: 128_000 })));
    expect(calls.execute).toHaveLength(1);
    expect(calls.execute[0].body.model).toBe('model-a');
    expect(records[1].ranked_choices).toEqual(rankFixture.fullRank.map(({ model, effort }) => ({ model, effort })));
    expect(records[1]).not.toHaveProperty('routeOptions');
  });

  it('reports only two distinct bases on a two-base permitted shortlist', async () => {
    const rank = rankFixture.fullRank.slice(0, 4);
    const { controller } = replayRank({
      config: { topK: 3, candidateModels: ['model-a', 'model-b'] }, routeResponse: () => ({ ranked_choices: rank }),
    });
    const { selection, routeOptions } = await controller.run();
    expect(selection.choice).toEqual(rank[0]);
    expect(routeOptions).toEqual({
      ordinaryPick: rankFixture.ordinaryPick,
      options: [rankFixture.ordinaryPick, { model: 'github-copilot/model-b', effort: 'high' }],
    });
  });

  it('refills past a multiplier-capped alternative but never substitutes for a blocked primary', async () => {
    const env = jest.replaceProperty(process, 'env', {
      ...process.env, AWF_MAX_MODEL_MULTIPLIER: '2', AWF_DEFAULT_MODEL_MULTIPLIER: '1',
      AWF_MODEL_MULTIPLIERS: JSON.stringify({ 'model-b': 3 }),
    });
    try {
      const { checkBeforePrimary } = require('./routing-provider-executor').createRoutingProviderExecutor({
        getAdapter: jest.fn(), proxyRequest: jest.fn(), checkRateLimit: jest.fn(),
      });
      const { controller, calls, records } = replayRank({ config: { topK: 2 }, checkBeforePrimary });
      const { selection, routeOptions } = await controller.run();
      expect(selection.choice).toEqual(rankFixture.fullRank[0]);
      expect(routeOptions).toEqual({
        ordinaryPick: rankFixture.ordinaryPick,
        options: [rankFixture.ordinaryPick, { model: 'github-copilot/model-c', effort: 'medium' }],
      });
      expect(records[1].ranked_choices).toEqual(rankFixture.fullRank.map(({ model, effort }) => ({ model, effort })));
      expect(calls.classify[0].models).toContainEqual(rankFixture.fullRank[3]);
      expect(calls.checkBeforePrimary).toHaveLength(1);

      process.env.AWF_MODEL_MULTIPLIERS = JSON.stringify({ 'model-a': 3 });
      const skipped = replayRank({ config: { topK: 2 }, checkBeforePrimary });
      await expect(skipped.controller.run()).resolves.toMatchObject({
        ok: true,
        selection: {
          wire_model: 'model-b',
          selection_source: 'router',
          fallback_reason: null,
          fallback_tier: null,
        },
      });

      process.env.AWF_MODEL_MULTIPLIERS = JSON.stringify({ 'model-a': 3, 'model-b': 3, 'model-c': 3 });
      const allBlocked = replayRank({ config: { topK: 2 }, checkBeforePrimary });
      await expect(allBlocked.controller.run()).resolves.toMatchObject({ ok: false, failure: { code: 'model_multiplier_cap_exceeded' } });
    } finally {
      env.restore();
    }
  });

  it.each([
    [{ dependencies: { policy: { disallowedModels: ['*'] } } }, 'model_policy_violation'],
    [{ config: { candidateModels: ['missing'] } }, 'no_route'],
  ])('does not soften an empty pool or policy failure: %s', async (overrides, code) => {
    const { controller, calls } = replayRank({
      ...overrides, config: { ...overrides.config, topK: 3 },
    });
    await expect(controller.run()).resolves.toMatchObject({ ok: false, failure: { code } });
    expect(calls.checkBeforePrimary).toHaveLength(0);
  });

  it.each([
    [{ planner: { route: async () => { throw { statusCode: 422, body: { code: 'no_route' } }; } } }, 'no_route'],
    [{ routeResponse: () => ({ ranked_choices: [...rankFixture.fullRank, rankFixture.fullRank[0]] }) }, 'routing_contract_error'],
    [{ routeResponse: () => ({ ranked_choices: [...rankFixture.fullRank, { id: 'foreign', model: 'openai/model-b' }] }) }, 'routing_contract_error'],
  ])('falls back without routeOptions when the router cannot produce a usable rank: %s', async (overrides, reason) => {
    const { controller } = replayRank({
      ...overrides, config: { ...overrides.config, topK: 3 },
    });
    const result = await controller.run();
    expect(result).toMatchObject({
      ok: true,
      selection: {
        selection_source: 'fallback',
        fallback_reason: reason,
        fallback_tier: 'unclassified',
      },
    });
    expect(result).not.toHaveProperty('routeOptions');
  });

  describe('adaptive selection', () => {
    const job = Object.freeze({ workflow: 'pr-sous-chef', run_id: '45000000812', attempt: 1 });
    const tokens = { input: 52000, cache_read: 410000, cache_write: 0, output: 14000, reasoning: null };
    // Per-token rates: B's tokens cost 28 credits; A costs twice as much per token and C 12/28 as much.
    const rates = { 'model-a': 2 * 28 / 29.8, 'model-b': 28 / 29.8, 'model-c': 12 / 29.8 };
    const priceRoute = (mapping, usage) => rates[mapping.wireModel] *
      (usage.input * 0.0002 + usage.cache_read * 0.00002 + usage.output * 0.0008);
    const discounted = count => Array.from({ length: count }, (_, k) => 0.98 ** k).reduce((a, b) => a + b, 0);
    const summary = (overrides = {}) => ({
      v: 2, workflow: job.workflow, run: { id: job.run_id, number: 812, attempt: 1 }, generation: '9f2c41d0',
      mode: 'live', scope: 'copilot/cost/shared', level: 'balanced',
      explore: { allowed: true, reason: 'clear', mode: 'queued', share: true, turn: true, in_flight: 0 },
      incumbent: 'github-copilot/model-b@high',
      pairs: [{
        pair: 'github-copilot/model-b@high', wins: discounted(40), losses: 0, runs: 40, credits: 28,
        model_credits: 28, bills: 40, tokens, streak: 0, tests: 0, suspended: null,
      }],
      ...overrides,
    });
    const run = (adaptiveSummary, overrides = {}) => {
      const writeAdaptiveReceipt = jest.fn();
      const harness = replayRank({
        ...overrides,
        dependencies: {
          adaptive: { job: overrides.job || job, summary: adaptiveSummary },
          priceRoute,
          writeAdaptiveReceipt,
          ...overrides.dependencies,
        },
      });
      return { ...harness, writeAdaptiveReceipt };
    };

    it('tests the rival the evidence favours and records the receipt once the final guard accepts it', async () => {
      const { controller, calls, records, executor, writeAdaptiveReceipt } = run(summary());
      const result = await controller.run();
      expect(result.selection).toMatchObject({ choice: rankFixture.fullRank[4], wire_model: 'model-c' });
      expect(calls.checkBeforePrimary.map(call => call.selection)).toContainEqual(result.selection);
      const triedIds = calls.checkBeforePrimary.map(call => call.selection.choice.id);
      expect(new Set(triedIds).size).toBe(triedIds.length);
      expect(calls.classify).toHaveLength(1);
      expect(calls.route).toHaveLength(1);
      expect(records[1]).toMatchObject({ selected_model: 'github-copilot/model-c', selected_effort: 'medium' });
      expect(records[1].ranked_choices).toEqual(rankFixture.fullRank.map(({ model, effort }) => ({ model, effort })));
      expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      const receipt = writeAdaptiveReceipt.mock.calls[0][0];
      expect(receipt).toEqual(result.adaptiveReceipt);
      expect(receipt).toMatchObject({
        event: 'adaptive_selection', role: 'test', selected: 'github-copilot/model-c@medium',
        ordinary: 'github-copilot/model-a@low', reason: 'challenger_hopeful_clears_need',
        incumbent: { before: 'github-copilot/model-b@high', after: 'github-copilot/model-b@high' },
        concurrency: { turn: true, in_flight: 0, capacity: 1 },
      });
      expect(receipt.costs['github-copilot/model-b@high']).toEqual({ credits: 28, basis: 'measured' });
      expect(receipt.costs['github-copilot/model-c@medium'].basis).toBe('estimated');
      expect(receipt.costs['github-copilot/model-c@medium'].credits).toBeCloseTo(12, 9);
      const lastGuardCall = executor.checkBeforePrimary.mock.invocationCallOrder.at(-1);
      expect(lastGuardCall).toBeLessThan(writeAdaptiveReceipt.mock.invocationCallOrder[0]);
    });

    it('keeps the ordinary pick in observe mode and reports what live mode would run', async () => {
      const observe = summary({
        mode: 'observe', incumbent: null,
        explore: { allowed: false, reason: 'observe', mode: 'queued', share: true, turn: true, in_flight: 0 },
      });
      const { controller, writeAdaptiveReceipt } = run(observe);
      const result = await controller.run();
      expect(result.selection.choice).toEqual(rankFixture.fullRank[0]);
      expect(writeAdaptiveReceipt.mock.calls[0][0]).toMatchObject({
        role: 'observe', selected: 'github-copilot/model-a@low', would: 'github-copilot/model-c@medium',
        reason: 'challenger_hopeful_clears_need',
      });
    });

    it.each([
      [null, 'summary_missing'],
      ['invalid', 'invalid_evidence'],
    ])('routes ordinarily with a visible reason when the summary is %s', async (adaptiveSummary, reason) => {
      const { controller, writeAdaptiveReceipt } = run(adaptiveSummary);
      const result = await controller.run();
      expect(result.selection.choice).toEqual(rankFixture.fullRank[0]);
      expect(writeAdaptiveReceipt.mock.calls[0][0]).toMatchObject({ role: 'ordinary', reason, concurrency: null });
    });

    it('preserves observe mode and its would counterfactual when rank #0 fails AWF_MAX_MODEL_MULTIPLIER', async () => {
      const env = jest.replaceProperty(process, 'env', {
        ...process.env, AWF_MAX_MODEL_MULTIPLIER: '1', AWF_DEFAULT_MODEL_MULTIPLIER: '1',
        AWF_MODEL_MULTIPLIERS: JSON.stringify({ 'model-a': 3, 'model-b': 1, 'model-c': 0.33 }),
      });
      try {
        const { checkBeforePrimary } = require('./routing-provider-executor').createRoutingProviderExecutor({
          getAdapter: jest.fn(), proxyRequest: jest.fn(), checkRateLimit: jest.fn(),
        });
        const withoutSummary = await replayRank({ config: { topK: 2 }, checkBeforePrimary }).controller.run();
        const observe = summary({
          mode: 'observe', incumbent: null,
          explore: { allowed: false, reason: 'observe', mode: 'queued', share: true, turn: true, in_flight: 0 },
        });
        const { controller, calls, executor, writeAdaptiveReceipt } = run(observe, {
          config: { topK: 2 },
          checkBeforePrimary,
        });
        const result = await controller.run();
        expect(result.ok).toBe(true);
        expect(result.selection).toEqual(withoutSummary.selection);
        expect(result.selection).toMatchObject({ wire_model: 'model-b', selection_source: 'router' });
        expect(result.routeOptions).toEqual({
          ordinaryPick: { model: 'github-copilot/model-b', effort: 'high' },
          options: [
            { model: 'github-copilot/model-b', effort: 'high' },
            { model: 'github-copilot/model-c', effort: 'medium' },
          ],
        });
        const triedIds = calls.checkBeforePrimary.map(call => call.selection.choice.id);
        expect(new Set(triedIds).size).toBe(triedIds.length);
        expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
        expect(result.adaptiveReceipt).toMatchObject({
          event: 'adaptive_selection',
          v: 2,
          mode: 'observe',
          role: 'observe',
          selected: 'github-copilot/model-b@high',
          ordinary: 'github-copilot/model-b@high',
          would: 'github-copilot/model-c@medium',
          incumbent: { before: null, after: null },
          concurrency: { turn: true, in_flight: 0, capacity: 1 },
          reason: 'challenger_hopeful_clears_need',
        });
        expect(writeAdaptiveReceipt.mock.calls[0][0]).toEqual(result.adaptiveReceipt);
        const lastGuardCall = executor.checkBeforePrimary.mock.invocationCallOrder.at(-1);
        expect(lastGuardCall).toBeLessThan(writeAdaptiveReceipt.mock.invocationCallOrder[0]);
      } finally {
        env.restore();
      }
    });

    it('preserves observe mode and its would counterfactual when rank #0 fails a non-cap per-model guard', async () => {
      const checkBeforePrimary = ({ selection }) => {
        if (selection.wire_model === 'model-a') {
          throw createRoutingError('pricing_resolution_error', 'unpriced');
        }
      };
      const withoutSummary = await replayRank({ config: { topK: 2 }, checkBeforePrimary }).controller.run();
      const observe = summary({
        mode: 'observe', incumbent: null,
        explore: { allowed: false, reason: 'observe', mode: 'queued', share: true, turn: true, in_flight: 0 },
      });
      const { controller, calls, executor, writeAdaptiveReceipt } = run(observe, {
        config: { topK: 2 },
        checkBeforePrimary,
      });
      const result = await controller.run();
      expect(result.ok).toBe(true);
      expect(result.selection).toEqual(withoutSummary.selection);
      expect(result.selection).toMatchObject({ wire_model: 'model-b', selection_source: 'router' });
      expect(result.routeOptions).toEqual({
        ordinaryPick: { model: 'github-copilot/model-b', effort: 'high' },
        options: [
          { model: 'github-copilot/model-b', effort: 'high' },
          { model: 'github-copilot/model-c', effort: 'medium' },
        ],
      });
      const triedIds = calls.checkBeforePrimary.map(call => call.selection.choice.id);
      expect(new Set(triedIds).size).toBe(triedIds.length);
      expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      expect(result.adaptiveReceipt).toMatchObject({
        event: 'adaptive_selection',
        v: 2,
        workflow: job.workflow,
        run: { id: job.run_id, attempt: job.attempt },
        generation: '9f2c41d0',
        mode: 'observe',
        scope: 'copilot/cost/shared',
        role: 'observe',
        explore_allowed: false,
        selected: 'github-copilot/model-b@high',
        ordinary: 'github-copilot/model-b@high',
        would: 'github-copilot/model-c@medium',
        incumbent: { before: null, after: null },
        concurrency: { turn: true, in_flight: 0, capacity: 1 },
        reason: 'challenger_hopeful_clears_need',
      });
      expect(writeAdaptiveReceipt.mock.calls[0][0]).toEqual(result.adaptiveReceipt);
      const lastGuardCall = executor.checkBeforePrimary.mock.invocationCallOrder.at(-1);
      expect(lastGuardCall).toBeLessThan(writeAdaptiveReceipt.mock.invocationCallOrder[0]);
    });

    it.each([
      ['retired_model', 'The selected model is retired'],
      ['model_policy_violation', 'The selected model is not permitted'],
      ['no_route', 'Model is ineligible for this harness'],
    ])('excludes a cheaper rival rejected by %s from observe-mode would and routeOptions', async (code, message) => {
      const checkBeforePrimary = ({ selection }) => {
        if (selection.wire_model === 'model-c') {
          throw createRoutingError(code, message);
        }
      };
      const observe = summary({
        mode: 'observe',
        explore: { allowed: false, reason: 'observe', mode: 'queued', share: true, turn: true, in_flight: 0 },
      });
      const { controller, writeAdaptiveReceipt } = run(observe, {
        config: { topK: 3 },
        checkBeforePrimary,
      });
      const result = await controller.run();
      expect(result.ok).toBe(true);
      expect(result.selection).toMatchObject({ choice: rankFixture.fullRank[0], wire_model: 'model-a' });
      expect(result.routeOptions).toEqual({
        ordinaryPick: rankFixture.ordinaryPick,
        options: [
          rankFixture.ordinaryPick,
          { model: 'github-copilot/model-b', effort: 'high' },
        ],
      });
      expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      expect(result.adaptiveReceipt).toMatchObject({
        role: 'observe',
        selected: 'github-copilot/model-a@low',
        ordinary: 'github-copilot/model-a@low',
        would: 'github-copilot/model-b@high',
        reason: 'no_challenger',
      });
    });

    it('excludes a guard-rejected live rival from selection instead of dropping the incumbent', async () => {
      const checkBeforePrimary = ({ selection }) => {
        if (selection.wire_model === 'model-c') {
          throw createRoutingError('model_policy_violation', 'The selected model is not permitted');
        }
      };
      const { controller, calls, executor, writeAdaptiveReceipt } = run(summary(), { checkBeforePrimary });
      const result = await controller.run();
      expect(result.ok).toBe(true);
      expect(result.selection).toMatchObject({
        choice: rankFixture.fullRank[3],
        wire_model: 'model-b',
        selection_source: 'router',
      });
      const triedIds = calls.checkBeforePrimary.map(call => call.selection.choice.id);
      expect(new Set(triedIds).size).toBe(triedIds.length);
      expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      expect(result.adaptiveReceipt).toMatchObject({
        event: 'adaptive_selection',
        v: 2,
        workflow: job.workflow,
        run: { id: job.run_id, attempt: job.attempt },
        generation: '9f2c41d0',
        mode: 'live',
        scope: 'copilot/cost/shared',
        role: 'serve',
        explore_allowed: true,
        selected: 'github-copilot/model-b@high',
        ordinary: 'github-copilot/model-a@low',
        would: null,
        incumbent: { before: 'github-copilot/model-b@high', after: 'github-copilot/model-b@high' },
        concurrency: { turn: true, in_flight: 0, capacity: null },
        reason: 'no_challenger',
      });
      const lastGuardCall = executor.checkBeforePrimary.mock.invocationCallOrder.at(-1);
      expect(lastGuardCall).toBeLessThan(writeAdaptiveReceipt.mock.invocationCallOrder[0]);
    });

    it('serves a guard-passing choice with all_suspended when rank #0 fails AWF_MAX_MODEL_MULTIPLIER', async () => {
      const env = jest.replaceProperty(process, 'env', {
        ...process.env, AWF_MAX_MODEL_MULTIPLIER: '1', AWF_DEFAULT_MODEL_MULTIPLIER: '1',
        AWF_MODEL_MULTIPLIERS: JSON.stringify({ 'model-a': 3, 'model-b': 1, 'model-c': 0.33 }),
      });
      try {
        const { checkBeforePrimary } = require('./routing-provider-executor').createRoutingProviderExecutor({
          getAdapter: jest.fn(), proxyRequest: jest.fn(), checkRateLimit: jest.fn(),
        });
        const suspended = summary({
          incumbent: null,
          pairs: [
            {
              pair: 'github-copilot/model-b@low', wins: 0, losses: 3, runs: 3, credits: null,
              model_credits: null, bills: 0, tokens: null, streak: 3, tests: 0,
              suspended: { pending: 3, probe_due: false },
            },
            {
              pair: 'github-copilot/model-c@low', wins: 0, losses: 3, runs: 3, credits: null,
              model_credits: null, bills: 0, tokens: null, streak: 3, tests: 0,
              suspended: { pending: 3, probe_due: false },
            },
          ],
        });
        const { controller, writeAdaptiveReceipt } = run(suspended, { config: { topK: 2 }, checkBeforePrimary });
        const result = await controller.run();
        expect(result.ok).toBe(true);
        expect(result.selection).toMatchObject({ wire_model: 'model-b', selection_source: 'router' });
        expect(result.routeOptions).toEqual({
          ordinaryPick: { model: 'github-copilot/model-b', effort: 'high' },
          options: [
            { model: 'github-copilot/model-b', effort: 'high' },
            { model: 'github-copilot/model-c', effort: 'medium' },
          ],
        });
        expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
        expect(result.adaptiveReceipt).toMatchObject({
          role: 'serve',
          selected: 'github-copilot/model-b@high',
          ordinary: 'github-copilot/model-b@high',
          would: null,
          reason: 'all_suspended',
        });
      } finally {
        env.restore();
      }
    });

    it('serves a guard-passing choice with all_suspended when rank #0 fails a non-cap guard', async () => {
      const checkBeforePrimary = ({ selection }) => {
        if (selection.wire_model === 'model-a') {
          throw createRoutingError('retired_model', 'The selected model is retired');
        }
      };
      const siblingSuspended = summary({
        incumbent: null,
        pairs: [
          {
            pair: 'github-copilot/model-b@low', wins: 0, losses: 3, runs: 3, credits: null,
            model_credits: null, bills: 0, tokens: null, streak: 3, tests: 0,
            suspended: { pending: 3, probe_due: false },
          },
          {
            pair: 'github-copilot/model-c@low', wins: 0, losses: 3, runs: 3, credits: null,
            model_credits: null, bills: 0, tokens: null, streak: 3, tests: 0,
            suspended: { pending: 3, probe_due: false },
          },
        ],
      });
      const fallbackToOrdinary = await run(siblingSuspended, { checkBeforePrimary }).controller.run();
      expect(fallbackToOrdinary.ok).toBe(true);
      expect(fallbackToOrdinary.selection).toMatchObject({ wire_model: 'model-b', selection_source: 'router' });
      expect(fallbackToOrdinary.adaptiveReceipt).toMatchObject({
        role: 'serve',
        selected: 'github-copilot/model-b@high',
        ordinary: 'github-copilot/model-b@high',
        would: null,
        reason: 'all_suspended',
      });

      const recordedSuspended = summary({
        incumbent: null,
        pairs: [
          {
            pair: 'github-copilot/model-a@low', wins: 10, losses: 3, runs: 13, credits: null,
            model_credits: null, bills: 0, tokens: null, streak: 3, tests: 0,
            suspended: { pending: 3, probe_due: false },
          },
          {
            pair: 'github-copilot/model-b@high', wins: 1, losses: 3, runs: 4, credits: null,
            model_credits: null, bills: 0, tokens: null, streak: 3, tests: 0,
            suspended: { pending: 3, probe_due: false },
          },
          {
            pair: 'github-copilot/model-c@medium', wins: 0, losses: 3, runs: 3, credits: null,
            model_credits: null, bills: 0, tokens: null, streak: 3, tests: 0,
            suspended: { pending: 3, probe_due: false },
          },
        ],
      });
      const bestPassing = await run(recordedSuspended, { checkBeforePrimary }).controller.run();
      expect(bestPassing.ok).toBe(true);
      expect(bestPassing.selection).toMatchObject({ wire_model: 'model-b', selection_source: 'router' });
      expect(bestPassing.adaptiveReceipt).toMatchObject({
        role: 'serve',
        selected: 'github-copilot/model-b@high',
        ordinary: 'github-copilot/model-b@high',
        would: null,
        reason: 'all_suspended',
      });
    });

    it('moves on to the fallback pool with selection_rejected when every router choice is rejected by per-model guards', async () => {
      const checkBeforePrimary = ({ selection }) => {
        if (selection.wire_model !== 'model-b') {
          throw createRoutingError('pricing_resolution_error', 'unpriced');
        }
      };
      const partialRank = [rankFixture.fullRank[0], rankFixture.fullRank[4]];
      const { controller, calls, executor, writeAdaptiveReceipt } = run(summary(), {
        routeResponse: () => ({ ranked_choices: partialRank }),
        checkBeforePrimary,
      });
      const result = await controller.run();
      expect(result.ok).toBe(true);
      expect(result.selection).toMatchObject({
        wire_model: 'model-b',
        selection_source: 'fallback',
        fallback_reason: 'pricing_resolution_error',
      });
      const triedIds = calls.checkBeforePrimary.map(call => call.selection.choice.id);
      expect(new Set(triedIds).size).toBe(triedIds.length);
      expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      expect(result.adaptiveReceipt).toMatchObject({
        role: 'ordinary',
        reason: 'selection_rejected',
        selected: 'github-copilot/model-b@high',
        ordinary: 'github-copilot/model-b@high',
        would: null,
        incumbent: { before: 'github-copilot/model-b@high', after: 'github-copilot/model-b@high' },
        costs: {},
        concurrency: { turn: true, in_flight: 0, capacity: null },
      });
      const lastGuardCall = executor.checkBeforePrimary.mock.invocationCallOrder.at(-1);
      expect(lastGuardCall).toBeLessThan(writeAdaptiveReceipt.mock.invocationCallOrder[0]);
    });

    it('writes no receipt without opt-in', async () => {
      const writeAdaptiveReceipt = jest.fn();
      const { controller } = replayRank({ dependencies: { writeAdaptiveReceipt } });
      const result = await controller.run();
      expect(result).not.toHaveProperty('adaptiveReceipt');
      expect(writeAdaptiveReceipt).not.toHaveBeenCalled();
    });

    it.each([
      [
        '422 no_route',
        { planner: { route: async () => { throw { statusCode: 422, body: { code: 'no_route' } }; } } },
        'no_route',
      ],
      [
        'unavailable router',
        {
          planner: { route: async () => { throw { statusCode: 503 }; } },
          dependencies: {
            clock: { now: () => 1_000, setTimer: () => 1, clearTimer: () => {}, sleep: async () => {} },
          },
        },
        'router_unavailable',
      ],
      [
        'router timeout',
        { planner: { route: async () => { throw createRoutingError('routing_timeout', 'Router phase timed out'); } } },
        'routing_timeout',
      ],
      [
        'invalid response',
        { routeResponse: () => ({ ranked_choices: [{ id: 'foreign', model: 'openai/model-b' }] }) },
        'routing_contract_error',
      ],
    ])('writes a router_fallback receipt when the router cannot choose (%s)', async (_label, overrides, fallbackReason) => {
      const { controller, executor, writeAdaptiveReceipt } = run(summary(), overrides);
      const result = await controller.run();
      expect(result).toMatchObject({
        ok: true,
        selection: {
          selection_source: 'fallback',
          fallback_reason: fallbackReason,
        },
      });
      const expectedPair = `github-copilot/${result.selection.wire_model}@${result.selection.choice.effort}`;
      expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      expect(result.adaptiveReceipt).toEqual({
        event: 'adaptive_selection',
        v: 2,
        workflow: job.workflow,
        run: { id: job.run_id, attempt: job.attempt },
        generation: '9f2c41d0',
        mode: 'live',
        scope: 'copilot/cost/shared',
        role: 'ordinary',
        explore_allowed: true,
        selected: expectedPair,
        ordinary: expectedPair,
        would: null,
        incumbent: { before: 'github-copilot/model-b@high', after: 'github-copilot/model-b@high' },
        costs: {},
        concurrency: { turn: true, in_flight: 0, capacity: null },
        reason: 'router_fallback',
      });
      expect(writeAdaptiveReceipt.mock.calls[0][0]).toEqual(result.adaptiveReceipt);
      const lastGuardCall = executor.checkBeforePrimary.mock.invocationCallOrder.at(-1);
      expect(lastGuardCall).toBeLessThan(writeAdaptiveReceipt.mock.invocationCallOrder[0]);
    });

    it('sets explore_allowed false on a rerun router_fallback receipt', async () => {
      const rerunJob = Object.freeze({ workflow: job.workflow, run_id: job.run_id, attempt: 2 });
      const rerunSummary = summary({ run: { id: job.run_id, number: 812, attempt: 2 } });
      const { controller, writeAdaptiveReceipt } = run(rerunSummary, {
        job: rerunJob,
        planner: { route: async () => { throw { statusCode: 422, body: { code: 'no_route' } }; } },
      });
      const result = await controller.run();
      expect(result.ok).toBe(true);
      expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      expect(result.adaptiveReceipt).toMatchObject({
        run: { id: job.run_id, attempt: 2 },
        role: 'ordinary',
        explore_allowed: false,
        reason: 'router_fallback',
      });
    });

    it.each([
      [null, 'summary_missing'],
      ['invalid', 'invalid_evidence'],
    ])('names the winning pair on a %s receipt after router failure or rejected first choice', async (adaptiveSummary, reason) => {
      const routerFail = { planner: { route: async () => { throw { statusCode: 422, body: { code: 'no_route' } }; } } };
      const plainFallback = await replayRank(routerFail).controller.run();
      const fallbackRun = run(adaptiveSummary, routerFail);
      const fallbackResult = await fallbackRun.controller.run();
      expect(fallbackResult.ok).toBe(true);
      expect(fallbackResult.selection).toEqual(plainFallback.selection);
      const fallbackPair = `github-copilot/${fallbackResult.selection.wire_model}@${fallbackResult.selection.choice.effort}`;
      expect(fallbackRun.writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      expect(fallbackResult.adaptiveReceipt).toMatchObject({
        mode: null,
        role: 'ordinary',
        explore_allowed: false,
        selected: fallbackPair,
        ordinary: fallbackPair,
        would: null,
        incumbent: null,
        costs: {},
        concurrency: null,
        reason,
      });
      expect(fallbackRun.executor.checkBeforePrimary.mock.invocationCallOrder.at(-1))
        .toBeLessThan(fallbackRun.writeAdaptiveReceipt.mock.invocationCallOrder[0]);

      const rejectFirst = {
        checkBeforePrimary: ({ selection }) => {
          if (selection.wire_model === 'model-a') {
            throw createRoutingError('pricing_resolution_error', 'unpriced');
          }
        },
      };
      const plainNext = await replayRank(rejectFirst).controller.run();
      const nextRun = run(adaptiveSummary, rejectFirst);
      const nextResult = await nextRun.controller.run();
      expect(nextResult.ok).toBe(true);
      expect(nextResult.selection).toEqual(plainNext.selection);
      expect(nextRun.writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      expect(nextResult.adaptiveReceipt).toMatchObject({
        mode: null,
        role: 'ordinary',
        explore_allowed: false,
        selected: 'github-copilot/model-b@high',
        ordinary: 'github-copilot/model-b@high',
        would: null,
        incumbent: null,
        costs: {},
        concurrency: null,
        reason,
      });
      expect(nextRun.executor.checkBeforePrimary.mock.invocationCallOrder.at(-1))
        .toBeLessThan(nextRun.writeAdaptiveReceipt.mock.invocationCallOrder[0]);
    });

    it('accepts a legacy summary with an unrelated non-incumbent pair whose model_credits exceeds credits', async () => {
      const base = summary();
      const legacySummary = summary({
        pairs: [
          ...base.pairs,
          {
            pair: 'github-copilot/legacy-model@high',
            wins: 1.98,
            losses: 0,
            runs: 2,
            credits: 10,
            model_credits: 28,
            bills: 2,
            tokens,
            streak: 0,
            tests: 0,
            suspended: null,
          },
        ],
      });
      const { controller, writeAdaptiveReceipt } = run(legacySummary);
      const result = await controller.run();
      expect(result.ok).toBe(true);
      expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
      expect(result.adaptiveReceipt).toMatchObject({
        event: 'adaptive_selection',
        v: 2,
        workflow: job.workflow,
        run: { id: job.run_id, attempt: job.attempt },
        generation: '9f2c41d0',
        mode: 'live',
        scope: 'copilot/cost/shared',
        explore_allowed: true,
        role: 'test',
        selected: 'github-copilot/model-c@medium',
        ordinary: 'github-copilot/model-a@low',
        incumbent: { before: 'github-copilot/model-b@high', after: 'github-copilot/model-b@high' },
        concurrency: { turn: true, in_flight: 0, capacity: 1 },
        reason: 'challenger_hopeful_clears_need',
      });
      expect(result.adaptiveReceipt.costs['github-copilot/model-b@high']).toEqual({ credits: 28, basis: 'measured' });
      expect(result.adaptiveReceipt.costs['github-copilot/model-c@medium'].basis).toBe('estimated');
      expect(result.adaptiveReceipt.costs['github-copilot/model-c@medium'].credits).toBeCloseTo(12, 9);
    });

    it('clears binding fields on invalid_evidence receipts for malformed object summaries', async () => {
      const malformed = summary({ v: 1 });
      const normalRun = run(malformed);
      const normalResult = await normalRun.controller.run();
      expect(normalResult.ok).toBe(true);
      expect(normalResult.adaptiveReceipt).toMatchObject({
        generation: null,
        mode: null,
        scope: null,
        role: 'ordinary',
        explore_allowed: false,
        selected: 'github-copilot/model-a@low',
        ordinary: 'github-copilot/model-a@low',
        would: null,
        incumbent: null,
        costs: {},
        concurrency: null,
        reason: 'invalid_evidence',
      });

      const fallbackRun = run(malformed, {
        planner: { route: async () => { throw { statusCode: 422, body: { code: 'no_route' } }; } },
      });
      const fallbackResult = await fallbackRun.controller.run();
      expect(fallbackResult.ok).toBe(true);
      const fallbackPair = `github-copilot/${fallbackResult.selection.wire_model}@${fallbackResult.selection.choice.effort}`;
      expect(fallbackResult.adaptiveReceipt).toMatchObject({
        generation: null,
        mode: null,
        scope: null,
        role: 'ordinary',
        explore_allowed: false,
        selected: fallbackPair,
        ordinary: fallbackPair,
        would: null,
        incumbent: null,
        costs: {},
        concurrency: null,
        reason: 'invalid_evidence',
      });
    });

    it('fails without a receipt on a run-wide guard or when every pair is rejected', async () => {
      const budgetRun = run(summary(), {
        checkBeforePrimary: () => { throw createRoutingError('ai_credits_limit_exceeded', 'Budget exhausted'); },
      });
      const budgetResult = await budgetRun.controller.run();
      expect(budgetResult).toMatchObject({ ok: false, failure: { code: 'ai_credits_limit_exceeded' } });
      expect(budgetResult).not.toHaveProperty('adaptiveReceipt');
      expect(budgetRun.calls.checkBeforePrimary).toHaveLength(1);
      expect(budgetRun.writeAdaptiveReceipt).not.toHaveBeenCalled();

      const allRejectedRun = run(summary(), {
        checkBeforePrimary: ({ selection }) => {
          if (selection.wire_model === 'model-a') {
            throw createRoutingError('model_policy_violation', 'blocked');
          }
          throw createRoutingError('pricing_resolution_error', 'unpriced');
        },
      });
      const allRejectedResult = await allRejectedRun.controller.run();
      expect(allRejectedResult).toMatchObject({ ok: false, failure: { code: 'model_policy_violation' } });
      expect(allRejectedResult).not.toHaveProperty('adaptiveReceipt');
      const triedIds = allRejectedRun.calls.checkBeforePrimary.map(call => call.selection.choice.id);
      expect(new Set(triedIds).size).toBe(triedIds.length);
      expect(allRejectedRun.writeAdaptiveReceipt).not.toHaveBeenCalled();
    });

    it('fails without a receipt when adaptive pricing crosses the overall deadline or is cancelled', async () => {
      let now = 1_000;
      const fakeClock = {
        now: () => now,
        setTimer: () => 1,
        clearTimer: () => {},
        sleep: async () => {},
      };
      const timedOutRun = run(summary(), {
        dependencies: {
          clock: fakeClock,
          priceRoute: (mapping, usage) => {
            now = 1_000 + ROUTING_BOOTSTRAP_TIMEOUT_MS;
            return priceRoute(mapping, usage);
          },
        },
      });
      const timedOutResult = await timedOutRun.controller.run();
      expect(timedOutResult).toMatchObject({ ok: false, failure: { code: 'routing_timeout' } });
      expect(timedOutResult).not.toHaveProperty('adaptiveReceipt');
      expect(timedOutRun.writeAdaptiveReceipt).not.toHaveBeenCalled();

      const abortController = new AbortController();
      const cancelledRun = run(summary(), {
        dependencies: {
          priceRoute: (mapping, usage) => {
            abortController.abort();
            return priceRoute(mapping, usage);
          },
        },
      });
      const cancelledResult = await cancelledRun.controller.run({ signal: abortController.signal });
      expect(cancelledResult).toMatchObject({ ok: false, failure: { code: 'routing_cancelled' } });
      expect(cancelledResult).not.toHaveProperty('adaptiveReceipt');
      expect(cancelledRun.writeAdaptiveReceipt).not.toHaveBeenCalled();

      let fallbackNow = 1_000;
      const fallbackClock = {
        now: () => fallbackNow,
        setTimer: () => 1,
        clearTimer: () => {},
        sleep: async () => {},
      };
      const partialRank = [rankFixture.fullRank[0], rankFixture.fullRank[4]];
      const fallbackTimedOutRun = run(summary(), {
        routeResponse: () => ({ ranked_choices: partialRank }),
        checkBeforePrimary: ({ selection }) => {
          if (selection.selection_source === 'router') {
            throw createRoutingError('pricing_resolution_error', 'unpriced');
          }
          fallbackNow = 1_000 + ROUTING_BOOTSTRAP_TIMEOUT_MS;
        },
        dependencies: { clock: fallbackClock },
      });
      const fallbackTimedOutResult = await fallbackTimedOutRun.controller.run();
      expect(fallbackTimedOutResult).toMatchObject({ ok: false, failure: { code: 'routing_timeout' } });
      expect(fallbackTimedOutResult).not.toHaveProperty('adaptiveReceipt');
      expect(fallbackTimedOutRun.writeAdaptiveReceipt).not.toHaveBeenCalled();

      let lastGuardNow = 1_000;
      const lastGuardClock = {
        now: () => lastGuardNow,
        setTimer: () => 1,
        clearTimer: () => {},
        sleep: async () => {},
      };
      const lastChoiceId = rankFixture.fullRank.at(-1).id;
      const lastGuardTimedOutRun = run(summary(), {
        checkBeforePrimary: ({ selection }) => {
          if (selection.choice.id === lastChoiceId) {
            lastGuardNow = 1_000 + ROUTING_BOOTSTRAP_TIMEOUT_MS;
          }
          throw createRoutingError('pricing_resolution_error', 'unpriced');
        },
        dependencies: { clock: lastGuardClock },
      });
      const lastGuardTimedOutResult = await lastGuardTimedOutRun.controller.run();
      expect(lastGuardTimedOutResult).toMatchObject({ ok: false, failure: { code: 'routing_timeout' } });
      expect(lastGuardTimedOutResult).not.toHaveProperty('adaptiveReceipt');
      expect(lastGuardTimedOutRun.writeAdaptiveReceipt).not.toHaveBeenCalled();
    });

    it('pins one pricing catalogue capture and caches model pricing across sibling efforts', async () => {
      const { getCatalogueLoader } = require('./catalogue-loader');
      const pricingResolution = require('./catalogue-contract/pricing-resolution');
      const { createAdaptivePrice } = require('./routing-runtime');
      const { checkBeforePrimary } = require('./routing-provider-executor').createRoutingProviderExecutor({
        getAdapter: jest.fn(), proxyRequest: jest.fn(), checkRateLimit: jest.fn(),
      });
      const captureSpy = jest.spyOn(getCatalogueLoader(), 'capture');
      const resolveSpy = jest.spyOn(pricingResolution, 'resolvePricing');
      try {
        const { controller, calls } = run(summary(), {
          checkBeforePrimary,
          dependencies: { priceRoute: createAdaptivePrice() },
        });
        const result = await controller.run();
        expect(result.ok).toBe(true);
        expect(calls.checkBeforePrimary.length).toBe(rankFixture.fullRank.length);
        expect(captureSpy).toHaveBeenCalledTimes(1);
        const pinned = calls.checkBeforePrimary[0].awfCatalogue;
        const pricingCache = calls.checkBeforePrimary[0].awfPricingCache;
        expect(pricingCache).toBeInstanceOf(Map);
        expect(calls.checkBeforePrimary.every(call =>
          call.awfCatalogue === pinned && call.awfPricingCache === pricingCache)).toBe(true);
        // Three distinct models (model-a across 3 efforts, model-b, model-c): model-a is cached after its first effort.
        expect(pricingCache.size).toBe(3);
        const modelAResolutions = resolveSpy.mock.calls.filter(([req]) => req.identity?.key === 'copilot:model-a');
        expect(modelAResolutions.length).toBeLessThanOrEqual(3);
      } finally {
        captureSpy.mockRestore();
        resolveSpy.mockRestore();
      }
    });

    it('excludes guard-rejected choices from topK routeOptions under adaptive selection', async () => {
      const checkBeforePrimary = ({ selection }) => {
        if (selection.wire_model === 'model-a' || selection.wire_model === 'model-c') {
          throw createRoutingError('pricing_resolution_error', 'unpriced');
        }
      };
      const withSummary = await run(summary(), { config: { topK: 2 }, checkBeforePrimary }).controller.run();
      expect(withSummary.ok).toBe(true);
      expect(withSummary.selection).toMatchObject({ wire_model: 'model-b', selection_source: 'router' });
      expect(withSummary.routeOptions).toEqual({
        ordinaryPick: { model: 'github-copilot/model-b', effort: 'high' },
        options: [{ model: 'github-copilot/model-b', effort: 'high' }],
      });
      expect(withSummary.adaptiveReceipt).toMatchObject({
        role: 'serve',
        reason: 'no_challenger',
        selected: 'github-copilot/model-b@high',
        ordinary: 'github-copilot/model-b@high',
      });
    });

    describe('classifier-resolved auto level', () => {
      const autoConfig = { objective: { goal: 'cost', mode: 'auto' } };
      const withChallenger = (wins, losses, overrides = {}) => summary({
        level: 'auto',
        pairs: [
          ...summary().pairs,
          {
            pair: 'github-copilot/model-c@medium',
            wins,
            losses,
            runs: wins + losses,
            credits: null,
            model_credits: null,
            bills: 0,
            tokens: null,
            streak: wins === 0 ? losses : 0,
            tests: 1,
            suspended: null,
          },
        ],
        ...overrides,
      });
      const classifiedAs = mode => ({
        executeResult: () => ({
          statusCode: 200,
          body: classifierBody(JSON.stringify({ ...VALID_CLASSIFICATION, mode })),
        }),
      });
      const degradedClassifier = () => ({
        executeResult: () => ({ statusCode: 200, body: classifierBody('not json') }),
      });

      it.each([
        // With 10 wins / 1 loss (expected rate ~0.906, hopeful rate ~0.977):
        // - economy (100): C's expected score (~23.6) beats B's hopeful score (~28.1) -> switch incumbent to C.
        // - balanced (500): C's hopeful score (~24.1) beats B's hopeful score (~28.5) -> test C.
        // - robust (2500): C's hopeful score (~71.3) loses to B's hopeful score (~30.5) -> serve B.
        ['economy', 'serve', 'github-copilot/model-c@medium', 'incumbent_switched', 'github-copilot/model-c@medium'],
        ['balanced', 'test', 'github-copilot/model-c@medium', 'challenger_hopeful_clears_need', 'github-copilot/model-b@high'],
        ['robust', 'serve', 'github-copilot/model-b@high', 'no_challenger', 'github-copilot/model-b@high'],
      ])(
        'resolves level "auto" to classification.mode "%s" (%s -> %s)',
        async (classifiedMode, expectedRole, expectedPair, expectedReason, expectedIncumbentAfter) => {
          const inputSummary = Object.freeze(withChallenger(10, 1));
          const { controller, writeAdaptiveReceipt } = run(inputSummary, {
            config: autoConfig,
            ...classifiedAs(classifiedMode),
          });
          const result = await controller.run();
          expect(result.ok).toBe(true);
          expect(inputSummary.level).toBe('auto');
          expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
          expect(result.adaptiveReceipt).toMatchObject({
            generation: '9f2c41d0',
            mode: 'live',
            scope: 'copilot/cost/shared',
            role: expectedRole,
            selected: expectedPair,
            ordinary: 'github-copilot/model-a@low',
            would: null,
            incumbent: { before: 'github-copilot/model-b@high', after: expectedIncumbentAfter },
            reason: expectedReason,
          });
        },
      );

      it.each([
        ['degraded (null)', degradedClassifier, true],
        ['unknown', () => classifiedAs('unknown'), false],
      ])(
        'falls back to "balanced" when objective.mode is "auto" and classification is %s',
        async (_label, classifierOverrides, expectDegraded) => {
          // On 10W/1L, only balanced (500) tests C; economy switches incumbent and robust serves B.
          const { controller, writeAdaptiveReceipt } = run(withChallenger(10, 1), {
            config: autoConfig,
            ...classifierOverrides(),
          });
          const result = await controller.run();
          expect(result.ok).toBe(true);
          expect(result.degradedClassification).toBe(expectDegraded);
          expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
          expect(result.adaptiveReceipt).toMatchObject({
            generation: '9f2c41d0',
            mode: 'live',
            scope: 'copilot/cost/shared',
            role: 'test',
            selected: 'github-copilot/model-c@medium',
            ordinary: 'github-copilot/model-a@low',
            would: null,
            incumbent: { before: 'github-copilot/model-b@high', after: 'github-copilot/model-b@high' },
            reason: 'challenger_hopeful_clears_need',
          });
        },
      );

      it.each(['economy', 'balanced', 'robust'])(
        'rejects level "auto" as invalid_evidence when objective.mode is fixed (%s)',
        async fixedMode => {
          const { controller, writeAdaptiveReceipt } = run(summary({ level: 'auto' }), {
            config: { objective: { goal: 'cost', mode: fixedMode } },
            ...classifiedAs(fixedMode),
          });
          const result = await controller.run();
          expect(result.ok).toBe(true);
          expect(result.selection.choice).toEqual(rankFixture.fullRank[0]);
          expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
          expect(result.adaptiveReceipt).toMatchObject({
            generation: null,
            mode: null,
            scope: null,
            role: 'ordinary',
            explore_allowed: false,
            selected: 'github-copilot/model-a@low',
            ordinary: 'github-copilot/model-a@low',
            would: null,
            incumbent: null,
            costs: {},
            concurrency: null,
            reason: 'invalid_evidence',
          });
        },
      );

      it('writes a router_fallback receipt rather than invalid_evidence for level "auto" when routing falls back', async () => {
        const { controller, writeAdaptiveReceipt } = run(summary({ level: 'auto' }), {
          config: autoConfig,
          planner: { route: async () => { throw { statusCode: 422, body: { code: 'no_route' } }; } },
        });
        const result = await controller.run();
        expect(result.ok).toBe(true);
        expect(result.selection.selection_source).toBe('fallback');
        expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
        expect(result.adaptiveReceipt).toMatchObject({
          generation: '9f2c41d0',
          mode: 'live',
          scope: 'copilot/cost/shared',
          role: 'ordinary',
          explore_allowed: true,
          incumbent: { before: 'github-copilot/model-b@high', after: 'github-copilot/model-b@high' },
          concurrency: { turn: true, in_flight: 0, capacity: null },
          reason: 'router_fallback',
        });
      });

      it('enforces the 16 KiB limit against the staged summary rather than the resolved level string length', async () => {
        const sizedAutoSummary = targetBytes => {
          const base = summary({ level: 'auto', generation: '' });
          const pad = targetBytes - Buffer.byteLength(JSON.stringify(base), 'utf8');
          expect(pad).toBeGreaterThanOrEqual(0);
          const sized = { ...base, generation: 'g'.repeat(pad) };
          expect(Buffer.byteLength(JSON.stringify(sized), 'utf8')).toBe(targetBytes);
          return sized;
        };

        // 16,384 bytes staged stays valid even when "auto" (4B) resolves to "balanced" (8B).
        const atLimit = sizedAutoSummary(MAX_SUMMARY_BYTES);
        for (const classifierOverrides of [classifiedAs('balanced'), degradedClassifier()]) {
          const { controller, writeAdaptiveReceipt } = run(atLimit, {
            config: autoConfig,
            ...classifierOverrides,
          });
          const result = await controller.run();
          expect(result.ok).toBe(true);
          expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
          expect(result.adaptiveReceipt).toMatchObject({
            role: 'test',
            selected: 'github-copilot/model-c@medium',
            reason: 'challenger_hopeful_clears_need',
          });
        }

        // 16,385 bytes staged is rejected regardless of resolved level.
        const overLimit = sizedAutoSummary(MAX_SUMMARY_BYTES + 1);
        const { controller, writeAdaptiveReceipt } = run(overLimit, {
          config: autoConfig,
          ...classifiedAs('robust'),
        });
        const overResult = await controller.run();
        expect(overResult.ok).toBe(true);
        expect(writeAdaptiveReceipt).toHaveBeenCalledTimes(1);
        expect(overResult.adaptiveReceipt).toMatchObject({
          generation: null,
          mode: null,
          scope: null,
          role: 'ordinary',
          selected: 'github-copilot/model-a@low',
          reason: 'invalid_evidence',
        });
      });
    });
  });

  describe('two offered IDs for the same model and effort', () => {
    const models = ['model-b', 'github-copilot/model-b'].map(id =>
      ({ id, efforts: ['high'], protocols: ['responses'], contextWindow: 128_000 }));
    const routeResponse = req => ({
      ranked_choices: req.models.map(({ id, model, effort }) => ({ id, model, effort })).reverse(),
    });

    it('keeps the first ID and wire mapping without topK', async () => {
      const { controller, calls, records } = createHarness({ models, routeResponse });
      const result = await controller.run();
      const pair = { model: 'github-copilot/model-b', effort: 'high' };
      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty('routeOptions');
      expect(result.selection).toMatchObject({
        choice: { id: 'choice-0002', ...pair }, wire_model: 'github-copilot/model-b',
      });
      expect(records[1].ranked_choices).toEqual([pair, pair]);
      expect(calls.classify).toHaveLength(1);
      expect(calls.execute).toHaveLength(1);
      expect(calls.route).toHaveLength(1);
      expect(calls.checkBeforePrimary.map(call => call.selection)).toEqual([result.selection]);
    });

    it('falls back without routeOptions when topK rejects duplicate pairs from the router', async () => {
      const { controller } = createHarness({ models, routeResponse, config: { topK: 1 } });
      const result = await controller.run();
      expect(result).toMatchObject({
        ok: true,
        selection: {
          selection_source: 'fallback',
          fallback_reason: 'routing_contract_error',
          fallback_tier: 'unclassified',
        },
      });
      expect(result).not.toHaveProperty('routeOptions');
    });

    it('routes an adaptive run as ordinary routing would, with its receipt, rather than rejecting the pair', async () => {
      const writeAdaptiveReceipt = jest.fn();
      const job = { workflow: 'pr-sous-chef', run_id: '45000000812', attempt: 1 };
      const { controller } = createHarness({
        models, routeResponse,
        dependencies: { adaptive: { job, summary: null }, priceRoute: () => null, writeAdaptiveReceipt },
      });
      const result = await controller.run();
      expect(result.ok).toBe(true);
      expect(result.selection.choice).toMatchObject({ id: 'choice-0002' });
      expect(writeAdaptiveReceipt.mock.calls[0][0]).toMatchObject({ role: 'ordinary', reason: 'summary_missing' });
    });
  });

  it('shortlists topK from the winning router choice when an earlier choice fails a non-cap guard', async () => {
    const { controller } = replayRank({
      config: { topK: 1 },
      checkBeforePrimary: ({ selection }) => {
        if (selection.wire_model === 'model-a') {
          throw createRoutingError('pricing_resolution_error', 'unpriced');
        }
      },
    });
    const result = await controller.run();
    expect(result.ok).toBe(true);
    expect(result.selection).toMatchObject({
      wire_model: 'model-b',
      selection_source: 'router',
    });
    expect(result.routeOptions).toEqual({
      ordinaryPick: { model: 'github-copilot/model-b', effort: 'high' },
      options: [{ model: 'github-copilot/model-b', effort: 'high' }],
    });
  });

  it('fails when every candidate is vetoed by guards and stops immediately on run-wide guards', async () => {
    const { controller, calls, records } = replayRank({
      config: { topK: 3 },
      checkBeforePrimary: () => { throw createRoutingError('ai_credits_limit_exceeded', 'Budget exhausted'); },
    });
    await expect(controller.run()).resolves.toMatchObject({ ok: false, failure: { code: 'ai_credits_limit_exceeded' } });
    expect(calls.checkBeforePrimary).toHaveLength(1);
    expect(calls.checkBeforePrimary[0].selection.choice).toMatchObject(rankFixture.ordinaryPick);
    expect(records.map(r => r.stage)).toEqual(['classification', 'failure']);
  });

  it('pins trusted eligibility before discovery and shares it with classifier retries and the final preflight', async () => {
    const { proxyEligibilityStore, evaluateModelEligibility } = require('./model-eligibility');
    const { resolveModelIdentity } = require('./model-identity');
    const scope = { provider: 'copilot', channel: 'copilot-api' };
    const eligibilityStore = { pin: jest.fn(() => proxyEligibilityStore.pin()) };
    proxyEligibilityStore.replaceTrustedEvidence({
      models: [{
        identity: resolveModelIdentity('blocked-test', 'copilot').identity,
        harnesses: [{
          name: 'copilot', scheme: 'semver', minimum: '1.2.0', scope,
          reason: 'Fixture requires a compatible routing harness',
          provenance: { authority: 'maintained', source: 'fixture' },
        }],
      }],
    });
    const models = ['blocked-test', 'gpt-test', 'gpt-next'].map(id => ({
      id, efforts: ['low'], protocols: ['responses'], contextWindow: 128_000,
    }));
    const { controller, calls } = createHarness({
      models,
      dependencies: { eligibilityStore, eligibilityScope: scope, catalogue: { getSnapshot: async () => {
        proxyEligibilityStore.replaceTrustedEvidence({});
        return snapshot(models);
      } } },
      executeResult: attempt => attempt === 1 ? { statusCode: 503 } : {
        statusCode: 200, body: classifierBody(JSON.stringify(VALID_CLASSIFICATION)),
      },
    });
    try {
      expect((await controller.run()).ok).toBe(true);
      await controller.run();
      expect(eligibilityStore.pin).toHaveBeenCalledTimes(1);
      expect(calls.classify[0].models.map(model => model.model)).not.toContain('github-copilot/blocked-test');
      expect(calls.execute).toHaveLength(2);
      const pin = calls.execute[0].awfEligibility;
      expect(calls.execute[1].awfEligibility).toBe(pin);
      expect(calls.checkBeforePrimary[0].awfEligibility).toBe(pin);
      expect(calls.execute[0].awfEligibilityScope).toEqual(scope);
      expect(Object.isFrozen(calls.execute[0].awfEligibilityScope)).toBe(true);
      expect(calls.execute[1].awfEligibilityScope).toBe(calls.execute[0].awfEligibilityScope);
      expect(calls.checkBeforePrimary[0].awfEligibilityScope).toBe(calls.execute[0].awfEligibilityScope);
      expect(evaluateModelEligibility('blocked-test', 'copilot', { awfEligibility: pin }).admitted).toBe(false);
      expect(evaluateModelEligibility('blocked-test', 'copilot', {}).admitted).toBe(true);
    } finally {
      proxyEligibilityStore.replaceTrustedEvidence({});
    }
  });

  it('exposes its bounded constants', () => {
    expect(ROUTING_BOOTSTRAP_TIMEOUT_MS).toBe(90_000);
    expect(CLASSIFIER_ATTEMPT_TIMEOUT_MS).toBe(30_000);
    expect(CLASSIFIER_MAX_ATTEMPTS).toBe(2);
    expect(PURPOSE).toBe('routing_classification');
  });

  it('produces exactly one immutable selection with the contracted planning bodies', async () => {
    const { controller, calls, records } = createHarness({
      catalogueModels: [{ model: 'github-copilot/gpt-test', efforts: ['low'] }],
    });
    const result = await controller.run();

    expect(result.ok).toBe(true);
    expect(result.selection).toEqual({
      schema: 'awf-routing-selection/v1',
      engine: 'copilot',
      provider: 'copilot',
      choice: { id: 'choice-0001', model: 'github-copilot/gpt-test', effort: 'low' },
      wire_model: 'gpt-test',
      endpoint: '/responses',
      selection_source: 'router',
      fallback_reason: null,
      fallback_tier: null,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.selection)).toBe(true);
    expect(Object.isFrozen(result.selection.choice)).toBe(true);
    expect(result.degradedClassification).toBe(false);
    expect(result.degradedReason).toBeUndefined();

    expect(Object.keys(calls.classify[0]).sort()).toEqual(['conversation', 'models']);
    expect(calls.classify[0].conversation).toEqual(CONVERSATION);
    expect(Object.keys(calls.route[0]).sort()).toEqual(['classification', 'conversation', 'models', 'objective']);
    expect(calls.route[0].objective).toEqual({ goal: 'cost', mode: 'balanced' });
    expect(calls.route[0].classification).toEqual(VALID_CLASSIFICATION);
    expect(calls.route[0].conversation).toEqual(calls.classify[0].conversation);
    expect(calls.route[0].models[0].context_window).toBe(128_000);

    expect(calls.execute[0].purpose).toBe(PURPOSE);
    expect(calls.checkBeforePrimary[0].selection).toBe(result.selection);

    const selectionRecord = records.find(record => record.stage === 'selection');
    expect(selectionRecord).toMatchObject({
      objective: { goal: 'cost', mode: 'balanced' },
      provider: 'copilot',
      selected_provider: 'copilot',
      wire_model: 'gpt-test',
      endpoint: '/responses',
      labels: VALID_CLASSIFICATION.labels,
      mode: VALID_CLASSIFICATION.mode,
      classifier_model: 'github-copilot/gpt-test',
      classifier_effort: 'low',
      router: { name: 'gh-aw-router', version: '1.0.0' },
      ranked_choices: [{ model: 'github-copilot/gpt-test', effort: 'low' }],
      selected_id: 'choice-0001',
      selected_model: 'github-copilot/gpt-test',
      selected_effort: 'low',
      degraded_classification: false,
      degraded_reason: null,
      classifier_attempts: 1,
      eligible_choices: 1,
      catalogue_overlap: 1,
    });
    expect(typeof selectionRecord.latency_ms).toBe('number');
    expect(selectionRecord.conversation_sha256).toBe(
      require('crypto').createHash('sha256').update(JSON.stringify(CONVERSATION)).digest('hex'),
    );
    expect(JSON.stringify(records)).not.toContain('add a test');
    expect(JSON.stringify(records)).not.toContain('classify the task');
  });

  it('routes Anthropic candidates through Messages without changing the selected provider', async () => {
    const { controller, calls } = createHarness({
      provider: 'anthropic',
      models: [{
        id: 'claude-opus-5-5',
        efforts: ['medium'],
        protocols: ['messages'],
        contextWindow: 1_000_000,
      }],
    });

    const result = await controller.run();
    expect(result.selection.provider).toBe('anthropic');
    expect(result.selection.choice.model).toBe('anthropic/claude-opus-5-5');
    expect(calls.execute[0]).toMatchObject({
      path: '/v1/messages',
      provider: 'anthropic',
      body: { output_config: { effort: 'medium' } },
    });
  });

  it('routes Copilot Claude reasoning candidates through Chat Completions', async () => {
    const { controller, calls } = createHarness({
      models: [{
        id: 'claude-sonnet-5',
        efforts: ['max'],
        protocols: ['messages', 'chat-completions'],
        contextWindow: 1_000_000,
      }],
    });
    const result = await controller.run();
    expect(result.selection).toMatchObject({
      provider: 'copilot',
      choice: { model: 'github-copilot/claude-sonnet-5', effort: 'max' },
      endpoint: '/chat/completions',
    });
    expect(calls.execute[0]).toMatchObject({
      path: '/chat/completions',
      body: { reasoning_effort: 'max' },
    });
  });

  it('adds the Chat Completions endpoint to an effortless selection', async () => {
    const { controller } = createHarness({
      models: [{
        id: 'claude-haiku-4.5',
        efforts: [],
        protocols: ['chat-completions'],
        contextWindow: 200_000,
      }],
    });
    const result = await controller.run();
    expect(result.selection.endpoint).toBe('/chat/completions');
  });

  it('records a classified selection when the classifier reply is fenced', async () => {
    const classification = {
      labels: { task_type: 'analyze', scope: 'local', task_complexity: 'unknown' },
      mode: 'economy',
    };
    const { controller, calls, records } = createHarness({
      models: [{
        id: 'claude-haiku-4.5',
        efforts: [],
        protocols: ['chat-completions'],
        contextWindow: 200_000,
      }],
      executeResult: () => ({
        statusCode: 200,
        body: Buffer.from(JSON.stringify({
          choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(classification)}\n\`\`\`` } }],
        })),
      }),
    });
    const result = await controller.run();

    expect(result.ok).toBe(true);
    expect(result.degradedClassification).toBe(false);
    expect(result.degradedReason).toBeUndefined();
    expect(calls.route[0].classification).toEqual(classification);
    expect(calls.execute).toHaveLength(1);
    expect(records.find(record => record.stage === 'selection')).toMatchObject({
      degraded_classification: false,
      degraded_reason: null,
      classifier_attempts: 1,
      labels: classification.labels,
      mode: classification.mode,
      classifier_model: 'github-copilot/claude-haiku-4.5',
    });
  });

  it('keeps invalid_classifier_output for a fenced reply that is otherwise invalid', async () => {
    const { controller, calls, records } = createHarness({
      executeResult: () => ({
        statusCode: 200,
        body: classifierBody(`\`\`\`json\n${JSON.stringify(VALID_CLASSIFICATION)}\n\`\`\`\nDone.`),
      }),
    });
    const result = await controller.run();

    expect(result.ok).toBe(true);
    expect(result.degradedReason).toBe('invalid_classifier_output');
    expect(Object.hasOwn(calls.route[0], 'classification')).toBe(false);
    expect(records.find(record => record.stage === 'selection')).toMatchObject({
      degraded_classification: true,
      degraded_reason: 'invalid_classifier_output',
      classifier_attempts: 1,
      labels: null,
      mode: null,
      classifier_model: null,
    });
  });

  it('runs the decision at most once', async () => {
    const { controller, planner } = createHarness();
    const first = controller.run();
    const second = controller.run();
    expect(first).toBe(second);
    await first;
    expect(planner.route).toHaveBeenCalledTimes(1);
  });

  it('records the successful retry classifier and the full ordered routing ranking', async () => {
    const { controller, records } = createHarness({
      models: [
        { id: 'a-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
        { id: 'b-test', efforts: ['high'], protocols: ['responses'], contextWindow: 128_000 },
      ],
      executeResult: attempt => attempt === 1
        ? { statusCode: 503, body: Buffer.from('{}') }
        : { statusCode: 200, body: classifierBody(JSON.stringify(VALID_CLASSIFICATION)) },
      planner: {
        route: jest.fn(async request => ({
          ranked_choices: request.models.slice().reverse().map(({ id, model, effort }) => ({ id, model, effort })),
        })),
      },
    });
    const result = await controller.run();
    expect(result.ok).toBe(true);
    expect(records.find(record => record.stage === 'selection')).toMatchObject({
      classifier_attempts: 2,
      classifier_model: 'github-copilot/b-test',
      classifier_effort: 'high',
      ranked_choices: [
        { model: 'github-copilot/b-test', effort: 'high' },
        { model: 'github-copilot/a-test', effort: 'low' },
      ],
    });
  });

  it.each(['success', 'degraded', 'failure', 'unwritable'])('handles real controller %s logs without task or classifier text', async scenario => {
    const fs = require('fs');
    const path = require('path');
    const { createRoutingObserver } = require('./routing-runtime');
    const directory = fs.mkdtempSync(path.join(require('os').tmpdir(), 'awf-routing-controller-log-'));
    const saved = process.env.AWF_TOKEN_LOG_DIR;
    process.env.AWF_TOKEN_LOG_DIR = directory;
    try {
      if (scenario === 'unwritable') {
        process.env.AWF_TOKEN_LOG_DIR = path.join(directory, 'not-a-directory');
        fs.writeFileSync(process.env.AWF_TOKEN_LOG_DIR, '');
      }
      const { controller } = createHarness({
        ...(scenario === 'degraded' ? {
          executeResult: () => ({ statusCode: 200, body: classifierBody('private invalid output') }),
        } : {}),
        ...(scenario === 'failure' ? {
          checkBeforePrimary: () => { throw createRoutingError('ai_credits_limit_exceeded', 'Budget exhausted'); },
        } : {}),
        dependencies: { observer: createRoutingObserver(jest.fn()) },
      });
      const result = await controller.run();
      if (scenario === 'unwritable') {
        expect(result.ok).toBe(true);
        expect(result.selection.wire_model).toBe('gpt-test');
        return;
      }
      const text = fs.readFileSync(path.join(directory, 'model-routing.jsonl'), 'utf8');
      const records = text.trim().split('\n').map(line => JSON.parse(line));
      expect(records[0]).toMatchObject({ stage: 'classification', attempt: 1 });
      if (scenario === 'failure') {
        expect(result.ok).toBe(false);
        expect(records.at(-1)).toMatchObject({ stage: 'failure', code: 'ai_credits_limit_exceeded' });
      } else {
        expect(result.ok).toBe(true);
        expect(records.at(-1)).toMatchObject({
          stage: 'selection', selected_model: result.selection.choice.model,
          degraded_classification: scenario === 'degraded',
        });
      }
      for (const privateText of ['add a test', 'classify the task', 'private invalid output']) {
        expect(text).not.toContain(privateText);
      }
    } finally {
      if (saved === undefined) delete process.env.AWF_TOKEN_LOG_DIR;
      else process.env.AWF_TOKEN_LOG_DIR = saved;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('omits classification and records degradation for an invalid classifier answer without retrying', async () => {
    const { controller, calls, records } = createHarness({
      models: [
        { id: 'a-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
        { id: 'b-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
      ],
      executeResult: () => ({ statusCode: 200, body: classifierBody('not json') }),
    });
    const result = await controller.run();

    expect(result.ok).toBe(true);
    expect(calls.execute).toHaveLength(1);
    expect(Object.hasOwn(calls.route[0], 'classification')).toBe(false);
    expect(result.degradedClassification).toBe(true);
    expect(result.degradedReason).toBe('invalid_classifier_output');
    expect(records.find(record => record.stage === 'selection')).toMatchObject({
      labels: null,
      mode: null,
      classifier_model: null,
      classifier_effort: null,
      degraded_classification: true,
      degraded_reason: 'invalid_classifier_output',
      classifier_attempts: 1,
    });
  });

  it('gives the route call the objective, classification flag and validated selection for tracing', async () => {
    const { controller, planner, calls } = createHarness({
      models: [
        { id: 'a-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
        { id: 'b-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
      ],
    });
    await expect(controller.run()).resolves.toMatchObject({ ok: true });

    const { trace } = planner.route.mock.calls[0][1];
    expect(Object.isFrozen(trace)).toBe(true);
    expect(trace.attributes).toEqual({
      'gh_aw_router.goal': 'cost',
      'gh_aw_router.mode': 'balanced',
      'gh_aw_router.classification.present': true,
    });
    const offered = calls.route[0].models;
    expect(trace.describeResult({
      ranked_choices: [{ id: offered[1].id, model: offered[1].model, effort: offered[1].effort }],
    })).toEqual({
      'gh_aw_router.selected.model': 'github-copilot/b-test',
      'gh_aw_router.selected.effort': 'low',
    });
    expect(() => trace.describeResult({
      ranked_choices: [{ id: offered[0].id, model: 'github-copilot/not-offered', effort: 'low' }],
    })).toThrow(expect.objectContaining({ code: 'routing_contract_error' }));
    expect(() => trace.describeResult({ ranked_choices: [] })).toThrow();
  });

  it('marks a route call without classification for tracing', async () => {
    const { controller, planner } = createHarness({
      executeResult: () => ({ statusCode: 200, body: classifierBody('not json') }),
    });
    await expect(controller.run()).resolves.toMatchObject({ ok: true });
    expect(planner.route.mock.calls[0][1].trace.attributes['gh_aw_router.classification.present']).toBe(false);
    expect(planner.classify.mock.calls[0][1]).not.toHaveProperty('trace');
  });

  it('spends no classifier attempt on a capacity exclusion', async () => {
    const { controller, calls, records } = createHarness({
      models: [{ id: 'tiny-test', efforts: ['low'], protocols: ['responses'], contextWindow: 8 }],
    });
    const result = await controller.run();

    expect(result.ok).toBe(true);
    expect(calls.execute).toHaveLength(0);
    expect(result.degradedReason).toBe('classifier_capacity_exhausted');
    expect(records.find(record => record.stage === 'selection')).toMatchObject({
      classifier_attempts: 0,
      degraded_reason: 'classifier_capacity_exhausted',
    });
  });

  it('skips classification when context capacity is missing but retains the model for final routing', async () => {
    const { controller, calls, records } = createHarness({
      models: [{ id: 'unknown-capacity', efforts: ['low'], protocols: ['responses'] }],
    });
    const result = await controller.run();

    expect(result.ok).toBe(true);
    expect(calls.execute).toHaveLength(0);
    expect(calls.route[0].models).toEqual([
      expect.objectContaining({ model: 'github-copilot/unknown-capacity' }),
    ]);
    expect(result.degradedReason).toBe('classifier_capacity_exhausted');
    expect(records.find(record => record.stage === 'selection')).toMatchObject({
      classifier_attempts: 0,
      degraded_reason: 'classifier_capacity_exhausted',
    });
  });

  it('makes at most two classifier calls when the provider is unavailable', async () => {
    const { controller, calls, records } = createHarness({
      models: [
        { id: 'a-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
        { id: 'b-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
        { id: 'c-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
      ],
      executeResult: () => ({ statusCode: 503, body: Buffer.from('{}') }),
    });
    const result = await controller.run();

    expect(result.ok).toBe(true);
    expect(calls.execute).toHaveLength(CLASSIFIER_MAX_ATTEMPTS);
    expect(result.degradedReason).toBe('classifier_attempts_exhausted');
    expect(records.filter(record => record.stage === 'classification')).toHaveLength(2);
  });

  it('stops the decision on a run-wide terminal provider failure', async () => {
    const { controller, calls } = createHarness({
      models: [
        { id: 'a-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
        { id: 'b-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
      ],
      executeResult: () => ({
        statusCode: 403,
        body: Buffer.from('{}'),
        terminal: { code: 'ai_credits_limit_exceeded', detail: 'budget exhausted' },
      }),
    });
    const result = await controller.run();

    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      schema: 'awf-routing-failure/v1',
      code: 'ai_credits_limit_exceeded',
      detail: 'budget exhausted',
      retryable: false,
    });
    expect(calls.execute).toHaveLength(1);
    expect(calls.route).toHaveLength(0);
  });

  it('falls back after one planner attempt when the router name cannot be resolved', async () => {
    let attempts = 0;
    const { controller, records } = createHarness({
      planner: {
        health: jest.fn(async () => {
          attempts++;
          throw Object.assign(new Error('getaddrinfo ENOTFOUND awf-router'), { code: 'ENOTFOUND' });
        }),
      },
    });
    const result = await controller.run();

    expect(attempts).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.selection).toMatchObject({
      wire_model: 'gpt-test',
      selection_source: 'fallback',
      fallback_reason: 'routing_configuration_error',
      fallback_tier: 'unclassified',
    });
    expect(records.find(record => record.stage === 'selection')).toMatchObject({
      selection_source: 'fallback',
      fallback_reason: 'routing_configuration_error',
      fallback_tier: 'unclassified',
      router: null,
      ranked_choices: null,
    });
  });

  it('falls back when the router returns 422 no_route for an eligible pool', async () => {
    const { controller, records } = createHarness({
      planner: {
        route: jest.fn(async () => {
          throw Object.assign(new Error('no route'), { statusCode: 422, body: { code: 'no_route' } });
        }),
      },
    });
    const result = await controller.run();

    expect(result.ok).toBe(true);
    expect(result.selection).toMatchObject({
      wire_model: 'gpt-test',
      selection_source: 'fallback',
      fallback_reason: 'no_route',
      fallback_tier: 'unclassified',
    });
    expect(Object.isFrozen(result.selection)).toBe(true);
    expect(records.find(record => record.stage === 'selection')).toMatchObject({
      selection_source: 'fallback',
      fallback_reason: 'no_route',
      ranked_choices: null,
    });
  });

  it('falls back on an invalid router health response and still rejects a missing dependency', async () => {
    const unhealthy = createHarness({ planner: { health: jest.fn(async () => 200) } });
    await expect(unhealthy.controller.run()).resolves.toMatchObject({
      ok: true,
      selection: {
        selection_source: 'fallback',
        fallback_reason: 'routing_contract_error',
      },
    });

    const incomplete = createHarness({ dependencies: { executor: { execute: () => {} } } });
    await expect(incomplete.controller.run()).resolves.toMatchObject({
      ok: false,
      failure: { code: 'routing_configuration_error' },
    });
  });

  it('rejects a conversation which does not meet the router contract', async () => {
    const { controller, calls } = createHarness({ loadConversation: async () => [] });
    const result = await controller.run();
    expect(result.ok).toBe(false);
    expect(result.failure.code).toBe('routing_contract_error');
    expect(calls.classify).toHaveLength(0);
  });
});
