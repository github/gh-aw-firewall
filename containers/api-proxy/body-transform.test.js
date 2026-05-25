const { injectStreamOptions, stripUnrecognizedToolTypes, stripEncryptedInclude } = require('./body-transform');

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

describe('stripUnrecognizedToolTypes', () => {
  test('strips tools with type "custom" from Responses API requests', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5.5',
      input: 'hello',
      tools: [
        { type: 'function', function: { name: 'bash', parameters: {} } },
        { type: 'custom', name: 'my_mcp_tool' },
        { type: 'function', function: { name: 'edit', parameters: {} } },
      ],
    }));

    const result = stripUnrecognizedToolTypes(body, '/v1/responses');
    expect(result).not.toBeNull();
    expect(result.strippedCount).toBe(1);
    expect(result.strippedTypes).toEqual(['custom']);
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.tools).toHaveLength(2);
    expect(parsed.tools.every(t => t.type === 'function')).toBe(true);
  });

  test('strips multiple unrecognized types', () => {
    const body = Buffer.from(JSON.stringify({
      input: 'hello',
      tools: [
        { type: 'custom', name: 'tool1' },
        { type: 'openrouter:datetime', name: 'tool2' },
        { type: 'function', function: { name: 'bash' } },
      ],
    }));

    const result = stripUnrecognizedToolTypes(body, 'responses');
    expect(result).not.toBeNull();
    expect(result.strippedCount).toBe(2);
    expect(result.strippedTypes).toContain('custom');
    expect(result.strippedTypes).toContain('openrouter:datetime');
  });

  test('returns null for non-Responses API paths', () => {
    const body = Buffer.from(JSON.stringify({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'custom', name: 'tool1' }],
    }));

    expect(stripUnrecognizedToolTypes(body, '/v1/chat/completions')).toBeNull();
  });

  test('returns null when all tools have recognized types', () => {
    const body = Buffer.from(JSON.stringify({
      input: 'hello',
      tools: [
        { type: 'function', function: { name: 'bash' } },
        { type: 'mcp', name: 'github' },
        { type: 'web_search_preview' },
      ],
    }));

    expect(stripUnrecognizedToolTypes(body, '/v1/responses')).toBeNull();
  });

  test('returns null when body has no tools array', () => {
    const body = Buffer.from(JSON.stringify({ input: 'hello', model: 'gpt-5.5' }));
    expect(stripUnrecognizedToolTypes(body, '/v1/responses')).toBeNull();
  });

  test('handles path without leading slash (Codex CLI behavior)', () => {
    const body = Buffer.from(JSON.stringify({
      input: 'hello',
      tools: [{ type: 'custom', name: 'tool1' }],
    }));

    const result = stripUnrecognizedToolTypes(body, 'v1/responses');
    expect(result).not.toBeNull();
    expect(result.strippedCount).toBe(1);
  });
});

describe('stripEncryptedInclude', () => {
  test('strips reasoning.encrypted_content from include array', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5.5',
      input: 'hello',
      include: ['reasoning.encrypted_content'],
    }));

    const result = stripEncryptedInclude(body, '/v1/responses');

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.include).toBeUndefined();
    expect(result.strippedValues).toEqual(['reasoning.encrypted_content']);
    expect(result.model).toBe('gpt-5.5');
  });

  test('preserves non-encrypted include values', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5.5',
      input: 'hello',
      include: ['reasoning.encrypted_content', 'file_search_call.results'],
    }));

    const result = stripEncryptedInclude(body, '/v1/responses');

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.include).toEqual(['file_search_call.results']);
    expect(result.strippedValues).toEqual(['reasoning.encrypted_content']);
  });

  test('returns null for non-responses paths', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5.5',
      include: ['reasoning.encrypted_content'],
    }));

    const result = stripEncryptedInclude(body, '/v1/chat/completions');
    expect(result).toBeNull();
  });

  test('returns null when no encrypted values present', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5.5',
      input: 'hello',
      include: ['file_search_call.results'],
    }));

    const result = stripEncryptedInclude(body, '/v1/responses');
    expect(result).toBeNull();
  });

  test('returns null when include is not an array', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5.5',
      input: 'hello',
    }));

    const result = stripEncryptedInclude(body, '/v1/responses');
    expect(result).toBeNull();
  });

  test('returns model as null when not present in body', () => {
    const body = Buffer.from(JSON.stringify({
      input: 'hello',
      include: ['reasoning.encrypted_content'],
    }));

    const result = stripEncryptedInclude(body, '/v1/responses');

    expect(result).not.toBeNull();
    expect(result.model).toBeNull();
  });

  test('handles path without leading slash', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5.5',
      input: 'hello',
      include: ['reasoning.encrypted_content'],
    }));

    const result = stripEncryptedInclude(body, 'v1/responses');
    expect(result).not.toBeNull();
    expect(result.strippedValues).toEqual(['reasoning.encrypted_content']);
  });
});
