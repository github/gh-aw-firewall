'use strict';

const { createFoundryAdapter } = require('./foundry');
const { buildUpstreamPath } = require('../proxy-utils');
const { buildRequestHeaders } = require('../request-headers');

describe('Foundry adapter', () => {
  const target = 'resource.services.ai.azure.com';

  it.each([
    {},
    { FOUNDRY_API_TARGET: target },
    { FOUNDRY_API_KEY: 'test-key' },
    { FOUNDRY_ENTRA_TOKEN: 'test-token' },
    { FOUNDRY_API_TARGET: target, FOUNDRY_ENTRA_TOKEN: 'test-token' },
    { FOUNDRY_API_TARGET: ' ', FOUNDRY_API_KEY: 'test-key' },
    { FOUNDRY_API_TARGET: target, FOUNDRY_API_KEY: ' ', FOUNDRY_ENTRA_TOKEN: ' ' },
  ])('does not bind without both an endpoint and credentials: %j', env => {
    const adapter = createFoundryAdapter(env);
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.alwaysBind).toBe(false);
    expect(adapter.participatesInValidation).toBe(false);
    expect(adapter.getValidationProbe()).toBeNull();
    expect(adapter.getReflectionInfo().configured).toBe(false);
    expect(adapter.getReflectionInfo().auth_type).toBeNull();
    expect(adapter.getAuthHeaders()).toEqual({});
  });

  it('injects the key and preserves native decision paths without startup inference', () => {
    const adapter = createFoundryAdapter({ FOUNDRY_API_TARGET: `https://${target}`, FOUNDRY_API_KEY: ' test-key ' });
    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.port).toBe(10005);
    expect(adapter.isManagementPort).toBe(false);
    expect(adapter.getTargetHost()).toBe(target);
    expect(adapter.getTargetScheme()).toBe('https');
    expect(adapter.getAuthHeaders()).toEqual({ 'api-key': 'test-key' });
    expect(adapter.getBasePath()).toBe('');
    expect(adapter.getBodyTransform()).toBeNull();
    expect(buildUpstreamPath('/providers/microsoft/v1/systemone', target, adapter.getBasePath()))
      .toBe('/providers/microsoft/v1/systemone');
    expect(adapter.getValidationProbe()).toEqual(expect.objectContaining({ skip: true }));
    expect(adapter.getModelsFetchConfig()).toBeNull();
    expect(adapter.getReflectionInfo()).toEqual(expect.objectContaining({
      provider: 'foundry', port: 10005, configured: true, models_url: null, models_cache_key: null,
    }));
    expect(JSON.stringify(adapter.getReflectionInfo())).not.toContain('test-key');
  });

  it('ignores Entra tokens even when an API key is configured', () => {
    const adapter = createFoundryAdapter({
      FOUNDRY_API_TARGET: target,
      FOUNDRY_ENTRA_TOKEN: ' test-token ',
      FOUNDRY_API_KEY: 'test-key',
    });
    expect(adapter.getAuthHeaders()).toEqual({ 'api-key': 'test-key' });
    expect(adapter.getReflectionInfo().auth_type).toBe('static-key');
  });

  it('supports explicit OpenAI-compatible base paths with an API key', () => {
    const adapter = createFoundryAdapter({
      FOUNDRY_API_TARGET: target,
      FOUNDRY_API_KEY: 'test-key',
      FOUNDRY_API_BASE_PATH: '/openai/v1/',
    });
    expect(adapter.isEnabled()).toBe(true);
    expect(buildUpstreamPath('/chat/completions?api-version=preview', target, adapter.getBasePath()))
      .toBe('/openai/v1/chat/completions?api-version=preview');
    expect(buildUpstreamPath('/openai/v1/chat/completions', target, adapter.getBasePath()))
      .toBe('/openai/v1/chat/completions');
  });

  it('replaces client-supplied auth rather than forwarding placeholders', () => {
    const adapter = createFoundryAdapter({ FOUNDRY_API_TARGET: target, FOUNDRY_API_KEY: 'test-key' });
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, {
      headers: { authorization: '******', 'api-key': 'placeholder', 'x-api-key': 'placeholder' },
    }, { injectHeaders: adapter.getAuthHeaders(), provider: adapter.name, targetHost: target, requestId: 'foundry-test' });
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
    expect(headers['api-key']).toBe('test-key');
  });

  it.each([
    ['', '/providers/microsoft/v1/systemone'],
    ['/providers/microsoft/v1', '/systemone'],
    ['/providers/microsoft/v1', '/providers/microsoft/v1/systemone'],
    ['', '/chat/completions'],
    ['', '/v1/responses'],
    ['', '/openai/v1/embeddings'],
    ['', '/openai/deployments/decision-1/completions?api-version=preview'],
    ['/openai/v1', '/chat/completions?api-version=preview'],
    ['/openai/v1', '/openai/v1/chat/completions'],
    ['/custom/v1', '/responses'],
  ])('allows inference with base %s and path %s', (basePath, url) => {
    const adapter = createFoundryAdapter({
      FOUNDRY_API_TARGET: target, FOUNDRY_API_KEY: 'test-key', FOUNDRY_API_BASE_PATH: basePath,
    });
    expect(adapter.isRequestAllowed({ method: 'POST', url, headers: {} })).toBe(true);
  });

  it.each([
    '/openai/v1/files', '/openai/v1/files/file123/content',
    '/openai/deployments/model/files', '/deployments/model',
    '/providers/microsoft/v1/systemone/extra', '/chat/completions/extra',
    '/admin/chat/completions', '/responses/delete', '/systemone',
    '/openai/v1/../files', '/openai/v1/%2e%2e/files',
    '/openai/v1/%2e%2e/chat/completions', '/openai//v1/chat/completions',
    '/openai\\v1\\chat/completions', '/chat%2fcompletions',
    '/responses#fragment', '//other.example/responses', 'https://other.example/responses',
  ])('rejects non-inference and ambiguous paths: %s', url => {
    const adapter = createFoundryAdapter({ FOUNDRY_API_TARGET: target, FOUNDRY_API_KEY: 'test-key' });
    expect(adapter.isRequestAllowed({ method: 'POST', url, headers: {} })).toBe(false);
  });

  it.each(['GET', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'])('rejects %s inference requests', method => {
    const adapter = createFoundryAdapter({ FOUNDRY_API_TARGET: target, FOUNDRY_API_KEY: 'test-key' });
    expect(adapter.isRequestAllowed({ method, url: '/responses', headers: {} })).toBe(false);
  });
});
