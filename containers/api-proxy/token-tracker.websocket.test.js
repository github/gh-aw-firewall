/**
 * Tests for token-tracker.js (WebSocket tracking)
 */

require('./test-helpers/token-tracker-setup');

const {
  parseWebSocketFrames,
  trackWebSocketTokenUsage,
  closeLogStream,
} = require('./token-tracker');
const { EventEmitter } = require('events');

afterAll(async () => {
  await closeLogStream();
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

  test('extracts OpenAI Responses API usage from response.completed WebSocket frame', (done) => {
    const socket = new EventEmitter();
    const metricsRef = { increment: jest.fn() };

    trackWebSocketTokenUsage(socket, {
      requestId: 'ws-openai-responses',
      provider: 'openai',
      path: '/v1/responses',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    socket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));
    socket.emit('data', buildTextFrame(JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-5',
        usage: {
          input_tokens: 300,
          output_tokens: 75,
          total_tokens: 375,
        },
      },
    })));
    socket.emit('close');

    setTimeout(() => {
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'input_tokens_total', { provider: 'openai' }, 300,
      );
      expect(metricsRef.increment).toHaveBeenCalledWith(
        'output_tokens_total', { provider: 'openai' }, 75,
      );
      done();
    }, 10);
  });

  test('warns when per-frame cache-read is later overwritten to zero in WebSocket rollup', (done) => {
    const socket = new EventEmitter();
    const metricsRef = { increment: jest.fn() };
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    trackWebSocketTokenUsage(socket, {
      requestId: 'ws-cache-rollup-mismatch',
      provider: 'openai',
      path: '/v1/responses',
      startTime: Date.now(),
      metrics: metricsRef,
    });

    socket.emit('data', Buffer.from('HTTP/1.1 101 Switching Protocols\r\n\r\n'));

    // Frame 1: response.completed with cache-read tokens
    socket.emit('data', buildTextFrame(JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-5',
        usage: {
          input_tokens: 200,
          output_tokens: 40,
          total_tokens: 240,
          prompt_tokens_details: { cached_tokens: 99 },
        },
      },
    })));

    // Frame 2: final usage chunk that overwrites cache_read_input_tokens to 0
    socket.emit('data', buildTextFrame(JSON.stringify({
      usage: {
        prompt_tokens: 200,
        completion_tokens: 40,
        total_tokens: 240,
        cache_read_input_tokens: 0,
      },
    })));

    socket.emit('close');

    setTimeout(() => {
      try {
        const lines = writeSpy.mock.calls
          .map((call) => call[0])
          .filter((line) => typeof line === 'string' && line.includes('ws-cache-rollup-mismatch'))
          .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
          })
          .filter(Boolean);

        expect(lines.some((line) => line.event === 'token_cache_read_rollup_mismatch'
          && line.observed_cache_read_tokens === 99
          && line.rolled_up_cache_read_tokens === 0
          && line.transport === 'websocket')).toBe(true);
        done();
      } catch (err) {
        done(err);
      } finally {
        writeSpy.mockRestore();
      }
    }, 10);
  });
});
