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

  describe('Vertex GCP OIDC routing', () => {
    const env = {
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'gcp',
      AWF_AUTH_GCP_PROJECT: 'vertex-project',
      AWF_AUTH_GCP_LOCATION: 'us-central1',
    };

    it.each([
      ['v1', 'generateContent', ''],
      ['v1beta1', 'streamGenerateContent', '?alt=sse&x=a%2Fb&x=c'],
      ['v1', 'countTokens', '?alt=json'],
      ['v1beta1', 'generateContent', ''],
    ])('scopes %s %s and preserves the query %s', (version, method, query) => {
      const adapter = createGoogleProviderAdapter('vertex', env);
      const modelPath = `publishers/google/models/gemini-2.5-pro:${method}${query}`;
      expect(adapter.transformRequestUrl(`/${version}/${modelPath}`)).toBe(
        `/${version}/projects/vertex-project/locations/us-central1/${modelPath}`,
      );
    });

    it.each([
      ['us-central1', 'us-central1-aiplatform.googleapis.com'],
      ['europe-west4', 'europe-west4-aiplatform.googleapis.com'],
      ['global', 'aiplatform.googleapis.com'],
    ])('uses the host for %s', (location, host) => {
      const adapter = createGoogleProviderAdapter('vertex', { ...env, AWF_AUTH_GCP_LOCATION: location });
      expect(adapter.getTargetHost()).toBe(host);
      expect(adapter.transformRequestUrl('/v1/publishers/google/models/gemini:generateContent')).toBe(
        `/v1/projects/vertex-project/locations/${location}/publishers/google/models/gemini:generateContent`,
      );
    });

    it('honors an explicit upstream target', () => {
      const adapter = createGoogleProviderAdapter('vertex', { ...env, VERTEX_API_TARGET: 'custom.example.com' });
      expect(adapter.getTargetHost()).toBe('custom.example.com');
    });

    it('rejects a location that is not a hostname label', () => {
      expect(() => createGoogleProviderAdapter('vertex', {
        ...env,
        AWF_AUTH_GCP_LOCATION: 'us-central1/other',
      })).toThrow('Invalid AWF_AUTH_GCP_LOCATION');
    });

    it('leaves static-key express mode and its host unchanged', () => {
      const adapter = createGoogleProviderAdapter('vertex', {
        ...env,
        AWF_AUTH_TYPE: 'static-key',
        GOOGLE_API_KEY: 'key',
      });
      expect(adapter.getTargetHost()).toBe('aiplatform.googleapis.com');
      expect(adapter.transformRequestUrl).toBeUndefined();
      expect(adapter.getAuthHeaders()).toEqual({ 'x-goog-api-key': 'key' });
    });

    it.each([
      '/v1/projects/existing/locations/global/publishers/google/models/gemini:generateContent?alt=sse',
      '/v1beta1/projects/existing/locations/us-east1/publishers/google/models/gemini:countTokens',
      '/v1/models',
      '/v1/publishers/other/models/gemini:generateContent',
    ])('leaves other paths unchanged: %s', (path) => {
      expect(createGoogleProviderAdapter('vertex', env).transformRequestUrl(path)).toBe(path);
    });

    it.each([
      { AWF_AUTH_TYPE: 'static-key' },
      { AWF_AUTH_PROVIDER: 'azure' },
      { AWF_AUTH_GCP_PROJECT: '' },
      { AWF_AUTH_GCP_LOCATION: '' },
    ])('does not rewrite without GCP OIDC project/location configuration: %j', (overrides) => {
      const adapter = createGoogleProviderAdapter('vertex', { ...env, ...overrides, GOOGLE_API_KEY: 'key' });
      expect(adapter.transformRequestUrl).toBeUndefined();
    });

    it('does not change native Gemini routing', () => {
      const adapter = createGoogleProviderAdapter('gemini', env);
      expect(adapter.getTargetHost()).toBe('generativelanguage.googleapis.com');
      expect(adapter.transformRequestUrl('/v1beta/models/gemini:generateContent?alt=sse')).toBe(
        '/v1beta/models/gemini:generateContent?alt=sse',
      );
    });
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
      error: 'Vertex AI OIDC token (gcp) unavailable; retry shortly',
    });
    adapter.getOidcProvider().shutdown();
  });

  it('reports incomplete GCP WIF configuration as non-retryable', () => {
    const adapter = createGoogleProviderAdapter('gemini', {
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'gcp',
      AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/pool/providers/github',
    });
    const expectedMessage = 'Gemini GCP OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (permissions: id-token: write) plus AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER.';
    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.getUnconfiguredResponse().body.error).toMatchObject({
      message: expectedMessage,
      retryable: false,
    });
    expect(adapter.getUnconfiguredHealthResponse().body).toMatchObject({
      status: 'unavailable',
      error: expectedMessage,
    });
  });
});
