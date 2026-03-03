/**
 * Tests for token-extractor.js
 */

'use strict';

const { createTokenExtractor } = require('./token-extractor');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');

/**
 * Helper: pipe data through a token extractor and collect the tokens event + output.
 */
async function extract(data, opts) {
  const extractor = createTokenExtractor(opts);
  const outputChunks = [];

  const tokensPromise = new Promise((resolve) => {
    extractor.on('tokens', resolve);
  });

  const source = Readable.from(typeof data === 'string' ? [Buffer.from(data)] : data.map(d => Buffer.from(d)));
  const sink = new Writable({
    write(chunk, enc, cb) {
      outputChunks.push(chunk);
      cb();
    },
  });

  await pipeline(source, extractor, sink);
  const tokens = await tokensPromise;
  const output = Buffer.concat(outputChunks).toString('utf8');
  return { tokens, output };
}

// ─── Anthropic non-streaming ──────────────────────────────────────

describe('Anthropic non-streaming', () => {
  const baseOpts = { provider: 'anthropic', contentType: 'application/json', contentEncoding: '' };

  test('extracts input_tokens and output_tokens', async () => {
    const body = JSON.stringify({
      id: 'msg_123',
      content: [{ type: 'text', text: 'Hello' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const { tokens, output } = await extract(body, baseOpts);
    expect(tokens).toEqual({ input: 100, output: 50, total: 150 });
    expect(output).toBe(body); // data passes through unchanged
  });

  test('handles missing usage field', async () => {
    const body = JSON.stringify({ id: 'msg_123', content: [] });
    const { tokens } = await extract(body, baseOpts);
    expect(tokens).toEqual({ input: 0, output: 0, total: 0 });
  });

  test('handles error response (no usage)', async () => {
    const body = JSON.stringify({ type: 'error', error: { message: 'rate limited' } });
    const { tokens } = await extract(body, baseOpts);
    expect(tokens).toEqual({ input: 0, output: 0, total: 0 });
  });

  test('handles malformed JSON', async () => {
    const { tokens } = await extract('not json at all{{{', baseOpts);
    expect(tokens).toEqual({ input: 0, output: 0, total: 0 });
  });

  test('handles empty body', async () => {
    const { tokens } = await extract('', baseOpts);
    expect(tokens).toEqual({ input: 0, output: 0, total: 0 });
  });

  test('handles multi-chunk body', async () => {
    const body = JSON.stringify({
      usage: { input_tokens: 200, output_tokens: 100 },
    });
    // Split into multiple chunks
    const chunks = [body.slice(0, 20), body.slice(20)];
    const { tokens, output } = await extract(chunks, baseOpts);
    expect(tokens).toEqual({ input: 200, output: 100, total: 300 });
    expect(output).toBe(body);
  });
});

// ─── OpenAI non-streaming ─────────────────────────────────────────

describe('OpenAI non-streaming', () => {
  const baseOpts = { provider: 'openai', contentType: 'application/json', contentEncoding: '' };

  test('extracts prompt_tokens and completion_tokens', async () => {
    const body = JSON.stringify({
      id: 'chatcmpl-123',
      choices: [{ message: { content: 'Hi' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    const { tokens, output } = await extract(body, baseOpts);
    expect(tokens).toEqual({ input: 100, output: 50, total: 150 });
    expect(output).toBe(body);
  });

  test('uses total_tokens from response', async () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 35 }, // total != sum (cached)
    });
    const { tokens } = await extract(body, baseOpts);
    expect(tokens).toEqual({ input: 10, output: 20, total: 35 });
  });

  test('handles missing usage', async () => {
    const body = JSON.stringify({ id: 'chatcmpl-123', choices: [] });
    const { tokens } = await extract(body, baseOpts);
    expect(tokens).toEqual({ input: 0, output: 0, total: 0 });
  });
});

// ─── Copilot non-streaming (same as OpenAI) ────────────────────────

describe('Copilot non-streaming', () => {
  test('extracts tokens using OpenAI format', async () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
    });
    const { tokens } = await extract(body, {
      provider: 'copilot', contentType: 'application/json', contentEncoding: '',
    });
    expect(tokens).toEqual({ input: 80, output: 40, total: 120 });
  });
});

// ─── Anthropic SSE ────────────────────────────────────────────────

describe('Anthropic SSE', () => {
  const baseOpts = { provider: 'anthropic', contentType: 'text/event-stream', contentEncoding: '' };

  test('extracts tokens from message_start and message_delta events', async () => {
    const sse = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}\n',
      '\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n',
      '\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":50}}\n',
      '\n',
    ];
    const { tokens, output } = await extract(sse, baseOpts);
    expect(tokens).toEqual({ input: 100, output: 50, total: 150 });
    expect(output).toBe(sse.join('')); // data passes through unchanged
  });

  test('handles SSE with no token events', async () => {
    const sse = [
      'event: ping\n',
      'data: {}\n',
      '\n',
    ];
    const { tokens } = await extract(sse, baseOpts);
    expect(tokens).toEqual({ input: 0, output: 0, total: 0 });
  });

  test('handles SSE with only input tokens (no delta)', async () => {
    const sse = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":75}}}\n',
      '\n',
    ];
    const { tokens } = await extract(sse, baseOpts);
    expect(tokens).toEqual({ input: 75, output: 0, total: 75 });
  });

  test('handles data split across chunks', async () => {
    const fullLine = 'data: {"type":"message_start","message":{"usage":{"input_tokens":42}}}\n';
    const chunks = [fullLine.slice(0, 30), fullLine.slice(30)];
    const sseChunks = [
      'event: message_start\n',
      ...chunks,
      '\nevent: message_delta\n',
      'data: {"type":"message_delta","usage":{"output_tokens":10}}\n\n',
    ];
    const { tokens } = await extract(sseChunks, baseOpts);
    expect(tokens).toEqual({ input: 42, output: 10, total: 52 });
  });
});

// ─── OpenAI SSE ───────────────────────────────────────────────────

describe('OpenAI SSE', () => {
  const baseOpts = { provider: 'openai', contentType: 'text/event-stream', contentEncoding: '' };

  test('extracts tokens from usage chunk before [DONE]', async () => {
    const sse = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { tokens, output } = await extract(sse, baseOpts);
    expect(tokens).toEqual({ input: 100, output: 50, total: 150 });
    expect(output).toBe(sse.join(''));
  });

  test('handles SSE with no usage chunk', async () => {
    const sse = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const { tokens } = await extract(sse, baseOpts);
    expect(tokens).toEqual({ input: 0, output: 0, total: 0 });
  });
});

// ─── Copilot SSE (same as OpenAI) ────────────────────────────────

describe('Copilot SSE', () => {
  test('extracts tokens using OpenAI SSE format', async () => {
    const sse = [
      'data: {"id":"1","choices":[],"usage":{"prompt_tokens":60,"completion_tokens":30,"total_tokens":90}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { tokens } = await extract(sse, {
      provider: 'copilot', contentType: 'text/event-stream', contentEncoding: '',
    });
    expect(tokens).toEqual({ input: 60, output: 30, total: 90 });
  });
});

// ─── Content-Encoding (compressed) ────────────────────────────────

describe('compressed responses', () => {
  test.each(['gzip', 'br', 'deflate'])('skips extraction for %s', async (enc) => {
    const body = JSON.stringify({ usage: { input_tokens: 999, output_tokens: 999 } });
    const { tokens, output } = await extract(body, {
      provider: 'anthropic', contentType: 'application/json', contentEncoding: enc,
    });
    expect(tokens).toEqual({ input: 0, output: 0, total: 0 });
    expect(output).toBe(body); // still passes through
  });

  test('does not skip for empty content-encoding', async () => {
    const body = JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } });
    const { tokens } = await extract(body, {
      provider: 'anthropic', contentType: 'application/json', contentEncoding: '',
    });
    expect(tokens).toEqual({ input: 10, output: 5, total: 15 });
  });
});

// ─── Data integrity ───────────────────────────────────────────────

describe('data integrity', () => {
  test('binary data passes through unchanged', async () => {
    const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80]);
    const extractor = createTokenExtractor({
      provider: 'openai', contentType: 'application/octet-stream', contentEncoding: '',
    });
    const outputChunks = [];

    const tokensPromise = new Promise((resolve) => extractor.on('tokens', resolve));
    const source = Readable.from([binary]);
    const sink = new Writable({
      write(chunk, enc, cb) { outputChunks.push(chunk); cb(); },
    });

    await pipeline(source, extractor, sink);
    await tokensPromise;

    expect(Buffer.concat(outputChunks)).toEqual(binary);
  });
});
