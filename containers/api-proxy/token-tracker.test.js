/**
 * Tests for token-tracker.js
 */

const {
  extractUsageFromJson,
  extractUsageFromSseLine,
  parseSseDataLines,
  normalizeUsage,
  isStreamingResponse,
  trackTokenUsage,
} = require('./token-tracker');
const { EventEmitter } = require('events');

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

  test('ignores non-numeric usage fields', () => {
    const body = Buffer.from(JSON.stringify({
      usage: { prompt_tokens: 'not a number', completion_tokens: 50 },
    }));
    const result = extractUsageFromJson(body);
    expect(result.usage).toEqual({ completion_tokens: 50 });
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
      method: 'POST',
      path: '/v1/chat/completions',
      targetHost: 'api.openai.com',
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
      method: 'POST',
      path: '/v1/messages',
      targetHost: 'api.anthropic.com',
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
      method: 'POST',
      path: '/v1/chat/completions',
      targetHost: 'api.openai.com',
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
      method: 'GET',
      path: '/v1/models',
      targetHost: 'api.openai.com',
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
