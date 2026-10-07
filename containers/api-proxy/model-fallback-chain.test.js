const {
  parseFallbackModels,
  getFallbackModels,
  isModelSpecificErrorBody,
  getFallbackReason,
  getRequestModel,
  normalizeFallbackModel,
  selectNextFallbackModel,
  rewriteRequestModel,
  resolveFallbackEntry,
  selectNextFallbackCandidate,
  validateFallbackChain,
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

  describe('resolveFallbackEntry', () => {
    test('keeps unqualified entries on the receiving provider', () => {
      expect(resolveFallbackEntry('gpt-5.4', 'copilot'))
        .toEqual({ entry: 'gpt-5.4', provider: 'copilot', model: 'gpt-5.4', qualified: false });
    });

    test('switches provider for entries qualified with another provider', () => {
      expect(resolveFallbackEntry('openai/gpt-5.4', 'copilot'))
        .toEqual({ entry: 'openai/gpt-5.4', provider: 'openai', model: 'gpt-5.4', qualified: true });
      expect(resolveFallbackEntry('Anthropic/claude-sonnet-4.6', 'copilot'))
        .toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4.6' });
      expect(resolveFallbackEntry('github-copilot/grok-4.7', 'openai'))
        .toMatchObject({ provider: 'copilot', model: 'grok-4.7' });
    });

    test('strips a prefix that names the receiving provider', () => {
      expect(resolveFallbackEntry('copilot/grok-4.7', 'copilot'))
        .toMatchObject({ provider: 'copilot', model: 'grok-4.7', qualified: true });
    });

    test('keeps unknown prefixes and nested IDs as part of the model', () => {
      expect(resolveFallbackEntry('meta-llama/llama-3.3-70b', 'openai'))
        .toMatchObject({ provider: 'openai', model: 'meta-llama/llama-3.3-70b', qualified: false });
      // Qualifying with the serving provider keeps an OpenRouter-style ID intact.
      expect(resolveFallbackEntry('openai/anthropic/claude-sonnet-4', 'openai'))
        .toMatchObject({ provider: 'openai', model: 'anthropic/claude-sonnet-4' });
    });
  });

  describe('selectNextFallbackCandidate', () => {
    const chain = ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6', 'gpt-5-mini'];

    test('returns configured candidates in order, skipping attempted ones', () => {
      expect(selectNextFallbackCandidate(chain, ['grok-4.7'], 'copilot'))
        .toMatchObject({ provider: 'openai', model: 'gpt-5.4' });
      expect(selectNextFallbackCandidate(chain, [
        { provider: 'copilot', model: 'grok-4.7' },
        { provider: 'openai', model: 'gpt-5.4' },
      ], 'copilot')).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-4.6' });
      expect(selectNextFallbackCandidate(chain, [
        { provider: 'copilot', model: 'grok-4.7' },
        { provider: 'openai', model: 'gpt-5.4' },
        { provider: 'anthropic', model: 'claude-sonnet-4.6' },
      ], 'copilot')).toMatchObject({ provider: 'copilot', model: 'gpt-5-mini' });
    });

    test('treats the same model on a different provider as a distinct attempt', () => {
      expect(selectNextFallbackCandidate(['openai/gpt-5.4'], [{ provider: 'copilot', model: 'gpt-5.4' }], 'copilot'))
        .toMatchObject({ provider: 'openai', model: 'gpt-5.4' });
    });

    test('evaluates guards against the target provider and reports vetoes', () => {
      const onSkip = jest.fn();
      const isPermitted = jest.fn((model, provider) => provider !== 'openai');
      expect(selectNextFallbackCandidate(chain, ['grok-4.7'], 'copilot', { isPermitted, onSkip }))
        .toMatchObject({ provider: 'anthropic' });
      expect(isPermitted).toHaveBeenCalledWith('gpt-5.4', 'openai');
      expect(onSkip).toHaveBeenCalledWith(expect.objectContaining({ provider: 'openai' }), 'guard_rejected');
    });

    test('skips candidates that cannot be routed and never invents alternatives', () => {
      const onSkip = jest.fn();
      const getRouteRejection = candidate => (candidate.provider === 'copilot' ? null : 'provider_not_configured');
      expect(selectNextFallbackCandidate(['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6'], ['grok-4.7'], 'copilot', {
        getRouteRejection, onSkip,
      })).toBeNull();
      expect(onSkip).toHaveBeenCalledTimes(2);
      expect(onSkip).toHaveBeenLastCalledWith(expect.objectContaining({ provider: 'anthropic' }), 'provider_not_configured');
    });

    test('honours the exclusion set', () => {
      const exclude = new Set(['openai\u0000gpt-5.4']);
      expect(selectNextFallbackCandidate(chain, ['grok-4.7'], 'copilot', { exclude }))
        .toMatchObject({ provider: 'anthropic' });
    });
  });

  describe('validateFallbackChain', () => {
    const enabled = { isEnabled: () => true };
    const disabled = { isEnabled: () => false };

    test('accepts qualified entries for configured providers and ignores unqualified ones', () => {
      const getAdapter = provider => (provider === 'openai' ? enabled : disabled);
      expect(validateFallbackChain(['gpt-5-mini', 'openai/gpt-5.4', 'meta-llama/llama-3'], getAdapter)).toEqual([]);
    });

    test('reports actionable errors for providers without credentials', () => {
      const errors = validateFallbackChain(
        ['openai/gpt-5.4', 'anthropic/claude-sonnet-4.6', 'gemini/gemini-2.5-pro'],
        provider => (provider === 'openai' ? enabled : provider === 'anthropic' ? disabled : undefined),
      );
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain('"anthropic/claude-sonnet-4.6"');
      expect(errors[0]).toContain('ANTHROPIC_API_KEY');
      expect(errors[1]).toContain('GEMINI_API_KEY');
    });

    test('accepts OIDC-configured providers before their token is ready', () => {
      const oidcAdapter = {
        isEnabled: () => false,
        getOidcProvider: () => ({ isReady: () => false }),
      };
      expect(validateFallbackChain(['openai/gpt-5.4'], () => oidcAdapter)).toEqual([]);
      expect(validateFallbackChain(['openai/gpt-5.4'], () => ({
        isEnabled: () => false,
        getAwsOidcProvider: () => ({ isReady: () => false }),
      }))).toEqual([]);
    });

    test('reports entries that name a provider but no model', () => {
      expect(validateFallbackChain(['openai/'], () => enabled)[0]).toContain('no model');
    });
  });
});
