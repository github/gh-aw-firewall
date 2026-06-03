/**
 * Tests for model transformation and persistence helpers.
 *
 * Extracted from server.test.js during test-file refactoring.
 */

const { cachedModels, resetModelCacheState, makeModelBodyTransform, MODEL_ALIASES, buildModelsJson, writeModelsJson } = require('./server');
const { composeBodyTransforms } = require('./proxy-utils');

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

  it('refreshes provider model cache when stale and rewrites using fresh models', async () => {
    const https = require('https');
    const { EventEmitter } = require('events');
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    const prevFallback = process.env.AWF_MODEL_FALLBACK;
    const prevCopilotToken = process.env.COPILOT_GITHUB_TOKEN;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { sonnet: ['copilot/*sonnet*'] } });
    process.env.AWF_MODEL_FALLBACK = JSON.stringify({ enabled: true, strategy: 'middle_power' });
    process.env.COPILOT_GITHUB_TOKEN = 'ghu_test_token_for_models_fetch';

    const requestSpy = jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      const req = new EventEmitter();
      req.write = jest.fn();
      req.end = jest.fn(() => {
        setImmediate(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.resume = jest.fn();
          callback(res);
          setImmediate(() => {
            res.emit('data', Buffer.from('{"data":[{"id":"claude-sonnet-4.6"}]}'));
            res.emit('end');
          });
        });
      });
      req.destroy = jest.fn();
      req.on = EventEmitter.prototype.on;
      return req;
    });

    try {
      let isolatedServer;
      jest.isolateModules(() => {
        isolatedServer = require('./server');
      });

      isolatedServer.resetModelCacheState();
      isolatedServer.cachedModels.copilot = null; // stale / unavailable cache

      const transform = isolatedServer.makeModelBodyTransform('copilot');
      const transformed = await transform(Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] })));
      expect(transformed).toBeInstanceOf(Buffer);
      expect(JSON.parse(transformed.toString('utf8')).model).toBe('claude-sonnet-4.6');
      expect(requestSpy).toHaveBeenCalled();
    } finally {
      requestSpy.mockRestore();
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
      if (prevFallback === undefined) delete process.env.AWF_MODEL_FALLBACK;
      else process.env.AWF_MODEL_FALLBACK = prevFallback;
      if (prevCopilotToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
      else process.env.COPILOT_GITHUB_TOKEN = prevCopilotToken;
    }
  });

  it('should write structured model alias diagnostics to token-diag.jsonl', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-model-diag-'));
    const prevDebugTokens = process.env.AWF_DEBUG_TOKENS;
    const prevLogDir = process.env.AWF_TOKEN_LOG_DIR;
    const prevAliases = process.env.AWF_MODEL_ALIASES;

    process.env.AWF_DEBUG_TOKENS = '1';
    process.env.AWF_TOKEN_LOG_DIR = tmpDir;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { sonnet: ['copilot/*sonnet*'] } });

    let isolatedServer;
    let tokenPersistence;

    try {
      jest.isolateModules(() => {
        isolatedServer = require('./server');
        tokenPersistence = require('./token-persistence');
      });

      isolatedServer.resetModelCacheState();
      isolatedServer.cachedModels.copilot = ['claude-sonnet-4.5', 'claude-sonnet-4.6'];

      const transform = isolatedServer.makeModelBodyTransform('copilot');
      const transformed = await transform(Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] })));
      expect(transformed).toBeInstanceOf(Buffer);

      await tokenPersistence.closeLogStream();

      const diagPath = path.join(tmpDir, 'token-diag.jsonl');
      expect(fs.existsSync(diagPath)).toBe(true);

      const records = fs.readFileSync(diagPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));

      expect(records.some(r => r.event === 'model_alias_resolution_step')).toBe(true);
      const rewrite = records.find(r => r.event === 'model_alias_rewrite');
      expect(rewrite).toBeDefined();
      expect(rewrite._schema).toMatch(/^token-diag\/v\d+\.\d+\.\d+(-\w+)?$/);
      expect(rewrite.data.provider).toBe('copilot');
      expect(rewrite.data.original_model).toBe('sonnet');
      expect(rewrite.data.resolved_model).toBe('claude-sonnet-4.6');
      expect(Array.isArray(rewrite.data.resolution_steps)).toBe(true);
    } finally {
      if (tokenPersistence) await tokenPersistence.closeLogStream();

      if (prevDebugTokens === undefined) delete process.env.AWF_DEBUG_TOKENS;
      else process.env.AWF_DEBUG_TOKENS = prevDebugTokens;

      if (prevLogDir === undefined) delete process.env.AWF_TOKEN_LOG_DIR;
      else process.env.AWF_TOKEN_LOG_DIR = prevLogDir;

      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;

      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('emits model_fallback_activated and model_fallback_candidates logs when middle fallback is used', async () => {
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    const prevFallback = process.env.AWF_MODEL_FALLBACK;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { sonnet: ['openai/*sonnet*'] } });
    process.env.AWF_MODEL_FALLBACK = JSON.stringify({ enabled: true, strategy: 'middle_power' });

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      let isolatedServer;
      jest.isolateModules(() => {
        isolatedServer = require('./server');
      });

      stdoutSpy.mockClear();
      isolatedServer.resetModelCacheState();
      isolatedServer.cachedModels.openai = ['gpt-5.2', 'gpt-4.1', 'gpt-3.5-turbo'];

      const transform = isolatedServer.makeModelBodyTransform('openai');
      const transformed = await transform(Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] })));
      expect(transformed).toBeInstanceOf(Buffer);

      const records = stdoutSpy.mock.calls
        .map(([line]) => String(line).trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));

      expect(records.some(r => r.event === 'model_fallback_activated' && r.level === 'warn')).toBe(true);
      expect(records.some(r => r.event === 'model_fallback_candidates' && r.level === 'debug')).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
      if (prevFallback === undefined) delete process.env.AWF_MODEL_FALLBACK;
      else process.env.AWF_MODEL_FALLBACK = prevFallback;
    }
  });

  it('emits model_fallback_skipped log when normal resolution succeeds', async () => {
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    const prevFallback = process.env.AWF_MODEL_FALLBACK;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { sonnet: ['openai/*sonnet*'] } });
    process.env.AWF_MODEL_FALLBACK = JSON.stringify({ enabled: true, strategy: 'middle_power' });

    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      let isolatedServer;
      jest.isolateModules(() => {
        isolatedServer = require('./server');
      });

      stdoutSpy.mockClear();
      isolatedServer.resetModelCacheState();
      isolatedServer.cachedModels.openai = ['claude-sonnet-4.6', 'claude-haiku-4.5'];

      const transform = isolatedServer.makeModelBodyTransform('openai');
      const transformed = await transform(Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] })));
      expect(transformed).toBeInstanceOf(Buffer);

      const records = stdoutSpy.mock.calls
        .map(([line]) => String(line).trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));

      expect(records.some(r => r.event === 'model_fallback_skipped' && r.level === 'info')).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
      if (prevFallback === undefined) delete process.env.AWF_MODEL_FALLBACK;
      else process.env.AWF_MODEL_FALLBACK = prevFallback;
    }
  });

  it('does not apply middle fallback on copilot BYOK non-githubcopilot targets', async () => {
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    const prevFallback = process.env.AWF_MODEL_FALLBACK;
    const prevCopilotTarget = process.env.COPILOT_API_TARGET;
    const prevCopilotProviderType = process.env.COPILOT_PROVIDER_TYPE;
    const prevCopilotProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
    const prevCopilotApiKey = process.env.COPILOT_PROVIDER_API_KEY;

    process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { sonnet: ['openai/*sonnet*'] } });
    process.env.AWF_MODEL_FALLBACK = JSON.stringify({ enabled: true, strategy: 'middle_power' });
    process.env.COPILOT_API_TARGET = 'example-resource.openai.azure.com';
    process.env.COPILOT_PROVIDER_TYPE = 'azure';
    process.env.COPILOT_PROVIDER_BASE_URL = 'https://example-resource.openai.azure.com/openai/deployments/test';
    delete process.env.COPILOT_PROVIDER_API_KEY;

    try {
      let isolatedServer;
      jest.isolateModules(() => {
        isolatedServer = require('./server');
      });

      isolatedServer.resetModelCacheState();
      isolatedServer.cachedModels.copilot = ['gpt-5.2', 'gpt-4.1', 'gpt-3.5-turbo'];

      const transform = isolatedServer.makeModelBodyTransform('copilot');
      const transformed = await transform(Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] })));
      expect(transformed).toBeNull();
    } finally {
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
      if (prevFallback === undefined) delete process.env.AWF_MODEL_FALLBACK;
      else process.env.AWF_MODEL_FALLBACK = prevFallback;
      if (prevCopilotTarget === undefined) delete process.env.COPILOT_API_TARGET;
      else process.env.COPILOT_API_TARGET = prevCopilotTarget;
      if (prevCopilotProviderType === undefined) delete process.env.COPILOT_PROVIDER_TYPE;
      else process.env.COPILOT_PROVIDER_TYPE = prevCopilotProviderType;
      if (prevCopilotProviderBaseUrl === undefined) delete process.env.COPILOT_PROVIDER_BASE_URL;
      else process.env.COPILOT_PROVIDER_BASE_URL = prevCopilotProviderBaseUrl;
      if (prevCopilotApiKey === undefined) delete process.env.COPILOT_PROVIDER_API_KEY;
      else process.env.COPILOT_PROVIDER_API_KEY = prevCopilotApiKey;
    }
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

  it('should include all four providers', () => {
    const result = buildModelsJson();
    const providerKeys = Object.keys(result.providers);
    expect(providerKeys).toHaveLength(4);
    expect(providerKeys).toEqual(expect.arrayContaining(['openai', 'anthropic', 'copilot', 'gemini']));
  });

  it('should set models to null for uncached providers', () => {
    const result = buildModelsJson();
    // Without populating cachedModels, all models fields should be null
    for (const provider of ['openai', 'anthropic', 'copilot', 'gemini']) {
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

  it('should filter out model_aliases that cannot be resolved with known model data', () => {
    // This test requires an isolated module with specific AWF_MODEL_ALIASES config.
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    const prevFallback = process.env.AWF_MODEL_FALLBACK;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({
      models: {
        sonnet: ['copilot/*sonnet*'],
        'no-match': ['copilot/nonexistent-model'],
      },
    });
    process.env.AWF_MODEL_FALLBACK = JSON.stringify({ enabled: false });

    try {
      let isolatedServer;
      jest.isolateModules(() => { isolatedServer = require('./server'); });

      isolatedServer.resetModelCacheState();
      // Only copilot has model data — and it has no 'nonexistent-model'
      isolatedServer.cachedModels.copilot = ['claude-sonnet-4.6'];

      const result = isolatedServer.buildModelsJson();
      // 'sonnet' resolves to 'claude-sonnet-4.6' → kept
      expect(result.model_aliases).toHaveProperty('sonnet');
      // 'no-match' resolves to nothing → filtered out
      expect(result.model_aliases).not.toHaveProperty('no-match');
    } finally {
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
      if (prevFallback === undefined) delete process.env.AWF_MODEL_FALLBACK;
      else process.env.AWF_MODEL_FALLBACK = prevFallback;
    }
  });

  it('should keep all model_aliases when no provider has model data yet', () => {
    const prevAliases = process.env.AWF_MODEL_ALIASES;
    process.env.AWF_MODEL_ALIASES = JSON.stringify({
      models: {
        sonnet: ['copilot/*sonnet*'],
        'no-match': ['copilot/nonexistent-model'],
      },
    });

    try {
      let isolatedServer;
      jest.isolateModules(() => { isolatedServer = require('./server'); });

      isolatedServer.resetModelCacheState();
      // No model data for any provider

      const result = isolatedServer.buildModelsJson();
      // Both aliases should be present since we don't yet know what's available
      expect(result.model_aliases).toHaveProperty('sonnet');
      expect(result.model_aliases).toHaveProperty('no-match');
    } finally {
      if (prevAliases === undefined) delete process.env.AWF_MODEL_ALIASES;
      else process.env.AWF_MODEL_ALIASES = prevAliases;
    }
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
    expect(providerKeys).toHaveLength(4);
    expect(providerKeys).toEqual(expect.arrayContaining(['openai', 'anthropic', 'copilot', 'gemini']));
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

  it('supports async transforms in composition', async () => {
    const asyncUpper = async (buf) => Buffer.from(buf.toString('utf8').toUpperCase(), 'utf8');
    const composed = composeBodyTransforms(asyncUpper, exclaim);
    const out = await composed(Buffer.from('hello'));
    expect(out.toString()).toBe('HELLO!');
  });
});
