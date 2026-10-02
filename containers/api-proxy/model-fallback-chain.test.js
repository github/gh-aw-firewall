const {
  parseFallbackModels,
  getFallbackModels,
  isModelSpecificErrorBody,
  getFallbackReason,
  getRequestModel,
  normalizeFallbackModel,
  selectNextFallbackModel,
  rewriteRequestModel,
} = require('./model-fallback-chain');

describe('model-fallback-chain', () => {
  describe('parseFallbackModels', () => {
    test('returns an empty list for unset or blank values', () => {
      expect(parseFallbackModels(undefined)).toEqual([]);
      expect(parseFallbackModels('')).toEqual([]);
      expect(parseFallbackModels('   ')).toEqual([]);
    });

    test('parses comma and newline separated lists preserving order', () => {
      expect(parseFallbackModels(' gpt-5.4 , claude-sonnet-4.6\ngpt-4.1 ')).toEqual([
        'gpt-5.4', 'claude-sonnet-4.6', 'gpt-4.1',
      ]);
    });

    test('parses JSON arrays and ignores non-string entries', () => {
      expect(parseFallbackModels('["a", 1, " b ", null]')).toEqual(['a', 'b']);
    });

    test('returns an empty list for malformed JSON arrays', () => {
      expect(parseFallbackModels('[not json')).toEqual([]);
    });

    test('removes case-insensitive duplicates and empty entries', () => {
      expect(parseFallbackModels('a,,A,b,')).toEqual(['a', 'b']);
    });

    test('getFallbackModels reads AWF_FALLBACK_MODELS', () => {
      expect(getFallbackModels({ AWF_FALLBACK_MODELS: 'x,y' })).toEqual(['x', 'y']);
      expect(getFallbackModels({})).toEqual([]);
    });
  });

  describe('getFallbackReason', () => {
    test.each([500, 502, 503, 529])('treats %i as an upstream 5xx', (status) => {
      expect(getFallbackReason(status, Buffer.from('oops'))).toBe('upstream_5xx');
    });

    test('treats 504 as an upstream timeout', () => {
      expect(getFallbackReason(504, null)).toBe('upstream_timeout');
    });

    test.each([401, 403, 429])('never falls back on %i', (status) => {
      expect(getFallbackReason(status, Buffer.from('{"error":"model_not_supported"}'))).toBeNull();
    });

    test('falls back on model-specific 400/404 only', () => {
      expect(getFallbackReason(400, Buffer.from('{"error":{"code":"model_not_supported"}}'))).toBe('model_not_supported');
      expect(getFallbackReason(404, Buffer.from('{"error":{"code":"model_not_found"}}'))).toBe('model_not_supported');
      expect(getFallbackReason(400, Buffer.from('{"error":"invalid tool schema"}'))).toBeNull();
      expect(getFallbackReason(404, Buffer.from('Not Found'))).toBeNull();
      expect(getFallbackReason(200, Buffer.from('model_not_supported'))).toBeNull();
    });
  });

  describe('isModelSpecificErrorBody', () => {
    test.each([
      ['copilot', '{"error":{"message":"The requested model is not supported.","code":"model_not_supported"}}'],
      ['copilot endpoint', '{"error":{"message":"model \\"gpt-5.4-mini\\" is not accessible via the /chat/completions endpoint"}}'],
      ['openai', '{"error":{"message":"The model `gpt-9` does not exist or you do not have access to it.","code":"model_not_found"}}'],
      ['anthropic', '{"type":"error","error":{"type":"not_found_error","message":"model: claude-9"}}'],
      ['anthropic reversed properties', '{"error":{"message":"model: claude-9","type":"not_found_error"}}'],
      ['gemini', '{"error":{"code":404,"message":"models/gemini-9 is not found for API version v1beta","status":"NOT_FOUND"}}'],
      ['generic', '{"error":"Unsupported model"}'],
    ])('detects %s model errors', (_name, body) => {
      expect(isModelSpecificErrorBody(Buffer.from(body))).toBe(true);
    });

    test.each([
      '{"error":{"message":"maximum context length is 8192 tokens"}}',
      '{"error":{"message":"Invalid schema for function \'x\'"}}',
      '',
    ])('ignores non-model errors: %s', (body) => {
      expect(isModelSpecificErrorBody(Buffer.from(body))).toBe(false);
    });

    test('handles null and string inputs', () => {
      expect(isModelSpecificErrorBody(null)).toBe(false);
      expect(isModelSpecificErrorBody('model_not_found')).toBe(true);
    });
  });

  describe('getRequestModel', () => {
    test('reads the model from the JSON body', () => {
      expect(getRequestModel(Buffer.from('{"model":"gpt-5"}'), '/v1/chat/completions'))
        .toEqual({ model: 'gpt-5', location: 'body' });
    });

    test('reads the model from a Gemini-style path when the body has none', () => {
      expect(getRequestModel(Buffer.from('{"contents":[]}'), '/v1beta/models/gemini-2.5-pro:generateContent?alt=sse'))
        .toEqual({ model: 'gemini-2.5-pro', location: 'path' });
    });

    test('returns null when no model can be located', () => {
      expect(getRequestModel(Buffer.from('not json'), '/v1/chat/completions')).toBeNull();
      expect(getRequestModel(Buffer.alloc(0), undefined)).toBeNull();
    });
  });

  describe('selectNextFallbackModel', () => {
    test('returns the first chain entry not yet attempted', () => {
      expect(selectNextFallbackModel(['a', 'b', 'c'], ['A'], 'openai')).toBe('b');
      expect(selectNextFallbackModel(['a', 'b', 'c'], ['x', 'a', 'b'], 'openai')).toBe('c');
      expect(selectNextFallbackModel(['a'], ['a'], 'openai')).toBeNull();
    });

    test('strips a redundant provider prefix', () => {
      expect(normalizeFallbackModel('copilot/gpt-5', 'copilot')).toBe('gpt-5');
      expect(normalizeFallbackModel('github-copilot/gpt-5', 'copilot')).toBe('gpt-5');
      expect(normalizeFallbackModel('anthropic/claude', 'openai')).toBe('anthropic/claude');
      expect(selectNextFallbackModel(['copilot/gpt-5', 'copilot/gpt-4.1'], ['gpt-5'], 'copilot')).toBe('gpt-4.1');
    });

    test('skips models rejected by the permission predicate', () => {
      const isPermitted = jest.fn(model => model !== 'b');
      expect(selectNextFallbackModel(['b', 'c'], ['a'], 'openai', isPermitted)).toBe('c');
      expect(isPermitted).toHaveBeenCalledWith('b', 'openai');
    });

    test('treats a throwing predicate as not permitted', () => {
      expect(selectNextFallbackModel(['b'], ['a'], 'openai', () => { throw new Error('boom'); })).toBeNull();
    });
  });

  describe('rewriteRequestModel', () => {
    test('rewrites the body model and preserves other fields', () => {
      const result = rewriteRequestModel(
        { body: Buffer.from('{"model":"a","stream":true}'), upstreamPath: '/v1/messages' }, 'body', 'b',
      );
      expect(JSON.parse(result.body.toString())).toEqual({ model: 'b', stream: true });
      expect(result.upstreamPath).toBe('/v1/messages');
    });

    test('rewrites the Gemini path model segment', () => {
      const body = Buffer.from('{"contents":[]}');
      const result = rewriteRequestModel(
        { body, upstreamPath: '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse' }, 'path', 'gemini-2.5-flash',
      );
      expect(result.body).toBe(body);
      expect(result.upstreamPath).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    });

    test('returns null when the request cannot be rewritten', () => {
      expect(rewriteRequestModel({ body: Buffer.from('nope'), upstreamPath: '/x' }, 'body', 'b')).toBeNull();
      expect(rewriteRequestModel({ body: Buffer.alloc(0), upstreamPath: '/x' }, 'path', 'b')).toBeNull();
      expect(rewriteRequestModel({ body: Buffer.alloc(0), upstreamPath: '/x' }, 'other', 'b')).toBeNull();
    });
  });
});
