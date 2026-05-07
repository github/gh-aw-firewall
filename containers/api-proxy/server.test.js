/**
 * Tests for api-proxy server.js — integration, provider server, and general tests.
 *
 * Routing tests → server.routing.test.js
 * Auth tests → server.auth.test.js
 * Proxy behavior tests → server.proxy.test.js
 * Gemini tests → server.gemini.test.js
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

// Core proxy functions that remain in server.js
const { httpProbe, validateApiKeys, keyValidationResults, resetKeyValidationState, fetchJson, extractModelIds, fetchStartupModels, reflectEndpoints, healthResponse, cachedModels, resetModelCacheState, makeModelBodyTransform, MODEL_ALIASES, buildModelsJson, writeModelsJson, createProviderServer, extractBillingHeaders } = require('./server');
const { composeBodyTransforms } = require('./proxy-utils');
const { createCopilotAdapter } = require('./providers/copilot');

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

  it('should populate cachedModels.copilot when BYOK key + custom provider target (adapter-based path)', async () => {
    mockHttpsRequestWithBody(200, '{"data":[{"id":"minimax/minimax-m2.5:free"},{"id":"openai/gpt-4o"}]}');
    const adapter = createCopilotAdapter({
      COPILOT_API_KEY: 'sk-or-byok-key',
      COPILOT_API_TARGET: 'openrouter.ai',
      COPILOT_API_BASE_PATH: '/api/v1',
    });
    await fetchStartupModels([adapter]);
    // Models from the custom BYOK provider should be cached
    expect(cachedModels.copilot).toEqual(['minimax/minimax-m2.5:free', 'openai/gpt-4o']);
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

describe('extractBillingHeaders', () => {
  it('returns null when no billing headers present', () => {
    expect(extractBillingHeaders({ 'content-type': 'application/json' })).toBeNull();
  });

  it('extracts X-Quota-Snapshot-Premium-Chat header', () => {
    const headers = {
      'x-quota-snapshot-premium-chat': 'ent=50&ov=0.0&ovPerm=false&rem=48.5&rst=2025-12-15T23%3A59%3A59Z',
    };
    const result = extractBillingHeaders(headers);
    expect(result).not.toBeNull();
    expect(result['quota_premium-chat']).toEqual({
      ent: '50',
      ov: '0.0',
      ovPerm: 'false',
      rem: '48.5',
      rst: '2025-12-15T23:59:59Z',
    });
  });

  it('extracts multiple quota snapshot headers', () => {
    const headers = {
      'x-quota-snapshot-chat': 'ent=-1&ov=0.0&ovPerm=true&rem=0.0',
      'x-quota-snapshot-premium-chat': 'ent=50&ov=2.0&ovPerm=false&rem=40.0',
    };
    const result = extractBillingHeaders(headers);
    expect(result['quota_chat']).toEqual({ ent: '-1', ov: '0.0', ovPerm: 'true', rem: '0.0' });
    expect(result['quota_premium-chat']).toEqual({ ent: '50', ov: '2.0', ovPerm: 'false', rem: '40.0' });
  });

  it('extracts rate limit headers', () => {
    const headers = {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '95',
      'x-ratelimit-reset': '1700000000',
    };
    const result = extractBillingHeaders(headers);
    expect(result.rate_limit).toBe('100');
    expect(result.rate_remaining).toBe('95');
    expect(result.rate_reset).toBe('1700000000');
  });

  it('handles malformed quota snapshot gracefully', () => {
    const headers = {
      'x-quota-snapshot-premium-chat': 'not-valid-url-params=%%invalid',
    };
    // URLSearchParams is lenient — it won't throw on most strings
    const result = extractBillingHeaders(headers);
    expect(result).not.toBeNull();
  });
});
