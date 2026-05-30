/**
 * Tests for Copilot Azure OpenAI BYOK routing.
 *
 * Covers: isAzureOpenAITarget detection, api-key header injection,
 * and api-version query parameter injection via transformRequestUrl.
 */

const {
  createCopilotAdapter,
  _testing: {
    isAzureOpenAITarget,
    shouldInjectAzureApiVersion,
    AZURE_DEFAULT_API_VERSION,
  },
} = require('./providers/copilot');

describe('isAzureOpenAITarget', () => {
  it('detects *.openai.azure.com', () => {
    expect(isAzureOpenAITarget('my-resource.openai.azure.com')).toBe(true);
  });

  it('detects *.cognitiveservices.azure.com', () => {
    expect(isAzureOpenAITarget('my-resource.cognitiveservices.azure.com')).toBe(true);
  });

  it('does not match standard Copilot target', () => {
    expect(isAzureOpenAITarget('api.githubcopilot.com')).toBe(false);
  });

  it('does not match partial hostname match', () => {
    expect(isAzureOpenAITarget('evil.openai.azure.com.attacker.com')).toBe(false);
    expect(isAzureOpenAITarget('openai.azure.com')).toBe(true);
  });

  it('does not match GitHub catalog targets', () => {
    expect(isAzureOpenAITarget('models.inference.ai.azure.com')).toBe(false);
  });
});

describe('shouldInjectAzureApiVersion', () => {
  it('returns true for Azure deployment-style base paths', () => {
    expect(shouldInjectAzureApiVersion('/openai/deployments/gpt-4o', '/chat/completions')).toBe(true);
  });

  it('returns false for Azure v1 base path', () => {
    expect(shouldInjectAzureApiVersion('/openai/v1', '/chat/completions')).toBe(false);
  });

  it('returns false when request path is Azure v1 formatted', () => {
    expect(shouldInjectAzureApiVersion('', '/openai/v1/chat/completions')).toBe(false);
  });
});

describe('Azure OpenAI BYOK adapter', () => {
  const azureEnv = {
    COPILOT_API_KEY: 'my-azure-api-key',
    COPILOT_API_TARGET: 'https://my-resource.openai.azure.com',
    COPILOT_API_BASE_PATH: '/openai/deployments/gpt-4o',
  };

  describe('getAuthHeaders', () => {
    it('uses api-key header for Azure targets', () => {
      const adapter = createCopilotAdapter(azureEnv);
      const req = { url: '/chat/completions', method: 'POST', headers: {} };
      const headers = adapter.getAuthHeaders(req);
      expect(headers).toEqual({ 'api-key': 'my-azure-api-key' });
    });

    it('does not include Copilot-Integration-Id for Azure targets', () => {
      const adapter = createCopilotAdapter(azureEnv);
      const req = { url: '/chat/completions', method: 'POST', headers: {} };
      const headers = adapter.getAuthHeaders(req);
      expect(headers['Copilot-Integration-Id']).toBeUndefined();
      expect(headers['Authorization']).toBeUndefined();
    });

    it('still uses Bearer auth for non-Azure targets', () => {
      const adapter = createCopilotAdapter({
        COPILOT_API_KEY: 'my-key',
        COPILOT_API_TARGET: 'https://api.githubcopilot.com',
      });
      const req = { url: '/chat/completions', method: 'POST', headers: {} };
      const headers = adapter.getAuthHeaders(req);
      expect(headers['Authorization']).toBe('Bearer my-key');
    });
  });

  describe('transformRequestUrl', () => {
    it('appends api-version when absent for Azure targets', () => {
      const adapter = createCopilotAdapter(azureEnv);
      const result = adapter.transformRequestUrl('/chat/completions');
      expect(result).toBe(`/chat/completions?api-version=${AZURE_DEFAULT_API_VERSION}`);
    });

    it('preserves existing api-version parameter', () => {
      const adapter = createCopilotAdapter(azureEnv);
      const result = adapter.transformRequestUrl('/chat/completions?api-version=2025-01-01');
      expect(result).toBe('/chat/completions?api-version=2025-01-01');
    });

    it('preserves other query parameters', () => {
      const adapter = createCopilotAdapter(azureEnv);
      const result = adapter.transformRequestUrl('/chat/completions?stream=true');
      expect(result).toContain('stream=true');
      expect(result).toContain(`api-version=${AZURE_DEFAULT_API_VERSION}`);
    });

    it('respects COPILOT_AZURE_API_VERSION override', () => {
      const adapter = createCopilotAdapter({
        ...azureEnv,
        COPILOT_AZURE_API_VERSION: '2025-03-01',
      });
      const result = adapter.transformRequestUrl('/chat/completions');
      expect(result).toBe('/chat/completions?api-version=2025-03-01');
    });

    it('does not append api-version for Azure OpenAI v1 base path', () => {
      const adapter = createCopilotAdapter({
        ...azureEnv,
        COPILOT_API_BASE_PATH: '/openai/v1',
      });
      const result = adapter.transformRequestUrl('/chat/completions?stream=true');
      expect(result).toBe('/chat/completions?stream=true');
    });

    it('does not append api-version for Azure OpenAI v1 request path', () => {
      const adapter = createCopilotAdapter({
        ...azureEnv,
        COPILOT_API_BASE_PATH: '',
      });
      const result = adapter.transformRequestUrl('/openai/v1/chat/completions?stream=true');
      expect(result).toBe('/openai/v1/chat/completions?stream=true');
    });

    it('is a no-op for non-Azure targets', () => {
      const adapter = createCopilotAdapter({
        COPILOT_API_KEY: 'my-key',
        COPILOT_API_TARGET: 'https://api.githubcopilot.com',
      });
      const result = adapter.transformRequestUrl('/v1/chat/completions');
      expect(result).toBe('/v1/chat/completions');
    });
  });

  describe('cognitiveservices.azure.com target', () => {
    it('also uses api-key header', () => {
      const adapter = createCopilotAdapter({
        COPILOT_API_KEY: 'cog-key',
        COPILOT_API_TARGET: 'https://my-resource.cognitiveservices.azure.com',
        COPILOT_API_BASE_PATH: '/openai/deployments/gpt-4o',
      });
      const req = { url: '/chat/completions', method: 'POST', headers: {} };
      const headers = adapter.getAuthHeaders(req);
      expect(headers).toEqual({ 'api-key': 'cog-key' });
    });
  });
});
