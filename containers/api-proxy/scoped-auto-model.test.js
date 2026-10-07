'use strict';

const { parseScopedAutoRequest, rewriteScopedAutoRequest, reflectScopedAuto } = require('./scoped-auto-model');
const { createBodyHandler } = require('./body-handler');
const { createCopilotAdapter } = require('./providers/copilot');
const { createAnthropicAdapter } = require('./providers/anthropic');
const { createOpenAIAdapter } = require('./providers/openai');

const records = [
  { id: 'gpt-5.4-codex', supportedEndpoints: ['/responses', '/chat/completions'] },
  { id: 'gpt-6', supportedEndpoints: ['/responses', '/chat/completions'] },
  { id: 'claude-sonnet-4.5', supportedEndpoints: ['/v1/messages', '/chat/completions'] },
  { id: 'claude-sonnet-4.6', supportedEndpoints: ['/v1/messages', '/chat/completions'] },
  { id: 'claude-opus-5', supportedEndpoints: ['/v1/messages'] },
  { id: 'claude-haiku-4.5', supportedEndpoints: ['/v1/messages'] },
  { id: 'claude-sonnet-6', supportedEndpoints: ['/chat/completions'] },
  { id: 'claude-sonnet-7' },
  { id: 'claude-sonnet-8', supportedEndpoints: ['/messages'], modelPickerEnabled: false },
  { id: 'gemini-3-pro', supportedEndpoints: ['chat_completions'] },
];
const models = records.map(record => record.id);
const encode = value => Buffer.from(JSON.stringify(value));
const messagesRequest = () => ({ method: 'POST', url: '/v1/messages?beta=true' });

describe('provider-scoped automatic selection', () => {
  function resolve(body, options = {}) {
    const selection = parseScopedAutoRequest(encode(body), options.req || messagesRequest(), 'copilot');
    return rewriteScopedAutoRequest(
      selection, 'copilot', options.models || models, options.records || records, options.policy,
    );
  }

  it.each(['auto', 'copilot/auto', 'COPILOT/AUTO'])('selects the newest Messages-compatible Sonnet for %s', model => {
    const result = resolve({ model, model_provider: 'anthropic', messages: [], max_tokens: 100 });
    expect(JSON.parse(result.body)).toEqual({
      model: 'claude-sonnet-4.6', messages: [], max_tokens: 100,
    });
    expect(result.candidates).toEqual([
      'claude-sonnet-4.6', 'claude-sonnet-4.5', 'claude-opus-5', 'claude-haiku-4.5',
    ]);
  });

  it('preserves the exact query suffix on every retry candidate', () => {
    const suffix = '?effort=high&custom=a%2Fb';
    const result = resolve({ model: `copilot/auto${suffix}`, model_provider: 'anthropic' });
    expect(result.resolvedModel).toBe(`claude-sonnet-4.6${suffix}`);
    expect(result.candidates.every(model => model.endsWith(suffix))).toBe(true);
  });

  it('prefers Opus, then Haiku when no Sonnet is eligible', () => {
    const body = { model: 'auto', model_provider: 'anthropic' };
    const opus = resolve(body, { policy: { disallowedModels: ['*sonnet*'] } });
    expect(opus.resolvedModel).toBe('claude-opus-5');
    const haiku = resolve(body, { policy: { disallowedModels: ['*sonnet*', '*opus*'] } });
    expect(haiku.resolvedModel).toBe('claude-haiku-4.5');
  });

  it.each([
    ['anthropic', '/chat/completions', 'claude-sonnet-6'],
    ['openai', '/v1/chat/completions/', 'gpt-6'],
    ['openai', '/v1/responses', 'gpt-6'],
    ['google', '/chat/completions', 'gemini-3-pro'],
  ])('selects %s only within the requested protocol %s', (model_provider, url, expected) => {
    expect(resolve({ model: 'auto', model_provider }, {
      req: { method: 'POST', url },
    }).resolvedModel).toBe(expected);
  });

  it('requires a Codex-compatible model for Copilot Responses custom tools', () => {
    expect(resolve({
      model: 'auto', model_provider: 'openai', tools: [{ type: 'custom', name: 'apply_patch' }],
    }, { req: { method: 'POST', url: '/responses' } }).resolvedModel).toBe('gpt-5.4-codex');
  });

  it('does not accept metadata for a model absent from this backend inventory', () => {
    expect(resolve({ model: 'auto', model_provider: 'anthropic' }, {
      models: ['gpt-6'],
    })).toBeNull();
  });

  it('does not infer Messages compatibility from a Claude model ID', () => {
    expect(resolve({ model: 'auto', model_provider: 'anthropic' }, {
      records: records.filter(record => !record.supportedEndpoints?.includes('/v1/messages')),
    })).toBeNull();
  });

  it('applies backend-qualified concrete model policy rather than policy for the auto sentinel', () => {
    expect(resolve({ model: 'auto', model_provider: 'anthropic' }, {
      policy: { allowedModels: ['copilot/claude-*'], disallowedModels: ['*sonnet*'] },
    }).resolvedModel).toBe('claude-opus-5');
  });

  it.each([
    { model: 'auto', model_provider: 'copilot' },
    { model: 'auto', model_provider: '__proto__' },
    { model: 'auto', model_provider: '' },
    { model: 'auto', model_provider: null },
    { model: 'auto', model_provider: ['anthropic'] },
    { model: 'claude-sonnet-4.6', model_provider: 'anthropic' },
    { model_provider: 'anthropic' },
  ])('rejects malformed picker requests: %j', body => {
    expect(() => parseScopedAutoRequest(encode(body), messagesRequest(), 'copilot')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'invalid_scoped_auto_request' }),
    );
  });

  it.each([
    { method: 'GET', url: '/v1/messages' },
    { method: 'POST', url: '/auto' },
    { method: 'POST', url: '/v1/messages/count_tokens' },
  ])('rejects unsupported request surfaces: %j', req => {
    expect(() => parseScopedAutoRequest(
      encode({ model: 'auto', model_provider: 'anthropic' }), req, 'copilot',
    )).toThrow(expect.objectContaining({ statusCode: 400, code: 'unsupported_scoped_auto_endpoint' }));
  });

  it.each(['auto', 'copilot/auto', 'gpt-6'])('leaves existing unscoped %s behavior alone', model => {
    expect(parseScopedAutoRequest(encode({ model }), messagesRequest(), 'copilot')).toBeNull();
  });

  it('exposes a picker contract separately from concrete model IDs', () => {
    const reflection = reflectScopedAuto('copilot', models, records, { disallowedModels: ['*sonnet*'] });
    expect(reflection).toMatchObject({
      model: 'auto',
      constraint_field: 'model_provider',
      model_providers: ['anthropic', 'openai', 'google'],
      preserves_backend: true,
      requires_advertised_endpoints: true,
    });
    expect(reflection.candidates.anthropic.messages).toEqual(['claude-opus-5', 'claude-haiku-4.5']);
    expect(reflection.candidates.openai.messages).toEqual([]);
    expect(models).not.toContain('auto');
  });
});

describe('scoped auto request pipeline', () => {
  const originalEnv = { ...process.env };
  let makeModelBodyTransform;

  beforeEach(() => {
    delete process.env.AWF_MODEL_ALIASES;
    delete process.env.AWF_ALLOWED_MODELS;
    delete process.env.AWF_DISALLOWED_MODELS;
    jest.isolateModules(() => {
      ({ makeModelBodyTransform } = require('./model-config'));
    });
  });

  afterEach(() => { process.env = { ...originalEnv }; });

  function transformFor(provider, cache, refresh = jest.fn(), getRecords = () => records) {
    return makeModelBodyTransform(provider, cache, refresh, () => new Set([provider]), getRecords);
  }

  it.each(['copilot', 'openai', 'anthropic'])('retains the configured %s backend and credentials for Claude selection', async provider => {
    const bodyTransform = transformFor(provider, { [provider]: models });
    const adapters = {
      copilot: () => createCopilotAdapter({
        COPILOT_PROVIDER_API_KEY: 'test-key',
        COPILOT_API_TARGET: 'router.example.com',
      }, { bodyTransform }),
      openai: () => createOpenAIAdapter({
        OPENAI_API_KEY: 'test-key', OPENAI_API_TARGET: 'router.example.com',
      }, { bodyTransform }),
      anthropic: () => createAnthropicAdapter({
        ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_API_TARGET: 'router.example.com',
      }, { bodyTransform }),
    };
    const adapter = adapters[provider]();
    const req = { ...messagesRequest(), headers: {} };
    const originalHeaders = adapter.getAuthHeaders(req);
    const { transformRequestBody } = createBodyHandler({ handleRequestError() {}, otel: {} });
    const result = await transformRequestBody(
      encode({ model: `${provider}/auto?effort=high`, model_provider: 'anthropic', messages: [] }),
      provider, req, 'test-scoped-auto', adapter.getBodyTransform(),
    );
    expect(JSON.parse(result.body).model).toBe('claude-sonnet-4.6?effort=high');
    expect(JSON.parse(result.body)).not.toHaveProperty('model_provider');
    expect(adapter.getTargetHost(req)).toBe('router.example.com');
    expect(adapter.getAuthHeaders(req)).toEqual(originalHeaders);
    expect(req.awfScopedAuto).toBe(true);
    expect(req.awfModelCandidates[0]).toBe('claude-sonnet-4.6?effort=high');
  });

  it('refreshes this backend once when inventory is unavailable', async () => {
    const cache = { copilot: null, anthropic: models };
    const refresh = jest.fn(async provider => { cache[provider] = models; });
    const result = await transformFor('copilot', cache, refresh)(
      encode({ model: 'auto', model_provider: 'anthropic' }), messagesRequest(),
    );
    expect(JSON.parse(result).model).toBe('claude-sonnet-4.6');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('copilot');
  });

  it('fails closed despite aliases and fallback when no compatible model is available', async () => {
    process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { auto: ['copilot/gpt-*'] } });
    jest.isolateModules(() => {
      ({ makeModelBodyTransform } = require('./model-config'));
    });
    const refresh = jest.fn();
    const transform = transformFor('copilot', { copilot: ['gpt-6'], anthropic: models }, refresh);
    await expect(transform(
      encode({ model: 'auto', model_provider: 'anthropic' }), messagesRequest(),
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'scoped_auto_model_unavailable',
      message: expect.stringContaining('configured copilot backend'),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
