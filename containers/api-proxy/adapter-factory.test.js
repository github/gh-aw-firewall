'use strict';

const { buildProviderAdapter } = require('./adapter-factory');

describe('buildProviderAdapter', () => {
  function makeAdapterMethods(overrides = {}) {
    return {
      getTargetHost() { return 'api.example.com'; },
      getBasePath() { return ''; },
      participatesInValidation: true,
      getValidationProbe() { return null; },
      getModelsFetchConfig() { return null; },
      getReflectionInfo() { return { provider: 'test', port: 10099 }; },
      ...overrides,
    };
  }

  describe('required fields', () => {
    it('sets name, port, isManagementPort, alwaysBind from opts', () => {
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        isManagementPort: true,
        alwaysBind: false,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
      });
      expect(adapter.name).toBe('test');
      expect(adapter.port).toBe(10099);
      expect(adapter.isManagementPort).toBe(true);
      expect(adapter.alwaysBind).toBe(false);
    });

    it('defaults isManagementPort to false and alwaysBind to true', () => {
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
      });
      expect(adapter.isManagementPort).toBe(false);
      expect(adapter.alwaysBind).toBe(true);
    });

    it('includes getAuthHeaders from opts', () => {
      const getAuthHeaders = () => ({ 'x-test-key': 'val' });
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders,
        isEnabled() { return true; },
      });
      expect(adapter.getAuthHeaders).toBe(getAuthHeaders);
      expect(adapter.getAuthHeaders()).toEqual({ 'x-test-key': 'val' });
    });

    it('spreads all adapterMethods into the returned object', () => {
      const adapterMethods = makeAdapterMethods({ participatesInValidation: false });
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods,
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
      });
      expect(adapter.getTargetHost).toBe(adapterMethods.getTargetHost);
      expect(adapter.getBasePath).toBe(adapterMethods.getBasePath);
      expect(adapter.participatesInValidation).toBe(false);
      expect(adapter.getValidationProbe).toBe(adapterMethods.getValidationProbe);
      expect(adapter.getModelsFetchConfig).toBe(adapterMethods.getModelsFetchConfig);
      expect(adapter.getReflectionInfo).toBe(adapterMethods.getReflectionInfo);
    });
  });

  describe('getBodyTransform', () => {
    it('wraps bodyTransform in getBodyTransform()', () => {
      const transform = (body) => body;
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
        bodyTransform: transform,
      });
      expect(adapter.getBodyTransform()).toBe(transform);
    });

    it('defaults bodyTransform to null', () => {
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
      });
      expect(adapter.getBodyTransform()).toBeNull();
    });
  });

  describe('optional methods', () => {
    it('throws when isEnabled is not provided', () => {
      expect(() => buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
      })).toThrow('must define an isEnabled() function');
    });

    it('includes isEnabled when provided', () => {
      const isEnabled = () => true;
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled,
      });
      expect(adapter.isEnabled).toBe(isEnabled);
      expect(adapter.isEnabled()).toBe(true);
    });

    it('accepts isEnabled provided via extra', () => {
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        extra: {
          isEnabled() { return true; },
        },
      });
      expect(adapter.isEnabled()).toBe(true);
    });

    it('omits transformRequestUrl when not provided', () => {
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
      });
      expect('transformRequestUrl' in adapter).toBe(false);
    });

    it('includes transformRequestUrl when provided', () => {
      const transformRequestUrl = (url) => url + '?transformed=1';
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
        transformRequestUrl,
      });
      expect(adapter.transformRequestUrl).toBe(transformRequestUrl);
    });

    it('omits getUnconfiguredResponse when not provided', () => {
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
      });
      expect('getUnconfiguredResponse' in adapter).toBe(false);
    });

    it('includes getUnconfiguredResponse when provided', () => {
      const getUnconfiguredResponse = () => ({ statusCode: 503, body: { error: 'not configured' } });
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
        getUnconfiguredResponse,
      });
      expect(adapter.getUnconfiguredResponse).toBe(getUnconfiguredResponse);
    });

    it('omits getUnconfiguredHealthResponse when not provided', () => {
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
      });
      expect('getUnconfiguredHealthResponse' in adapter).toBe(false);
    });

    it('includes getUnconfiguredHealthResponse when provided', () => {
      const getUnconfiguredHealthResponse = () => ({ statusCode: 503, body: { status: 'down' } });
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
        getUnconfiguredHealthResponse,
      });
      expect(adapter.getUnconfiguredHealthResponse).toBe(getUnconfiguredHealthResponse);
    });
  });

  describe('extra fields', () => {
    it('spreads extra fields into the returned object after adapterMethods', () => {
      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods({ participatesInValidation: false }),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
        extra: {
          participatesInValidation: true,  // override from adapterMethods
          _customField: 'hello',
          getOidcProvider() { return null; },
        },
      });
      expect(adapter.participatesInValidation).toBe(true);
      expect(adapter._customField).toBe('hello');
      expect(adapter.getOidcProvider()).toBeNull();
    });

    it('defaults extra to empty object when not provided', () => {
      expect(() => buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods: makeAdapterMethods(),
        getAuthHeaders() { return {}; },
        isEnabled() { return true; },
      })).not.toThrow();
    });
  });

  describe('integration with createAdapterMethods', () => {
    it('correctly wires up a complete minimal adapter', () => {
      const { createBaseAdapterConfig, createAdapterMethods } = require('./adapter-factory');
      const env = { MY_API_KEY: 'test-key' };
      const { apiKey, rawTarget, basePath } = createBaseAdapterConfig(env, {
        keyEnvVar: 'MY_API_KEY',
        targetEnvVar: 'MY_API_TARGET',
        basePathEnvVar: 'MY_API_BASE_PATH',
        defaultTarget: 'api.example.com',
      });
      const adapterMethods = createAdapterMethods({
        apiKey,
        rawTarget,
        basePath,
        provider: 'test',
        port: 10099,
        modelsPath: '/v1/models',
        validationPath: '/v1/models',
        validationHeaders: () => ({ 'Authorization': '******' }),
      });

      const adapter = buildProviderAdapter({
        name: 'test',
        port: 10099,
        adapterMethods,
        getAuthHeaders() { return { 'Authorization': '******' }; },
        isEnabled() { return !!apiKey; },
        getUnconfiguredResponse() {
          return { statusCode: 503, body: { error: 'not configured' } };
        },
      });

      expect(adapter.name).toBe('test');
      expect(adapter.port).toBe(10099);
      expect(adapter.isManagementPort).toBe(false);
      expect(adapter.alwaysBind).toBe(true);
      expect(adapter.isEnabled()).toBe(true);
      expect(adapter.getAuthHeaders()).toEqual({ 'Authorization': '******' });
      expect(adapter.getBodyTransform()).toBeNull();
      expect(adapter.getTargetHost()).toBe('api.example.com');
      expect(adapter.getBasePath()).toBe('');
      expect(adapter.getUnconfiguredResponse()).toEqual({ statusCode: 503, body: { error: 'not configured' } });
    });
  });
});
