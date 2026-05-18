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
const { EventEmitter } = require('events');

afterAll(async () => {
  await closeLogStream();
});

// ── validateTokenUsageRecord ─────────────────────────────────────────

describe('validateTokenUsageRecord', () => {
  const validRecord = {
    _schema: 'token-usage/v0.0.0-dev',
    timestamp: '2025-01-01T00:00:00.000Z',
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

    function buildFrame(text) {
      const payload = Buffer.from(text, 'utf8');
      const header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = payload.length;
      return Buffer.concat([header, payload]);
    }

    const httpHeader = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
    const frame1 = buildFrame(JSON.stringify({
      type: 'message_start',
      message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 20, output_tokens: 0 } },
    }));
    const frame2 = buildFrame(JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 8 },
    }));

    trackWebSocketTokenUsage(socket, {
      requestId: 'schema-field-ws',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: null,
    });

    socket.emit('data', Buffer.concat([httpHeader, frame1, frame2]));
    socket.emit('close');

    setTimeout(() => {
      expect(mockStream.write).toHaveBeenCalledTimes(1);
      const parsed = mockStream.writtenRecords[0];
      expect(parsed._schema).toMatch(/^token-usage\/v\d+\.\d+\.\d+(-\w+)?$/);
      expect(parsed.request_id).toBe('schema-field-ws');
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
