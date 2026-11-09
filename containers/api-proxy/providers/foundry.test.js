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
    { FOUNDRY_API_TARGET: ' ', FOUNDRY_API_KEY: 'test-key' },
    { FOUNDRY_API_TARGET: target, FOUNDRY_API_KEY: ' ', FOUNDRY_ENTRA_TOKEN: ' ' },
  ])('does not bind without both an endpoint and credentials: %j', env => {
    const adapter = createFoundryAdapter(env);
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.alwaysBind).toBe(false);
    expect(adapter.participatesInValidation).toBe(false);
    expect(adapter.getValidationProbe()).toBeNull();
    expect(adapter.getReflectionInfo().configured).toBe(false);
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

  it('uses an Entra bearer token in preference to the API key', () => {
    const adapter = createFoundryAdapter({
      FOUNDRY_API_TARGET: target,
      FOUNDRY_ENTRA_TOKEN: ' test-token ',
      FOUNDRY_API_KEY: 'test-key',
    });
    expect(adapter.getAuthHeaders()).toEqual({ Authorization: ['Bearer', 'test-token'].join(' ') });
    expect(adapter.getReflectionInfo().auth_type).toBe('entra-token');
  });

  it('supports token-only authentication and explicit OpenAI-compatible base paths', () => {
    const adapter = createFoundryAdapter({
      FOUNDRY_API_TARGET: target,
      FOUNDRY_ENTRA_TOKEN: 'test-token',
      FOUNDRY_API_BASE_PATH: '/openai/v1/',
    });
    expect(adapter.isEnabled()).toBe(true);
    expect(buildUpstreamPath('/chat/completions?api-version=preview', target, adapter.getBasePath()))
      .toBe('/openai/v1/chat/completions?api-version=preview');
    expect(buildUpstreamPath('/openai/v1/chat/completions', target, adapter.getBasePath()))
      .toBe('/openai/v1/chat/completions');
  });

  it.each([
    { FOUNDRY_API_KEY: 'test-key' },
    { FOUNDRY_ENTRA_TOKEN: 'test-token' },
  ])('replaces client-supplied auth rather than forwarding placeholders: %j', credential => {
    const adapter = createFoundryAdapter({ FOUNDRY_API_TARGET: target, ...credential });
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, {
      headers: { authorization: '******', 'api-key': 'placeholder', 'x-api-key': 'placeholder' },
    }, { injectHeaders: adapter.getAuthHeaders(), provider: adapter.name, targetHost: target, requestId: 'foundry-test' });
    expect(headers.authorization).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();
    if (credential.FOUNDRY_ENTRA_TOKEN) {
      expect(headers.Authorization).toBe(['Bearer', 'test-token'].join(' '));
      expect(headers['api-key']).toBeUndefined();
    } else {
      expect(headers['api-key']).toBe('test-key');
    }
  });
});
