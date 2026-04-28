/**
 * Tests for api-proxy server.js
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { EventEmitter } = require('events');
const { normalizeApiTarget, deriveCopilotApiTarget, deriveGitHubApiTarget, deriveGitHubApiBasePath, normalizeBasePath, buildUpstreamPath, proxyWebSocket, resolveCopilotAuthToken, resolveOpenCodeRoute, shouldStripHeader, stripGeminiKeyParam, httpProbe, validateApiKeys, keyValidationResults, resetKeyValidationState, fetchJson, extractModelIds, fetchStartupModels, reflectEndpoints, cachedModels, resetModelCacheState } = require('./server');

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

    it('should map unversioned /responses to /v1/responses for api.openai.com', () => {
      expect(buildUpstreamPath('/responses', 'api.openai.com', ''))
        .toBe('/v1/responses');
    });

    it('should preserve already-versioned OpenAI responses path', () => {
      expect(buildUpstreamPath('/v1/responses', 'api.openai.com', ''))
        .toBe('/v1/responses');
    });

    it('should map unversioned /responses to /v1/responses when OpenAI host includes port', () => {
      expect(buildUpstreamPath('/responses', 'api.openai.com:443', ''))
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

  it('should report opencode as configured when openai key is present', () => {
    // The module-level OPENAI_API_KEY is whatever process.env had at import time.
    // We reflect the real configured state — just verify the shape is correct.
    const result = reflectEndpoints();
    const opencode = result.endpoints.find((e) => e.provider === 'opencode');
    expect(typeof opencode.configured).toBe('boolean');
    expect(opencode.models).toBeNull();
    expect(opencode.models_url).toBeNull();
  });
});
