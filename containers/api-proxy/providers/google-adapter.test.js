'use strict';

const {
  createGoogleProviderAdapter,
  makeGoogleProviderFactory,
  GOOGLE_PROVIDER_ADAPTER_FACTORIES,
} = require('./google-adapter');
const { GOOGLE_PROVIDER_SPECS } = require('./google-provider-specs');

describe('createGoogleProviderAdapter', () => {
  it('throws for an unknown provider key', () => {
    expect(() => createGoogleProviderAdapter('bogus', {})).toThrow(/Unknown Google provider spec: bogus/);
  });

  it('creates reusable provider factories from provider keys', () => {
    const createGemini = makeGoogleProviderFactory('gemini');
    expect(createGemini({ GEMINI_API_KEY: 'key' }).getAuthHeaders()).toEqual({
      'x-goog-api-key': 'key',
    });
  });

  it('exports factories for every declared Google provider', () => {
    expect(Object.keys(GOOGLE_PROVIDER_ADAPTER_FACTORIES)).toEqual(Object.keys(GOOGLE_PROVIDER_SPECS));
    expect(GOOGLE_PROVIDER_ADAPTER_FACTORIES.gemini({ GEMINI_API_KEY: 'key' }).getAuthHeaders()).toEqual({
      'x-goog-api-key': 'key',
    });
    expect(GOOGLE_PROVIDER_ADAPTER_FACTORIES.vertex({ GOOGLE_API_KEY: 'key' }).getAuthHeaders()).toEqual({
      'x-goog-api-key': 'key',
    });
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
    const gemini = GOOGLE_PROVIDER_ADAPTER_FACTORIES.gemini({ GEMINI_API_KEY: 'k' });
    const vertex = GOOGLE_PROVIDER_ADAPTER_FACTORIES.vertex({ GOOGLE_API_KEY: 'k' });
    expect(gemini.transformRequestUrl('/v1beta/models?key=secret')).toBe('/v1beta/models');
    expect(vertex.transformRequestUrl).toBeUndefined();
  });

  it('exposes a models fetch config only when the spec defines a models path', () => {
    const gemini = GOOGLE_PROVIDER_ADAPTER_FACTORIES.gemini({ GEMINI_API_KEY: 'k' });
    const vertex = GOOGLE_PROVIDER_ADAPTER_FACTORIES.vertex({ GOOGLE_API_KEY: 'k' });
    expect(gemini.getModelsFetchConfig()).toMatchObject({
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
    });
    expect(vertex.getModelsFetchConfig()).toBeNull();
    expect(GOOGLE_PROVIDER_SPECS.vertex.modelsPath).toBeNull();
  });

  it('authenticates both providers with the x-goog-api-key header', () => {
    expect(GOOGLE_PROVIDER_ADAPTER_FACTORIES.gemini({ GEMINI_API_KEY: 'g' }).getAuthHeaders()).toEqual({ 'x-goog-api-key': 'g' });
    expect(GOOGLE_PROVIDER_ADAPTER_FACTORIES.vertex({ GOOGLE_API_KEY: 'v' }).getAuthHeaders()).toEqual({ 'x-goog-api-key': 'v' });
  });

  it('enables Gemini with GCP WIF and injects a bearer token when ready', () => {
    const adapter = createGoogleProviderAdapter('gemini', {
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'gcp',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
      AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
    });
    const provider = adapter.getOidcProvider();
    expect(provider).toBeTruthy();
    expect(adapter.getAuthHeaders()).toEqual({});
    provider._cachedToken = 'gcp-access-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;
    expect(adapter.isEnabled()).toBe(true);
    const headers = adapter.getAuthHeaders();
    expect(headers.Authorization).toBe('Bearer gcp-access-token');
    expect(headers['x-goog-api-key']).toBeUndefined();
    expect(adapter.getReflectionInfo()).toMatchObject({
      configured: true,
      auth_type: 'github-oidc/gcp',
    });
    provider.shutdown();
  });

  it('enables Vertex with GCP WIF and reports retryable not-configured while token is pending', () => {
    const adapter = createGoogleProviderAdapter('vertex', {
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'gcp',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
      AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
      AWF_AUTH_GCP_SERVICE_ACCOUNT: 'vertex-sa@example.iam.gserviceaccount.com',
    });
    expect(adapter.getOidcProvider()).toBeTruthy();
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.getUnconfiguredResponse()).toEqual({
      statusCode: 503,
      body: {
        error: {
          message: 'Vertex AI OIDC token (gcp) unavailable; retry shortly',
          type: 'provider_not_configured',
          provider: 'vertex',
          port: 10004,
          retryable: true,
        },
      },
    });
    expect(adapter.getUnconfiguredHealthResponse().body).toMatchObject({
      status: 'unavailable',
      error: 'Vertex AI OIDC token (gcp) not yet available in api-proxy sidecar',
    });
    adapter.getOidcProvider().shutdown();
  });
});
