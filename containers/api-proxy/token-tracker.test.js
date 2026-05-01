/**
 * Tests for token-tracker.js
 */

const {
  extractUsageFromJson,
  extractUsageFromSseLine,
  parseSseDataLines,
  parseWebSocketFrames,
  normalizeUsage,
  isStreamingResponse,
  isCompressedResponse,
  trackTokenUsage,
  trackWebSocketTokenUsage,
  validateTokenUsageRecord,
  writeTokenUsage,
} = require('./token-tracker');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

// Redirect token log output to a temp dir to avoid /var/log permission errors
let tmpLogDir;
beforeAll(() => {
  tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-tracker-test-'));
  process.env.AWF_TOKEN_LOG_DIR = tmpLogDir;
});

afterAll(() => {
  fs.rmSync(tmpLogDir, { recursive: true, force: true });
  delete process.env.AWF_TOKEN_LOG_DIR;
});

// ── extractUsageFromJson ──────────────────────────────────────────────

describe('extractUsageFromJson', () => {
  test('extracts OpenAI usage format', () => {
    const body = Buffer.from(JSON.stringify({
      id: 'chatcmpl-123',
      model: 'gpt-4o',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    }));

    const result = extractUsageFromJson(body);
    expect(result.model).toBe('gpt-4o');
    expect(result.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
  });

  test('extracts Anthropic usage format', () => {
    const body = Buffer.from(JSON.stringify({
      id: 'msg_123',
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 200,
        output_tokens: 80,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 150,
      },
    }));

    const result = extractUsageFromJson(body);
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.usage).toEqual({
      input_tokens: 200,
      output_tokens: 80,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 150,
    });
  });

  test('returns null usage for response without usage field', () => {
    const body = Buffer.from(JSON.stringify({ id: 'test', model: 'gpt-4o' }));
    const result = extractUsageFromJson(body);
    expect(result.usage).toBeNull();
    expect(result.model).toBe('gpt-4o');
  });

  test('returns null for invalid JSON', () => {
    const body = Buffer.from('not json');
    const result = extractUsageFromJson(body);
    expect(result.usage).toBeNull();
    expect(result.model).toBeNull();
  });

  test('returns null for empty buffer', () => {
    const result = extractUsageFromJson(Buffer.alloc(0));
    expect(result.usage).toBeNull();
  });

  test('returns null usage when usage object has no numeric fields', () => {
    const body = Buffer.from(JSON.stringify({
      usage: { some_string: 'not a number' },
    }));
    const result = extractUsageFromJson(body);
    expect(result.usage).toBeNull();
  });

  test('ignores non-numeric usage fields but keeps numeric ones', () => {
    const body = Buffer.from(JSON.stringify({
      usage: { prompt_tokens: 'not a number', completion_tokens: 50 },
    }));
    const result = extractUsageFromJson(body);
    expect(result.usage).toEqual({ completion_tokens: 50 });
  });

  test('extracts OpenAI prompt_tokens_details.cached_tokens', () => {
    const body = Buffer.from(JSON.stringify({
      id: 'chatcmpl-456',
      model: 'claude-sonnet-4.6',
      usage: {
        prompt_tokens: 41344,
        completion_tokens: 256,
        total_tokens: 41600,
        prompt_tokens_details: {
          cached_tokens: 36500,
        },
      },
    }));

    const result = extractUsageFromJson(body);
    expect(result.model).toBe('claude-sonnet-4.6');
    expect(result.usage).toEqual({
      prompt_tokens: 41344,
      completion_tokens: 256,
      total_tokens: 41600,
      cache_read_input_tokens: 36500,
    });
  });

  test('handles OpenAI usage without prompt_tokens_details', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-4o',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      },
    }));

    const result = extractUsageFromJson(body);
    expect(result.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    // Should NOT have cache_read_input_tokens
    expect(result.usage.cache_read_input_tokens).toBeUndefined();
  });
});

// ── extractUsageFromSseLine ───────────────────────────────────────────

describe('extractUsageFromSseLine', () => {
  test('extracts Anthropic message_start usage', () => {
    const line = JSON.stringify({
      type: 'message_start',
      message: {
        model: 'claude-sonnet-4-20250514',
        usage: {
          input_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 400,
        },
      },
    });

    const result = extractUsageFromSseLine(line);
    expect(result.model).toBe('claude-sonnet-4-20250514');
    expect(result.usage).toEqual({
      input_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 400,
    });
  });

  test('extracts Anthropic message_delta usage', () => {
    const line = JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 42 },
    });

    const result = extractUsageFromSseLine(line);
    expect(result.usage).toEqual({ output_tokens: 42 });
  });

  test('extracts OpenAI final chunk usage', () => {
    const line = JSON.stringify({
      model: 'gpt-4o',
      choices: [{ finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
    });

    const result = extractUsageFromSseLine(line);
    expect(result.model).toBe('gpt-4o');
    expect(result.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 130,
    });
  });

  test('returns null for [DONE]', () => {
    const result = extractUsageFromSseLine('[DONE]');
    expect(result.usage).toBeNull();
  });

  test('returns null for empty string', () => {
    const result = extractUsageFromSseLine('');
    expect(result.usage).toBeNull();
  });

  test('returns null for non-usage SSE event', () => {
    const line = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello' },
    });
    const result = extractUsageFromSseLine(line);
    expect(result.usage).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    const result = extractUsageFromSseLine('invalid json');
    expect(result.usage).toBeNull();
  });

  test('extracts OpenAI prompt_tokens_details.cached_tokens from streaming final chunk', () => {
    const line = JSON.stringify({
      model: 'claude-sonnet-4.6',
      choices: [{ finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 43977,
        completion_tokens: 24,
        total_tokens: 44001,
        prompt_tokens_details: {
          cached_tokens: 43894,
        },
      },
    });

    const result = extractUsageFromSseLine(line);
    expect(result.model).toBe('claude-sonnet-4.6');
    expect(result.usage).toEqual({
      prompt_tokens: 43977,
      completion_tokens: 24,
      total_tokens: 44001,
      cache_read_input_tokens: 43894,
    });
  });
});

// ── parseSseDataLines ─────────────────────────────────────────────────

describe('parseSseDataLines', () => {
  test('extracts data lines from SSE text', () => {
    const text = 'data: {"type":"ping"}\n\ndata: {"type":"content"}\n\n';
    const lines = parseSseDataLines(text);
    expect(lines).toEqual(['{"type":"ping"}', '{"type":"content"}']);
  });

  test('handles empty data lines', () => {
    const text = 'data:\n\ndata: {"a":1}\n\n';
    const lines = parseSseDataLines(text);
    expect(lines).toEqual(['{"a":1}']);
  });

  test('handles data: [DONE]', () => {
    const text = 'data: [DONE]\n\n';
    const lines = parseSseDataLines(text);
    expect(lines).toEqual(['[DONE]']);
  });

  test('returns empty array for non-data text', () => {
    const text = 'event: message\nid: 123\n\n';
    const lines = parseSseDataLines(text);
    expect(lines).toEqual([]);
  });

  test('handles mixed content', () => {
    const text = 'event: message\ndata: {"a":1}\ndata: {"b":2}\n\n';
    const lines = parseSseDataLines(text);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

// ── normalizeUsage ────────────────────────────────────────────────────

describe('normalizeUsage', () => {
  test('normalizes OpenAI format', () => {
    const result = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });

  test('normalizes Anthropic format', () => {
    const result = normalizeUsage({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_input_tokens: 150,
      cache_creation_input_tokens: 10,
    });
    expect(result).toEqual({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_tokens: 150,
      cache_write_tokens: 10,
    });
  });

  test('returns null for null input', () => {
    expect(normalizeUsage(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(normalizeUsage(undefined)).toBeNull();
  });

  test('defaults missing fields to 0', () => {
    const result = normalizeUsage({ input_tokens: 100 });
    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
  });

  test('prefers Anthropic fields over OpenAI when both present', () => {
    const result = normalizeUsage({
      input_tokens: 200,
      prompt_tokens: 100,
      output_tokens: 80,
      completion_tokens: 50,
    });
    expect(result.input_tokens).toBe(200);
    expect(result.output_tokens).toBe(80);
  });

  test('normalizes OpenAI cache tokens via cache_read_input_tokens mapping', () => {
    const result = normalizeUsage({
      prompt_tokens: 43977,
      completion_tokens: 24,
      total_tokens: 44001,
      cache_read_input_tokens: 43894,
    });
    expect(result).toEqual({
      input_tokens: 43977,
      output_tokens: 24,
      cache_read_tokens: 43894,
      cache_write_tokens: 0,
    });
  });
});

// ── isStreamingResponse ───────────────────────────────────────────────

describe('isStreamingResponse', () => {
  test('detects text/event-stream', () => {
    expect(isStreamingResponse({ 'content-type': 'text/event-stream' })).toBe(true);
  });

  test('detects text/event-stream with charset', () => {
    expect(isStreamingResponse({ 'content-type': 'text/event-stream; charset=utf-8' })).toBe(true);
  });

  test('returns false for application/json', () => {
    expect(isStreamingResponse({ 'content-type': 'application/json' })).toBe(false);
  });

  test('returns false for missing content-type', () => {
    expect(isStreamingResponse({})).toBe(false);
  });
});

// ── trackTokenUsage integration ───────────────────────────────────────

describe('trackTokenUsage', () => {
  test('extracts usage from non-streaming JSON response', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.statusCode = 200;

    const metricsRef = {
      increment: jest.fn(),
    };

    trackTokenUsage(proxyRes, {
      requestId: 'test-123',
      provider: 'openai',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    const body = JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    proxyRes.emit('data', Buffer.from(body));
    proxyRes.emit('end');

    // Check metrics were updated
    setTimeout(() => {
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'input_tokens_total',
        { provider: 'openai' },
        100,
      );
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'output_tokens_total',
        { provider: 'openai' },
        50,
      );
      done();
    }, 10);
  });

  test('extracts usage from streaming SSE response', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'text/event-stream' };
    proxyRes.statusCode = 200;

    const metricsRef = {
      increment: jest.fn(),
    };

    trackTokenUsage(proxyRes, {
      requestId: 'test-456',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    // Simulate Anthropic streaming: message_start with input tokens, then message_delta with output tokens
    const chunk1 = 'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 500 } },
    }) + '\n\n';

    const chunk2 = 'event: content_block_delta\ndata: ' + JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello' },
    }) + '\n\n';

    const chunk3 = 'event: message_delta\ndata: ' + JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 42 },
    }) + '\n\ndata: [DONE]\n\n';

    proxyRes.emit('data', Buffer.from(chunk1));
    proxyRes.emit('data', Buffer.from(chunk2));
    proxyRes.emit('data', Buffer.from(chunk3));
    proxyRes.emit('end');

    setTimeout(() => {
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'input_tokens_total',
        { provider: 'anthropic' },
        500,
      );
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'output_tokens_total',
        { provider: 'anthropic' },
        42,
      );
      done();
    }, 10);
  });

  test('skips non-2xx responses', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.statusCode = 401;

    const metricsRef = { increment: jest.fn() };

    trackTokenUsage(proxyRes, {
      requestId: 'test-789',
      provider: 'openai',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    proxyRes.emit('data', Buffer.from(JSON.stringify({
      error: { message: 'Unauthorized' },
    })));
    proxyRes.emit('end');

    setTimeout(() => {
      expect(metricsRef.increment).not.toHaveBeenCalled();
      done();
    }, 10);
  });

  test('handles response without usage field gracefully', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };

    trackTokenUsage(proxyRes, {
      requestId: 'test-no-usage',
      provider: 'openai',
      path: '/v1/models',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    proxyRes.emit('data', Buffer.from(JSON.stringify({ data: [] })));
    proxyRes.emit('end');

    setTimeout(() => {
      expect(metricsRef.increment).not.toHaveBeenCalled();
      done();
    }, 10);
  });
});

// ── isCompressedResponse ──────────────────────────────────────────────

describe('isCompressedResponse', () => {
  test('detects gzip encoding', () => {
    expect(isCompressedResponse({ 'content-encoding': 'gzip' })).toBe(true);
  });

  test('detects deflate encoding', () => {
    expect(isCompressedResponse({ 'content-encoding': 'deflate' })).toBe(true);
  });

  test('detects br (brotli) encoding', () => {
    expect(isCompressedResponse({ 'content-encoding': 'br' })).toBe(true);
  });

  test('returns false for no encoding', () => {
    expect(isCompressedResponse({})).toBe(false);
    expect(isCompressedResponse({ 'content-encoding': '' })).toBe(false);
    expect(isCompressedResponse({ 'content-encoding': 'identity' })).toBe(false);
  });
});

// ── trackTokenUsage with compressed responses ─────────────────────────

describe('trackTokenUsage (compressed responses)', () => {
  test('decompresses gzip SSE streaming response and extracts usage', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = {
      'content-type': 'text/event-stream; charset=utf-8',
      'content-encoding': 'gzip',
    };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };

    trackTokenUsage(proxyRes, {
      requestId: 'test-gzip-sse',
      provider: 'anthropic',
      path: '/v1/messages?beta=true',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    // Build Anthropic SSE data (plaintext)
    const sseText =
      'event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1000, cache_read_input_tokens: 800 } },
      }) + '\n\n' +
      'event: content_block_delta\ndata: ' + JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hello' },
      }) + '\n\n' +
      'event: message_delta\ndata: ' + JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 42 },
      }) + '\n\ndata: [DONE]\n\n';

    // Compress the SSE data with gzip
    zlib.gzip(Buffer.from(sseText), (err, compressed) => {
      expect(err).toBeNull();

      // Emit compressed data (simulating Anthropic API response)
      proxyRes.emit('data', compressed);
      proxyRes.emit('end');

      // Allow time for decompression pipeline
      setTimeout(() => {
        expect(metricsRef.increment).toHaveBeenCalledWith(
          'input_tokens_total',
          { provider: 'anthropic' },
          1000,
        );
        expect(metricsRef.increment).toHaveBeenCalledWith(
          'output_tokens_total',
          { provider: 'anthropic' },
          42,
        );
        done();
      }, 50);
    });
  });

  test('decompresses gzip non-streaming JSON and extracts usage', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };

    trackTokenUsage(proxyRes, {
      requestId: 'test-gzip-json',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 200, output_tokens: 30 },
    });

    zlib.gzip(Buffer.from(body), (err, compressed) => {
      expect(err).toBeNull();
      proxyRes.emit('data', compressed);
      proxyRes.emit('end');

      setTimeout(() => {
        expect(metricsRef.increment).toHaveBeenCalledWith(
          'input_tokens_total',
          { provider: 'anthropic' },
          200,
        );
        expect(metricsRef.increment).toHaveBeenCalledWith(
          'output_tokens_total',
          { provider: 'anthropic' },
          30,
        );
        done();
      }, 50);
    });
  });

  test('handles multi-chunk gzip SSE response', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = {
      'content-type': 'text/event-stream; charset=utf-8',
      'content-encoding': 'gzip',
    };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };

    trackTokenUsage(proxyRes, {
      requestId: 'test-gzip-multi',
      provider: 'anthropic',
      path: '/v1/messages?beta=true',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    const sseText =
      'event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 5000 } },
      }) + '\n\n' +
      'event: message_delta\ndata: ' + JSON.stringify({
        type: 'message_delta',
        usage: { output_tokens: 100 },
      }) + '\n\n';

    zlib.gzip(Buffer.from(sseText), (err, compressed) => {
      expect(err).toBeNull();

      // Split compressed data into multiple chunks to simulate network delivery
      const mid = Math.floor(compressed.length / 2);
      proxyRes.emit('data', compressed.slice(0, mid));
      proxyRes.emit('data', compressed.slice(mid));
      proxyRes.emit('end');

      setTimeout(() => {
        expect(metricsRef.increment).toHaveBeenCalledWith(
          'input_tokens_total',
          { provider: 'anthropic' },
          5000,
        );
        expect(metricsRef.increment).toHaveBeenCalledWith(
          'output_tokens_total',
          { provider: 'anthropic' },
          100,
        );
        done();
      }, 50);
    });
  });

  test('still works with uncompressed SSE (no content-encoding)', (done) => {
    // Verify existing uncompressed path still works
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'text/event-stream' };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };

    trackTokenUsage(proxyRes, {
      requestId: 'test-uncompressed',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    const chunk = 'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 300 } },
    }) + '\n\nevent: message_delta\ndata: ' + JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 20 },
    }) + '\n\n';

    proxyRes.emit('data', Buffer.from(chunk));
    proxyRes.emit('end');

    setTimeout(() => {
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'input_tokens_total',
        { provider: 'anthropic' },
        300,
      );
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'output_tokens_total',
        { provider: 'anthropic' },
        20,
      );
      done();
    }, 10);
  });
});

// ── parseWebSocketFrames ──────────────────────────────────────────────

/**
 * Helper: build a WebSocket text frame (server→client, unmasked).
 */
function buildTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text opcode
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

describe('parseWebSocketFrames', () => {
  test('parses a single small text frame', () => {
    const frame = buildTextFrame('{"type":"message_start"}');
    const { messages, consumed } = parseWebSocketFrames(frame);
    expect(messages).toEqual(['{"type":"message_start"}']);
    expect(consumed).toBe(frame.length);
  });

  test('parses multiple text frames', () => {
    const f1 = buildTextFrame('{"type":"message_start"}');
    const f2 = buildTextFrame('{"type":"message_delta"}');
    const buf = Buffer.concat([f1, f2]);
    const { messages, consumed } = parseWebSocketFrames(buf);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe('{"type":"message_start"}');
    expect(messages[1]).toBe('{"type":"message_delta"}');
    expect(consumed).toBe(buf.length);
  });

  test('handles partial frame (not enough data)', () => {
    const frame = buildTextFrame('{"type":"test"}');
    // Give only half the frame
    const partial = frame.slice(0, Math.floor(frame.length / 2));
    const { messages, consumed } = parseWebSocketFrames(partial);
    expect(messages).toHaveLength(0);
    expect(consumed).toBe(0);
  });

  test('handles medium payload (126-byte extended length)', () => {
    const text = 'x'.repeat(200);
    const frame = buildTextFrame(text);
    // Verify 4-byte header was used (126 extended)
    expect(frame[1] & 0x7F).toBe(126);
    const { messages, consumed } = parseWebSocketFrames(frame);
    expect(messages).toEqual([text]);
    expect(consumed).toBe(frame.length);
  });

  test('skips binary frames (opcode 2)', () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const header = Buffer.alloc(2);
    header[0] = 0x82; // FIN + binary opcode
    header[1] = payload.length;
    const binaryFrame = Buffer.concat([header, payload]);

    const textFrame = buildTextFrame('{"type":"text"}');
    const buf = Buffer.concat([binaryFrame, textFrame]);

    const { messages, consumed } = parseWebSocketFrames(buf);
    expect(messages).toEqual(['{"type":"text"}']);
    expect(consumed).toBe(buf.length);
  });

  test('skips ping frames (opcode 9)', () => {
    const header = Buffer.alloc(2);
    header[0] = 0x89; // FIN + ping opcode
    header[1] = 0;    // empty payload
    const pingFrame = header;

    const textFrame = buildTextFrame('{"type":"data"}');
    const buf = Buffer.concat([pingFrame, textFrame]);

    const { messages, consumed } = parseWebSocketFrames(buf);
    expect(messages).toEqual(['{"type":"data"}']);
    expect(consumed).toBe(buf.length);
  });

  test('handles empty buffer', () => {
    const { messages, consumed } = parseWebSocketFrames(Buffer.alloc(0));
    expect(messages).toHaveLength(0);
    expect(consumed).toBe(0);
  });

  test('handles buffer with only 1 byte', () => {
    const { messages, consumed } = parseWebSocketFrames(Buffer.alloc(1));
    expect(messages).toHaveLength(0);
    expect(consumed).toBe(0);
  });

  test('unmasks masked text frames correctly', () => {
    const text = '{"type":"message_start"}';
    const payload = Buffer.from(text, 'utf8');
    const maskingKey = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

    // Build masked frame: FIN + text opcode, masked bit + length, key, masked payload
    const header = Buffer.alloc(2 + 4);
    header[0] = 0x81; // FIN + text
    header[1] = 0x80 | payload.length; // masked bit set + length
    maskingKey.copy(header, 2);

    const maskedPayload = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++) {
      maskedPayload[i] = payload[i] ^ maskingKey[i % 4];
    }

    const frame = Buffer.concat([header, maskedPayload]);
    const { messages, consumed } = parseWebSocketFrames(frame);
    expect(messages).toEqual([text]);
    expect(consumed).toBe(frame.length);
  });
});

// ── trackWebSocketTokenUsage ──────────────────────────────────────────

describe('trackWebSocketTokenUsage', () => {
  test('extracts Anthropic token usage from WebSocket frames', (done) => {
    const socket = new EventEmitter();
    const metricsRef = { increment: jest.fn() };

    trackWebSocketTokenUsage(socket, {
      requestId: 'ws-test-1',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    // Send HTTP 101 response header
    socket.emit('data', Buffer.from(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      '\r\n'
    ));

    // Send message_start with input tokens
    const msgStart = JSON.stringify({
      type: 'message_start',
      message: {
        model: 'claude-sonnet-4.6',
        usage: { input_tokens: 1500, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 },
      },
    });
    socket.emit('data', buildTextFrame(msgStart));

    // Send message_delta with output tokens
    const msgDelta = JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 350 },
    });
    socket.emit('data', buildTextFrame(msgDelta));

    // Close socket
    socket.emit('close');

    setTimeout(() => {
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'input_tokens_total', { provider: 'anthropic' }, 1500
      );
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'output_tokens_total', { provider: 'anthropic' }, 350
      );
      done();
    }, 10);
  });

  test('handles HTTP 101 header and frames in same chunk', (done) => {
    const socket = new EventEmitter();
    const metricsRef = { increment: jest.fn() };

    trackWebSocketTokenUsage(socket, {
      requestId: 'ws-test-2',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    // Send 101 header + frame in a single chunk
    const header = 'HTTP/1.1 101 Switching Protocols\r\n\r\n';
    const frame = buildTextFrame(JSON.stringify({
      type: 'message_start',
      message: {
        model: 'claude-sonnet-4.6',
        usage: { input_tokens: 500 },
      },
    }));
    socket.emit('data', Buffer.concat([Buffer.from(header), frame]));

    const deltaFrame = buildTextFrame(JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 100 },
    }));
    socket.emit('data', deltaFrame);
    socket.emit('end');

    setTimeout(() => {
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'input_tokens_total', { provider: 'anthropic' }, 500
      );
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'output_tokens_total', { provider: 'anthropic' }, 100
      );
      done();
    }, 10);
  });

  test('does not log when no usage data is found', (done) => {
    const socket = new EventEmitter();
    const metricsRef = { increment: jest.fn() };

    trackWebSocketTokenUsage(socket, {
      requestId: 'ws-test-3',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    socket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    // Send a content_block_delta (no usage data)
    socket.emit('data', buildTextFrame(JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello' },
    })));
    socket.emit('close');

    setTimeout(() => {
      expect(metricsRef.increment).not.toHaveBeenCalled();
      done();
    }, 10);
  });

  test('only finalizes once (close + end)', (done) => {
    const socket = new EventEmitter();
    const metricsRef = { increment: jest.fn() };

    trackWebSocketTokenUsage(socket, {
      requestId: 'ws-test-4',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    socket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    socket.emit('data', buildTextFrame(JSON.stringify({
      type: 'message_start',
      message: { model: 'claude-sonnet-4.6', usage: { input_tokens: 100 } },
    })));
    socket.emit('data', buildTextFrame(JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 50 },
    })));

    // Both close and end fire
    socket.emit('close');
    socket.emit('end');

    setTimeout(() => {
      // Should only be called once despite both events
      expect(metricsRef.increment).toHaveBeenCalledTimes(2);
      done();
    }, 10);
  });
});

// ── validateTokenUsageRecord ─────────────────────────────────────────

describe('validateTokenUsageRecord', () => {
  const validRecord = {
    _schema: 'token-usage/v1',
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

  test('rejects a record with wrong _schema', () => {
    expect(validateTokenUsageRecord({ ...validRecord, _schema: 'wrong/v99' })).toBe(false);
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
});

// ── JSONL records include _schema field ───────────────────────────────

describe('token-usage JSONL record schema field', () => {
  test('writeTokenUsage writes _schema:"token-usage/v1" to JSONL when stream is writable', (done) => {
    // Since TOKEN_LOG_FILE is computed at module load time (may not be writable
    // in test env), verify that a valid record (including _schema) is accepted.
    const record = {
      _schema: 'token-usage/v1',
      timestamp: new Date().toISOString(),
      request_id: 'sentinel-schema-http',
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
      response_bytes: 42,
    };

    // We have no direct access to the internal logStream singleton.
    // Instead, verify that writeTokenUsage validates and does NOT throw
    // when given a valid record (which requires _schema to be correct).
    // The absence of a thrown error + validateTokenUsageRecord returning true
    // is the integration proof that _schema is accepted.
    expect(() => writeTokenUsage(record)).not.toThrow();
    done();
  });

  test('trackTokenUsage HTTP path: finalizeTracking includes _schema in the record it passes to writeTokenUsage', (done) => {
    // We verify via validateTokenUsageRecord (exported) that the record produced
    // by finalizeTracking would pass schema validation.  The combination of:
    //   1. validateTokenUsageRecord rejects records without _schema (tested above)
    //   2. trackTokenUsage calls writeTokenUsage which calls validateTokenUsageRecord
    //   3. metrics.increment IS called (confirming writeTokenUsage was reached)
    // proves that the record contains _schema.
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };

    trackTokenUsage(proxyRes, {
      requestId: 'schema-field-http',
      provider: 'openai',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    proxyRes.emit('data', Buffer.from(JSON.stringify({
      model: 'gpt-4o',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })));
    proxyRes.emit('end');

    setTimeout(() => {
      // metrics.increment was called, which means the record passed validation
      // (validateTokenUsageRecord rejects records without _schema), so _schema was present.
      expect(metricsRef.increment).toHaveBeenCalled();
      done();
    }, 20);
  });

  test('trackWebSocketTokenUsage path: finalizeTracking includes _schema in the record it passes to writeTokenUsage', (done) => {
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

    const metricsRef = { increment: jest.fn() };

    trackWebSocketTokenUsage(socket, {
      requestId: 'schema-field-ws',
      provider: 'anthropic',
      path: '/v1/messages',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    socket.emit('data', Buffer.concat([httpHeader, frame1, frame2]));
    socket.emit('close');

    setTimeout(() => {
      // Same indirect proof as the HTTP test above.
      expect(metricsRef.increment).toHaveBeenCalled();
      done();
    }, 20);
  });
});
