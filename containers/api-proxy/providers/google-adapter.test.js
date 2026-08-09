'use strict';

const { createGoogleProviderAdapter } = require('./google-adapter');
const { GOOGLE_PROVIDER_SPECS } = require('./google-provider-specs');
const { createGeminiAdapter } = require('./gemini');
const { createVertexAdapter } = require('./vertex');

describe('createGoogleProviderAdapter', () => {
  it('throws for an unknown provider key', () => {
    expect(() => createGoogleProviderAdapter('bogus', {})).toThrow(/Unknown Google provider spec: bogus/);
  });

  it('derives gemini ports, targets and messages from the spec', () => {
    const adapter = createGoogleProviderAdapter('gemini', {});
    expect(adapter.name).toBe('gemini');
    expect(adapter.port).toBe(10003);
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.getUnconfiguredResponse()).toEqual({
      statusCode: 503,
      body: { error: 'Gemini proxy not configured (no GEMINI_API_KEY). Set GEMINI_API_KEY in the AWF runner environment to enable credential isolation.' },
    });
    expect(adapter.getUnconfiguredHealthResponse().body).toMatchObject({
      service: 'awf-api-proxy-gemini',
      error: 'GEMINI_API_KEY not configured in api-proxy sidecar',
    });
  });

  it('derives vertex ports, targets and messages from the spec', () => {
    const adapter = createGoogleProviderAdapter('vertex', {});
    expect(adapter.name).toBe('vertex');
    expect(adapter.port).toBe(10004);
    expect(adapter.getUnconfiguredResponse()).toEqual({
      statusCode: 503,
      body: { error: 'Vertex AI proxy not configured (no GOOGLE_API_KEY). Set GOOGLE_API_KEY in the AWF runner environment to enable credential isolation.' },
    });
    expect(adapter.getUnconfiguredHealthResponse().body).toMatchObject({
      service: 'awf-api-proxy-vertex',
      error: 'GOOGLE_API_KEY not configured in api-proxy sidecar',
    });
  });

  it('applies the gemini URL transform and omits it for vertex', () => {
    const gemini = createGeminiAdapter({ GEMINI_API_KEY: 'k' });
    const vertex = createVertexAdapter({ GOOGLE_API_KEY: 'k' });
    expect(gemini.transformRequestUrl('/v1beta/models?key=secret')).toBe('/v1beta/models');
    expect(vertex.transformRequestUrl).toBeUndefined();
  });

  it('exposes a models fetch config only when the spec defines a models path', () => {
    const gemini = createGeminiAdapter({ GEMINI_API_KEY: 'k' });
    const vertex = createVertexAdapter({ GOOGLE_API_KEY: 'k' });
    expect(gemini.getModelsFetchConfig()).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
    });
    expect(vertex.getModelsFetchConfig()).toBeNull();
    expect(GOOGLE_PROVIDER_SPECS.vertex.modelsPath).toBeNull();
  });

  it('authenticates both providers with the x-goog-api-key header', () => {
    expect(createGeminiAdapter({ GEMINI_API_KEY: 'g' }).getAuthHeaders()).toEqual({ 'x-goog-api-key': 'g' });
    expect(createVertexAdapter({ GOOGLE_API_KEY: 'v' }).getAuthHeaders()).toEqual({ 'x-goog-api-key': 'v' });
  });
});
