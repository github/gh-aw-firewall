/**
 * Tests for api-proxy server lifecycle and provider adapter behavior.
 *
 * Extracted from server.test.js during test-file refactoring.
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const { fetchStartupModels, healthResponse, createProviderServer, resetModelCacheState } = require('./server');
const { createCopilotAdapter } = require('./providers/copilot');
const { collectLogOutput } = require('./test-helpers/log-test-helpers');

describe('healthResponse', () => {
  afterEach(() => {
    resetModelCacheState();
  });

  it('should include models_fetch_complete: false before model fetch runs', () => {
    const result = healthResponse();
    expect(result.models_fetch_complete).toBe(false);
  });

  it('should include models_fetch_complete: true after model fetch completes', async () => {
    await fetchStartupModels([]);
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

  it('normalizes null tool_call type before forwarding when upstream returns 400', async () => {
    const { lines, spy } = collectLogOutput();
    let writtenBody = null;
    jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      const proxyReq = new EventEmitter();
      proxyReq.write = jest.fn((chunk) => {
        writtenBody = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      });
      proxyReq.end = jest.fn(() => {
        setImmediate(() => {
          const proxyRes = new EventEmitter();
          proxyRes.statusCode = 400;
          proxyRes.headers = { 'content-type': 'application/json' };
          proxyRes.pipe = jest.fn((destRes) => { destRes.end('{}'); });
          callback(proxyRes);
          setImmediate(() => proxyRes.emit('end'));
        });
      });
      proxyReq.destroy = jest.fn();
      return proxyReq;
    });

    const adapter = createCopilotAdapter({ COPILOT_API_KEY: 'sk-test' });
    const port = await startAdapter(adapter);
    const body = {
      model: 'gpt-5.4',
      messages: [
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: null,
              function: { name: 'edit', arguments: '{"path":"README.md"}' },
            },
          ],
        },
      ],
    };
    await fetch(port, '/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });

    jest.restoreAllMocks();
    spy.mockRestore();

    const forwarded = JSON.parse(writtenBody);
    expect(forwarded.messages[0].tool_calls[0].type).toBe('function');
    const authErrLog = lines.find(l => l.event === 'upstream_auth_error' && l.status === 400);
    expect(authErrLog).toBeDefined();
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
// These tests verify that anthropic and copilot always bind and
// return clear errors when credentials are absent.
//

const { createAnthropicAdapter } = require('./providers/anthropic');

describe('provider adapter alwaysBind', () => {
  it('anthropic alwaysBind is true', () => {
    const adapter = createAnthropicAdapter({});
    expect(adapter.alwaysBind).toBe(true);
  });

  it('copilot alwaysBind is true', () => {
    const adapter = createCopilotAdapter({});
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

  it('anthropic OIDC reports disabled until token is initialized', () => {
    const adapter = createAnthropicAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
      AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid-test',
      AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
    });

    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.getOidcProvider()).not.toBeNull();
    expect(adapter.getValidationProbe()).toEqual({ skip: true, reason: 'OIDC auth; token not yet available' });
    expect(adapter.getModelsFetchConfig()).toBeNull();
    expect(adapter.getReflectionInfo().configured).toBe(true);
    expect(adapter.getReflectionInfo().auth_type).toBe('github-oidc/anthropic');
    expect(adapter.getUnconfiguredResponse()).toEqual({
      statusCode: 503,
      body: { error: 'Anthropic OIDC token unavailable; retry shortly' },
    });
    expect(adapter.getUnconfiguredHealthResponse()).toEqual({
      statusCode: 503,
      body: {
        status: 'unavailable',
        service: 'awf-api-proxy-anthropic',
        error: 'Anthropic OIDC token unavailable; retry shortly',
      },
    });

    adapter.getOidcProvider().shutdown();
  });

  it('anthropic OIDC reports a clear error when Actions OIDC env is missing', () => {
    const adapter = createAnthropicAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
    });

    expect(adapter.getOidcProvider()).toBeNull();
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.getReflectionInfo().configured).toBe(true);
    expect(adapter.getReflectionInfo().auth_type).toBe('github-oidc/anthropic');
    expect(adapter.getValidationProbe()).toBeNull();
    expect(adapter.getModelsFetchConfig()).toBeNull();
    expect(adapter.getUnconfiguredResponse()).toEqual({
      statusCode: 503,
      body: {
        error: 'Anthropic OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (permissions: id-token: write).',
      },
    });
    expect(adapter.getUnconfiguredHealthResponse()).toEqual({
      statusCode: 503,
      body: {
        status: 'unavailable',
        service: 'awf-api-proxy-anthropic',
        error: 'Anthropic OIDC requires ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (permissions: id-token: write).',
      },
    });
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

});

// ── Copilot adapter BYOK model fetch ──────────────────────────────────────────
//
// These tests verify that the Copilot adapter fetches models from a custom
// BYOK provider (e.g. OpenRouter) at startup, and that the reflect response
// includes the correct base-path-aware models URL.
//

describe('copilot adapter BYOK model fetch', () => {
  it('getModelsFetchConfig returns null for BYOK key on standard Copilot API (no GitHub token)', () => {
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-byok-key',
      COPILOT_API_TARGET: 'api.githubcopilot.com',
    });
    expect(adapter.getModelsFetchConfig()).toBeNull();
  });

  it('getModelsFetchConfig returns fetch config for BYOK key on custom target', () => {
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-or-key',
      COPILOT_API_TARGET: 'openrouter.ai',
      COPILOT_API_BASE_PATH: '/api/v1',
    });
    const config = adapter.getModelsFetchConfig();
    expect(config).not.toBeNull();
    expect(config.url).toBe('https://openrouter.ai/api/v1/models');
    expect(config.opts.method).toBe('GET');
    expect(config.opts.headers['Authorization']).toBe('Bearer sk-or-key');
    expect(config.cacheKey).toBe('copilot');
  });

  it('getModelsFetchConfig uses github token for standard Copilot API target', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_token',
    });
    const config = adapter.getModelsFetchConfig();
    expect(config).not.toBeNull();
    expect(config.url).toBe('https://api.githubcopilot.com/models');
    expect(config.opts.headers['Authorization']).toBe('Bearer ghu_token');
    expect(config.opts.headers['Copilot-Integration-Id']).toBeDefined();
    expect(config.cacheKey).toBe('copilot');
  });

  it('getModelsFetchConfig returns null when no auth token is configured', () => {
    const adapter = createCopilotAdapter({});
    expect(adapter.getModelsFetchConfig()).toBeNull();
  });

  it('getModelsFetchConfig uses /models directly when basePath is not configured', () => {
    // When no basePath is set, /models is used directly (no prefix)
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-custom-key',
      COPILOT_API_TARGET: 'custom.llm.example.com',
    });
    const config = adapter.getModelsFetchConfig();
    expect(config).not.toBeNull();
    expect(config.url).toBe('https://custom.llm.example.com/models');
  });

  it('getModelsFetchConfig uses /models (not //models) when basePath is "/"', () => {
    // normalizeBasePath('/') returns '/' — ensure we don't produce //models
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-custom-key',
      COPILOT_API_TARGET: 'custom.llm.example.com',
      COPILOT_API_BASE_PATH: '/',
    });
    const config = adapter.getModelsFetchConfig();
    expect(config).not.toBeNull();
    expect(config.url).toBe('https://custom.llm.example.com/models');
    expect(config.url).not.toContain('//models');
  });

  it('getModelsFetchConfig uses COPILOT_API_KEY (not GitHub token) for custom targets even when both are set', () => {
    // Verify that the GitHub OAuth token is never sent to third-party BYOK providers
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_github_token',
      COPILOT_API_KEY: 'sk-byok-key',
      COPILOT_API_TARGET: 'openrouter.ai',
      COPILOT_API_BASE_PATH: '/api/v1',
    });
    const config = adapter.getModelsFetchConfig();
    expect(config).not.toBeNull();
    expect(config.opts.headers['Authorization']).toBe('Bearer sk-byok-key');
    expect(config.opts.headers['Authorization']).not.toContain('ghu_github_token');
  });

  it('getModelsFetchConfig returns null for custom target when only github token is set (no BYOK key)', () => {
    // Without an explicit COPILOT_API_KEY there is nothing to authenticate with
    // at the custom provider — skip the fetch rather than forward the GitHub token.
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_token',
      COPILOT_API_TARGET: 'openrouter.ai',
    });
    expect(adapter.getModelsFetchConfig()).toBeNull();
  });

  it('getReflectionInfo includes /models for standard Copilot API (no base path)', () => {
    const adapter = createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'ghu_token' });
    const info = adapter.getReflectionInfo();
    expect(info.models_url).toBe('http://api-proxy:10002/models');
  });

  it('getReflectionInfo includes base path in models_url for BYOK providers', () => {
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-or-key',
      COPILOT_API_TARGET: 'openrouter.ai',
      COPILOT_API_BASE_PATH: '/api/v1',
    });
    const info = adapter.getReflectionInfo();
    expect(info.models_url).toBe('http://api-proxy:10002/api/v1/models');
  });

  it('getReflectionInfo uses /models (not //models) when basePath is "/"', () => {
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-or-key',
      COPILOT_API_TARGET: 'openrouter.ai',
      COPILOT_API_BASE_PATH: '/',
    });
    const info = adapter.getReflectionInfo();
    expect(info.models_url).toBe('http://api-proxy:10002/models');
    expect(info.models_url).not.toContain('//models');
  });
});
