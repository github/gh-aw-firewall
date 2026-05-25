const { injectStreamOptions } = require('./body-transform');

describe('injectStreamOptions', () => {
  test('injects include_usage for streaming chat completions requests', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    const transformed = injectStreamOptions(body, 'openai', '/v1/chat/completions');

    expect(transformed).not.toBeNull();
    expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
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
});

