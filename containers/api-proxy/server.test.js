/**
 * Tests for api-proxy server.js
 */

const { deriveCopilotApiTarget, normalizeBasePath, buildUpstreamPath, extractInboundToken, validateProxyAuth } = require('./server');

describe('extractInboundToken', () => {
  it('should return x-api-key value when present', () => {
    const req = { headers: { 'x-api-key': 'my-token' } };
    expect(extractInboundToken(req)).toBe('my-token');
  });

  it('should return Bearer token from Authorization header', () => {
    const req = { headers: { authorization: 'Bearer my-bearer-token' } };
    expect(extractInboundToken(req)).toBe('my-bearer-token');
  });

  it('should prefer x-api-key over Authorization', () => {
    const req = { headers: { 'x-api-key': 'api-key-token', authorization: 'Bearer bearer-token' } };
    expect(extractInboundToken(req)).toBe('api-key-token');
  });

  it('should return null when no auth headers present', () => {
    const req = { headers: {} };
    expect(extractInboundToken(req)).toBeNull();
  });

  it('should return null when x-api-key is empty string', () => {
    const req = { headers: { 'x-api-key': '' } };
    expect(extractInboundToken(req)).toBeNull();
  });

  it('should return null when Authorization has no Bearer prefix', () => {
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
    expect(extractInboundToken(req)).toBeNull();
  });

  it('should handle Bearer token case-insensitively', () => {
    const req = { headers: { authorization: 'bearer my-token' } };
    expect(extractInboundToken(req)).toBe('my-token');
  });

  it('should return null when Authorization is just "Bearer " with no token', () => {
    const req = { headers: { authorization: 'Bearer ' } };
    expect(extractInboundToken(req)).toBeNull();
  });
});

describe('validateProxyAuth', () => {
  const VALID_TOKEN = 'a'.repeat(64);
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.AWF_PROXY_TOKEN;
    process.env.AWF_PROXY_TOKEN = VALID_TOKEN;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.AWF_PROXY_TOKEN = originalEnv;
    } else {
      delete process.env.AWF_PROXY_TOKEN;
    }
  });

  it('should return false when AWF_PROXY_TOKEN is not set', () => {
    delete process.env.AWF_PROXY_TOKEN;
    const req = { headers: { 'x-api-key': VALID_TOKEN } };
    expect(validateProxyAuth(req)).toBe(false);
  });

  it('should return true when x-api-key matches the proxy token', () => {
    const req = { headers: { 'x-api-key': VALID_TOKEN } };
    expect(validateProxyAuth(req)).toBe(true);
  });

  it('should return true when Authorization Bearer matches the proxy token', () => {
    const req = { headers: { authorization: `Bearer ${VALID_TOKEN}` } };
    expect(validateProxyAuth(req)).toBe(true);
  });

  it('should return false when no auth header is present', () => {
    const req = { headers: {} };
    expect(validateProxyAuth(req)).toBe(false);
  });

  it('should return false when x-api-key does not match', () => {
    const req = { headers: { 'x-api-key': 'wrong-token' } };
    expect(validateProxyAuth(req)).toBe(false);
  });

  it('should return false for a fabricated key (fake-key-test)', () => {
    const req = { headers: { 'x-api-key': 'fake-key-test' } };
    expect(validateProxyAuth(req)).toBe(false);
  });

  it('should return false when token has correct prefix but wrong length', () => {
    const req = { headers: { 'x-api-key': VALID_TOKEN.slice(0, -1) } };
    expect(validateProxyAuth(req)).toBe(false);
  });

  it('should return false when token is empty string', () => {
    const req = { headers: { 'x-api-key': '' } };
    expect(validateProxyAuth(req)).toBe(false);
  });

  it('should return false for the old hardcoded placeholder', () => {
    const req = { headers: { 'x-api-key': 'sk-ant-placeholder-key-for-credential-isolation' } };
    expect(validateProxyAuth(req)).toBe(false);
  });

  it('should return false for the old placeholder-token-for-credential-isolation string', () => {
    const req = { headers: { 'x-api-key': 'placeholder-token-for-credential-isolation' } };
    expect(validateProxyAuth(req)).toBe(false);
  });
});



describe('deriveCopilotApiTarget', () => {
  let originalEnv;

  beforeEach(() => {
    // Save original env vars
    originalEnv = {
      COPILOT_API_TARGET: process.env.COPILOT_API_TARGET,
      GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
    };
    // Clear env vars before each test
    delete process.env.COPILOT_API_TARGET;
    delete process.env.GITHUB_SERVER_URL;
  });

  afterEach(() => {
    // Restore original env vars
    if (originalEnv.COPILOT_API_TARGET !== undefined) {
      process.env.COPILOT_API_TARGET = originalEnv.COPILOT_API_TARGET;
    } else {
      delete process.env.COPILOT_API_TARGET;
    }
    if (originalEnv.GITHUB_SERVER_URL !== undefined) {
      process.env.GITHUB_SERVER_URL = originalEnv.GITHUB_SERVER_URL;
    } else {
      delete process.env.GITHUB_SERVER_URL;
    }
  });

  describe('COPILOT_API_TARGET env var (highest priority)', () => {
    it('should return COPILOT_API_TARGET when explicitly set', () => {
      process.env.COPILOT_API_TARGET = 'custom.api.com';
      expect(deriveCopilotApiTarget()).toBe('custom.api.com');
    });

    it('should prefer COPILOT_API_TARGET over GITHUB_SERVER_URL', () => {
      process.env.COPILOT_API_TARGET = 'custom.api.com';
      process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
      expect(deriveCopilotApiTarget()).toBe('custom.api.com');
    });
  });

  describe('GitHub Enterprise Cloud (*.ghe.com)', () => {
    it('should derive copilot-api.<subdomain>.ghe.com for GHEC tenants', () => {
      process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
      expect(deriveCopilotApiTarget()).toBe('copilot-api.mycompany.ghe.com');
    });

    it('should handle GHEC URLs with trailing slash', () => {
      process.env.GITHUB_SERVER_URL = 'https://example.ghe.com/';
      expect(deriveCopilotApiTarget()).toBe('copilot-api.example.ghe.com');
    });

    it('should handle GHEC URLs with path components', () => {
      process.env.GITHUB_SERVER_URL = 'https://acme.ghe.com/some/path';
      expect(deriveCopilotApiTarget()).toBe('copilot-api.acme.ghe.com');
    });

    it('should handle multi-part subdomain for GHEC', () => {
      process.env.GITHUB_SERVER_URL = 'https://dev.mycompany.ghe.com';
      expect(deriveCopilotApiTarget()).toBe('copilot-api.dev.mycompany.ghe.com');
    });
  });

  describe('GitHub Enterprise Server (GHES)', () => {
    it('should return api.enterprise.githubcopilot.com for GHES', () => {
      process.env.GITHUB_SERVER_URL = 'https://github.example.com';
      expect(deriveCopilotApiTarget()).toBe('api.enterprise.githubcopilot.com');
    });

    it('should handle GHES with IP address', () => {
      process.env.GITHUB_SERVER_URL = 'https://192.168.1.100';
      expect(deriveCopilotApiTarget()).toBe('api.enterprise.githubcopilot.com');
    });

    it('should handle GHES with custom port', () => {
      process.env.GITHUB_SERVER_URL = 'https://github.internal:8443';
      expect(deriveCopilotApiTarget()).toBe('api.enterprise.githubcopilot.com');
    });
  });

  describe('GitHub.com (public)', () => {
    it('should return api.githubcopilot.com for github.com', () => {
      process.env.GITHUB_SERVER_URL = 'https://github.com';
      expect(deriveCopilotApiTarget()).toBe('api.githubcopilot.com');
    });

    it('should handle github.com with trailing slash', () => {
      process.env.GITHUB_SERVER_URL = 'https://github.com/';
      expect(deriveCopilotApiTarget()).toBe('api.githubcopilot.com');
    });

    it('should handle github.com with path', () => {
      process.env.GITHUB_SERVER_URL = 'https://github.com/github/hub';
      expect(deriveCopilotApiTarget()).toBe('api.githubcopilot.com');
    });
  });

  describe('Default behavior', () => {
    it('should return api.githubcopilot.com when no env vars are set', () => {
      expect(deriveCopilotApiTarget()).toBe('api.githubcopilot.com');
    });

    it('should return default when GITHUB_SERVER_URL is empty string', () => {
      process.env.GITHUB_SERVER_URL = '';
      expect(deriveCopilotApiTarget()).toBe('api.githubcopilot.com');
    });

    it('should return default when GITHUB_SERVER_URL is invalid', () => {
      process.env.GITHUB_SERVER_URL = 'not-a-valid-url';
      expect(deriveCopilotApiTarget()).toBe('api.githubcopilot.com');
    });

    it('should return default when GITHUB_SERVER_URL is malformed', () => {
      process.env.GITHUB_SERVER_URL = 'ht!tp://bad-url';
      expect(deriveCopilotApiTarget()).toBe('api.githubcopilot.com');
    });
  });
});

describe('normalizeBasePath', () => {
  it('should return empty string for undefined', () => {
    expect(normalizeBasePath(undefined)).toBe('');
  });

  it('should return empty string for null', () => {
    expect(normalizeBasePath(null)).toBe('');
  });

  it('should return empty string for empty string', () => {
    expect(normalizeBasePath('')).toBe('');
  });

  it('should return empty string for whitespace-only string', () => {
    expect(normalizeBasePath('   ')).toBe('');
  });

  it('should preserve a well-formed path', () => {
    expect(normalizeBasePath('/serving-endpoints')).toBe('/serving-endpoints');
  });

  it('should add leading slash when missing', () => {
    expect(normalizeBasePath('serving-endpoints')).toBe('/serving-endpoints');
  });

  it('should strip trailing slash', () => {
    expect(normalizeBasePath('/serving-endpoints/')).toBe('/serving-endpoints');
  });

  it('should handle multi-segment paths', () => {
    expect(normalizeBasePath('/openai/deployments/gpt-4')).toBe('/openai/deployments/gpt-4');
  });

  it('should normalize a path missing the leading slash and with trailing slash', () => {
    expect(normalizeBasePath('openai/deployments/gpt-4/')).toBe('/openai/deployments/gpt-4');
  });

  it('should preserve a root-only path', () => {
    expect(normalizeBasePath('/')).toBe('/');
  });
});

describe('buildUpstreamPath', () => {
  const HOST = 'api.example.com';

  describe('no base path (empty string)', () => {
    it('should return the request path unchanged when basePath is empty', () => {
      expect(buildUpstreamPath('/v1/chat/completions', HOST, '')).toBe('/v1/chat/completions');
    });

    it('should preserve query string when basePath is empty', () => {
      expect(buildUpstreamPath('/v1/chat/completions?stream=true', HOST, '')).toBe('/v1/chat/completions?stream=true');
    });

    it('should preserve multiple query params when basePath is empty', () => {
      expect(buildUpstreamPath('/v1/models?limit=10&order=asc', HOST, '')).toBe('/v1/models?limit=10&order=asc');
    });

    it('should handle root path with no base path', () => {
      expect(buildUpstreamPath('/', HOST, '')).toBe('/');
    });
  });

  describe('Databricks serving-endpoints (single-segment base path)', () => {
    it('should prepend /serving-endpoints to chat completions path', () => {
      expect(buildUpstreamPath('/v1/chat/completions', HOST, '/serving-endpoints'))
        .toBe('/serving-endpoints/v1/chat/completions');
    });

    it('should prepend /serving-endpoints and preserve query string', () => {
      expect(buildUpstreamPath('/v1/chat/completions?stream=true', HOST, '/serving-endpoints'))
        .toBe('/serving-endpoints/v1/chat/completions?stream=true');
    });

    it('should prepend /serving-endpoints to models path', () => {
      expect(buildUpstreamPath('/v1/models', HOST, '/serving-endpoints'))
        .toBe('/serving-endpoints/v1/models');
    });

    it('should prepend /serving-endpoints to embeddings path', () => {
      expect(buildUpstreamPath('/v1/embeddings', HOST, '/serving-endpoints'))
        .toBe('/serving-endpoints/v1/embeddings');
    });
  });

  describe('Azure OpenAI deployments (multi-segment base path)', () => {
    it('should prepend Azure deployment path to chat completions', () => {
      expect(buildUpstreamPath('/chat/completions', HOST, '/openai/deployments/gpt-4'))
        .toBe('/openai/deployments/gpt-4/chat/completions');
    });

    it('should prepend Azure deployment path and preserve api-version query param', () => {
      expect(buildUpstreamPath('/chat/completions?api-version=2024-02-01', HOST, '/openai/deployments/gpt-4'))
        .toBe('/openai/deployments/gpt-4/chat/completions?api-version=2024-02-01');
    });

    it('should handle a deeply nested Azure deployment name', () => {
      expect(buildUpstreamPath('/chat/completions', HOST, '/openai/deployments/my-custom-gpt-4-deployment'))
        .toBe('/openai/deployments/my-custom-gpt-4-deployment/chat/completions');
    });
  });

  describe('Anthropic custom target with base path', () => {
    it('should prepend /anthropic to messages endpoint', () => {
      expect(buildUpstreamPath('/v1/messages', 'proxy.corporate.com', '/anthropic'))
        .toBe('/anthropic/v1/messages');
    });

    it('should preserve Anthropic query params', () => {
      expect(buildUpstreamPath('/v1/messages?beta=true', 'proxy.corporate.com', '/anthropic'))
        .toBe('/anthropic/v1/messages?beta=true');
    });
  });

  describe('path preservation for real-world API endpoints', () => {
    it('should preserve /v1/chat/completions exactly (OpenAI standard path)', () => {
      expect(buildUpstreamPath('/v1/chat/completions', 'api.openai.com', ''))
        .toBe('/v1/chat/completions');
    });

    it('should preserve /v1/messages exactly (Anthropic standard path)', () => {
      expect(buildUpstreamPath('/v1/messages', 'api.anthropic.com', ''))
        .toBe('/v1/messages');
    });

    it('should handle URL-encoded characters in path', () => {
      // %2F is preserved by the URL parser (an encoded slash stays encoded)
      expect(buildUpstreamPath('/v1/models/gpt-4%2Fturbo', HOST, '/serving-endpoints'))
        .toBe('/serving-endpoints/v1/models/gpt-4%2Fturbo');
    });

    it('should handle hash fragment being ignored (not forwarded in HTTP requests)', () => {
      // Hash fragments are never sent to the server; URL parser drops them
      expect(buildUpstreamPath('/v1/chat/completions#fragment', HOST, '/serving-endpoints'))
        .toBe('/serving-endpoints/v1/chat/completions');
    });

    it('should drop empty query string marker', () => {
      expect(buildUpstreamPath('/v1/chat/completions?', HOST, '/serving-endpoints'))
        .toBe('/serving-endpoints/v1/chat/completions');
    });
  });
});
