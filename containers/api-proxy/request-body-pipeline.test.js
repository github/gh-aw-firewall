const { createBodyHandler } = require('./body-handler');

const { transformRequestBody } = createBodyHandler({ handleRequestError() {}, otel: {} });

describe('request body pipeline byte preservation', () => {
  test.each(['POST', 'PUT', 'PATCH', 'GET', 'DELETE'])(
    '%s preserves untouched JSON whitespace and non-JSON bytes',
    async method => {
      for (const text of [' { "messages": [], "stream": false }\n', 'not JSON \u0000', '']) {
        const body = Buffer.from(text);
        const req = { method, url: '/v1/chat/completions' };
        const result = await transformRequestBody(body, 'openai', req, 'unchanged', null);
        expect(result).toEqual({
          body, codexCompatibility: null, wireApiCompatibility: null, wireApiSourceBody: null, steering: null,
        });
        expect(result.body).toBe(body);
        if (['POST', 'PUT', 'PATCH'].includes(method)) {
          expect(req.awfFallbackSourceBody).toEqual(body);
          expect(req.awfFallbackSourceBody).not.toBe(body);
        } else {
          expect(req.awfFallbackSourceBody).toBeUndefined();
        }
      }
    },
  );

  test.each(['POST', 'PUT', 'PATCH'])('normalizes before the %s caller and sanitizes its output', async method => {
    const req = { method, url: '/v1/chat/completions' };
    const body = Buffer.from(' { "model": "openai/pipeline-model", "stream": true }\n');
    const normalized = Buffer.from('{"model":"pipeline-model","stream":true}');
    const caller = jest.fn(async (value, request) => {
      expect(value).toEqual(normalized);
      expect(request).toBe(req);
      expect(request.awfRequestedModelSelector).toBe('openai/pipeline-model');
      return Buffer.from('{"model":"pipeline-model","stream":true,"messages":[{"role":"assistant","tool_calls":[{"id":"call","type":null,"function":{"name":"read","arguments":"{}"}},{"id":"bad","type":null}]}]}');
    });
    const result = await transformRequestBody(body, 'openai', req, 'ordered', caller);
    const expected = '{"model":"pipeline-model","stream":true,"messages":[{"role":"assistant","tool_calls":[{"id":"call","type":"function","function":{"name":"read","arguments":"{}"}}]}]' +
      (method === 'POST' ? ',"stream_options":{"include_usage":true}}' : '}');
    expect(caller).toHaveBeenCalledTimes(1);
    expect(result.body).toEqual(Buffer.from(expected));
    expect(req.awfFallbackSourceBody).toEqual(result.body);
  });

  test.each([null, undefined, {}, 'invalid'])('ignores a non-Buffer caller result: %p', async value => {
    const body = Buffer.from(' { "messages": [] }\n');
    const result = await transformRequestBody(body, 'openai', { method: 'POST', url: '/responses' },
      'caller-contract', async () => value);
    expect(result.body).toBe(body);
  });

  test('does not call the caller transform for read-only methods', async () => {
    const caller = jest.fn();
    const body = Buffer.from(' { "model": "openai/pipeline-model" }\n');
    const result = await transformRequestBody(body, 'openai', { method: 'GET', url: '/models' }, 'read-only', caller);
    expect(caller).not.toHaveBeenCalled();
    expect(result.body).toBe(body);
  });

  test('preserves the full transform order, metadata, and pre-wire source bytes', async () => {
    const saved = process.env.AWF_ENABLE_TOKEN_STEERING;
    process.env.AWF_ENABLE_TOKEN_STEERING = 'true';
    try {
      await jest.isolateModulesAsync(async () => {
        const stages = [];
        const append = (body, stage) => {
          stages.push(stage);
          return Buffer.concat([body, Buffer.from(`|${stage}`)]);
        };
        const customTools = new Set(['apply_patch']);
        const compatibility = { direction: 'responses_to_chat' };
        const delivery = { acknowledge: jest.fn(() => true), legacyThreshold: () => null, release: jest.fn() };
        const transforms = require('./body-transform');
        jest.spyOn(require('./model-body-rewriter'), 'stripRedundantModelPrefixInBody')
          .mockImplementation(body => append(body, 'prefix'));
        jest.spyOn(require('./codex-compat'), 'translateCodexCustomToolsForCopilot')
          .mockImplementation(body => ({ body: append(body, 'codex'), compatibility: { customTools } }));
        jest.spyOn(require('./model-recovery'), 'recoverRequestModel')
          .mockImplementation(body => append(body, 'recovery'));
        jest.spyOn(transforms, 'sanitizeNullToolCallTypes')
          .mockImplementation(body => ({ body: append(body, 'sanitize'), normalizedCount: 1, droppedCount: 0 }));
        jest.spyOn(transforms, 'describeSteeringConversation')
          .mockReturnValue({ conversation: 'conversation', endsWithToolResult: true });
        jest.spyOn(require('./guards/timeout-steering'), 'hasCrossedTimeoutSteeringThreshold').mockReturnValue(true);
        jest.spyOn(require('./guards/timeout-steering'), 'getPendingTimeoutSteeringWarning')
          .mockReturnValue({ message: 'warning', rank: 80, trigger: 'threshold', threshold: 80 });
        jest.spyOn(require('./guards/timeout-steering'), 'claimTimeoutSteeringWarning').mockReturnValue(delivery);
        jest.spyOn(require('./guards/ai-credits-guard'), 'hasCrossedAiCreditSteeringThreshold').mockReturnValue(false);
        jest.spyOn(require('./guards/ai-credits-guard'), 'getPendingAiCreditSteeringWarning').mockReturnValue(null);
        jest.spyOn(transforms, 'injectSteeringMessage').mockImplementation(body => append(body, 'steering'));
        jest.spyOn(transforms, 'injectStreamOptions').mockImplementation(body => ({ body: append(body, 'stream') }));
        jest.spyOn(require('./wire-api-compat'), 'translateCopilotWireApi')
          .mockImplementation(body => ({ body: append(body, 'wire'), compatibility }));
        const handler = require('./body-handler').createBodyHandler({ handleRequestError() {}, otel: {} });
        const onEndpointTranslation = jest.fn();
        const req = { method: 'POST', url: '/responses', awfRouting: { onEndpointTranslation } };
        const result = await handler.transformRequestBody(Buffer.from('body'), 'copilot', req, 'all-stages',
          async body => append(body, 'caller'));

        expect(stages).toEqual(['prefix', 'caller', 'codex', 'recovery', 'sanitize', 'steering', 'stream', 'wire']);
        expect(result.body).toEqual(Buffer.from('body|prefix|caller|codex|recovery|sanitize|steering|stream|wire'));
        expect(req.awfFallbackSourceBody).toEqual(Buffer.from('body|prefix|caller|codex|recovery|sanitize|steering|stream'));
        expect(result.wireApiSourceBody).toEqual(req.awfFallbackSourceBody);
        expect(result.wireApiSourceBody).not.toBe(req.awfFallbackSourceBody);
        expect(result.codexCompatibility).toEqual({ customTools });
        expect(result.wireApiCompatibility).toBe(compatibility);
        expect(onEndpointTranslation).toHaveBeenCalledTimes(1);
        expect(onEndpointTranslation).toHaveBeenCalledWith(compatibility);
        expect(result.steering).toMatchObject({ type: 'timeout', threshold: 80, first: false });
        req.awfSteeringDelivery.acknowledge();
        expect(result.steering.first).toBe(true);
        req.awfSteeringDelivery.release();
        expect(delivery.release).toHaveBeenCalledTimes(1);
      });
    } finally {
      jest.restoreAllMocks();
      if (saved === undefined) delete process.env.AWF_ENABLE_TOKEN_STEERING;
      else process.env.AWF_ENABLE_TOKEN_STEERING = saved;
    }
  });
});
