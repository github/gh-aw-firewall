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
          body: { messages: [{ role: 'system', content: 'Caller instructions.' }, { role: 'user', content: 'Hi' }] },
          getWarning: parsed => parsed.messages.find(message => message.role === 'system' && message.content.includes(warningPrefix))?.content,
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
          getWarning: parsed => parsed.input.at(-1).content,
        },
        {
          provider: 'anthropic',
          url: '/v1/messages',
          body: { system: 'Caller instructions.', messages: [{ role: 'user', content: 'Hi' }] },
          getWarning: parsed => parsed.system,
        },
        {
          provider: 'copilot',
          url: '/v1/messages',
          body: { system: [{ type: 'text', text: 'Caller instructions.' }], messages: [{ role: 'user', content: 'Hi' }] },
          getWarning: parsed => parsed.system.map(block => block.text).join('\n'),
        },
        {
          provider: 'gemini',
          url: '/v1beta/models/gemini-2.0-flash:generateContent',
          body: { systemInstruction: { parts: [{ text: 'Caller instructions.' }] }, contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] },
          getWarning: parsed => parsed.systemInstruction.parts.map(part => part.text).join('\n'),
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
        const result = await transformRequestBody(
          body,
          testCase.provider,
          { method: 'POST', url: testCase.url },
          `request-${index}`,
          null,
        );
        const parsed = json(result.body);

        expect(testCase.getWarning(parsed)).toContain(warningPrefix);
        expect(JSON.stringify(parsed)).toContain('Caller instructions.');
        expect(getPendingAiCreditSteeringWarning()).toBeNull();
        if (testCase.url === '/v1/responses') {
          const prefixEnd = baseline.body.indexOf(Buffer.from(JSON.stringify(testCase.body.input)))
            + Buffer.byteLength(JSON.stringify(testCase.body.input)) - 1;
          expect(result.body.subarray(0, prefixEnd)).toEqual(baseline.body.subarray(0, prefixEnd));
          expect(parsed.input).toHaveLength(testCase.body.input.length + 1);
          expect(parsed.input.pop()).toEqual({
            type: 'message',
            role: 'developer',
            content: expect.stringContaining(warningPrefix),
          });
          expect(Buffer.from(JSON.stringify(parsed))).toEqual(baseline.body);
          expect(result.steering).toEqual({ type: 'ai_credit', threshold: 80 });
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
        const parsed = json(result.body);

        expect(result.wireApiCompatibility.direction).toBe('responses_to_chat');
        expect(parsed.messages).toHaveLength(json(baseline.body).messages.length + 1);
        expect(parsed.messages[0]).toEqual({ role: 'system', content: 'Caller instructions.' });
        expect(parsed.messages.pop()).toEqual({
          role: 'developer',
          content: expect.stringContaining(warningPrefix),
        });
        expect(Buffer.from(JSON.stringify(parsed))).toEqual(baseline.body);
        expect(result.steering).toEqual({ type: 'ai_credit', threshold: 80 });
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
        const result = await transformRequestBody(
          Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'Continue.' }] })),
          'openai',
          { method: 'POST', url: '/v1/chat/completions' },
          `credit-threshold-${threshold}`,
          null,
        );
        const parsed = json(result.body);

        expect(parsed.messages[0].content).toContain(warningPrefix);
        expect(parsed.messages[0].content).toContain(`${threshold}%`);
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
        const result = await transformRequestBody(
          Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'Continue.' }] })),
          'openai',
          { method: 'POST', url: '/v1/chat/completions' },
          requestId,
          null,
        );
        return json(result.body).messages[0].content;
      };

      try {
        expect(await runRequest('time-credit-1')).toContain('[AWF TIME WARNING]');
        expect(getPendingAiCreditSteeringWarning().threshold).toBe(80);
        expect(await runRequest('time-credit-2')).toContain('[AWF TIME WARNING]');
        expect(await runRequest('time-credit-3')).toContain('[AWF AI CREDIT WARNING]');
        expect(getPendingAiCreditSteeringWarning()).toBeNull();
      } finally {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
      }
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
