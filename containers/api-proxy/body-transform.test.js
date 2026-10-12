const { injectSteeringMessage, injectStreamOptions } = require('./body-transform');

describe('injectStreamOptions', () => {
  test('injects include_usage for streaming chat completions requests', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    const transformed = injectStreamOptions(body, 'openai', '/v1/chat/completions');

    expect(transformed).not.toBeNull();
    expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
  });

  describe('injectSteeringMessage for Responses requests', () => {
    const warning = '[AWF AI CREDIT WARNING] Use the remaining budget carefully.';

    test.each([
      ['tool loop ending in a function result', {
        instructions: 'Keep working carefully.',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Continue the task.' }] },
          { type: 'reasoning', id: 'reasoning-1', summary: [] },
          { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: 'file contents' },
        ],
      }],
      ['input ending in a user message', {
        instructions: 'Keep working carefully.',
        input: [{ role: 'user', content: 'Continue the task.' }],
      }],
      ['no instructions', { input: [{ role: 'user', content: 'Continue the task.' }] }],
      ['null instructions', { instructions: null, input: [{ role: 'user', content: 'Continue the task.' }] }],
      ['string input', { instructions: 'Keep working carefully.', input: 'Continue the task.' }],
      ['empty input', { input: [] }],
    ])('appends one final developer notice preserving the prefix for %s', (_name, request) => {
      const original = {
        model: 'gpt-5-mini',
        ...request,
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
        prompt_cache_key: 'stable-cache-key',
        stream: true,
      };
      const body = Buffer.from(JSON.stringify(original));
      const input = typeof original.input === 'string'
        ? [{ role: 'user', content: original.input }]
        : original.input;
      const baseline = JSON.stringify({ ...original, input });
      const prefixEnd = baseline.indexOf(JSON.stringify(input)) + JSON.stringify(input).length - 1;

      const result = injectSteeringMessage(body, 'copilot', warning, '/v1/responses');

      expect(result).not.toBeNull();
      expect(result.subarray(0, Buffer.byteLength(baseline.slice(0, prefixEnd))))
        .toEqual(Buffer.from(baseline.slice(0, prefixEnd)));
      const parsed = JSON.parse(result.toString());
      expect(parsed.input).toHaveLength(input.length + 1);
      expect(parsed.input.pop()).toEqual({ type: 'message', role: 'developer', content: warning });
      expect(JSON.stringify(parsed)).toBe(baseline);
      if (typeof original.input === 'string') parsed.input = original.input;
      expect(Buffer.from(JSON.stringify(parsed))).toEqual(body);
    });

    test('also appends a notice for Responses body shapes on unrecognized paths', () => {
      const result = injectSteeringMessage(
        Buffer.from(JSON.stringify({ input: 'Continue the task.' })),
        'openai',
        warning,
        '/unknown',
      );

      expect(JSON.parse(result.toString())).toEqual({
        input: [
          { role: 'user', content: 'Continue the task.' },
          { type: 'message', role: 'developer', content: warning },
        ],
      });
    });

    test('returns null for malformed Responses input or instructions', () => {
      expect(injectSteeringMessage(
        Buffer.from(JSON.stringify({ input: { text: 'not a supported input' } })),
        'openai',
        warning,
        '/v1/responses',
      )).toBeNull();
      expect(injectSteeringMessage(
        Buffer.from(JSON.stringify({ input: 'hello', instructions: [] })),
        'openai',
        warning,
        '/v1/responses',
      )).toBeNull();
    });
  });

  describe('injectSteeringMessage for Gemini requests', () => {
    const warning = '[AWF AI CREDIT WARNING] Use the remaining budget carefully.';

    test.each([null, 'malformed', []])('returns null for malformed systemInstruction %p', (systemInstruction) => {
      const body = Buffer.from(JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Continue the task.' }] }],
        systemInstruction,
      }));

      expect(injectSteeringMessage(body, 'gemini', warning)).toBeNull();
    });
  });

  test('does not inject include_usage for OpenAI responses endpoint', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, input: 'hello' }));

    expect(injectStreamOptions(body, 'openai', '/v1/responses')).toBeNull();
    expect(injectStreamOptions(body, 'openai', '/responses?foo=1')).toBeNull();
  });

  test('does not inject include_usage for OpenAI responses endpoint without leading slash', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, input: 'hello' }));

    expect(injectStreamOptions(body, 'openai', 'responses')).toBeNull();
    expect(injectStreamOptions(body, 'openai', 'v1/responses')).toBeNull();
    expect(injectStreamOptions(body, 'openai', 'v1/responses?foo=1')).toBeNull();
  });

  test('does not inject include_usage when body has input field but no messages (Responses API shape)', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, input: 'hello', model: 'gpt-5-mini' }));

    // Even with an unrecognised path, body-shape guard should catch it
    expect(injectStreamOptions(body, 'openai', '/v1/unknown')).toBeNull();
  });

  test('does not trigger body-shape guard when messages array is present alongside input', () => {
    const body = Buffer.from(
      JSON.stringify({ stream: true, input: 'hello', messages: [{ role: 'user', content: 'hi' }] })
    );

    // Has both input and messages — not a pure Responses API shape, should still inject
    const transformed = injectStreamOptions(body, 'openai', '/v1/chat/completions');
    expect(transformed).not.toBeNull();
    expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
  });

  test('does not inject include_usage for Anthropic Messages endpoint via Copilot provider', () => {
    const body = Buffer.from(
      JSON.stringify({ stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(injectStreamOptions(body, 'copilot', '/v1/messages')).toBeNull();
    expect(injectStreamOptions(body, 'copilot', '/messages?foo=1')).toBeNull();
    expect(injectStreamOptions(body, 'copilot', 'messages')).toBeNull();
    expect(injectStreamOptions(body, 'copilot', 'v1/messages')).toBeNull();
  });

  test('still injects include_usage for OpenAI-compatible chat completions on copilot provider', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    const transformed = injectStreamOptions(body, 'copilot', '/v1/chat/completions');
    expect(transformed).not.toBeNull();
    expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
  });

  test.each([
    '/messages/../v1/chat/completions',
    '/messages/%2e%2e/v1/chat/completions',
    '/v1/messages/../../v1/chat/completions',
  ])('uses the canonical path before applying route exclusions: %s', (requestPath) => {
    const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    const transformed = injectStreamOptions(body, 'copilot', requestPath);

    expect(transformed).not.toBeNull();
    expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
  });

  test.each(['/v1/messages/extra', '/v1/responses/extra'])(
    'does not exclude descendants of exact API routes: %s',
    (requestPath) => {
      const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));

      const transformed = injectStreamOptions(body, 'copilot', requestPath);

      expect(transformed).not.toBeNull();
      expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
    }
  );
});
