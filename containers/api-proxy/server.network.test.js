/**
 * Tests for network-oriented api-proxy server helpers.
 *
 * Extracted from server.test.js during test-file refactoring.
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const { httpProbe, fetchJson, extractModelIds, fetchStartupModels, reflectEndpoints, cachedModels, resetModelCacheState } = require('./server');
const { createCopilotAdapter } = require('./providers/copilot');

function createModelsAdapter(name, config) {
  return {
    name,
    getModelsFetchConfig: () => config,
  };
}

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
    await fetchStartupModels([createModelsAdapter('openai', {
      cacheKey: 'openai',
      url: 'https://api.openai.com/v1/models',
      opts: { method: 'GET', headers: { Authorization: 'Bearer sk-test' } },
    })]);
    expect(cachedModels.openai).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('should populate cachedModels.anthropic when Anthropic key is configured', async () => {
    mockHttpsRequestWithBody(200, '{"data":[{"id":"claude-opus-4-5"},{"id":"claude-haiku-4-5"}]}');
    await fetchStartupModels([createModelsAdapter('anthropic', {
      cacheKey: 'anthropic',
      url: 'https://api.anthropic.com/v1/models',
      opts: { method: 'GET', headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' } },
    })]);
    expect(cachedModels.anthropic).toEqual(['claude-haiku-4-5', 'claude-opus-4-5']);
  });

  it('should populate cachedModels.copilot when Copilot token is configured', async () => {
    mockHttpsRequestWithBody(200, '{"data":[{"id":"gpt-4o"},{"id":"o3-mini"}]}');
    await fetchStartupModels([createModelsAdapter('copilot', {
      cacheKey: 'copilot',
      url: 'https://api.githubcopilot.com/models',
      opts: {
        method: 'GET',
        headers: { Authorization: 'Bearer gho_test', 'Copilot-Integration-Id': 'copilot-developer-cli' },
      },
    })]);
    expect(cachedModels.copilot).toEqual(['gpt-4o', 'o3-mini']);
  });

  it('should populate cachedModels.gemini when Gemini key is configured', async () => {
    mockHttpsRequestWithBody(200, '{"models":[{"name":"models/gemini-1.5-pro"},{"name":"models/gemini-1.5-flash"}]}');
    await fetchStartupModels([createModelsAdapter('gemini', {
      cacheKey: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/models',
      opts: { method: 'GET', headers: { 'x-goog-api-key': 'gemini-test-key' } },
    })]);
    expect(cachedModels.gemini).toEqual(['gemini-1.5-flash', 'gemini-1.5-pro']);
  });

  it('should set cachedModels.openai to null when models fetch returns error status', async () => {
    mockHttpsRequestWithBody(401, '{"error":"unauthorized"}');
    await fetchStartupModels([createModelsAdapter('openai', {
      cacheKey: 'openai',
      url: 'https://api.openai.com/v1/models',
      opts: { method: 'GET', headers: { Authorization: 'Bearer sk-bad' } },
    })]);
    expect(cachedModels.openai).toBeNull();
    const reflect = reflectEndpoints();
    expect(reflect.models_fetch_complete).toBe(true);
  });

  it('should skip Copilot models fetch when only BYOK key (no GitHub token) is configured', async () => {
    const spy = jest.spyOn(https, 'request');
    await fetchStartupModels([createModelsAdapter('copilot', null)]);
    // No HTTPS request should have been made for the copilot models endpoint
    expect(spy).not.toHaveBeenCalled();
    expect(cachedModels.copilot).toBeUndefined();
  });

  it('should populate cachedModels.copilot when BYOK key + custom provider target (adapter-based path)', async () => {
    mockHttpsRequestWithBody(200, '{"data":[{"id":"minimax/minimax-m2.5:free"},{"id":"openai/gpt-4o"}]}');
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'sk-or-byok-key',
      COPILOT_API_TARGET: 'openrouter.ai',
      COPILOT_API_BASE_PATH: '/api/v1',
    });
    await fetchStartupModels([adapter]);
    // Models from the custom BYOK provider should be cached
    expect(cachedModels.copilot).toEqual(['minimax/minimax-m2.5:free', 'openai/gpt-4o']);
  });

  it('should skip fetching when no keys are configured', async () => {
    const spy = jest.spyOn(https, 'request');
    await fetchStartupModels([]);
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

  it('should return an array of 4 endpoints', () => {
    const result = reflectEndpoints();
    expect(result.endpoints).toHaveLength(4);
  });

  it('should include all expected providers', () => {
    const result = reflectEndpoints();
    const providers = result.endpoints.map((e) => e.provider);
    expect(providers).toEqual(['openai', 'anthropic', 'copilot', 'gemini']);
  });

  it('should report models_fetch_complete false before fetch runs', () => {
    const result = reflectEndpoints();
    expect(result.models_fetch_complete).toBe(false);
  });

  it('should include model fallback settings in reflect output', () => {
    const result = reflectEndpoints();
    expect(result.model_fallback).toEqual({
      enabled: true,
      strategy: 'middle_power',
      excludeEngines: [],
    });
    expect(result.model_fallback_effective).toEqual({
      openai: { enabled: true, strategy: 'middle_power', excludeEngines: [], suppressed: false },
      anthropic: { enabled: true, strategy: 'middle_power', excludeEngines: [], suppressed: false },
      copilot: { enabled: false, strategy: 'middle_power', excludeEngines: [], suppressed: true, suppression_reason: 'copilot_standard_authoritative' },
      gemini: { enabled: true, strategy: 'middle_power', excludeEngines: [], suppressed: false },
    });
  });

  it('should include ai_credits in reflect output', () => {
    const result = reflectEndpoints();
    expect(result.ai_credits).toEqual({
      total: 0,
      by_model: {},
    });
  });

  it('should expose Copilot fallback suppression in reflect output for BYOK non-githubcopilot targets', () => {
    const prevTarget = process.env.COPILOT_API_TARGET;
    const prevProviderType = process.env.COPILOT_PROVIDER_TYPE;
    const prevProviderBase = process.env.COPILOT_PROVIDER_BASE_URL;
    const prevApiKey = process.env.COPILOT_PROVIDER_API_KEY;

    process.env.COPILOT_API_TARGET = 'example-resource.openai.azure.com';
    process.env.COPILOT_PROVIDER_TYPE = 'azure';
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://example-resource.openai.azure.com/openai/deployments/test';
    process.env.COPILOT_PROVIDER_API_KEY = 'sk-test-byok';

    try {
      let isolatedServer;
      jest.isolateModules(() => {
        isolatedServer = require('./server');
      });

      const reflect = isolatedServer.reflectEndpoints();
      expect(reflect.model_fallback).toEqual({ enabled: true, strategy: 'middle_power', excludeEngines: [] });
      expect(reflect.model_fallback_effective.copilot).toEqual({
        enabled: false,
        strategy: 'middle_power',
        excludeEngines: [],
        suppressed: true,
        suppression_reason: 'copilot_byok_non_githubcopilot_target',
      });
    } finally {
      if (prevTarget === undefined) delete process.env.COPILOT_API_TARGET;
      else process.env.COPILOT_API_TARGET = prevTarget;
      if (prevProviderType === undefined) delete process.env.COPILOT_PROVIDER_TYPE;
      else process.env.COPILOT_PROVIDER_TYPE = prevProviderType;
      if (prevProviderBase === undefined) delete process.env.COPILOT_PROVIDER_BASE_URL;
      else process.env.COPILOT_PROVIDER_BASE_URL = prevProviderBase;
      if (prevApiKey === undefined) delete process.env.COPILOT_PROVIDER_API_KEY;
      else process.env.COPILOT_PROVIDER_API_KEY = prevApiKey;
    }
  });

  it('should suppress fallback for standard Copilot (no BYOK hints)', () => {
    const hintVars = [
      'COPILOT_PROVIDER_TYPE',
      'COPILOT_PROVIDER_BASE_URL',
      'COPILOT_PROVIDER_API_KEY',
      'COPILOT_API_TARGET',
    ];
    const prevValues = Object.fromEntries(hintVars.map(name => [name, process.env[name]]));
    for (const name of hintVars) delete process.env[name];

    try {
      let isolatedServer;
      jest.isolateModules(() => {
        isolatedServer = require('./server');
      });

      const result = isolatedServer.reflectEndpoints();
      expect(result.model_fallback_effective.copilot).toEqual({
        enabled: false,
        strategy: 'middle_power',
        excludeEngines: [],
        suppressed: true,
        suppression_reason: 'copilot_standard_authoritative',
      });
    } finally {
      for (const [name, value] of Object.entries(prevValues)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('should suppress fallback for engines in excludeEngines config', () => {
    const prevFallback = process.env.AWF_MODEL_FALLBACK;
    process.env.AWF_MODEL_FALLBACK = JSON.stringify({
      enabled: true,
      strategy: 'middle_power',
      excludeEngines: [' OpenAI ', 'anthropic', 'OPENAI', '   '],
    });

    try {
      let isolatedServer;
      jest.isolateModules(() => {
        isolatedServer = require('./server');
      });

      const reflect = isolatedServer.reflectEndpoints();
      expect(reflect.model_fallback_effective.openai).toEqual({
        enabled: false,
        strategy: 'middle_power',
        excludeEngines: ['openai', 'anthropic'],
        suppressed: true,
        suppression_reason: 'excluded_by_config',
      });
      expect(reflect.model_fallback_effective.anthropic).toEqual({
        enabled: false,
        strategy: 'middle_power',
        excludeEngines: ['openai', 'anthropic'],
        suppressed: true,
        suppression_reason: 'excluded_by_config',
      });
      // Gemini not in excludeEngines — should NOT be suppressed
      expect(reflect.model_fallback_effective.gemini).toEqual({
        enabled: true,
        strategy: 'middle_power',
        excludeEngines: ['openai', 'anthropic'],
        suppressed: false,
      });
    } finally {
      if (prevFallback === undefined) delete process.env.AWF_MODEL_FALLBACK;
      else process.env.AWF_MODEL_FALLBACK = prevFallback;
    }
  });

  it('should report models_fetch_complete true after fetch completes', async () => {
    await fetchStartupModels([]);
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
    });
  });

  it('should include correct models_url for configured providers', () => {
    const result = reflectEndpoints();
    const urlMap = Object.fromEntries(result.endpoints.map((e) => [e.provider, e.models_url]));
    expect(urlMap.openai).toBe('http://api-proxy:10000/v1/models');
    expect(urlMap.anthropic).toBe('http://api-proxy:10001/v1/models');
    expect(urlMap.copilot).toBe('http://api-proxy:10002/models');
    expect(urlMap.gemini).toBe('http://api-proxy:10003/v1beta/models');
  });
});
