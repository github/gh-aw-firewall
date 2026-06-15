/**
 * Tests for token-tracker.js (schema validation)
 */

const fs = require('fs');

require('./test-helpers/token-tracker-setup');

const {
  trackTokenUsage,
  trackWebSocketTokenUsage,
  validateTokenUsageRecord,
  writeTokenUsage,
  closeLogStream,
} = require('./token-tracker');
const {
  buildTokenUsageRecord,
  buildTokenDiagRecord,
  incrementTokenMetrics,
  validateTokenDiagRecord,
  TOKEN_DIAG_SCHEMA,
} = require('./token-persistence');
const { EventEmitter } = require('events');
const { buildAnthropicUsageFrames } = require('./test-helpers/websocket-frame-helpers');

afterAll(async () => {
  await closeLogStream();
});

// ── validateTokenUsageRecord ─────────────────────────────────────────

describe('validateTokenUsageRecord', () => {
  const validRecord = {
    _schema: 'token-usage/v0.0.0-dev',
    timestamp: '2025-01-01T00:00:00.000Z',
    event: 'token_usage',
    request_id: 'req-123',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    path: '/v1/messages',
    status: 200,
    streaming: false,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    duration_ms: 1234,
  };

  test('accepts a valid record', () => {
    expect(validateTokenUsageRecord(validRecord)).toBe(true);
  });

  test('accepts a record with optional response_bytes', () => {
    expect(validateTokenUsageRecord({ ...validRecord, response_bytes: 512 })).toBe(true);
  });

  test('accepts any semver version in _schema', () => {
    expect(validateTokenUsageRecord({ ...validRecord, _schema: 'token-usage/v1.2.3' })).toBe(true);
    expect(validateTokenUsageRecord({ ...validRecord, _schema: 'token-usage/v0.26.0' })).toBe(true);
    expect(validateTokenUsageRecord({ ...validRecord, _schema: 'token-usage/v0.0.0-dev' })).toBe(true);
  });

  test('rejects a record with wrong _schema', () => {
    expect(validateTokenUsageRecord({ ...validRecord, _schema: 'wrong/v99' })).toBe(false);
  });

  test('rejects a record with non-semver _schema', () => {
    expect(validateTokenUsageRecord({ ...validRecord, _schema: 'token-usage/v1' })).toBe(false);
  });

  test('rejects a record missing _schema', () => {
    const { _schema, ...noSchema } = validRecord;
    expect(validateTokenUsageRecord(noSchema)).toBe(false);
  });

  test('rejects a record with non-string timestamp', () => {
    expect(validateTokenUsageRecord({ ...validRecord, timestamp: 1234567890 })).toBe(false);
  });

  test('rejects a record missing event', () => {
    const { event, ...noEvent } = validRecord;
    expect(validateTokenUsageRecord(noEvent)).toBe(false);
  });

  test('rejects a record with non-number input_tokens', () => {
    expect(validateTokenUsageRecord({ ...validRecord, input_tokens: '100' })).toBe(false);
  });

  test('rejects a record with non-boolean streaming', () => {
    expect(validateTokenUsageRecord({ ...validRecord, streaming: 'true' })).toBe(false);
  });

  test('rejects a record missing a required field', () => {
    const { model, ...noModel } = validRecord;
    expect(validateTokenUsageRecord(noModel)).toBe(false);
  });

  test('rejects null without throwing', () => {
    expect(validateTokenUsageRecord(null)).toBe(false);
  });

  test('rejects undefined without throwing', () => {
    expect(validateTokenUsageRecord(undefined)).toBe(false);
  });

  test('rejects a non-object primitive without throwing', () => {
    expect(validateTokenUsageRecord('not-an-object')).toBe(false);
    expect(validateTokenUsageRecord(42)).toBe(false);
  });
});

describe('shared token usage helpers', () => {
  test('buildTokenUsageRecord returns schema-compatible record shape', () => {
    const record = buildTokenUsageRecord({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
    }, {
      requestId: 'helper-record-test',
      provider: 'openai',
      model: null,
      reqPath: '/v1/chat/completions',
      status: 200,
      streaming: false,
      duration: 123,
      responseBytes: 456,
    });

    expect(record).toMatchObject({
      event: 'token_usage',
      request_id: 'helper-record-test',
      provider: 'openai',
      model: 'unknown',
      path: '/v1/chat/completions',
      status: 200,
      streaming: false,
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      duration_ms: 123,
      response_bytes: 456,
    });
    expect(validateTokenUsageRecord(record)).toBe(true);
  });

  test('incrementTokenMetrics is a no-op when metrics sink is missing', () => {
    expect(() => {
      incrementTokenMetrics(null, 'anthropic', { input_tokens: 1, output_tokens: 2 });
    }).not.toThrow();
  });
});

describe('token-diag schema helpers', () => {
  test('buildTokenDiagRecord returns schema-compatible record shape', () => {
    const record = buildTokenDiagRecord('MODEL_ALIAS_REWRITE', {
      provider: 'copilot',
      original_model: 'gpt-5.5',
      resolved_model: 'gpt-5.4',
    });
    expect(record).toMatchObject({
      _schema: TOKEN_DIAG_SCHEMA,
      event: 'MODEL_ALIAS_REWRITE',
    });
    expect(validateTokenDiagRecord(record)).toBe(true);
  });

  test('validateTokenDiagRecord rejects invalid diag schema record', () => {
    expect(validateTokenDiagRecord({
      _schema: 'token-diag/v1',
      timestamp: new Date().toISOString(),
      event: 'MODEL_ALIAS_REWRITE',
      data: {},
    })).toBe(false);
  });
});

// ── JSONL records include _schema field ───────────────────────────────

/**
 * Build a writable mock stream that captures all written chunks.
 * The `written` getter parses the accumulated JSONL and returns records.
 */
function makeMockStream() {
  const chunks = [];
  const stream = {
    writableEnded: false,
    write: jest.fn((chunk) => { chunks.push(chunk); return true; }),
    end: jest.fn((cb) => { stream.writableEnded = true; if (cb) cb(); }),
    on: jest.fn(),
    get writtenRecords() {
      return chunks.map(c => JSON.parse(c.trim()));
    },
  };
  return stream;
}

describe('token-usage JSONL record schema field', () => {
  let mockStream;
  let mkdirSyncSpy;
  let createWriteStreamSpy;

  beforeEach(async () => {
    // Close any open log stream so the next getLogStream() call creates a fresh one.
    await closeLogStream();

    mockStream = makeMockStream();

    // Redirect fs.mkdirSync and fs.createWriteStream so the module writes to our
    // in-memory stream rather than the unwritable /var/log/api-proxy path.
    mkdirSyncSpy = jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    createWriteStreamSpy = jest.spyOn(fs, 'createWriteStream').mockReturnValue(mockStream);
  });

  afterEach(async () => {
    mkdirSyncSpy.mockRestore();
    createWriteStreamSpy.mockRestore();
    await closeLogStream();
  });

  test('writeTokenUsage serializes _schema with semver version into the JSONL stream', () => {
    const record = {
      _schema: 'token-usage/v0.0.0',
      timestamp: new Date().toISOString(),
      event: 'token_usage',
      request_id: 'direct-write-test',
      provider: 'openai',
      model: 'gpt-4o',
      path: '/v1/chat/completions',
      status: 200,
      streaming: false,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      duration_ms: 10,
    };

    writeTokenUsage(record);

    expect(mockStream.write).toHaveBeenCalledTimes(1);
    const parsed = mockStream.writtenRecords[0];
    expect(parsed._schema).toMatch(/^token-usage\/v\d+\.\d+\.\d+(-\w+)?$/);
    expect(parsed.request_id).toBe('direct-write-test');
  });

  test('trackTokenUsage HTTP path writes versioned _schema to the stream', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.statusCode = 200;

    trackTokenUsage(proxyRes, {
      requestId: 'schema-field-http',
      provider: 'openai',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: null,
    });

    proxyRes.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })));
    proxyRes.emit('end');

    setTimeout(() => {
      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const parsed = mockStream.writtenRecords[0];
      expect(parsed._schema).toMatch(/^token-usage\/v\d+\.\d+\.\d+(-\w+)?$/);
      expect(parsed.request_id).toBe('schema-field-http');
      done();
    }, 20);
  });

  test('trackWebSocketTokenUsage path writes versioned _schema to the stream', (done) => {
    const socket = new EventEmitter();

    trackWebSocketTokenUsage(socket, {
      requestId: 'schema-field-ws',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: null,
    });

    socket.emit('data', buildAnthropicUsageFrames());
    socket.emit('close');

    setTimeout(() => {
      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const parsed = mockStream.writtenRecords[0];
      expect(parsed._schema).toMatch(/^token-usage\/v\d+\.\d+\.\d+(-\w+)?$/);
      expect(parsed.request_id).toBe('schema-field-ws');
      done();
    }, 20);
  });

  test('trackTokenUsage HTTP path persists optional budget fields returned by onUsage', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.statusCode = 200;

    trackTokenUsage(proxyRes, {
      requestId: 'budget-fields-http',
      provider: 'openai',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: null,
      onUsage: () => ({
        effective_tokens_this_response: 40,
        effective_tokens_total: 140,
        model_multiplier: 2,
        ai_credits_this_response: 0.01,
        ai_credits_total: 0.05,
      }),
    });

    proxyRes.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })));
    proxyRes.emit('end');

    setTimeout(() => {
      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const parsed = mockStream.writtenRecords[0];
      expect(parsed).toMatchObject({
        request_id: 'budget-fields-http',
        effective_tokens_this_response: 40,
        effective_tokens_total: 140,
        model_multiplier: 2,
        ai_credits_this_response: 0.01,
        ai_credits_total: 0.05,
      });
      done();
    }, 20);
  });

  test('trackTokenUsage HTTP path omits optional budget fields when onUsage returns undefined', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.statusCode = 200;

    trackTokenUsage(proxyRes, {
      requestId: 'budget-fields-http-none',
      provider: 'openai',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: null,
      onUsage: () => undefined,
    });

    proxyRes.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })));
    proxyRes.emit('end');

    setTimeout(() => {
      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const parsed = mockStream.writtenRecords[0];
      expect(parsed.effective_tokens_this_response).toBeUndefined();
      expect(parsed.effective_tokens_total).toBeUndefined();
      expect(parsed.model_multiplier).toBeUndefined();
      expect(parsed.ai_credits_this_response).toBeUndefined();
      expect(parsed.ai_credits_total).toBeUndefined();
      done();
    }, 20);
  });

  test('trackWebSocketTokenUsage path persists optional budget fields returned by onUsage', (done) => {
    const socket = new EventEmitter();

    trackWebSocketTokenUsage(socket, {
      requestId: 'budget-fields-ws',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: null,
      onUsage: () => ({
        effective_tokens_this_response: 112,
        effective_tokens_total: 224,
        model_multiplier: 4,
        ai_credits_this_response: 0.02,
        ai_credits_total: 0.08,
      }),
    });

    socket.emit('data', buildAnthropicUsageFrames());
    socket.emit('close');

    setTimeout(() => {
      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const parsed = mockStream.writtenRecords[0];
      expect(parsed).toMatchObject({
        request_id: 'budget-fields-ws',
        effective_tokens_this_response: 112,
        effective_tokens_total: 224,
        model_multiplier: 4,
        ai_credits_this_response: 0.02,
        ai_credits_total: 0.08,
      });
      done();
    }, 20);
  });

  test('trackWebSocketTokenUsage path omits optional budget fields when onUsage returns undefined', (done) => {
    const socket = new EventEmitter();

    trackWebSocketTokenUsage(socket, {
      requestId: 'budget-fields-ws-none',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: null,
      onUsage: () => undefined,
    });

    socket.emit('data', buildAnthropicUsageFrames());
    socket.emit('close');

    setTimeout(() => {
      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const parsed = mockStream.writtenRecords[0];
      expect(parsed.effective_tokens_this_response).toBeUndefined();
      expect(parsed.effective_tokens_total).toBeUndefined();
      expect(parsed.model_multiplier).toBeUndefined();
      expect(parsed.ai_credits_this_response).toBeUndefined();
      expect(parsed.ai_credits_total).toBeUndefined();
      done();
    }, 20);
  });
});

// ── AWF_VERSION env var propagated as exact _schema value ─────────────
//
// Uses jest.isolateModules() to load a fresh token-tracker instance with a
// controlled AWF_VERSION env var so the test verifies the exact _schema value
// emitted, not just the semver pattern.

describe('token-usage _schema exact version from AWF_VERSION', () => {
  test('emits exact AWF_VERSION in _schema field', (done) => {
    const origVersion = process.env.AWF_VERSION;
    process.env.AWF_VERSION = '9.8.7';

    // Load an isolated copy of token-tracker with AWF_VERSION=9.8.7 already set
    let isolated;
    jest.isolateModules(() => {
      isolated = require('./token-tracker');
    });

    // Restore env var right away — the isolated module already captured it
    process.env.AWF_VERSION = origVersion;

    const mockStream = makeMockStream();
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeStreamSpy = jest.spyOn(fs, 'createWriteStream').mockReturnValue(mockStream);

    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.statusCode = 200;

    isolated.trackTokenUsage(proxyRes, {
      requestId: 'exact-version-test',
      provider: 'openai',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: null,
    });

    proxyRes.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })));
    proxyRes.emit('end');

    setTimeout(async () => {
      mkdirSpy.mockRestore();
      writeStreamSpy.mockRestore();
      await isolated.closeLogStream();

      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const parsed = mockStream.writtenRecords[0];
      expect(parsed._schema).toBe('token-usage/v9.8.7');
      expect(parsed.request_id).toBe('exact-version-test');
      done();
    }, 20);
  });
});
