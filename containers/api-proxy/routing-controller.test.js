'use strict';

const {
  CLASSIFIER_ATTEMPT_TIMEOUT_MS,
  CLASSIFIER_MAX_ATTEMPTS,
  PURPOSE,
  ROUTING_BOOTSTRAP_TIMEOUT_MS,
  createRoutingController,
} = require('./routing-controller');

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

describe('routing controller', () => {
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
    expect(calls.route[0].conversation).toBe(calls.classify[0].conversation);
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

  it('routes Copilot Claude reasoning candidates through Messages', async () => {
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
      endpoint: '/v1/messages',
    });
    expect(calls.execute[0]).toMatchObject({
      path: '/v1/messages',
      body: { output_config: { effort: 'max' } },
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
          planner: { route: jest.fn(async () => { throw { statusCode: 422, body: { code: 'no_route' } }; }) },
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
        expect(records.at(-1)).toMatchObject({ stage: 'failure', code: 'no_route' });
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

  it('stops the decision on a terminal provider failure', async () => {
    const { controller, calls } = createHarness({
      models: [
        { id: 'a-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
        { id: 'b-test', efforts: ['low'], protocols: ['responses'], contextWindow: 128_000 },
      ],
      executeResult: () => ({
        statusCode: 403,
        body: Buffer.from('{}'),
        terminal: { code: 'model_policy_violation', detail: 'blocked' },
      }),
    });
    const result = await controller.run();

    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      schema: 'awf-routing-failure/v1',
      code: 'model_policy_violation',
      detail: 'blocked',
      retryable: false,
    });
    expect(calls.execute).toHaveLength(1);
    expect(calls.route).toHaveLength(0);
  });

  it('reports an unresolvable router name as a configuration error after one planner attempt', async () => {
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
    expect(result.ok).toBe(false);
    expect(result.failure.code).toBe('routing_configuration_error');
    expect(records.find(record => record.stage === 'failure')).toMatchObject({
      code: 'routing_configuration_error',
    });
  });

  it('maps an unservable pool to a sanitized no_route failure', async () => {
    const { controller } = createHarness({
      planner: {
        route: jest.fn(async () => {
          throw Object.assign(new Error('no route'), { statusCode: 422, body: { code: 'no_route' } });
        }),
      },
    });
    const result = await controller.run();

    expect(result.ok).toBe(false);
    expect(result.failure.code).toBe('no_route');
    expect(Object.isFrozen(result.failure)).toBe(true);
  });

  it('rejects an invalid router health response and a missing dependency', async () => {
    const unhealthy = createHarness({ planner: { health: jest.fn(async () => 200) } });
    await expect(unhealthy.controller.run()).resolves.toMatchObject({
      ok: false,
      failure: { code: 'routing_contract_error' },
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
