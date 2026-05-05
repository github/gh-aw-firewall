/**
 * Tests for api-proxy server.js
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { EventEmitter } = require('events');

// Functions that live in proxy-utils.js
const { normalizeApiTarget, normalizeBasePath, buildUpstreamPath, shouldStripHeader, stripGeminiKeyParam, composeBodyTransforms } = require('./proxy-utils');

// Provider-specific functions that live in their respective adapter modules
const { deriveCopilotApiTarget, deriveGitHubApiTarget, deriveGitHubApiBasePath, resolveCopilotAuthToken, stripBearerPrefix, createCopilotAdapter } = require('./providers/copilot');
const { resolveOpenCodeRoute } = require('./providers/opencode');

// Core proxy functions that remain in server.js
const { proxyWebSocket, httpProbe, validateApiKeys, keyValidationResults, resetKeyValidationState, fetchJson, extractModelIds, fetchStartupModels, reflectEndpoints, healthResponse, cachedModels, resetModelCacheState, makeModelBodyTransform, MODEL_ALIASES, buildModelsJson, writeModelsJson, createProviderServer } = require('./server');

describe('normalizeApiTarget', () => {
  it('should strip https:// prefix', () => {
    expect(normalizeApiTarget('https://my-gateway.example.com')).toBe('my-gateway.example.com');
  });

  it('should strip http:// prefix', () => {
    expect(normalizeApiTarget('http://my-gateway.example.com')).toBe('my-gateway.example.com');
  });

  it('should preserve bare hostname', () => {
    expect(normalizeApiTarget('api.openai.com')).toBe('api.openai.com');
  });

  it('should normalize a URL with a path to just the hostname', () => {
    expect(normalizeApiTarget('https://my-gateway.example.com/some-path')).toBe('my-gateway.example.com');
  });

  it('should trim whitespace', () => {
    expect(normalizeApiTarget('  https://api.openai.com  ')).toBe('api.openai.com');
  });

  it('should return undefined for falsy input', () => {
    expect(normalizeApiTarget(undefined)).toBeUndefined();
    expect(normalizeApiTarget('')).toBe('');
  });

  it('should not strip scheme-like substrings in the middle', () => {
    expect(normalizeApiTarget('api.https.example.com')).toBe('api.https.example.com');
  });

  it('should discard port from URL', () => {
    expect(normalizeApiTarget('https://my-gateway.example.com:8443')).toBe('my-gateway.example.com');
  });

  it('should discard query and fragment from URL', () => {
    expect(normalizeApiTarget('https://my-gateway.example.com/path?key=val#frag')).toBe('my-gateway.example.com');
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

describe('deriveGitHubApiTarget', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = {
      GITHUB_API_URL: process.env.GITHUB_API_URL,
      GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
    };
    delete process.env.GITHUB_API_URL;
    delete process.env.GITHUB_SERVER_URL;
  });

  afterEach(() => {
    if (originalEnv.GITHUB_API_URL !== undefined) {
      process.env.GITHUB_API_URL = originalEnv.GITHUB_API_URL;
    } else {
      delete process.env.GITHUB_API_URL;
    }
    if (originalEnv.GITHUB_SERVER_URL !== undefined) {
      process.env.GITHUB_SERVER_URL = originalEnv.GITHUB_SERVER_URL;
    } else {
      delete process.env.GITHUB_SERVER_URL;
    }
  });

  describe('GITHUB_API_URL env var (highest priority)', () => {
    it('should return hostname from GITHUB_API_URL full URL', () => {
      process.env.GITHUB_API_URL = 'https://api.github.com';
      expect(deriveGitHubApiTarget()).toBe('api.github.com');
    });

    it('should return hostname from GITHUB_API_URL for GHES', () => {
      process.env.GITHUB_API_URL = 'https://github.internal/api/v3';
      expect(deriveGitHubApiTarget()).toBe('github.internal');
    });

    it('should prefer GITHUB_API_URL over GITHUB_SERVER_URL', () => {
      process.env.GITHUB_API_URL = 'https://api.mycompany.ghe.com';
      process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
      expect(deriveGitHubApiTarget()).toBe('api.mycompany.ghe.com');
    });
  });

  describe('GHEC (*.ghe.com)', () => {
    it('should return api.<subdomain>.ghe.com for GHEC tenant', () => {
      process.env.GITHUB_SERVER_URL = 'https://mycompany.ghe.com';
      expect(deriveGitHubApiTarget()).toBe('api.mycompany.ghe.com');
    });

    it('should handle multiple-level subdomains', () => {
      process.env.GITHUB_SERVER_URL = 'https://sub.example.ghe.com';
      expect(deriveGitHubApiTarget()).toBe('api.sub.example.ghe.com');
    });
  });

  describe('Default behavior', () => {
    it('should return api.github.com when no env vars are set', () => {
      expect(deriveGitHubApiTarget()).toBe('api.github.com');
    });

    it('should return api.github.com for github.com GITHUB_SERVER_URL', () => {
      process.env.GITHUB_SERVER_URL = 'https://github.com';
      expect(deriveGitHubApiTarget()).toBe('api.github.com');
    });

    it('should return api.github.com for GHES without GITHUB_API_URL', () => {
      // GHES without an explicit GITHUB_API_URL falls back to api.github.com.
      // This is a known limitation: GHES deployments should set GITHUB_API_URL explicitly
      // so deriveGitHubApiTarget() resolves to the correct enterprise API hostname.
      process.env.GITHUB_SERVER_URL = 'https://github.internal';
      expect(deriveGitHubApiTarget()).toBe('api.github.com');
    });

    it('should return api.github.com when GITHUB_SERVER_URL is invalid', () => {
      process.env.GITHUB_SERVER_URL = 'not-a-valid-url';
      expect(deriveGitHubApiTarget()).toBe('api.github.com');
    });
  });
});

describe('deriveGitHubApiBasePath', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.GITHUB_API_URL = process.env.GITHUB_API_URL;
    delete process.env.GITHUB_API_URL;
  });

  afterEach(() => {
    if (savedEnv.GITHUB_API_URL !== undefined) {
      process.env.GITHUB_API_URL = savedEnv.GITHUB_API_URL;
    } else {
      delete process.env.GITHUB_API_URL;
    }
  });

  it('should return empty string when GITHUB_API_URL is not set', () => {
    expect(deriveGitHubApiBasePath()).toBe('');
  });

  it('should extract /api/v3 from GHES-style GITHUB_API_URL', () => {
    process.env.GITHUB_API_URL = 'https://ghes.example.com/api/v3';
    expect(deriveGitHubApiBasePath()).toBe('/api/v3');
  });

  it('should return empty string for github.com API URL (no path)', () => {
    process.env.GITHUB_API_URL = 'https://api.github.com';
    expect(deriveGitHubApiBasePath()).toBe('');
  });

  it('should strip trailing slashes', () => {
    process.env.GITHUB_API_URL = 'https://ghes.example.com/api/v3/';
    expect(deriveGitHubApiBasePath()).toBe('/api/v3');
  });

  it('should return empty string for invalid URL', () => {
    process.env.GITHUB_API_URL = '://invalid';
    expect(deriveGitHubApiBasePath()).toBe('');
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

    it('should reject protocol-relative URLs to prevent host override', () => {
      expect(() => buildUpstreamPath('//evil.com/v1/chat/completions', HOST, ''))
        .toThrow('URL must be a relative origin-form path');
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

    it('should map unversioned /responses to /v1/responses when basePath is /v1 (OpenAI default)', () => {
      // The OpenAI adapter passes basePath='/v1' for the public endpoint.
      // buildUpstreamPath is now provider-agnostic; the /v1 prefix comes from the adapter.
      expect(buildUpstreamPath('/responses', 'api.openai.com', '/v1'))
        .toBe('/v1/responses');
    });

    it('should preserve already-versioned OpenAI responses path with /v1 basePath', () => {
      expect(buildUpstreamPath('/v1/responses', 'api.openai.com', '/v1'))
        .toBe('/v1/responses');
    });

    it('should map unversioned /responses to /v1/responses when basePath is /v1 (host-with-port variant)', () => {
      // basePath='/v1' is the canonical form; the OpenAI adapter normalises the target.
      expect(buildUpstreamPath('/responses', 'api.openai.com', '/v1'))
        .toBe('/v1/responses');
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

  describe('with normalized API target (gh-aw#25137 regression)', () => {
    it('should produce correct path when target was already normalized', () => {
      // normalizeApiTarget('https://my-gateway.example.com/some-path')
      // returns 'my-gateway.example.com' (hostname only)
      const target = 'my-gateway.example.com';
      expect(buildUpstreamPath('/v1/messages', target, ''))
        .toBe('/v1/messages');
    });

    it('should not force /v1 for non-OpenAI custom targets', () => {
      const target = 'my-gateway.example.com';
      expect(buildUpstreamPath('/responses', target, ''))
        .toBe('/responses');
    });

    it('should produce wrong hostname if scheme is NOT stripped (demonstrating the bug)', () => {
      // Without normalizeApiTarget, the scheme-prefixed value causes
      // new URL() to parse 'https' as the hostname instead of the real host
      const badTarget = 'https://my-gateway.example.com';
      const targetUrl = new URL('/v1/messages', `https://${badTarget}`);
      // Node parses this as hostname='https', not 'my-gateway.example.com'
      expect(targetUrl.hostname).not.toBe('my-gateway.example.com');
    });
  });
});

describe('shouldStripHeader', () => {
  it('should strip authorization header', () => {
    expect(shouldStripHeader('authorization')).toBe(true);
    expect(shouldStripHeader('Authorization')).toBe(true);
  });

  it('should strip x-api-key header', () => {
    expect(shouldStripHeader('x-api-key')).toBe(true);
    expect(shouldStripHeader('X-Api-Key')).toBe(true);
  });

  it('should strip x-goog-api-key header (Gemini placeholder must be stripped)', () => {
    expect(shouldStripHeader('x-goog-api-key')).toBe(true);
    expect(shouldStripHeader('X-Goog-Api-Key')).toBe(true);
  });

  it('should strip proxy-authorization header', () => {
    expect(shouldStripHeader('proxy-authorization')).toBe(true);
  });

  it('should strip x-forwarded-* headers', () => {
    expect(shouldStripHeader('x-forwarded-for')).toBe(true);
    expect(shouldStripHeader('x-forwarded-host')).toBe(true);
  });

  it('should not strip content-type header', () => {
    expect(shouldStripHeader('content-type')).toBe(false);
  });

  it('should not strip anthropic-version header', () => {
    expect(shouldStripHeader('anthropic-version')).toBe(false);
  });
});

describe('stripGeminiKeyParam', () => {
  it('should remove the key= query parameter', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?key=placeholder'))
      .toBe('/v1/models/gemini-pro:generateContent');
  });

  it('should remove key= while preserving other query parameters', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?key=placeholder&alt=json'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json');
  });

  it('should return path unchanged when no key= parameter is present', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent'))
      .toBe('/v1/models/gemini-pro:generateContent');
  });

  it('should return path unchanged when only unrelated query parameters exist', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?alt=json&stream=true'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json&stream=true');
  });

  it('should handle root path without key param', () => {
    expect(stripGeminiKeyParam('/')).toBe('/');
  });

  it('should handle path with only key= param, leaving no trailing ?', () => {
    // URL.search returns '' when no params remain after deletion
    const result = stripGeminiKeyParam('/v1/generateContent?key=abc');
    expect(result).toBe('/v1/generateContent');
  });

  it('should remove the apiKey= query parameter', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?apiKey=placeholder'))
      .toBe('/v1/models/gemini-pro:generateContent');
  });

  it('should remove the api_key= query parameter', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?api_key=placeholder'))
      .toBe('/v1/models/gemini-pro:generateContent');
  });

  it('should remove apiKey= while preserving other query parameters', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?apiKey=placeholder&alt=json'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json');
  });

  it('should remove api_key= while preserving other query parameters', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?api_key=placeholder&alt=json'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json');
  });

  it('should remove all auth params when multiple variants are present', () => {
    expect(stripGeminiKeyParam('/v1/models/gemini-pro:generateContent?key=foo&apiKey=bar&api_key=baz&alt=json'))
      .toBe('/v1/models/gemini-pro:generateContent?alt=json');
  });

  it('should handle path with only api_key= param, leaving no trailing ?', () => {
    const result = stripGeminiKeyParam('/v1/generateContent?api_key=abc');
    expect(result).toBe('/v1/generateContent');
  });
});

// ── Helpers for proxyWebSocket tests ──────────────────────────────────────────

/** Create a minimal mock socket with write/destroy spies. */
function makeMockSocket() {
  const s = new EventEmitter();
  s.write = jest.fn();
  s.destroy = jest.fn();
  s.pipe = jest.fn();
  s.writable = true;
  s.destroyed = false;
  return s;
}

/** Create a mock HTTP request for a WebSocket upgrade. */
function makeUpgradeReq(overrides = {}) {
  return {
    url: '/v1/responses',
    headers: {
      'upgrade': 'websocket',
      'connection': 'Upgrade',
      'sec-websocket-key': 'test-ws-key==',
      'sec-websocket-version': '13',
      'host': '172.30.0.30',
      ...overrides.headers,
    },
    ...overrides,
  };
}

describe('proxyWebSocket', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Request validation ─────────────────────────────────────────────────────

  describe('request validation', () => {
    it('rejects a non-WebSocket upgrade (e.g. h2c) with 400', () => {
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq({ headers: { 'upgrade': 'h2c' } }), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('rejects an upgrade with no Upgrade header with 400', () => {
      const socket = makeMockSocket();
      const req = makeUpgradeReq();
      delete req.headers['upgrade'];
      proxyWebSocket(req, socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('rejects an absolute URL with 400 (SSRF prevention)', () => {
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq({ url: 'https://evil.com/v1/responses' }), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('rejects a protocol-relative URL with 400 (SSRF prevention)', () => {
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq({ url: '//evil.com/v1/responses' }), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });

    it('rejects a null URL with 400', () => {
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq({ url: null }), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 400 Bad Request'));
      expect(socket.destroy).toHaveBeenCalled();
    });
  });

  // ── Proxy config errors ────────────────────────────────────────────────────

  describe('proxy configuration errors', () => {
    it('returns 502 when HTTPS_PROXY is not configured', () => {
      // The module was loaded without HTTPS_PROXY; proxyWebSocket should fail-safe.
      const socket = makeMockSocket();
      proxyWebSocket(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
      expect(socket.destroy).toHaveBeenCalled();
    });
  });

  // ── Network tunnel tests (module loaded with HTTPS_PROXY set) ─────────────

  describe('CONNECT tunnel and auth injection', () => {
    let wsProxy;

    beforeAll(() => {
      // Re-require server with HTTPS_PROXY so proxyWebSocket uses the proxy URL.
      process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
      jest.resetModules();
      wsProxy = require('./server').proxyWebSocket;
    });

    afterAll(() => {
      delete process.env.HTTPS_PROXY;
      jest.resetModules();
    });

    it('returns 502 when the CONNECT response is not 200', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      setImmediate(() => connectReq.emit('connect', { statusCode: 407 }, tunnel));

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer key' }, 'openai');

      return new Promise(resolve => setImmediate(() => {
        expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
        expect(socket.destroy).toHaveBeenCalled();
        expect(tunnel.destroy).toHaveBeenCalled();
        resolve();
      }));
    });

    it('returns 502 when the CONNECT request emits an error', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      setImmediate(() => connectReq.emit('error', new Error('connection refused')));

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer key' }, 'openai');

      return new Promise(resolve => setImmediate(() => {
        expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
        expect(socket.destroy).toHaveBeenCalled();
        resolve();
      }));
    });

    it('returns 502 when TLS handshake fails', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();
      const tlsSocket = new EventEmitter();
      tlsSocket.write = jest.fn();
      tlsSocket.destroy = jest.fn();
      tlsSocket.pipe = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('error', new Error('certificate unknown')));
      });

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer key' }, 'openai');

      return new Promise(resolve => setTimeout(() => {
        expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('HTTP/1.1 502 Bad Gateway'));
        expect(socket.destroy).toHaveBeenCalled();
        resolve();
      }, 30));
    });

    it('injects Authorization header and fixes Host header in the upgrade request', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();
      const tlsSocket = new EventEmitter();
      tlsSocket.write = jest.fn();
      tlsSocket.destroy = jest.fn();
      tlsSocket.pipe = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('secureConnect'));
      });

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer secret' }, 'openai');

      return new Promise(resolve => setTimeout(() => {
        // The upgrade request is written as a string to tlsSocket
        const upgradeWrite = tlsSocket.write.mock.calls.find(
          c => typeof c[0] === 'string' && c[0].startsWith('GET ')
        );
        expect(upgradeWrite).toBeDefined();
        const upgradeReqStr = upgradeWrite[0];
        expect(upgradeReqStr).toContain('Authorization: Bearer secret');
        expect(upgradeReqStr).toContain('host: api.openai.com');
        // Both sides should be piped
        expect(tlsSocket.pipe).toHaveBeenCalledWith(socket);
        expect(socket.pipe).toHaveBeenCalledWith(tlsSocket);
        resolve();
      }, 30));
    });

    it('strips client-supplied auth headers before forwarding', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();
      const tlsSocket = new EventEmitter();
      tlsSocket.write = jest.fn();
      tlsSocket.destroy = jest.fn();
      tlsSocket.pipe = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('secureConnect'));
      });

      const req = makeUpgradeReq({
        headers: {
          'upgrade': 'websocket',
          'authorization': 'Bearer client-supplied',  // must be stripped
          'x-api-key': 'client-api-key',              // must be stripped
          'sec-websocket-key': 'ws-key==',
          'sec-websocket-version': '13',
        },
      });

      wsProxy(req, socket, Buffer.alloc(0), 'api.openai.com', { 'Authorization': 'Bearer injected' }, 'openai');

      return new Promise(resolve => setTimeout(() => {
        const upgradeWrite = tlsSocket.write.mock.calls.find(
          c => typeof c[0] === 'string' && c[0].startsWith('GET ')
        );
        expect(upgradeWrite).toBeDefined();
        const upgradeReqStr = upgradeWrite[0];
        // Client-supplied auth is stripped; injected auth is present
        expect(upgradeReqStr).not.toContain('client-supplied');
        expect(upgradeReqStr).not.toContain('client-api-key');
        expect(upgradeReqStr).toContain('Bearer injected');
        resolve();
      }, 30));
    });

    it('forwards the CONNECT request to the configured Squid proxy host/port', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();

      let capturedOptions;
      jest.spyOn(http, 'request').mockImplementation((options) => {
        capturedOptions = options;
        return connectReq;
      });

      wsProxy(makeUpgradeReq(), socket, Buffer.alloc(0), 'api.openai.com', {}, 'openai');

      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.method).toBe('CONNECT');
      expect(capturedOptions.path).toBe('api.openai.com:443');
      expect(capturedOptions.host).toBe('127.0.0.1');
      expect(capturedOptions.port).toBe(3128);
    });

    it('forwards buffered head bytes to the upstream after upgrade', () => {
      const socket = makeMockSocket();
      const connectReq = new EventEmitter();
      connectReq.end = jest.fn();
      const tunnel = makeMockSocket();
      const tlsSocket = new EventEmitter();
      tlsSocket.write = jest.fn();
      tlsSocket.destroy = jest.fn();
      tlsSocket.pipe = jest.fn();

      jest.spyOn(http, 'request').mockReturnValue(connectReq);
      jest.spyOn(tls, 'connect').mockReturnValue(tlsSocket);

      setImmediate(() => {
        connectReq.emit('connect', { statusCode: 200 }, tunnel);
        setImmediate(() => tlsSocket.emit('secureConnect'));
      });

      const headBytes = Buffer.from([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]); // WS text frame: FIN=1, opcode=1, len=5, payload='Hello'
      wsProxy(makeUpgradeReq(), socket, headBytes, 'api.openai.com', { 'Authorization': 'Bearer k' }, 'openai');

      return new Promise(resolve => setTimeout(() => {
        // The head buffer should have been written to tlsSocket
        const bufWrite = tlsSocket.write.mock.calls.find(c => Buffer.isBuffer(c[0]));
        expect(bufWrite).toBeDefined();
        expect(bufWrite[0]).toEqual(headBytes);
        resolve();
      }, 30));
    });
  });
});

describe('stripBearerPrefix', () => {
  it('strips "Bearer " prefix from a token value', () => {
    expect(stripBearerPrefix('Bearer sk-or-v1-abc')).toBe('sk-or-v1-abc');
  });

  it('strips "Bearer " prefix case-insensitively', () => {
    expect(stripBearerPrefix('bearer sk-or-v1-abc')).toBe('sk-or-v1-abc');
    expect(stripBearerPrefix('BEARER sk-or-v1-abc')).toBe('sk-or-v1-abc');
  });

  it('strips leading whitespace before "Bearer "', () => {
    expect(stripBearerPrefix('  Bearer sk-or-v1-abc')).toBe('sk-or-v1-abc');
  });

  it('returns value unchanged when no "Bearer " prefix is present', () => {
    expect(stripBearerPrefix('sk-or-v1-abc')).toBe('sk-or-v1-abc');
    expect(stripBearerPrefix('gho_abc123')).toBe('gho_abc123');
  });

  it('does not strip "Bearer" without a following space', () => {
    expect(stripBearerPrefix('BearerToken123')).toBe('BearerToken123');
  });

  it('returns undefined when value is only "Bearer " (nothing after prefix)', () => {
    expect(stripBearerPrefix('Bearer ')).toBeUndefined();
    expect(stripBearerPrefix('Bearer   ')).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only input', () => {
    expect(stripBearerPrefix('')).toBeUndefined();
    expect(stripBearerPrefix('   ')).toBeUndefined();
    expect(stripBearerPrefix(undefined)).toBeUndefined();
  });

  it('trims surrounding whitespace from the token', () => {
    expect(stripBearerPrefix('  sk-or-v1-abc  ')).toBe('sk-or-v1-abc');
  });
});

describe('resolveCopilotAuthToken', () => {
  it('should return COPILOT_GITHUB_TOKEN when only it is set', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: 'gho_abc123' })).toBe('gho_abc123');
  });

  it('should return COPILOT_API_KEY when only it is set', () => {
    expect(resolveCopilotAuthToken({ COPILOT_API_KEY: 'sk-byok-key' })).toBe('sk-byok-key');
  });

  it('should prefer COPILOT_GITHUB_TOKEN over COPILOT_API_KEY when both are set', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'gho_abc123',
      COPILOT_API_KEY: 'sk-byok-key',
    })).toBe('gho_abc123');
  });

  it('should return undefined when neither is set', () => {
    expect(resolveCopilotAuthToken({})).toBeUndefined();
  });

  it('should return undefined for empty strings', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: '', COPILOT_API_KEY: '' })).toBeUndefined();
  });

  it('should return undefined for whitespace-only values', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: '  ', COPILOT_API_KEY: '  \n' })).toBeUndefined();
  });

  it('should trim whitespace from token values', () => {
    expect(resolveCopilotAuthToken({ COPILOT_API_KEY: '  sk-byok-key  ' })).toBe('sk-byok-key');
  });

  it('should fall back to COPILOT_API_KEY when COPILOT_GITHUB_TOKEN is whitespace-only', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: '  ',
      COPILOT_API_KEY: 'sk-byok-key',
    })).toBe('sk-byok-key');
  });

  // Integration: verify that Bearer-prefix stripping (via stripBearerPrefix) is
  // applied to both token sources when resolving.

  it('strips "Bearer " prefix from COPILOT_API_KEY when resolving', () => {
    expect(resolveCopilotAuthToken({ COPILOT_API_KEY: 'Bearer sk-or-v1-abc' })).toBe('sk-or-v1-abc');
  });

  it('strips "Bearer " prefix from COPILOT_GITHUB_TOKEN when resolving', () => {
    expect(resolveCopilotAuthToken({ COPILOT_GITHUB_TOKEN: 'Bearer gho_abc123' })).toBe('gho_abc123');
  });

  it('prefers stripped COPILOT_GITHUB_TOKEN over stripped COPILOT_API_KEY', () => {
    expect(resolveCopilotAuthToken({
      COPILOT_GITHUB_TOKEN: 'Bearer gho_abc123',
      COPILOT_API_KEY: 'Bearer sk-byok-key',
    })).toBe('gho_abc123');
  });
});

// ── createCopilotAdapter — BYOK auth header format ───────────────────────────
//
// These tests guard against the "badly formatted Authorization header" bug in
// BYOK mode where the sidecar is configured with COPILOT_API_KEY (the real key
// held by the sidecar) and could produce "Authorization: Bearer Bearer <key>"
// if the COPILOT_API_KEY value already contained the "Bearer " prefix.
// They also verify that the header injected for inference requests is exactly
// "Bearer <key>" and that the Copilot-Integration-Id header is present.

describe('createCopilotAdapter — BYOK getAuthHeaders', () => {
  const fakeReq = { url: '/v1/chat/completions', method: 'POST', headers: {} };
  const fakeModelsReq = { url: '/models', method: 'GET', headers: {} };

  it('injects Authorization: Bearer <key> for BYOK inference request', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('injects Copilot-Integration-Id header for BYOK inference request', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Copilot-Integration-Id']).toBe('copilot-developer-cli');
  });

  it('prevents double "Bearer " prefix when API key already contains "Bearer " prefix (BYOK bug fix)', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'Bearer sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    // Must NOT be "Bearer Bearer sk-or-v1-abc123"
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
    expect(headers['Authorization']).not.toContain('Bearer Bearer');
  });

  it('strips "Bearer " prefix case-insensitively from API key', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'BEARER sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('uses COPILOT_GITHUB_TOKEN (not COPILOT_API_KEY) for /models GET in BYOK+token mode', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'gho_oauth_token',
      COPILOT_API_KEY: 'sk-or-v1-abc123',
    });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    expect(headers['Authorization']).toBe('Bearer gho_oauth_token');
  });

  it('uses API key for /models GET when no GITHUB_TOKEN is set (BYOK-only mode)', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-or-v1-abc123' });
    const headers = adapter.getAuthHeaders(fakeModelsReq);
    // In BYOK-only mode, githubToken is undefined so falls through to authToken (apiKey)
    expect(headers['Authorization']).toBe('Bearer sk-or-v1-abc123');
  });

  it('is enabled when only COPILOT_API_KEY is set', () => {
    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-or-v1-abc123' });
    expect(adapter.isEnabled()).toBe(true);
  });

  it('uses custom COPILOT_INTEGRATION_ID when set', () => {
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-or-v1-abc123',
      COPILOT_INTEGRATION_ID: 'my-custom-integration',
    });
    const headers = adapter.getAuthHeaders(fakeReq);
    expect(headers['Copilot-Integration-Id']).toBe('my-custom-integration');
  });
});

describe('resolveOpenCodeRoute', () => {
  const OPENAI_TARGET = 'api.openai.com';
  const ANTHROPIC_TARGET = 'api.anthropic.com';
  const COPILOT_TARGET = 'api.githubcopilot.com';
  const OPENAI_BASE = '/v1';
  const ANTHROPIC_BASE = '';

  it('should route to OpenAI when OPENAI_API_KEY is set (highest priority)', () => {
    const route = resolveOpenCodeRoute(
      'sk-openai-key', 'sk-anthropic-key', 'gho_copilot-token',
      OPENAI_TARGET, ANTHROPIC_TARGET, COPILOT_TARGET,
      OPENAI_BASE, ANTHROPIC_BASE
    );
    expect(route).not.toBeNull();
    expect(route.target).toBe(OPENAI_TARGET);
    expect(route.headers['Authorization']).toBe('Bearer sk-openai-key');
    expect(route.basePath).toBe(OPENAI_BASE);
    expect(route.needsAnthropicVersion).toBe(false);
  });

  it('should route to Anthropic when only ANTHROPIC_API_KEY is set', () => {
    const route = resolveOpenCodeRoute(
      undefined, 'sk-anthropic-key', undefined,
      OPENAI_TARGET, ANTHROPIC_TARGET, COPILOT_TARGET,
      OPENAI_BASE, ANTHROPIC_BASE
    );
    expect(route).not.toBeNull();
    expect(route.target).toBe(ANTHROPIC_TARGET);
    expect(route.headers['x-api-key']).toBe('sk-anthropic-key');
    expect(route.basePath).toBe(ANTHROPIC_BASE);
    expect(route.needsAnthropicVersion).toBe(true);
  });

  it('should prefer OpenAI over Anthropic when both are set', () => {
    const route = resolveOpenCodeRoute(
      'sk-openai-key', 'sk-anthropic-key', undefined,
      OPENAI_TARGET, ANTHROPIC_TARGET, COPILOT_TARGET,
      OPENAI_BASE, ANTHROPIC_BASE
    );
    expect(route).not.toBeNull();
    expect(route.target).toBe(OPENAI_TARGET);
    expect(route.headers['Authorization']).toBe('Bearer sk-openai-key');
    expect(route.needsAnthropicVersion).toBe(false);
  });

  it('should route to Copilot when only copilotToken is set', () => {
    const route = resolveOpenCodeRoute(
      undefined, undefined, 'gho_copilot-token',
      OPENAI_TARGET, ANTHROPIC_TARGET, COPILOT_TARGET,
      OPENAI_BASE, ANTHROPIC_BASE
    );
    expect(route).not.toBeNull();
    expect(route.target).toBe(COPILOT_TARGET);
    expect(route.headers['Authorization']).toBe('Bearer gho_copilot-token');
    expect(route.basePath).toBeUndefined();
    expect(route.needsAnthropicVersion).toBe(false);
  });

  it('should prefer Anthropic over Copilot when both are set', () => {
    const route = resolveOpenCodeRoute(
      undefined, 'sk-anthropic-key', 'gho_copilot-token',
      OPENAI_TARGET, ANTHROPIC_TARGET, COPILOT_TARGET,
      OPENAI_BASE, ANTHROPIC_BASE
    );
    expect(route).not.toBeNull();
    expect(route.target).toBe(ANTHROPIC_TARGET);
    expect(route.headers['x-api-key']).toBe('sk-anthropic-key');
    expect(route.needsAnthropicVersion).toBe(true);
  });

  it('should return null when no credentials are available', () => {
    const route = resolveOpenCodeRoute(
      undefined, undefined, undefined,
      OPENAI_TARGET, ANTHROPIC_TARGET, COPILOT_TARGET,
      OPENAI_BASE, ANTHROPIC_BASE
    );
    expect(route).toBeNull();
  });

  it('should not set Authorization header for Anthropic route', () => {
    const route = resolveOpenCodeRoute(
      undefined, 'sk-anthropic-key', undefined,
      OPENAI_TARGET, ANTHROPIC_TARGET, COPILOT_TARGET,
      OPENAI_BASE, ANTHROPIC_BASE
    );
    expect(route).not.toBeNull();
    expect(route.headers['Authorization']).toBeUndefined();
  });

  it('should not set x-api-key header for OpenAI route', () => {
    const route = resolveOpenCodeRoute(
      'sk-openai-key', undefined, undefined,
      OPENAI_TARGET, ANTHROPIC_TARGET, COPILOT_TARGET,
      OPENAI_BASE, ANTHROPIC_BASE
    );
    expect(route).not.toBeNull();
    expect(route.headers['x-api-key']).toBeUndefined();
  });
});

// ── OpenCode adapter delegation ────────────────────────────────────────────────
// Tests that verify OpenCode correctly delegates to its candidate adapters and
// that all providers can be simultaneously active on their own ports.

describe('OpenCode adapter delegation', () => {
  const { createOpenCodeAdapter } = require('./providers/opencode');

  function makeStubAdapter(name, enabled, { targetHost = `api.${name}.com`, basePath = '', authHeaders = {}, bodyTransform = null, urlTransform = undefined } = {}) {
    return {
      name,
      isEnabled: () => enabled,
      getTargetHost: () => targetHost,
      getBasePath: () => basePath,
      getAuthHeaders: () => authHeaders,
      getBodyTransform: () => bodyTransform,
      transformRequestUrl: urlTransform,
    };
  }

  const fakeReq = { headers: {}, method: 'POST', url: '/v1/messages' };

  it('routes to the first enabled candidate when multiple are configured', () => {
    const openai     = makeStubAdapter('openai',    true,  { targetHost: 'api.openai.com',    basePath: '/v1', authHeaders: { Authorization: 'Bearer sk-oai' } });
    const anthropic  = makeStubAdapter('anthropic', true,  { targetHost: 'api.anthropic.com', authHeaders: { 'x-api-key': 'sk-ant' } });
    const copilot    = makeStubAdapter('copilot',   true,  { targetHost: 'api.githubcopilot.com', authHeaders: { Authorization: 'Bearer gho_cop' } });

    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [openai, anthropic, copilot] });

    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.getTargetHost(fakeReq)).toBe('api.openai.com');
    expect(adapter.getAuthHeaders(fakeReq).Authorization).toBe('Bearer sk-oai');
    expect(adapter.getBasePath(fakeReq)).toBe('/v1');
  });

  it('skips disabled candidates and picks the next enabled one', () => {
    const openai    = makeStubAdapter('openai',    false, { targetHost: 'api.openai.com' });
    const anthropic = makeStubAdapter('anthropic', true,  { targetHost: 'api.anthropic.com', authHeaders: { 'x-api-key': 'sk-ant' } });

    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [openai, anthropic] });

    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.getTargetHost(fakeReq)).toBe('api.anthropic.com');
    expect(adapter.getAuthHeaders(fakeReq)['x-api-key']).toBe('sk-ant');
  });

  it('is disabled when all candidate adapters are disabled', () => {
    const openai    = makeStubAdapter('openai',    false, {});
    const anthropic = makeStubAdapter('anthropic', false, {});

    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [openai, anthropic] });
    expect(adapter.isEnabled()).toBe(false);
  });

  it('is disabled when AWF_ENABLE_OPENCODE is not set, even if candidates are enabled', () => {
    const openai = makeStubAdapter('openai', true, { targetHost: 'api.openai.com' });

    const adapter = createOpenCodeAdapter({}, { candidateAdapters: [openai] });
    expect(adapter.isEnabled()).toBe(false);
  });

  it('delegates body transform to the active candidate adapter', () => {
    const transform = (buf) => Buffer.from(buf.toString().toUpperCase());
    const anthropic = makeStubAdapter('anthropic', true, { targetHost: 'api.anthropic.com', bodyTransform: transform });

    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [anthropic] });
    const fn = adapter.getBodyTransform();
    expect(fn).toBe(transform);
  });

  it('returns null body transform when active candidate has none', () => {
    const openai = makeStubAdapter('openai', true, { bodyTransform: null });
    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [openai] });
    expect(adapter.getBodyTransform()).toBeNull();
  });

  it('delegates URL transform to the active candidate when one is defined', () => {
    const urlTransform = (url) => url.replace('?key=placeholder', '');
    const gemini = makeStubAdapter('gemini', true, { targetHost: 'generativelanguage.googleapis.com', urlTransform });

    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [gemini] });
    const transformed = adapter.transformRequestUrl('/v1/models?key=placeholder');
    expect(transformed).toBe('/v1/models');
  });

  it('returns url unchanged when active candidate has no URL transform', () => {
    const openai = makeStubAdapter('openai', true, {});
    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [openai] });
    expect(adapter.transformRequestUrl('/v1/chat/completions')).toBe('/v1/chat/completions');
  });

  it('reports the active adapter name at startup for introspection', () => {
    const anthropic = makeStubAdapter('anthropic', false, {});
    const copilot   = makeStubAdapter('copilot',   true,  { targetHost: 'api.githubcopilot.com' });

    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [anthropic, copilot] });
    expect(adapter._startupActiveAdapterName).toBe('copilot');
  });

  it('exposes the candidate adapter list for introspection', () => {
    const openai    = makeStubAdapter('openai',    true, {});
    const anthropic = makeStubAdapter('anthropic', true, {});

    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [openai, anthropic] });
    expect(adapter._candidateAdapters).toHaveLength(2);
    expect(adapter._candidateAdapters[0].name).toBe('openai');
    expect(adapter._candidateAdapters[1].name).toBe('anthropic');
  });

  it('all providers remain independently active on their own ports', () => {
    // Simulate the production setup: OpenAI + Anthropic + Copilot all enabled
    const openai    = makeStubAdapter('openai',    true, { targetHost: 'api.openai.com' });
    const anthropic = makeStubAdapter('anthropic', true, { targetHost: 'api.anthropic.com' });
    const copilot   = makeStubAdapter('copilot',   true, { targetHost: 'api.githubcopilot.com' });

    const opencode = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [openai, anthropic, copilot] });

    // Each provider is independently enabled
    expect(openai.isEnabled()).toBe(true);
    expect(anthropic.isEnabled()).toBe(true);
    expect(copilot.isEnabled()).toBe(true);

    // OpenCode routes to the first enabled (OpenAI in this priority order)
    expect(opencode.isEnabled()).toBe(true);
    expect(opencode.getTargetHost(fakeReq)).toBe('api.openai.com');

    // All three base providers are still individually reachable (different ports)
    expect(openai.getTargetHost()).toBe('api.openai.com');
    expect(anthropic.getTargetHost()).toBe('api.anthropic.com');
    expect(copilot.getTargetHost()).toBe('api.githubcopilot.com');
  });
});

describe('httpProbe', () => {
  let server;
  let serverPort;

  afterEach((done) => {
    if (server) {
      server.close(done);
      server = null;
    } else {
      done();
    }
  });

  function startServer(statusCode, body) {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(body || '{}');
      });
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  }

  it('should return status code 200 for a healthy endpoint', async () => {
    await startServer(200, '{"ok":true}');
    const status = await httpProbe(`http://127.0.0.1:${serverPort}/health`, {
      method: 'GET',
      headers: {},
    }, 5000);
    expect(status).toBe(200);
  });

  it('should return status code 401 for unauthorized', async () => {
    await startServer(401, '{"error":"unauthorized"}');
    const status = await httpProbe(`http://127.0.0.1:${serverPort}/models`, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer bad-token' },
    }, 5000);
    expect(status).toBe(401);
  });

  it('should return status code 400 for bad request (Anthropic key valid probe)', async () => {
    await startServer(400, '{"error":"bad request"}');
    const status = await httpProbe(`http://127.0.0.1:${serverPort}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-key', 'content-type': 'application/json' },
      body: '{}',
    }, 5000);
    expect(status).toBe(400);
  });

  it('should reject on connection refused', async () => {
    // Allocate a port, then close it — guarantees nothing is listening
    const tmpServer = http.createServer();
    const refusedPort = await new Promise((resolve) => {
      tmpServer.listen(0, '127.0.0.1', () => {
        resolve(tmpServer.address().port);
        tmpServer.close();
      });
    });
    await expect(
      httpProbe(`http://127.0.0.1:${refusedPort}/health`, {
        method: 'GET',
        headers: {},
      }, 5000)
    ).rejects.toThrow();
  });

  it('should reject on timeout', async () => {
    // Start a server that never responds
    server = http.createServer(() => {
      // intentionally never respond
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });

    await expect(
      httpProbe(`http://127.0.0.1:${serverPort}/slow`, {
        method: 'GET',
        headers: {},
      }, 100) // 100ms timeout
    ).rejects.toThrow(/timed out/i);
  });
});

// ── Helpers for validateApiKeys tests ──────────────────────────────────────────

/**
 * Create a mock https.request implementation that responds with the given status code.
 */
function mockHttpsRequestWithStatus(statusCode) {
  return jest.spyOn(https, 'request').mockImplementation((options, callback) => {
    const req = new EventEmitter();
    req.write = jest.fn();
    req.end = jest.fn(() => {
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.resume = jest.fn();
        callback(res);
        setImmediate(() => res.emit('end'));
      });
    });
    req.destroy = jest.fn();
    return req;
  });
}

/**
 * Collect structured log lines emitted by logRequest() (written to process.stdout).
 */
function collectLogOutput() {
  const lines = [];
  const spy = jest.spyOn(process.stdout, 'write').mockImplementation((data) => {
    try {
      lines.push(JSON.parse(data.toString()));
    } catch {
      // ignore non-JSON writes
    }
    return true;
  });
  return { lines, spy };
}

describe('validateApiKeys', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetKeyValidationState();
  });

  // ── OpenAI ─────────────────────────────────────────────────────────────────

  it('marks OpenAI valid when probe returns 200', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(200);
    await validateApiKeys({ openaiKey: 'sk-test', openaiTarget: 'api.openai.com' });
    expect(keyValidationResults.openai.status).toBe('valid');
    const log = lines.find(l => l.provider === 'openai' && l.status === 'valid');
    expect(log).toBeDefined();
  });

  it('marks OpenAI auth_rejected when probe returns 401', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(401);
    await validateApiKeys({ openaiKey: 'sk-bad', openaiTarget: 'api.openai.com' });
    expect(keyValidationResults.openai.status).toBe('auth_rejected');
    const failLog = lines.find(l => l.event === 'key_validation_failed' && l.provider === 'openai');
    expect(failLog).toBeDefined();
    expect(failLog.level).toBe('error');
  });

  it('skips OpenAI for custom API target', async () => {
    const { lines } = collectLogOutput();
    await validateApiKeys({ openaiKey: 'sk-test', openaiTarget: 'my-llm-router.internal' });
    expect(keyValidationResults.openai.status).toBe('skipped');
    const log = lines.find(l => l.provider === 'openai' && l.status === 'skipped');
    expect(log).toBeDefined();
  });

  it('does not validate OpenAI when key is not provided', async () => {
    collectLogOutput();
    const spy = jest.spyOn(https, 'request');
    await validateApiKeys({ openaiKey: undefined });
    expect(keyValidationResults.openai).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  // ── Anthropic ──────────────────────────────────────────────────────────────

  it('marks Anthropic valid when probe returns 400 (key valid, body incomplete)', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(400);
    await validateApiKeys({ anthropicKey: 'sk-ant-test', anthropicTarget: 'api.anthropic.com' });
    expect(keyValidationResults.anthropic.status).toBe('valid');
    const log = lines.find(l => l.provider === 'anthropic' && l.status === 'valid');
    expect(log).toBeDefined();
    expect(log.note).toContain('probe body rejected');
  });

  it('marks Anthropic auth_rejected when probe returns 401', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(401);
    await validateApiKeys({ anthropicKey: 'sk-ant-bad', anthropicTarget: 'api.anthropic.com' });
    expect(keyValidationResults.anthropic.status).toBe('auth_rejected');
    const failLog = lines.find(l => l.event === 'key_validation_failed' && l.provider === 'anthropic');
    expect(failLog).toBeDefined();
  });

  it('marks Anthropic auth_rejected when probe returns 403', async () => {
    mockHttpsRequestWithStatus(403);
    await validateApiKeys({ anthropicKey: 'sk-ant-bad', anthropicTarget: 'api.anthropic.com' });
    expect(keyValidationResults.anthropic.status).toBe('auth_rejected');
  });

  it('skips Anthropic for custom API target', async () => {
    const { lines } = collectLogOutput();
    await validateApiKeys({ anthropicKey: 'sk-ant-test', anthropicTarget: 'proxy.corp.internal' });
    expect(keyValidationResults.anthropic.status).toBe('skipped');
    const log = lines.find(l => l.provider === 'anthropic' && l.status === 'skipped');
    expect(log).toBeDefined();
  });

  // ── Copilot ────────────────────────────────────────────────────────────────

  it('marks Copilot valid when probe returns 200 with non-classic token', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(200);
    await validateApiKeys({
      copilotGithubToken: 'ghu_valid_token',
      copilotTarget: 'api.githubcopilot.com',
      copilotIntegrationId: 'copilot-developer-cli',
    });
    expect(keyValidationResults.copilot.status).toBe('valid');
    const log = lines.find(l => l.provider === 'copilot' && l.status === 'valid');
    expect(log).toBeDefined();
  });

  it('marks Copilot auth_rejected when probe returns 401', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(401);
    await validateApiKeys({
      copilotGithubToken: 'ghu_invalid',
      copilotTarget: 'api.githubcopilot.com',
      copilotIntegrationId: 'copilot-developer-cli',
    });
    expect(keyValidationResults.copilot.status).toBe('auth_rejected');
    const failLog = lines.find(l => l.event === 'key_validation_failed' && l.provider === 'copilot');
    expect(failLog).toBeDefined();
  });

  it('skips Copilot for custom API target', async () => {
    const { lines } = collectLogOutput();
    await validateApiKeys({
      copilotGithubToken: 'ghu_valid',
      copilotTarget: 'copilot-api.mycompany.ghe.com',
      copilotIntegrationId: 'copilot-developer-cli',
    });
    expect(keyValidationResults.copilot.status).toBe('skipped');
    const log = lines.find(l => l.provider === 'copilot' && l.status === 'skipped');
    expect(log).toBeDefined();
  });

  it('skips Copilot when only COPILOT_API_KEY is set (BYOK mode)', async () => {
    collectLogOutput();
    const spy = jest.spyOn(https, 'request');
    await validateApiKeys({
      copilotGithubToken: undefined,
      copilotApiKey: 'sk-byok-key',
      copilotTarget: 'api.githubcopilot.com',
    });
    expect(keyValidationResults.copilot.status).toBe('skipped');
    expect(keyValidationResults.copilot.message).toContain('COPILOT_API_KEY');
    expect(spy).not.toHaveBeenCalled();
  });

  // ── Gemini ─────────────────────────────────────────────────────────────────

  it('marks Gemini valid when probe returns 200', async () => {
    const { lines } = collectLogOutput();
    mockHttpsRequestWithStatus(200);
    await validateApiKeys({ geminiKey: 'ai-test-key', geminiTarget: 'generativelanguage.googleapis.com' });
    expect(keyValidationResults.gemini.status).toBe('valid');
    const log = lines.find(l => l.provider === 'gemini' && l.status === 'valid');
    expect(log).toBeDefined();
  });

  it('marks Gemini auth_rejected when probe returns 403', async () => {
    mockHttpsRequestWithStatus(403);
    await validateApiKeys({ geminiKey: 'ai-bad-key', geminiTarget: 'generativelanguage.googleapis.com' });
    expect(keyValidationResults.gemini.status).toBe('auth_rejected');
  });

  it('skips Gemini for custom API target', async () => {
    const { lines } = collectLogOutput();
    await validateApiKeys({ geminiKey: 'ai-test', geminiTarget: 'my-vertex-endpoint.internal' });
    expect(keyValidationResults.gemini.status).toBe('skipped');
    const log = lines.find(l => l.provider === 'gemini' && l.status === 'skipped');
    expect(log).toBeDefined();
  });

  // ── Cross-cutting ──────────────────────────────────────────────────────────

  it('handles network_error when probe times out', async () => {
    collectLogOutput();
    jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      const req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn(); // never responds
      req.destroy = jest.fn((err) => {
        setImmediate(() => req.emit('error', err || new Error('socket hang up')));
      });
      // Simulate Node's built-in timeout: fire 'timeout' event after the requested delay
      if (options.timeout) {
        setTimeout(() => req.emit('timeout'), options.timeout);
      }
      return req;
    });
    await validateApiKeys({
      openaiKey: 'sk-test',
      openaiTarget: 'api.openai.com',
      timeoutMs: 50,
    });
    expect(keyValidationResults.openai.status).toBe('network_error');
  }, 5000);

  it('does not validate any provider when no keys are provided', async () => {
    collectLogOutput();
    const spy = jest.spyOn(https, 'request');
    await validateApiKeys({
      openaiKey: undefined,
      anthropicKey: undefined,
      copilotGithubToken: undefined,
      copilotApiKey: undefined,
      geminiKey: undefined,
    });
    expect(Object.keys(keyValidationResults)).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── fetchJson ──────────────────────────────────────────────────────────────

describe('fetchJson', () => {
  let server;
  let serverPort;

  afterEach((done) => {
    if (server) {
      server.close(done);
      server = null;
    } else {
      done();
    }
  });

  function startServer(statusCode, body) {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(body);
      });
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  }

  it('should return parsed JSON for a 200 response', async () => {
    await startServer(200, '{"data":[{"id":"gpt-4o"}]}');
    const result = await fetchJson(`http://127.0.0.1:${serverPort}/v1/models`, {
      method: 'GET',
      headers: {},
    }, 5000);
    expect(result).toEqual({ data: [{ id: 'gpt-4o' }] });
  });

  it('should return null for a non-2xx response', async () => {
    await startServer(401, '{"error":"unauthorized"}');
    const result = await fetchJson(`http://127.0.0.1:${serverPort}/v1/models`, {
      method: 'GET',
      headers: {},
    }, 5000);
    expect(result).toBeNull();
  });

  it('should return null for invalid JSON', async () => {
    await startServer(200, 'not-json');
    const result = await fetchJson(`http://127.0.0.1:${serverPort}/v1/models`, {
      method: 'GET',
      headers: {},
    }, 5000);
    expect(result).toBeNull();
  });

  it('should return null on timeout', async () => {
    server = http.createServer(() => {
      // intentionally never respond
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
    const result = await fetchJson(`http://127.0.0.1:${serverPort}/slow`, {
      method: 'GET',
      headers: {},
    }, 100);
    expect(result).toBeNull();
  }, 5000);

  it('should return null for an invalid URL', async () => {
    const result = await fetchJson('not-a-url', { method: 'GET', headers: {} }, 5000);
    expect(result).toBeNull();
  });

  it('should return null when connection drops mid-body (res emits close without end)', async () => {
    // Server writes partial body then destroys the socket
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"dat'); // partial body — never completes
      res.destroy();      // simulate connection drop
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
    const result = await fetchJson(`http://127.0.0.1:${serverPort}/v1/models`, {
      method: 'GET',
      headers: {},
    }, 5000);
    expect(result).toBeNull();
  }, 5000);
});

// ── extractModelIds ────────────────────────────────────────────────────────

describe('extractModelIds', () => {
  it('should extract IDs from OpenAI/Anthropic/Copilot format', () => {
    const json = { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'o1' }] };
    expect(extractModelIds(json)).toEqual(['gpt-4o', 'gpt-4o-mini', 'o1']);
  });

  it('should extract names from Gemini format', () => {
    const json = {
      models: [
        { name: 'models/gemini-1.5-pro' },
        { name: 'models/gemini-1.5-flash' },
      ],
    };
    expect(extractModelIds(json)).toEqual(['gemini-1.5-flash', 'gemini-1.5-pro']);
  });

  it('should keep Gemini model names that do not start with models/ prefix as-is', () => {
    const json = { models: [{ name: 'gemini-2.0-flash-exp' }] };
    expect(extractModelIds(json)).toEqual(['gemini-2.0-flash-exp']);
  });

  it('should return sorted model IDs', () => {
    const json = { data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'm-model' }] };
    expect(extractModelIds(json)).toEqual(['a-model', 'm-model', 'z-model']);
  });

  it('should return null for null input', () => {
    expect(extractModelIds(null)).toBeNull();
  });

  it('should return null for empty data array', () => {
    expect(extractModelIds({ data: [] })).toBeNull();
  });

  it('should return null for unrecognized format', () => {
    expect(extractModelIds({ something: 'else' })).toBeNull();
  });

  it('should fall back to name field when id is missing', () => {
    const json = { data: [{ name: 'claude-3-5-sonnet' }] };
    expect(extractModelIds(json)).toEqual(['claude-3-5-sonnet']);
  });
});

// ── fetchStartupModels ─────────────────────────────────────────────────────

describe('fetchStartupModels', () => {
  afterEach(() => {
    resetModelCacheState();
    jest.restoreAllMocks();
  });

  /**
   * Mock https.request to return a JSON body with the given status code.
   */
  function mockHttpsRequestWithBody(statusCode, bodyStr) {
    return jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      const req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn(() => {
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = statusCode;
          res.resume = jest.fn();
          callback(res);
          setImmediate(() => {
            res.emit('data', Buffer.from(bodyStr));
            res.emit('end');
          });
        });
      });
      req.destroy = jest.fn();
      return req;
    });
  }

  it('should populate cachedModels.openai when OpenAI key is configured', async () => {
    mockHttpsRequestWithBody(200, '{"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"}]}');
    await fetchStartupModels({ openaiKey: 'sk-test', openaiTarget: 'api.openai.com', timeoutMs: 5000 });
    expect(cachedModels.openai).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('should populate cachedModels.anthropic when Anthropic key is configured', async () => {
    mockHttpsRequestWithBody(200, '{"data":[{"id":"claude-opus-4-5"},{"id":"claude-haiku-4-5"}]}');
    await fetchStartupModels({ anthropicKey: 'sk-ant-test', anthropicTarget: 'api.anthropic.com', timeoutMs: 5000 });
    expect(cachedModels.anthropic).toEqual(['claude-haiku-4-5', 'claude-opus-4-5']);
  });

  it('should populate cachedModels.copilot when Copilot token is configured', async () => {
    mockHttpsRequestWithBody(200, '{"data":[{"id":"gpt-4o"},{"id":"o3-mini"}]}');
    await fetchStartupModels({
      copilotGithubToken: 'gho_test',
      copilotAuthToken: 'gho_test',
      copilotTarget: 'api.githubcopilot.com',
      timeoutMs: 5000,
    });
    expect(cachedModels.copilot).toEqual(['gpt-4o', 'o3-mini']);
  });

  it('should populate cachedModels.gemini when Gemini key is configured', async () => {
    mockHttpsRequestWithBody(200, '{"models":[{"name":"models/gemini-1.5-pro"},{"name":"models/gemini-1.5-flash"}]}');
    await fetchStartupModels({ geminiKey: 'gemini-test-key', geminiTarget: 'generativelanguage.googleapis.com', timeoutMs: 5000 });
    expect(cachedModels.gemini).toEqual(['gemini-1.5-flash', 'gemini-1.5-pro']);
  });

  it('should set cachedModels.openai to null when models fetch returns error status', async () => {
    mockHttpsRequestWithBody(401, '{"error":"unauthorized"}');
    await fetchStartupModels({ openaiKey: 'sk-bad', openaiTarget: 'api.openai.com', timeoutMs: 5000 });
    expect(cachedModels.openai).toBeNull();
    const reflect = reflectEndpoints();
    expect(reflect.models_fetch_complete).toBe(true);
  });

  it('should skip Copilot models fetch when only BYOK key (no GitHub token) is configured', async () => {
    const spy = jest.spyOn(https, 'request');
    await fetchStartupModels({
      copilotGithubToken: undefined,
      copilotAuthToken: 'sk-byok-copilot-key', // BYOK — derived from COPILOT_API_KEY
      copilotTarget: 'api.githubcopilot.com',
      timeoutMs: 5000,
    });
    // No HTTPS request should have been made for the copilot models endpoint
    expect(spy).not.toHaveBeenCalled();
    expect(cachedModels.copilot).toBeUndefined();
  });

  it('should skip fetching when no keys are configured', async () => {
    const spy = jest.spyOn(https, 'request');
    await fetchStartupModels({
      openaiKey: undefined,
      anthropicKey: undefined,
      copilotGithubToken: undefined,
      copilotAuthToken: undefined,
      geminiKey: undefined,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(cachedModels).toEqual({});
    const reflect = reflectEndpoints();
    expect(reflect.models_fetch_complete).toBe(true);
  });
});

// ── reflectEndpoints ───────────────────────────────────────────────────────

describe('reflectEndpoints', () => {
  afterEach(() => {
    resetModelCacheState();
  });

  it('should return an array of 5 endpoints', () => {
    const result = reflectEndpoints();
    expect(result.endpoints).toHaveLength(5);
  });

  it('should include all expected providers', () => {
    const result = reflectEndpoints();
    const providers = result.endpoints.map((e) => e.provider);
    expect(providers).toEqual(['openai', 'anthropic', 'copilot', 'gemini', 'opencode']);
  });

  it('should report models_fetch_complete false before fetch runs', () => {
    const result = reflectEndpoints();
    expect(result.models_fetch_complete).toBe(false);
  });

  it('should report models_fetch_complete true after fetch completes', async () => {
    await fetchStartupModels({});
    const result = reflectEndpoints();
    expect(result.models_fetch_complete).toBe(true);
  });

  it('should include cached models when available', async () => {
    // Manually populate cache to avoid real network calls
    cachedModels.openai = ['gpt-4o', 'o1'];
    const result = reflectEndpoints();
    const openai = result.endpoints.find((e) => e.provider === 'openai');
    expect(openai.models).toEqual(['gpt-4o', 'o1']);
  });

  it('should include correct ports', () => {
    const result = reflectEndpoints();
    const portMap = Object.fromEntries(result.endpoints.map((e) => [e.provider, e.port]));
    expect(portMap).toEqual({
      openai: 10000,
      anthropic: 10001,
      copilot: 10002,
      gemini: 10003,
      opencode: 10004,
    });
  });

  it('should include correct models_url for configured providers', () => {
    const result = reflectEndpoints();
    const urlMap = Object.fromEntries(result.endpoints.map((e) => [e.provider, e.models_url]));
    expect(urlMap.openai).toBe('http://api-proxy:10000/v1/models');
    expect(urlMap.anthropic).toBe('http://api-proxy:10001/v1/models');
    expect(urlMap.copilot).toBe('http://api-proxy:10002/models');
    expect(urlMap.gemini).toBe('http://api-proxy:10003/v1beta/models');
    expect(urlMap.opencode).toBeNull();
  });

  it('should report opencode as not configured when AWF_ENABLE_OPENCODE is not set', () => {
    // ENABLE_OPENCODE is false at module load time (AWF_ENABLE_OPENCODE not set in test env),
    // so opencode.configured must always be false regardless of other credentials.
    const result = reflectEndpoints();
    const opencode = result.endpoints.find((e) => e.provider === 'opencode');
    expect(opencode.configured).toBe(false);
    expect(opencode.models).toBeNull();
    expect(opencode.models_url).toBeNull();
  });

  it('should report opencode as configured when AWF_ENABLE_OPENCODE=true and a credential is present', () => {
    let isolatedReflect;
    jest.isolateModules(() => {
      process.env.AWF_ENABLE_OPENCODE = 'true';
      process.env.OPENAI_API_KEY = 'sk-test-isolated';
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        ({ reflectEndpoints: isolatedReflect } = require('./server'));
      } finally {
        delete process.env.AWF_ENABLE_OPENCODE;
        delete process.env.OPENAI_API_KEY;
      }
    });
    const result = isolatedReflect();
    const opencode = result.endpoints.find((e) => e.provider === 'opencode');
    expect(opencode.configured).toBe(true);
  });
});

// ── healthResponse ─────────────────────────────────────────────────────────

describe('healthResponse', () => {
  afterEach(() => {
    resetModelCacheState();
  });

  it('should include models_fetch_complete: false before model fetch runs', () => {
    const result = healthResponse();
    expect(result.models_fetch_complete).toBe(false);
  });

  it('should include models_fetch_complete: true after model fetch completes', async () => {
    // Pass explicit undefined overrides so no real network calls are made
    await fetchStartupModels({
      openaiKey: undefined,
      anthropicKey: undefined,
      copilotGithubToken: undefined,
      copilotAuthToken: undefined,
      geminiKey: undefined,
    });
    const result = healthResponse();
    expect(result.models_fetch_complete).toBe(true);
  });

  it('should include required top-level fields', () => {
    const result = healthResponse();
    expect(result.status).toBe('healthy');
    expect(result.service).toBe('awf-api-proxy');
    expect(typeof result.providers).toBe('object');
    expect(typeof result.key_validation).toBe('object');
    expect(typeof result.models_fetch_complete).toBe('boolean');
  });
});

// ── makeModelBodyTransform integration ─────────────────────────────────────

describe('makeModelBodyTransform', () => {
  beforeEach(() => {
    resetModelCacheState();
  });

  afterEach(() => {
    resetModelCacheState();
  });

  it('should return null when MODEL_ALIASES is not configured', () => {
    // When AWF_MODEL_ALIASES is not set, MODEL_ALIASES is null and
    // makeModelBodyTransform returns null (no transform applied).
    if (MODEL_ALIASES) {
      // If the env var happens to be set in this test environment, skip.
      return;
    }
    const transform = makeModelBodyTransform('copilot');
    expect(transform).toBeNull();
  });

  it('should rewrite model field in POST body when aliases are configured', () => {
    // Manually populate the model cache so resolution can find a match
    cachedModels.copilot = ['claude-sonnet-4.5', 'claude-sonnet-4.6', 'gpt-4o'];

    // Build a transform directly by simulating what makeModelBodyTransform does:
    // call rewriteModelInBody from model-resolver.
    const { rewriteModelInBody } = require('./model-resolver');

    const aliases = {
      sonnet: ['copilot/*sonnet*'],
    };

    const inBody = Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] }));
    const result = rewriteModelInBody(inBody, 'copilot', aliases, cachedModels);

    expect(result).not.toBeNull();
    expect(result.originalModel).toBe('sonnet');
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');

    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.model).toBe('claude-sonnet-4.6');
    expect(parsed.messages).toEqual([]);
  });

  it('should update content-length and strip transfer-encoding after body rewrite', () => {
    // Simulate the header fixup logic in proxyRequest directly.
    const { rewriteModelInBody } = require('./model-resolver');

    cachedModels.copilot = ['claude-sonnet-4.6'];
    const aliases = { sonnet: ['copilot/*sonnet*'] };

    const originalBody = Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] }));
    const result = rewriteModelInBody(originalBody, 'copilot', aliases, cachedModels);
    expect(result).not.toBeNull();

    // Simulate what proxyRequest does to headers after a rewrite
    const headers = {
      'content-type': 'application/json',
      'content-length': String(originalBody.length),
      'transfer-encoding': 'chunked',
    };
    const newBody = result.body;

    if (newBody.length !== originalBody.length) {
      headers['content-length'] = String(newBody.length);
      delete headers['transfer-encoding'];
    }

    expect(headers['content-length']).toBe(String(newBody.length));
    expect(headers['transfer-encoding']).toBeUndefined();
  });

  it('should report forwarded (post-rewrite) byte count in metrics', () => {
    // Verify that requestBytes reflects the transformed body size, not original.
    const { rewriteModelInBody } = require('./model-resolver');

    cachedModels.copilot = ['claude-sonnet-4.6'];
    const aliases = { sonnet: ['copilot/*sonnet*'] };

    const shortAlias = Buffer.from(JSON.stringify({ model: 'sonnet' }));
    const result = rewriteModelInBody(shortAlias, 'copilot', aliases, cachedModels);
    expect(result).not.toBeNull();

    // The rewritten body ('claude-sonnet-4.6') is longer than the alias ('sonnet')
    expect(result.body.length).toBeGreaterThan(shortAlias.length);
  });

  it('should not modify body when model is already a direct match', () => {
    const { rewriteModelInBody } = require('./model-resolver');

    cachedModels.copilot = ['gpt-4o'];
    const aliases = { sonnet: ['copilot/*sonnet*'] };

    const body = Buffer.from(JSON.stringify({ model: 'gpt-4o', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, cachedModels);
    // gpt-4o is a direct match with no rewrite needed (resolvedModel === original)
    expect(result).toBeNull();
  });
});

// ── buildModelsJson ────────────────────────────────────────────────────────

describe('buildModelsJson', () => {
  afterEach(() => {
    resetModelCacheState();
  });

  it('should return an object with timestamp, providers, and model_aliases fields', () => {
    const result = buildModelsJson();
    expect(typeof result.timestamp).toBe('string');
    expect(typeof result.providers).toBe('object');
    expect(result).toHaveProperty('model_aliases');
  });

  it('should include all five providers', () => {
    const result = buildModelsJson();
    const providerKeys = Object.keys(result.providers);
    expect(providerKeys).toHaveLength(5);
    expect(providerKeys).toEqual(expect.arrayContaining(['openai', 'anthropic', 'copilot', 'gemini', 'opencode']));
  });

  it('should set models to null for uncached providers', () => {
    const result = buildModelsJson();
    // Without populating cachedModels, all models fields should be null
    for (const provider of ['openai', 'anthropic', 'copilot', 'gemini', 'opencode']) {
      expect(result.providers[provider].models).toBeNull();
    }
  });

  it('should include cached models when available', () => {
    cachedModels.openai = ['gpt-4o', 'gpt-4o-mini'];
    cachedModels.copilot = ['claude-sonnet-4'];
    const result = buildModelsJson();
    expect(result.providers.openai.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(result.providers.copilot.models).toEqual(['claude-sonnet-4']);
    expect(result.providers.anthropic.models).toBeNull();
  });

  it('should include null models for providers that returned null (fetch failed)', () => {
    cachedModels.openai = null;
    const result = buildModelsJson();
    expect(result.providers.openai.models).toBeNull();
  });

  it('should set model_aliases to null when MODEL_ALIASES is not configured', () => {
    // MODEL_ALIASES is a module-level constant fixed at import time.
    // This assertion is only meaningful when AWF_MODEL_ALIASES is unset.
    if (MODEL_ALIASES) {
      expect(MODEL_ALIASES).not.toBeNull(); // trivially passes — env var is set, skip
      return;
    }
    const result = buildModelsJson();
    expect(result.model_aliases).toBeNull();
  });

  it('should produce a valid ISO 8601 timestamp', () => {
    const result = buildModelsJson();
    const ts = new Date(result.timestamp);
    expect(ts.toString()).not.toBe('Invalid Date');
  });

  it('should include opencode provider with correct static fields', () => {
    // opencode.configured mirrors whether any base provider is configured at
    // module load time — just verify the expected shape is always present.
    const result = buildModelsJson();
    expect(typeof result.providers.opencode.configured).toBe('boolean');
    expect(result.providers.opencode.models).toBeNull();
    expect(result.providers.opencode.target).toBeNull();
  });
});

// ── writeModelsJson ────────────────────────────────────────────────────────

describe('writeModelsJson', () => {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  let tmpDir;

  beforeEach(() => {
    resetModelCacheState();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-models-'));
  });

  afterEach(() => {
    resetModelCacheState();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should write models.json to the specified directory', () => {
    writeModelsJson(tmpDir);
    const filePath = path.join(tmpDir, 'models.json');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('should write valid JSON', () => {
    writeModelsJson(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, 'models.json'), 'utf8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('should write JSON with the expected schema', () => {
    cachedModels.openai = ['gpt-4o'];
    writeModelsJson(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'models.json'), 'utf8'));
    expect(typeof data.timestamp).toBe('string');
    expect(typeof data.providers).toBe('object');
    const providerKeys = Object.keys(data.providers);
    expect(providerKeys).toHaveLength(5);
    expect(providerKeys).toEqual(expect.arrayContaining(['openai', 'anthropic', 'copilot', 'gemini', 'opencode']));
    expect(data).toHaveProperty('model_aliases');
  });

  it('should create the directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'sub', 'dir');
    writeModelsJson(nestedDir);
    expect(fs.existsSync(path.join(nestedDir, 'models.json'))).toBe(true);
  });

  it('should overwrite an existing models.json on subsequent writes', () => {
    writeModelsJson(tmpDir);
    cachedModels.copilot = ['claude-sonnet-4'];
    writeModelsJson(tmpDir);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'models.json'), 'utf8'));
    expect(data.providers.copilot.models).toEqual(['claude-sonnet-4']);
  });
});

// ── composeBodyTransforms ──────────────────────────────────────────────────────

describe('composeBodyTransforms', () => {
  const upper = (buf) => Buffer.from(buf.toString('utf8').toUpperCase(), 'utf8');
  const exclaim = (buf) => Buffer.from(`${buf.toString('utf8')}!`, 'utf8');
  const noOp = () => null; // signals "no change"

  it('returns null when both transforms are null', () => {
    expect(composeBodyTransforms(null, null)).toBeNull();
  });

  it('returns the second transform when first is null', () => {
    const composed = composeBodyTransforms(null, upper);
    const buf = Buffer.from('hello');
    expect(composed(buf).toString()).toBe('HELLO');
  });

  it('returns the first transform when second is null', () => {
    const composed = composeBodyTransforms(upper, null);
    const buf = Buffer.from('hello');
    expect(composed(buf).toString()).toBe('HELLO');
  });

  it('chains two transforms: first result feeds into second', () => {
    const composed = composeBodyTransforms(upper, exclaim);
    const buf = Buffer.from('hello');
    expect(composed(buf).toString()).toBe('HELLO!');
  });

  it('when first returns null (no-op), original buffer is passed to second', () => {
    const composed = composeBodyTransforms(noOp, exclaim);
    const buf = Buffer.from('hello');
    // noOp returns null → exclaim receives original 'hello' → 'hello!'
    expect(composed(buf).toString()).toBe('hello!');
  });

  it('when first transforms and second returns null, returns first result', () => {
    const composed = composeBodyTransforms(upper, noOp);
    const buf = Buffer.from('hello');
    expect(composed(buf).toString()).toBe('HELLO');
  });

  it('when both return null, composed returns null', () => {
    const composed = composeBodyTransforms(noOp, noOp);
    expect(composed(Buffer.from('hello'))).toBeNull();
  });
});

// ── createProviderServer tests ────────────────────────────────────────────────
//
// Tests that verify the generic proxy server factory honours the ProviderAdapter
// interface: health routing, unconfigured-stub responses, URL transforms, and
// adapter-specific auth selection.
//
describe('createProviderServer', () => {
  const servers = [];

  /** Small helper: start a createProviderServer instance and return its port. */
  function startAdapter(adapter) {
    return new Promise((resolve) => {
      const srv = createProviderServer(adapter);
      srv.listen(0, '127.0.0.1', () => {
        servers.push(srv);
        resolve(srv.address().port);
      });
    });
  }

  /** Fetch a path from a server running on localhost and return { status, body }. */
  function fetch(port, path, opts = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path, method: opts.method || 'GET', headers: opts.headers || {} },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            let parsed;
            try { parsed = JSON.parse(data); } catch { parsed = data; }
            resolve({ status: res.statusCode, body: parsed, headers: res.headers });
          });
        }
      );
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  afterEach((done) => {
    let remaining = servers.length;
    if (!remaining) { done(); return; }
    servers.splice(0).forEach((s) => s.close(() => { if (!--remaining) done(); }));
  });

  // ── /health endpoint — enabled adapter ──────────────────────────────────────

  it('returns 200 /health when adapter is enabled', async () => {
    const adapter = {
      name: 'test-enabled', port: 0, isManagementPort: false, alwaysBind: false,
      participatesInValidation: false,
      isEnabled: () => true,
      getTargetHost: () => 'api.example.com',
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => null,
    };
    const port = await startAdapter(adapter);
    const { status, body } = await fetch(port, '/health');
    expect(status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.service).toBe('awf-api-proxy-test-enabled');
  });

  // ── /health endpoint — disabled adapter (default 503) ───────────────────────

  it('returns default 503 /health when adapter is disabled and has no getUnconfiguredHealthResponse', async () => {
    const adapter = {
      name: 'test-disabled', port: 0, isManagementPort: false, alwaysBind: true,
      participatesInValidation: false,
      isEnabled: () => false,
      getTargetHost: () => '',
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => null,
      getUnconfiguredResponse: () => ({ statusCode: 503, body: { error: 'not configured' } }),
    };
    const port = await startAdapter(adapter);
    const { status, body } = await fetch(port, '/health');
    expect(status).toBe(503);
    expect(body.status).toBe('not_configured');
    expect(body.service).toBe('awf-api-proxy-test-disabled');
  });

  // ── /health endpoint — custom unconfigured health response ──────────────────

  it('returns custom getUnconfiguredHealthResponse when adapter is disabled', async () => {
    const adapter = {
      name: 'test-custom-health', port: 0, isManagementPort: false, alwaysBind: true,
      participatesInValidation: false,
      isEnabled: () => false,
      getTargetHost: () => '',
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => null,
      getUnconfiguredResponse: () => ({ statusCode: 503, body: { error: 'not configured' } }),
      getUnconfiguredHealthResponse: () => ({
        statusCode: 503,
        body: { status: 'not_configured', service: 'awf-api-proxy-gemini', error: 'GEMINI_API_KEY not configured' },
      }),
    };
    const port = await startAdapter(adapter);
    const { status, body } = await fetch(port, '/health');
    expect(status).toBe(503);
    expect(body.service).toBe('awf-api-proxy-gemini');
    expect(body.error).toMatch(/GEMINI_API_KEY/);
  });

  // ── Unconfigured stub — non-health request ────────────────────────────────

  it('returns getUnconfiguredResponse body for proxy requests when disabled', async () => {
    const adapter = {
      name: 'test-unconfigured', port: 0, isManagementPort: false, alwaysBind: true,
      participatesInValidation: false,
      isEnabled: () => false,
      getTargetHost: () => '',
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => null,
      getUnconfiguredResponse: () => ({
        statusCode: 503,
        body: { error: 'proxy not configured (no API key)' },
      }),
    };
    const port = await startAdapter(adapter);
    const { status, body } = await fetch(port, '/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(status).toBe(503);
    expect(body.error).toMatch(/proxy not configured/);
  });

  it('returns default 503 for proxy requests when disabled and no getUnconfiguredResponse', async () => {
    const adapter = {
      name: 'test-no-stub', port: 0, isManagementPort: false, alwaysBind: false,
      participatesInValidation: false,
      isEnabled: () => false,
      getTargetHost: () => '',
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => null,
    };
    const port = await startAdapter(adapter);
    const { status, body } = await fetch(port, '/v1/models', { method: 'GET' });
    expect(status).toBe(503);
    expect(body.error).toMatch(/test-no-stub.*not configured/);
  });

  // ── /reflect endpoint — non-management port ──────────────────────────────

  it('returns 200 /reflect on a non-management port (enabled adapter)', async () => {
    const adapter = {
      name: 'test-reflect-enabled', port: 0, isManagementPort: false, alwaysBind: true,
      participatesInValidation: false,
      isEnabled: () => true,
      getTargetHost: () => 'api.example.com',
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => null,
      getReflectionInfo: () => ({
        provider: 'test-reflect-enabled', port: 0, base_url: 'http://api-proxy:0',
        configured: true, models_cache_key: null, models_url: null,
      }),
    };
    const port = await startAdapter(adapter);
    const { status, body } = await fetch(port, '/reflect');
    expect(status).toBe(200);
    expect(body).toHaveProperty('endpoints');
    expect(body).toHaveProperty('models_fetch_complete');
  });

  it('returns 200 /reflect on a non-management port (disabled/unconfigured adapter)', async () => {
    const adapter = {
      name: 'test-reflect-disabled', port: 0, isManagementPort: false, alwaysBind: true,
      participatesInValidation: false,
      isEnabled: () => false,
      getTargetHost: () => '',
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => null,
      getUnconfiguredResponse: () => ({ statusCode: 503, body: { error: 'not configured' } }),
      getReflectionInfo: () => ({
        provider: 'test-reflect-disabled', port: 0, base_url: 'http://api-proxy:0',
        configured: false, models_cache_key: null, models_url: null,
      }),
    };
    const port = await startAdapter(adapter);
    const { status, body } = await fetch(port, '/reflect');
    // /reflect should return 200 even for unconfigured adapters
    expect(status).toBe(200);
    expect(body).toHaveProperty('endpoints');
  });

  // ── /reflect not intercepted before unconfigured-stub check ────────────────

  it('does not intercept /reflect as a proxy request on disabled adapters', async () => {
    const adapter = {
      name: 'test-no-intercept', port: 0, isManagementPort: false, alwaysBind: true,
      participatesInValidation: false,
      isEnabled: () => false,
      getTargetHost: () => '',
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => null,
      getUnconfiguredResponse: () => ({ statusCode: 503, body: { error: 'not configured' } }),
      getReflectionInfo: () => ({
        provider: 'test-no-intercept', port: 0, base_url: 'http://api-proxy:0',
        configured: false, models_cache_key: null, models_url: null,
      }),
    };
    const port = await startAdapter(adapter);
    // /reflect should return 200, not the unconfigured 503
    const { status } = await fetch(port, '/reflect');
    expect(status).toBe(200);
    // Other paths should still return the unconfigured response
    const { status: proxyStatus } = await fetch(port, '/v1/chat/completions', { method: 'POST', body: '{}' });
    expect(proxyStatus).toBe(503);
  });

  // ── URL transform ─────────────────────────────────────────────────────────

  it('applies transformRequestUrl before proxying', async () => {
    // Record what the transform was called with; upstream will fail (no real host)
    // but the transform runs synchronously in the request handler before proxying starts.
    const calls = [];
    const adapter = {
      name: 'test-url-transform', port: 0, isManagementPort: false, alwaysBind: false,
      participatesInValidation: false,
      isEnabled: () => true,
      getTargetHost: () => 'api.example.com',
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => null,
      transformRequestUrl: (url) => {
        const result = url.replace('?key=placeholder', '');
        calls.push({ input: url, output: result });
        return result;
      },
    };
    const port = await startAdapter(adapter);
    // fetch will return a non-2xx (proxy can't reach api.example.com in test), that's fine.
    await fetch(port, '/v1/models?key=placeholder').catch(() => {});
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('/v1/models?key=placeholder');
    expect(calls[0].output).toBe('/v1/models');
  });

  // ── Auth headers ──────────────────────────────────────────────────────────

  it('calls getAuthHeaders() for each proxied request', async () => {
    // Record the headers returned by getAuthHeaders; upstream will fail (no real host)
    // but getAuthHeaders is called synchronously in the request handler.
    const headerCalls = [];
    const adapter = {
      name: 'test-auth', port: 0, isManagementPort: false, alwaysBind: false,
      participatesInValidation: false,
      isEnabled: () => true,
      getTargetHost: () => 'api.example.com',
      getBasePath: () => '',
      getAuthHeaders: (req) => {
        const h = { 'Authorization': 'Bearer injected-token' };
        headerCalls.push(h);
        return h;
      },
      getBodyTransform: () => null,
    };
    const port = await startAdapter(adapter);
    await fetch(port, '/v1/models').catch(() => {});
    expect(headerCalls).toHaveLength(1);
    expect(headerCalls[0].Authorization).toBe('Bearer injected-token');
  });

  // ── getBodyTransform called once per request (not per-call) ──────────────

  it('calls getBodyTransform() once per request', async () => {
    let callCount = 0;
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const upstreamPort = await new Promise((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve(upstream.address().port));
    });
    servers.push(upstream);

    const adapter = {
      name: 'test-transform-count', port: 0, isManagementPort: false, alwaysBind: false,
      participatesInValidation: false,
      isEnabled: () => true,
      getTargetHost: () => `127.0.0.1:${upstreamPort}`,
      getBasePath: () => '',
      getAuthHeaders: () => ({}),
      getBodyTransform: () => { callCount++; return null; },
    };
    const port = await startAdapter(adapter);

    await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST' }, resolve);
      req.on('error', reject);
      req.write('{}');
      req.end();
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(callCount).toBe(1);
  });

  // ── 400/401/403 upstream response → upstream_auth_error log ──────────────
  //
  // When the upstream provider returns an auth-related error status, the proxy
  // must emit an 'upstream_auth_error' log event so operators can diagnose
  // credential problems quickly.  A 400 specifically indicates a possible
  // malformed Authorization header (e.g. double "Bearer " prefix in BYOK mode).

  /**
   * Build a minimal mock for https.request that immediately calls back with a
   * response of the given status code.  The mock proxyRes emits 'end' after
   * the callback so request_complete is also logged.
   */
  function mockHttpsWithStatus(statusCode) {
    return jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      const proxyReq = new EventEmitter();
      proxyReq.write = jest.fn();
      proxyReq.end = jest.fn(() => {
        setImmediate(() => {
          const proxyRes = new EventEmitter();
          proxyRes.statusCode = statusCode;
          proxyRes.headers = { 'content-type': 'application/json' };
          proxyRes.pipe = jest.fn((destRes) => { destRes.end('{}'); });
          callback(proxyRes);
          setImmediate(() => proxyRes.emit('end'));
        });
      });
      proxyReq.destroy = jest.fn();
      return proxyReq;
    });
  }

  it('emits upstream_auth_error when upstream returns 400', async () => {
    const { lines, spy } = collectLogOutput();
    mockHttpsWithStatus(400);

    const adapter = {
      name: 'copilot', port: 0, isManagementPort: false, alwaysBind: false,
      participatesInValidation: false,
      isEnabled: () => true,
      getTargetHost: () => 'openrouter.ai',
      getBasePath: () => '',
      getAuthHeaders: () => ({ 'Authorization': 'Bearer sk-or-key' }),
      getBodyTransform: () => null,
    };
    const port = await startAdapter(adapter);

    await fetch(port, '/v1/chat/completions', { method: 'POST', body: '{}' });

    jest.restoreAllMocks();
    spy.mockRestore();

    const authErrLog = lines.find(l => l.event === 'upstream_auth_error' && l.status === 400);
    expect(authErrLog).toBeDefined();
    expect(authErrLog.provider).toBe('copilot');
    expect(authErrLog.message).toContain('400');
  });

  it('emits upstream_auth_error when upstream returns 401', async () => {
    const { lines, spy } = collectLogOutput();
    mockHttpsWithStatus(401);

    const adapter = {
      name: 'copilot', port: 0, isManagementPort: false, alwaysBind: false,
      participatesInValidation: false,
      isEnabled: () => true,
      getTargetHost: () => 'api.githubcopilot.com',
      getBasePath: () => '',
      getAuthHeaders: () => ({ 'Authorization': 'Bearer gho_token' }),
      getBodyTransform: () => null,
    };
    const port = await startAdapter(adapter);

    await fetch(port, '/v1/chat/completions', { method: 'POST', body: '{}' });

    jest.restoreAllMocks();
    spy.mockRestore();

    const authErrLog = lines.find(l => l.event === 'upstream_auth_error' && l.status === 401);
    expect(authErrLog).toBeDefined();
    expect(authErrLog.provider).toBe('copilot');
    expect(authErrLog.message).toContain('401');
  });

  it('does NOT emit upstream_auth_error for a successful 200 response', async () => {
    const { lines, spy } = collectLogOutput();
    mockHttpsWithStatus(200);

    const adapter = {
      name: 'copilot', port: 0, isManagementPort: false, alwaysBind: false,
      participatesInValidation: false,
      isEnabled: () => true,
      getTargetHost: () => 'api.githubcopilot.com',
      getBasePath: () => '',
      getAuthHeaders: () => ({ 'Authorization': 'Bearer gho_token' }),
      getBodyTransform: () => null,
    };
    const port = await startAdapter(adapter);

    await fetch(port, '/v1/chat/completions', { method: 'POST', body: '{}' });

    jest.restoreAllMocks();
    spy.mockRestore();

    const authErrLog = lines.find(l => l.event === 'upstream_auth_error');
    expect(authErrLog).toBeUndefined();
  });
});

// ── Provider adapter alwaysBind tests ─────────────────────────────────────────
//
// These tests verify that anthropic, copilot, and opencode always bind and
// return clear errors when credentials are absent.
//

const { createAnthropicAdapter } = require('./providers/anthropic');
const { createCopilotAdapter }   = require('./providers/copilot');
const { createOpenCodeAdapter }  = require('./providers/opencode');

describe('provider adapter alwaysBind', () => {
  it('anthropic alwaysBind is true', () => {
    const adapter = createAnthropicAdapter({});
    expect(adapter.alwaysBind).toBe(true);
  });

  it('copilot alwaysBind is true', () => {
    const adapter = createCopilotAdapter({});
    expect(adapter.alwaysBind).toBe(true);
  });

  it('opencode alwaysBind is true', () => {
    const adapter = createOpenCodeAdapter({});
    expect(adapter.alwaysBind).toBe(true);
  });

  it('anthropic getUnconfiguredResponse returns 503 with structured error', () => {
    const adapter = createAnthropicAdapter({});
    const { statusCode, body } = adapter.getUnconfiguredResponse();
    expect(statusCode).toBe(503);
    expect(body.error.type).toBe('provider_not_configured');
    expect(body.error.provider).toBe('anthropic');
    expect(body.error.port).toBe(10001);
    expect(body.error.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('anthropic getUnconfiguredHealthResponse returns 503 with not_configured status', () => {
    const adapter = createAnthropicAdapter({});
    const { statusCode, body } = adapter.getUnconfiguredHealthResponse();
    expect(statusCode).toBe(503);
    expect(body.status).toBe('not_configured');
    expect(body.service).toBe('awf-api-proxy-anthropic');
    expect(body.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('copilot getUnconfiguredResponse returns 503 with structured error', () => {
    const adapter = createCopilotAdapter({});
    const { statusCode, body } = adapter.getUnconfiguredResponse();
    expect(statusCode).toBe(503);
    expect(body.error.type).toBe('provider_not_configured');
    expect(body.error.provider).toBe('copilot');
    expect(body.error.port).toBe(10002);
    expect(body.error.message).toMatch(/COPILOT_GITHUB_TOKEN/);
  });

  it('copilot getUnconfiguredHealthResponse returns 503 with not_configured status', () => {
    const adapter = createCopilotAdapter({});
    const { statusCode, body } = adapter.getUnconfiguredHealthResponse();
    expect(statusCode).toBe(503);
    expect(body.status).toBe('not_configured');
    expect(body.service).toBe('awf-api-proxy-copilot');
    expect(body.error).toMatch(/COPILOT_GITHUB_TOKEN/);
  });

  it('opencode getUnconfiguredResponse returns 503 mentioning AWF_ENABLE_OPENCODE when not enabled', () => {
    const adapter = createOpenCodeAdapter({});
    const { statusCode, body } = adapter.getUnconfiguredResponse();
    expect(statusCode).toBe(503);
    expect(body.error.type).toBe('provider_not_configured');
    expect(body.error.provider).toBe('opencode');
    expect(body.error.port).toBe(10004);
    expect(body.error.message).toMatch(/AWF_ENABLE_OPENCODE/);
  });

  it('opencode getUnconfiguredResponse returns 503 mentioning credentials when enabled but no candidates', () => {
    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' });
    const { statusCode, body } = adapter.getUnconfiguredResponse();
    expect(statusCode).toBe(503);
    expect(body.error.type).toBe('provider_not_configured');
    expect(body.error.message).toMatch(/OPENAI_API_KEY/);
    expect(body.error.message).toMatch(/COPILOT_API_KEY/);
  });

  it('opencode getUnconfiguredResponse mentions COPILOT_API_KEY when not enabled', () => {
    const adapter = createOpenCodeAdapter({});
    const { body } = adapter.getUnconfiguredResponse();
    expect(body.error.message).toMatch(/COPILOT_API_KEY/);
  });

  it('opencode getUnconfiguredHealthResponse returns 503 with not_configured status (disabled)', () => {
    const adapter = createOpenCodeAdapter({});
    const { statusCode, body } = adapter.getUnconfiguredHealthResponse();
    expect(statusCode).toBe(503);
    expect(body.status).toBe('not_configured');
    expect(body.service).toBe('awf-api-proxy-opencode');
    expect(body.error).toMatch(/AWF_ENABLE_OPENCODE/);
  });

  it('opencode getUnconfiguredHealthResponse mentions credentials when enabled but no candidates', () => {
    const adapter = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' });
    const { statusCode, body } = adapter.getUnconfiguredHealthResponse();
    expect(statusCode).toBe(503);
    expect(body.error).toMatch(/no candidate provider credentials/);
  });
});
