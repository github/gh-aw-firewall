/**
 * Tests for token-tracker.js (HTTP tracking)
 */

require('./test-helpers/token-tracker-setup');

const {
  isStreamingResponse,
  isCompressedResponse,
  trackTokenUsage,
  closeLogStream,
} = require('./token-tracker');
const { EventEmitter } = require('events');
const zlib = require('zlib');

afterAll(async () => {
  await closeLogStream();
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

  test('extracts usage from OpenAI Responses API streaming completion event', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'text/event-stream' };
    proxyRes.statusCode = 200;

    const metricsRef = {
      increment: jest.fn(),
    };

    trackTokenUsage(proxyRes, {
      requestId: 'test-openai-responses-sse',
      provider: 'openai',
      path: '/v1/responses',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    const chunk = 'event: response.completed\ndata: ' + JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-5',
        usage: { input_tokens: 1234, output_tokens: 567, total_tokens: 1801 },
      },
    }) + '\n\ndata: [DONE]\n\n';

    proxyRes.emit('data', Buffer.from(chunk));
    proxyRes.emit('end');

    setTimeout(() => {
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'input_tokens_total',
        { provider: 'openai' },
        1234,
      );
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'output_tokens_total',
        { provider: 'openai' },
        567,
      );
      done();
    }, 10);
  });

  test('warns when cache-read was observed in events but rolled-up value is zero', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'text/event-stream' };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    trackTokenUsage(proxyRes, {
      requestId: 'test-cache-rollup-mismatch',
      provider: 'openai',
      path: '/v1/responses',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    const chunk1 = 'event: response.completed\ndata: ' + JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-5',
        usage: {
          input_tokens: 200,
          output_tokens: 40,
          total_tokens: 240,
          prompt_tokens_details: {
            cached_tokens: 99,
          },
        },
      },
    }) + '\n\n';

    const chunk2 = 'data: ' + JSON.stringify({
      usage: {
        prompt_tokens: 200,
        completion_tokens: 40,
        total_tokens: 240,
        cache_read_input_tokens: 0,
      },
    }) + '\n\ndata: [DONE]\n\n';

    proxyRes.emit('data', Buffer.from(chunk1));
    proxyRes.emit('data', Buffer.from(chunk2));
    proxyRes.emit('end');

    setTimeout(() => {
      try {
        const lines = writeSpy.mock.calls
          .map((call) => call[0])
          .filter((line) => typeof line === 'string' && line.includes('test-cache-rollup-mismatch'))
          .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          })
          .filter(Boolean);

        expect(lines.some((line) => line.event === 'token_cache_read_rollup_mismatch'
          && line.observed_cache_read_tokens === 99
          && line.rolled_up_cache_read_tokens === 0)).toBe(true);
        done();
      } catch (err) {
        done(err);
      } finally {
        writeSpy.mockRestore();
      }
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
