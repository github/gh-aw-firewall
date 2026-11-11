const { createBodyHandler } = require('./body-handler');
const { APPLY_PATCH_FUNCTION_TOOL, CodexCompatibilityError } = require('./codex-compat');
const {
  applyAiCreditsUsage,
  getPendingAiCreditSteeringWarning,
  resetAiCreditsGuardForTests,
} = require('./guards/ai-credits-guard');
const {
  resetTimeoutSteeringForTests,
} = require('./guards/timeout-steering');
const { replaceRuntimeModels, clearRuntimeModels } = require('./runtime-model-catalog');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { transformRequestBody } = createBodyHandler({ handleRequestError() {}, otel: {} });

function json(buffer) {
  return JSON.parse(buffer.toString('utf8'));
}

describe('transformRequestBody Codex custom-tool translation routing', () => {
  test.each(['/chat/completions', '/v1/chat/completions', '/chat/completions/?x=1'])(
    'passes Chat Completions custom tools through unchanged on %s',
    async (url) => {
      const tools = [{ type: 'custom', custom: { name: 'bash' } }];
      const body = Buffer.from(JSON.stringify({ tools }));

      const result = await transformRequestBody(body, 'copilot', { method: 'POST', url }, 'req-1', null);

      expect(result.codexCompatibility).toBeNull();
      expect(json(result.body).tools).toEqual(tools);
    },
  );

  test('still translates Responses apply_patch custom tools', async () => {
    const body = Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }],
      input: 'edit a file',
    }));

    const req = { method: 'POST', url: '/responses' };
    const result = await transformRequestBody(body, 'copilot', req, 'req-2', null);

    expect(result.codexCompatibility.customTools.has('apply_patch')).toBe(true);
    expect(json(result.body).tools).toEqual([APPLY_PATCH_FUNCTION_TOOL]);
    expect(json(req.awfFallbackSourceBody).tools).toEqual([APPLY_PATCH_FUNCTION_TOOL]);
  });

  test('fallback source retains pre-wire semantic fields without changing primary translation', async () => {
    replaceRuntimeModels('copilot', [{ id: 'response-only', supportedEndpoints: ['/responses'] }]);
    try {
      const req = { method: 'POST', url: '/chat/completions' };
      const body = Buffer.from(JSON.stringify({ model: 'response-only', messages: [
        { role: 'developer', content: 'priority instruction' }, { role: 'user', content: 'hello' },
      ] }));
      const result = await transformRequestBody(body, 'copilot', req, 'primary-wire', null);
      expect(json(result.body).instructions).toBe('priority instruction');
      expect(json(req.awfFallbackSourceBody).messages[0].role).toBe('developer');
      expect(req.awfFallbackSourceBody).not.toBe(body);
      expect(require('./protocol-compatibility/assessment').assessRequestCompatibility({
        body: req.awfFallbackSourceBody, source: 'chat_completions', target: 'responses',
      }).status).toBe('incompatible');
    } finally { clearRuntimeModels(); }
  });

  test('a marked resolver fallback cannot dispatch a role-collapsing primary wire translation', async () => {
    replaceRuntimeModels('copilot', [{ id: 'response-only', supportedEndpoints: ['/responses'] }]);
    try {
      const observe = jest.fn();
      const req = { method: 'POST', url: '/chat/completions',
        awfResolverFallback: { provider: 'copilot', fromModel: 'missing-model', model: 'response-only' },
        awfObserveModelDecision: observe };
      const body = Buffer.from(JSON.stringify({ model: 'response-only', messages: [
        { role: 'developer', content: 'priority instruction' }, { role: 'user', content: 'hello' },
      ] }));
      await expect(transformRequestBody(body, 'copilot', req, 'automatic-wire', null))
        .rejects.toMatchObject({ statusCode: 400, code: 'model_recovery_exhausted' });
      expect(observe.mock.calls.map(([record]) => record.outcome)).toEqual(['skipped', 'exhausted']);
      expect(observe.mock.calls[0][0].compatibility.reasons)
        .toContainEqual({ feature: 'message_roles', code: 'role_priority_loss' });
      expect(observe.mock.calls[1][0].model).toBeNull();
    } finally { clearRuntimeModels(); }
  });

  test('a marked resolver fallback still accepts established Codex normalization and native passthrough', async () => {
    const observe = jest.fn();
    const req = { method: 'POST', url: '/responses',
      awfResolverFallback: { provider: 'copilot', fromModel: 'missing-model', model: 'native-model' },
      awfObserveModelDecision: observe };
    const body = Buffer.from(JSON.stringify({ model: 'native-model', input: 'edit a file',
      tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }] }));
    const result = await transformRequestBody(body, 'copilot', req, 'automatic-native', null);
    expect(json(result.body).tools).toEqual([APPLY_PATCH_FUNCTION_TOOL]);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'accepted',
      compatibility: expect.objectContaining({ status: 'compatible', contracts: [] }) }));
  });

  test('marked initial fallback skips incompatible ranked candidates before wire translation', async () => {
    let calls;
    await jest.isolateModulesAsync(async () => {
      const wire = require('./wire-api-compat');
      calls = jest.spyOn(wire, 'translateCopilotWireApi');
      const runtime = require('./runtime-model-catalog');
      runtime.replaceRuntimeModels('copilot', [
        { id: 'response-only', supportedEndpoints: ['/responses'] },
        { id: 'native-chat', supportedEndpoints: ['/chat/completions'] },
      ]);
      const observe = jest.fn();
      const req = { method: 'POST', url: '/chat/completions',
        awfResolverFallback: { provider: 'copilot', fromModel: 'missing', model: 'response-only' },
        awfModelCandidates: ['response-only', 'native-chat'], awfRuntimePricing: runtime.captureRuntimePricing(),
        awfObserveModelDecision: observe };
      const body = Buffer.from(JSON.stringify({ model: 'response-only', messages: [
        { role: 'developer', content: 'PRIVATE_RULES' }, { role: 'user', content: 'hello' },
      ] }));
      const transform = require('./body-handler').createBodyHandler({ handleRequestError() {}, otel: {} }).transformRequestBody;
      const result = await transform(body, 'copilot', req, 'ranked-initial', null);
      expect(calls).not.toHaveBeenCalled();
      expect(json(result.body)).toEqual({ ...json(body), model: 'native-chat' });
      expect(json(req.awfFallbackSourceBody).model).toBe('native-chat');
      expect(req.awfSelectedModelEligibility.model).toBe('native-chat');
      expect(observe.mock.calls.map(([r]) => [r.model, r.outcome])).toEqual([
        ['response-only', 'skipped'], ['native-chat', 'accepted'],
      ]);
      expect(JSON.stringify(observe.mock.calls)).not.toContain('PRIVATE_RULES');
      calls.mockRestore();
    });
  });

  test('marked initial exhaustion never calls the inference wire translator', async () => {
    await jest.isolateModulesAsync(async () => {
      const wire = require('./wire-api-compat');
      const calls = jest.spyOn(wire, 'translateCopilotWireApi');
      const runtime = require('./runtime-model-catalog');
      runtime.replaceRuntimeModels('copilot', [{ id: 'response-only', supportedEndpoints: ['/responses'] }]);
      const req = { method: 'POST', url: '/chat/completions',
        awfResolverFallback: { provider: 'copilot', fromModel: 'missing', model: 'response-only' } };
      const body = Buffer.from(JSON.stringify({ model: 'response-only', messages: [
        { role: 'system', content: 'rule' }, { role: 'user', content: 'hello' },
      ] }));
      const transform = require('./body-handler').createBodyHandler({ handleRequestError() {}, otel: {} }).transformRequestBody;
      await expect(transform(body, 'copilot', req, 'initial-exhausted', null))
        .rejects.toMatchObject({ code: 'model_recovery_exhausted', statusCode: 400 });
      expect(calls).not.toHaveBeenCalled();
      calls.mockRestore();
    });
  });

    test('marked initial fallback skips unverified effort and strictly translates only the accepted ranked candidate', async () => {
      await jest.isolateModulesAsync(async () => {
        const runtime = require('./runtime-model-catalog');
        runtime.replaceRuntimeModels('copilot', [
          { id: 'unverified', supportedEndpoints: ['/chat/completions'], supportedReasoningEfforts: ['high'] },
          { id: 'accepted', supportedEndpoints: ['/responses'], supportedReasoningEfforts: ['high'] },
        ]);
        const { resolveModelReasoning } = require('./model-reasoning');
        const observe = jest.fn();
        const req = { method: 'POST', url: '/chat/completions',
          awfResolverFallback: { provider: 'copilot', fromModel: 'missing', model: 'unverified' },
          awfModelCandidates: ['unverified', 'accepted'], awfRuntimePricing: runtime.captureRuntimePricing(),
          awfReasoning: resolveModelReasoning('unverified', 'copilot', { records: [], maintained: false }),
          awfObserveModelDecision: observe };
        const wire = require('./wire-api-compat');
        const calls = jest.spyOn(wire, 'translateCopilotWireApi');
        const assessment = require('./protocol-compatibility/assessment');
        const assessments = jest.spyOn(assessment, 'assessRequestCompatibility');
        const transform = require('./body-handler').createBodyHandler({ handleRequestError() {}, otel: {} }).transformRequestBody;
        const body = Buffer.from(JSON.stringify({
          model: 'unverified', reasoning_effort: 'high', stream: true,
          messages: [{ role: 'user', content: 'hello' }],
          tools: [{ type: 'function', function: { name: 'check', parameters: { type: 'object' } } }],
        }));
        const result = await transform(body, 'copilot', req, 'initial-effort', null);
        expect(calls).toHaveBeenCalledTimes(1);
        expect(calls).toHaveBeenCalledWith(expect.any(Buffer), req.url, { upstreamEndpoint: '/responses' });
        expect(json(result.body)).toMatchObject({ model: 'accepted', reasoning: { effort: 'high' } });
        expect(observe.mock.calls.map(([r]) => [r.model, r.outcome, r.compatibility.status])).toEqual([
          ['unverified', 'skipped', 'unverified'], ['accepted', 'accepted', 'compatible'],
        ]);
        expect(assessments).toHaveBeenCalledWith(expect.objectContaining({
          candidate: { provider: 'copilot', model: 'accepted' }, requiredResponseFeatures: ['usage', 'function_tools'],
        }));
        calls.mockRestore();
        assessments.mockRestore();
      });
    });

    test.each([
      { awfModelRecoveryDisabled: true },
      { awfScopedAuto: true },
      { awfRequestContext: { purpose: 'routing_classification' } },
    ])('initial automatic compatibility retries respect opt-outs %j', async flags => {
      replaceRuntimeModels('copilot', [{ id: 'response-only', supportedEndpoints: ['/responses'] }]);
      try {
        const observe = jest.fn();
        const req = { method: 'POST', url: '/chat/completions',
          awfResolverFallback: { provider: 'copilot', fromModel: 'missing', model: 'response-only' },
          awfModelCandidates: ['response-only', 'native-chat'], awfObserveModelDecision: observe, ...flags };
        const body = Buffer.from(JSON.stringify({ model: 'response-only', messages: [
          { role: 'developer', content: 'rule' }, { role: 'user', content: 'hello' },
        ] }));
        await expect(transformRequestBody(body, 'copilot', req, 'initial-opt-out', null))
          .rejects.toMatchObject({ code: 'model_recovery_exhausted' });
        expect(observe.mock.calls.map(([r]) => [r.model, r.outcome])).toEqual([
          ['response-only', 'skipped'], [null, 'exhausted'],
        ]);
      } finally { clearRuntimeModels(); }
    });

  test('the real resolver marks synthesized fallback, but not an explicitly authorized alias match', async () => {
    const saved = process.env.AWF_MODEL_ALIASES;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: {
      direct: ['copilot/gpt-5.4'],
    } });
    try {
      await jest.isolateModulesAsync(async () => {
        const { makeModelBodyTransform } = require('./model-config');
        const runtime = require('./runtime-model-catalog');
        runtime.replaceRuntimeModels('copilot', [{ id: 'gpt-5.4', supportedEndpoints: ['/responses'] }]);
        const transform = makeModelBodyTransform('copilot', { copilot: ['gpt-5.4'] },
          async () => null, null, runtime.getRuntimeModels, true);
        const { transformRequestBody } = require('./body-handler').createBodyHandler({
          handleRequestError() {}, otel: {},
        });
        const body = model => Buffer.from(JSON.stringify({ model, messages: [
          { role: 'developer', content: 'instruction' }, { role: 'user', content: 'hello' },
        ] }));
        const automatic = { method: 'POST', url: '/chat/completions' };
        await expect(transformRequestBody(body('gpt-5.3'), 'copilot', automatic, 'resolver-auto', transform))
          .rejects.toMatchObject({ code: 'model_recovery_exhausted' });
        expect(automatic.awfResolverFallback).toMatchObject({ fromModel: 'gpt-5.3', model: 'gpt-5.4' });
        const authorized = { method: 'POST', url: '/chat/completions' };
        const result = await transformRequestBody(body('direct'), 'copilot', authorized, 'resolver-alias', transform);
        expect(authorized.awfResolverFallback).toBeUndefined();
        expect(json(result.body).instructions).toBe('instruction');
        runtime.clearRuntimeModels();
      });
    } finally {
      if (saved === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = saved;
    }
  });

  test.each([
    ['gemini', '/v1beta/models/gemini-test:generateContent'],
    ['gemini', '/v1beta/models/gemini-test:streamGenerateContent?alt=sse'],
    ['vertex', '/v1/projects/project/locations/us-central1/publishers/google/models/gemini-test:generateContent'],
    ['vertex', '/v1/projects/project/locations/us-central1/publishers/google/models/gemini-test:streamGenerateContent?alt=sse'],
  ])('%s native resolver fallback on %s requires no invented translation direction', async (provider, url) => {
    const observe = jest.fn();
    const req = { method: 'POST', url, awfObserveModelDecision: observe };
    const body = Buffer.from(JSON.stringify({ model: 'gemini-test',
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }));
    const result = await transformRequestBody(body, provider, req, 'resolver-native', async value => {
      req.awfResolverFallback = Object.freeze({
        provider, fromModel: 'gemini-old', model: 'gemini-test',
      });
      return value;
    });
    expect(result.body).toEqual(body);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'accepted', compatibility: expect.objectContaining({
        status: 'compatible', source: null, target: null, contracts: [],
      }),
    }));
  });

  test.each([
    ['gemini', '/v1beta/models/gemini-test:unknownMethod'],
    ['vertex', '/v1/projects/project/locations/us-central1/publishers/google/models/gemini-test:unknownMethod'],
    ['openai', '/models/gemini-test:generateContent'],
    ['copilot', '/unknown'],
  ])('%s resolver fallback cannot approve an unimplemented endpoint %s', async (provider, url) => {
    const observe = jest.fn();
    const req = { method: 'POST', url, awfObserveModelDecision: observe };
    const body = Buffer.from(JSON.stringify({ model: 'gemini-test',
      contents: [{ parts: [{ text: 'PRIVATE_PROMPT' }] }] }));
    await expect(transformRequestBody(body, provider, req, 'resolver-unknown', async value => {
      req.awfResolverFallback = Object.freeze({
        provider, fromModel: 'missing', model: 'gemini-test',
      });
      return value;
    })).rejects.toMatchObject({ statusCode: 400, code: 'model_recovery_exhausted' });
    expect(observe.mock.calls.map(([record]) => [record.outcome, record.compatibility.status]))
      .toEqual([['skipped', 'unverified'], ['exhausted', 'unverified']]);
    expect(observe.mock.calls[0][0].compatibility.reasons)
      .toContainEqual({ feature: 'unknown_fields', code: 'direction_unimplemented' });
    expect(JSON.stringify(observe.mock.calls)).not.toContain('PRIVATE_PROMPT');

    const direct = await transformRequestBody(body, provider, { method: 'POST', url }, 'direct-unknown', null);
    expect(direct.body).toEqual(body);
  });

  test.each([['/chat/completions', '/responses'], ['/responses', '/chat/completions']])(
    'initial automatic routing remains pinned to %s across a refresh to %s',
    async (pinned, refreshed) => {
      const model = 'pinned-candidate';
      const req = { method: 'POST', url: '/chat/completions',
        awfResolverFallback: { provider: 'copilot', fromModel: 'missing', model },
        awfRuntimePricing: Object.freeze({ copilot: Object.freeze([
          Object.freeze({ id: model, supportedEndpoints: Object.freeze([pinned]) }),
        ]) }) };
      replaceRuntimeModels('copilot', [{ id: model, supportedEndpoints: [refreshed] }]);
      try {
        const body = Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hello' }] }));
        const result = await transformRequestBody(body, 'copilot', req, 'resolver-pinned', null);
        expect(result.wireApiCompatibility?.upstreamEndpoint || req.url).toBe(pinned);
        if (pinned === '/responses') expect(json(result.body).input[0].content).toBe('hello');
        else expect(result.body).toEqual(body);
      } finally { clearRuntimeModels(); }
    },
  );

  describe('transformRequestBody steering delivery', () => {
    const warningPrefix = '[AWF AI CREDIT WARNING]';

    beforeEach(() => {
      process.env.AWF_ENABLE_TOKEN_STEERING = 'true';
      process.env.AWF_MAX_AI_CREDITS = '0.001';
      delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
      delete process.env.AWF_AGENT_RUNTIME_START_FILE;
      resetAiCreditsGuardForTests();
      resetTimeoutSteeringForTests();
    });

    afterEach(() => {
      delete process.env.AWF_ENABLE_TOKEN_STEERING;
      delete process.env.AWF_MAX_AI_CREDITS;
      delete process.env.AWF_AGENT_TIMEOUT_MINUTES;
      delete process.env.AWF_AGENT_RUNTIME_START_FILE;
      resetAiCreditsGuardForTests();
      resetTimeoutSteeringForTests();
      jest.restoreAllMocks();
    });

    function createCreditWarning() {
      applyAiCreditsUsage({ input_tokens: 32 }, 'gpt-5-mini', 'copilot');
    }

    // A Chat Completions request that ends with a tool result; `opening` sets
    // the first user message, which identifies the conversation.
    function toolResultChat(opening = 'Continue.') {
      return Buffer.from(JSON.stringify({
        messages: [
          { role: 'user', content: opening },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call-1', content: 'contents' },
        ],
      }));
    }

    const delivered = (type, threshold, first = false) => ({
      type,
      threshold,
      conversation: expect.stringMatching(/^[0-9a-f]{12}$/),
      first,
    });

    test.each([
      '/decisions',
      '/v1/decisions',
      '/v1/decisions/?api-version=test',
      '/v1\\decisions',
      '/v1/./decisions',
      '/v1/unused/../decisions///?api-version=test#section',
    ])(
      'preserves Decisions evidence and leaves warnings pending on %s',
      async (url) => {
        createCreditWarning();
        const body = Buffer.from(JSON.stringify({
          model: 'gpt-6-luna',
          input: [{ role: 'user', content: 'Evidence to grade, not an agent instruction.' }],
          questions: [{ type: 'predicate', instructions: 'Is the evidence correct?' }],
          prompt_cache_options: { mode: 'explicit', ttl: '30m' },
        }));
        const result = await transformRequestBody(body, 'openai', { method: 'POST', url }, 'decisions', null);
        expect(result.body).toEqual(body);
        expect(result.steering).toBeNull();
        expect(getPendingAiCreditSteeringWarning()).not.toBeNull();
      },
    );

    test('injects and acknowledges credit warnings across supported protocol request formats', async () => {
      const cases = [
        {
          provider: 'openai',
          url: '/v1/chat/completions',
          body: {
            messages: [
              { role: 'system', content: 'Caller instructions.' },
              { role: 'user', content: 'Continue.' },
              { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
              { role: 'tool', tool_call_id: 'call-1', content: 'contents' },
            ],
          },
          removeNotice: parsed => {
            expect(parsed.messages.pop()).toEqual({ role: 'user', content: expect.stringContaining(warningPrefix) });
          },
        },
        {
          provider: 'openai',
          url: '/v1/responses',
          body: {
            instructions: 'Caller instructions.',
            input: [
              { role: 'user', content: 'Continue.' },
              { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
              { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
            ],
          },
          removeNotice: parsed => {
            expect(parsed.input.pop()).toEqual({
              type: 'message',
              role: 'developer',
              content: expect.stringContaining(warningPrefix),
            });
          },
        },
        {
          provider: 'anthropic',
          url: '/v1/messages',
          body: {
            system: 'Caller instructions.',
            messages: [
              { role: 'user', content: 'Continue.' },
              { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'read_file', input: {} }] },
              { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'contents' }] },
            ],
          },
          removeNotice: parsed => {
            expect(parsed.messages.at(-1).content.pop())
              .toEqual({ type: 'text', text: expect.stringContaining(warningPrefix) });
          },
        },
        {
          provider: 'copilot',
          url: '/v1/messages',
          body: {
            system: [{ type: 'text', text: 'Caller instructions.' }],
            messages: [
              { role: 'user', content: 'Continue.' },
              { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'read_file', input: {} }] },
              { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'contents' }] },
            ],
          },
          removeNotice: parsed => {
            expect(parsed.messages.at(-1).content.pop())
              .toEqual({ type: 'text', text: expect.stringContaining(warningPrefix) });
          },
        },
        {
          provider: 'gemini',
          url: '/v1beta/models/gemini-2.0-flash:generateContent',
          body: {
            systemInstruction: { parts: [{ text: 'Caller instructions.' }] },
            contents: [
              { role: 'user', parts: [{ text: 'Continue.' }] },
              { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
              { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'contents' } } }] },
            ],
          },
          removeNotice: parsed => {
            expect(parsed.contents.at(-1).parts.pop()).toEqual({ text: expect.stringContaining(warningPrefix) });
          },
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        resetAiCreditsGuardForTests();
        const body = Buffer.from(JSON.stringify(testCase.body));
        const baseline = await transformRequestBody(
          body,
          testCase.provider,
          { method: 'POST', url: testCase.url },
          `baseline-${index}`,
          null,
        );
        createCreditWarning();
        const req = { method: 'POST', url: testCase.url };
        const result = await transformRequestBody(
          body,
          testCase.provider,
          req,
          `request-${index}`,
          null,
        );
        const parsed = json(result.body);

        expect(result.steering).toEqual(delivered('ai_credit', 80));
        // Everything before the notice — including the system prompt or
        // instructions — is byte-identical to the request without a notice.
        const serialized = result.body.toString('utf8');
        const noticeStart = serialized.indexOf(warningPrefix);
        expect(noticeStart).toBeGreaterThan(serialized.indexOf('contents'));
        expect(serialized.indexOf('Caller instructions.')).toBe(baseline.body.toString('utf8').indexOf('Caller instructions.'));
        testCase.removeNotice(parsed);
        expect(Buffer.from(JSON.stringify(parsed))).toEqual(baseline.body);

        // While the notice is in flight the same conversation does not repeat it.
        const concurrent = await transformRequestBody(
          body,
          testCase.provider,
          { method: 'POST', url: testCase.url },
          `concurrent-${index}`,
          null,
        );
        expect(concurrent.steering).toBeNull();

        req.awfSteeringDelivery.acknowledge();
        expect(result.steering.first).toBe(true);
        expect(getPendingAiCreditSteeringWarning()).toBeNull();

        const later = await transformRequestBody(
          body,
          testCase.provider,
          { method: 'POST', url: testCase.url },
          `later-${index}`,
          null,
        );
        expect(later.body).toEqual(baseline.body);
        expect(later.steering).toBeNull();
      }
    });

    test('does not consume pending notices for malformed or classifier requests', async () => {
      createCreditWarning();
      const malformed = await transformRequestBody(
        Buffer.from(JSON.stringify({ input: { malformed: true } })),
        'openai',
        { method: 'POST', url: '/v1/responses' },
        'malformed',
        null,
      );
      expect(json(malformed.body)).toEqual({ input: { malformed: true } });
      expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);

      const classifier = await transformRequestBody(
        Buffer.from(JSON.stringify({ input: 'Classify this request.' })),
        'openai',
        { method: 'POST', url: '/v1/responses', awfRequestContext: { purpose: 'routing_classification' } },
        'classifier',
        null,
      );
      expect(json(classifier.body)).toEqual({ input: 'Classify this request.' });
      expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);
    });

    test('keeps steering last and instructions unchanged when translating Responses to Chat', async () => {
      replaceRuntimeModels('copilot', [{
        id: 'chat-only',
        supportedEndpoints: ['/chat/completions'],
      }]);
      const body = Buffer.from(JSON.stringify({
        model: 'chat-only',
        instructions: 'Caller instructions.',
        input: [
          { role: 'user', content: 'Continue.' },
          { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
        ],
      }));
      const req = { method: 'POST', url: '/v1/responses' };

      try {
        const baseline = await transformRequestBody(body, 'copilot', req, 'chat-baseline', null);
        createCreditWarning();
        const result = await transformRequestBody(body, 'copilot', req, 'chat-steered', null);
        req.awfSteeringDelivery.acknowledge();
        const parsed = json(result.body);

        expect(result.wireApiCompatibility.direction).toBe('responses_to_chat');
        expect(parsed.messages).toHaveLength(json(baseline.body).messages.length + 1);
        expect(parsed.messages[0]).toEqual({ role: 'system', content: 'Caller instructions.' });
        expect(parsed.messages.pop()).toEqual({
          role: 'developer',
          content: expect.stringContaining(warningPrefix),
        });
        expect(Buffer.from(JSON.stringify(parsed))).toEqual(baseline.body);
        expect(result.steering).toEqual(delivered('ai_credit', 80, true));
        expect(getPendingAiCreditSteeringWarning()).toBeNull();
      } finally {
        clearRuntimeModels();
      }
    });

    test('keeps steering last and instructions unchanged when translating Chat to Responses', async () => {
      replaceRuntimeModels('copilot', [{
        id: 'responses-only',
        supportedEndpoints: ['/responses'],
      }]);
      const body = Buffer.from(JSON.stringify({
        model: 'responses-only',
        messages: [
          { role: 'system', content: 'Caller instructions.' },
          { role: 'user', content: 'Continue.' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call-1', content: 'contents' },
        ],
      }));
      const req = { method: 'POST', url: '/v1/chat/completions' };

      try {
        const baseline = await transformRequestBody(body, 'copilot', req, 'responses-baseline', null);
        createCreditWarning();
        const result = await transformRequestBody(body, 'copilot', req, 'responses-steered', null);
        req.awfSteeringDelivery.acknowledge();
        const parsed = json(result.body);

        expect(result.wireApiCompatibility.direction).toBe('chat_to_responses');
        expect(parsed.instructions).toBe('Caller instructions.');
        expect(parsed.input).toHaveLength(json(baseline.body).input.length + 1);
        expect(parsed.input.at(-2)).toEqual({ type: 'function_call_output', call_id: 'call-1', output: 'contents' });
        expect(parsed.input.pop()).toEqual({
          role: 'user',
          content: expect.stringContaining(warningPrefix),
        });
        expect(Buffer.from(JSON.stringify(parsed))).toEqual(baseline.body);
        expect(result.steering).toEqual(delivered('ai_credit', 80, true));
        expect(getPendingAiCreditSteeringWarning()).toBeNull();
      } finally {
        clearRuntimeModels();
      }
    });

    test('delivers AI-credit warnings at each configured threshold on later eligible requests', async () => {
      process.env.AWF_MAX_AI_CREDITS = '1';
      const creditUsageByThreshold = new Map([
        [80, 32_000],
        [90, 4_000],
        [95, 2_000],
        [99, 1_600],
      ]);

      for (const [threshold, inputTokens] of creditUsageByThreshold) {
        applyAiCreditsUsage({ input_tokens: inputTokens }, 'gpt-5-mini', 'copilot');
        const req = { method: 'POST', url: '/v1/chat/completions' };
        const result = await transformRequestBody(
          toolResultChat(),
          'openai',
          req,
          `credit-threshold-${threshold}`,
          null,
        );
        req.awfSteeringDelivery.acknowledge();
        const parsed = json(result.body);

        expect(parsed.messages.at(-1).content).toContain(warningPrefix);
        expect(parsed.messages.at(-1).content).toContain(`${threshold}%`);
        expect(getPendingAiCreditSteeringWarning()).toBeNull();
      }
    });

    test('delivers the highest urgency warning first when time and credit thresholds coincide', async () => {
      const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runtime-clock-'));
      const startTimeMs = 1_700_000_000_000;
      const startFile = path.join(runtimeDir, 'started-at-ms');
      fs.writeFileSync(startFile, String(startTimeMs));
      process.env.AWF_AGENT_RUNTIME_START_FILE = startFile;
      process.env.AWF_AGENT_TIMEOUT_MINUTES = '10';
      jest.spyOn(Date, 'now').mockReturnValue(startTimeMs + 9 * 60 * 1000);
      createCreditWarning();

      const runRequest = async requestId => {
        const req = { method: 'POST', url: '/v1/chat/completions' };
        const result = await transformRequestBody(
          toolResultChat(),
          'openai',
          req,
          requestId,
          null,
        );
        req.awfSteeringDelivery?.acknowledge();
        return json(result.body).messages.at(-1).content;
      };

      try {
        const timeNotice = await runRequest('time-credit-1');
        expect(timeNotice).toContain('[AWF TIME WARNING]');
        expect(timeNotice).toContain('90%');
        expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);
        // The superseded 80% time notice is dropped once the 90% one is delivered.
        expect(await runRequest('time-credit-2')).toContain('[AWF AI CREDIT WARNING]');
        expect(getPendingAiCreditSteeringWarning()).toBeNull();
        expect((await transformRequestBody(
          toolResultChat(),
          'openai',
          { method: 'POST', url: '/v1/chat/completions' },
          'time-credit-3',
          null,
        )).body).toEqual(toolResultChat());
      } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
      }
    });

    test('leaves a notice pending when its request is released and drops it once acknowledged', async () => {
      createCreditWarning();
      const send = async (requestId, opening) => {
        const req = { method: 'POST', url: '/v1/chat/completions' };
        const result = await transformRequestBody(toolResultChat(opening), 'openai', req, requestId, null);
        return { req, result };
      };

      const failed = await send('notice-failed');
      expect(failed.result.steering).toEqual(delivered('ai_credit', 80));
      const concurrent = await send('notice-concurrent');
      expect(concurrent.result.steering).toBeNull();
      failed.req.awfSteeringDelivery.release();
      expect(failed.result.steering.first).toBe(false);

      const retried = await send('notice-retried');
      expect(retried.result.steering).toEqual(delivered('ai_credit', 80));
      retried.req.awfSteeringDelivery.acknowledge();
      expect(retried.result.steering.first).toBe(true);
      expect(getPendingAiCreditSteeringWarning()).toBeNull();
      expect((await send('notice-after')).result.steering).toBeNull();
    });

    test('delivers each notice once to every conversation, on its own next tool-result request', async () => {
      createCreditWarning();
      const send = async (requestId, body) => {
        const req = { method: 'POST', url: '/v1/chat/completions' };
        const result = await transformRequestBody(body, 'openai', req, requestId, null);
        return { req, result };
      };

      // Main agent and a sub-agent carry the notice at the same time.
      const main = await send('main-1', toolResultChat('Research the papers.'));
      const sub = await send('sub-1', toolResultChat('Screen this batch.'));
      expect(main.result.steering).toEqual(delivered('ai_credit', 80));
      expect(sub.result.steering).toEqual(delivered('ai_credit', 80));
      expect(main.result.steering.conversation).not.toBe(sub.result.steering.conversation);
      sub.req.awfSteeringDelivery.acknowledge();
      main.req.awfSteeringDelivery.acknowledge();
      // Only the first acknowledged delivery carries the run-level record.
      expect(sub.result.steering.first).toBe(true);
      expect(main.result.steering.first).toBe(false);

      // Neither conversation hears it again; a new conversation hears it once.
      expect((await send('main-2', toolResultChat('Research the papers.'))).result.steering).toBeNull();
      expect((await send('sub-2', toolResultChat('Screen this batch.'))).result.steering).toBeNull();
      const other = await send('other-1', toolResultChat('Screen another batch.'));
      expect(other.result.steering).toEqual(delivered('ai_credit', 80));
      other.req.awfSteeringDelivery.acknowledge();
      expect(other.result.steering.first).toBe(false);

      // The next threshold reaches each conversation again.
      applyAiCreditsUsage({ input_tokens: 4 }, 'gpt-5-mini', 'copilot');
      const mainNext = await send('main-3', toolResultChat('Research the papers.'));
      expect(mainNext.result.steering).toEqual(delivered('ai_credit', 90));
    });

    test('does not record a conversation as notified until its request is acknowledged', async () => {
      createCreditWarning();
      const req = { method: 'POST', url: '/v1/chat/completions' };
      await transformRequestBody(toolResultChat(), 'openai', req, 'released', null);
      req.awfSteeringDelivery.release();
      const retry = await transformRequestBody(
        toolResultChat(), 'openai', { method: 'POST', url: '/v1/chat/completions' }, 'retry', null);
      expect(retry.steering).toEqual(delivered('ai_credit', 80));
    });

    test('skips requests that do not end with tool results and keeps the notice for the next one', async () => {
      createCreditWarning();
      const cases = [
        { messages: [{ role: 'user', content: 'Continue.' }] },
        {
          messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Done.' },
            { role: 'user', content: 'Summarize the conversation so far.' },
          ],
        },
      ];
      for (const [index, body] of cases.entries()) {
        const encoded = Buffer.from(JSON.stringify(body));
        const result = await transformRequestBody(
          encoded, 'openai', { method: 'POST', url: '/v1/chat/completions' }, `housekeeping-${index}`, null);
        expect(result.body).toEqual(encoded);
        expect(result.steering).toBeNull();
      }
      const working = await transformRequestBody(
        toolResultChat(), 'openai', { method: 'POST', url: '/v1/chat/completions' }, 'working', null);
      expect(working.steering).toEqual(delivered('ai_credit', 80));
    });

    test('gives requests continuing a stored response each notice once per run', async () => {
      createCreditWarning();
      const continuation = Buffer.from(JSON.stringify({
        previous_response_id: 'resp_1',
        input: [{ type: 'function_call_output', call_id: 'call-1', output: 'contents' }],
      }));
      const send = async requestId => {
        const req = { method: 'POST', url: '/v1/responses' };
        const result = await transformRequestBody(continuation, 'openai', req, requestId, null);
        return { req, result };
      };

      const first = await send('stored-1');
      expect(first.result.steering).toEqual({ type: 'ai_credit', threshold: 80, conversation: null, first: false });
      expect((await send('stored-concurrent')).result.steering).toBeNull();
      first.req.awfSteeringDelivery.acknowledge();
      expect(first.result.steering.first).toBe(true);
      expect((await send('stored-2')).result.steering).toBeNull();

      // A conversation with history still hears the notice.
      const withHistory = await transformRequestBody(
        toolResultChat(), 'openai', { method: 'POST', url: '/v1/chat/completions' }, 'history', null);
      expect(withHistory.steering).toEqual(delivered('ai_credit', 80));
    });
  });

  test('still rejects unsupported Responses custom tools', async () => {
    const body = Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'freeform_shell' }],
      input: 'run',
    }));

    await expect(
      transformRequestBody(body, 'copilot', { method: 'POST', url: '/v1/responses' }, 'req-3', null),
    ).rejects.toThrow(CodexCompatibilityError);
  });
});
