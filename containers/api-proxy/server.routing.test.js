/**
 * Tests for URL normalization & routing functions.
 *
 * Extracted from server.test.js lines 20–489, 1066–1296.
 */

const { normalizeApiTarget, normalizeBasePath, buildUpstreamPath } = require('./proxy-utils');
const { deriveCopilotApiTarget, deriveGitHubApiTarget, deriveGitHubApiBasePath } = require('./providers/copilot');
const { resolveOpenCodeRoute } = require('./providers/opencode');

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
    originalEnv = {
      COPILOT_API_TARGET: process.env.COPILOT_API_TARGET,
      GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
    };
    delete process.env.COPILOT_API_TARGET;
    delete process.env.GITHUB_SERVER_URL;
  });

  afterEach(() => {
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
      expect(buildUpstreamPath('/responses', 'api.openai.com', '/v1'))
        .toBe('/v1/responses');
    });

    it('should preserve already-versioned OpenAI responses path with /v1 basePath', () => {
      expect(buildUpstreamPath('/v1/responses', 'api.openai.com', '/v1'))
        .toBe('/v1/responses');
    });

    it('should map unversioned /responses to /v1/responses when basePath is /v1 (host-with-port variant)', () => {
      expect(buildUpstreamPath('/responses', 'api.openai.com', '/v1'))
        .toBe('/v1/responses');
    });

    it('should preserve /v1/messages exactly (Anthropic standard path)', () => {
      expect(buildUpstreamPath('/v1/messages', 'api.anthropic.com', ''))
        .toBe('/v1/messages');
    });

    it('should handle URL-encoded characters in path', () => {
      expect(buildUpstreamPath('/v1/models/gpt-4%2Fturbo', HOST, '/serving-endpoints'))
        .toBe('/serving-endpoints/v1/models/gpt-4%2Fturbo');
    });

    it('should handle hash fragment being ignored (not forwarded in HTTP requests)', () => {
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
      const badTarget = 'https://my-gateway.example.com';
      const targetUrl = new URL('/v1/messages', `https://${badTarget}`);
      expect(targetUrl.hostname).not.toBe('my-gateway.example.com');
    });
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
    const openai    = makeStubAdapter('openai',    true, { targetHost: 'api.openai.com' });
    const anthropic = makeStubAdapter('anthropic', true, { targetHost: 'api.anthropic.com' });
    const copilot   = makeStubAdapter('copilot',   true, { targetHost: 'api.githubcopilot.com' });

    const opencode = createOpenCodeAdapter({ AWF_ENABLE_OPENCODE: 'true' }, { candidateAdapters: [openai, anthropic, copilot] });

    expect(openai.isEnabled()).toBe(true);
    expect(anthropic.isEnabled()).toBe(true);
    expect(copilot.isEnabled()).toBe(true);

    expect(opencode.isEnabled()).toBe(true);
    expect(opencode.getTargetHost(fakeReq)).toBe('api.openai.com');

    expect(openai.getTargetHost()).toBe('api.openai.com');
    expect(anthropic.getTargetHost()).toBe('api.anthropic.com');
    expect(copilot.getTargetHost()).toBe('api.githubcopilot.com');
  });
});
