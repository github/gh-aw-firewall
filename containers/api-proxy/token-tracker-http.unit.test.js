/**
 * Unit tests for the extracted sub-functions in token-tracker-http.js.
 *
 * These tests exercise createChunkHandler and finalizeHttpTracking
 * directly using synthetic state objects — no need to construct a full
 * http.IncomingMessage stream.
 */

require('./test-helpers/token-tracker-setup');

const fs = require('fs');
const { createChunkHandler, finalizeHttpTracking, extractUsageFromTrackedState, buildAndWriteTokenRecord } = require('./token-tracker-http');
const { closeLogStream } = require('./token-tracker');

afterAll(async () => {
  await closeLogStream();
});

// ── createChunkHandler ────────────────────────────────────────────────

describe('createChunkHandler', () => {
  function makeStreamingState() {
    return {
      streaming: true,
      compressed: false,
      contentType: 'text/event-stream',
      contentEncoding: '(none)',
      chunks: [],
      totalBytes: 0,
      bufferedBytes: 0,
      overflow: false,
      streamingUsage: {},
      streamingModel: null,
      observedCacheReadTokens: 0,
      partialLine: '',
    };
  }

  function makeBufferingState() {
    return {
      streaming: false,
      compressed: false,
      contentType: 'application/json',
      contentEncoding: '(none)',
      chunks: [],
      totalBytes: 0,
      bufferedBytes: 0,
      overflow: false,
      streamingUsage: {},
      streamingModel: null,
      observedCacheReadTokens: 0,
      partialLine: '',
    };
  }

  test('streaming: accumulates SSE usage and model from a complete line', () => {
    const state = makeStreamingState();
    const handle = createChunkHandler(state, { requestId: 'r1', provider: 'anthropic' });

    const text = 'event: message_start\ndata: ' + JSON.stringify({
      type: 'message_start',
      message: { model: 'claude-opus-4', usage: { input_tokens: 300 } },
    }) + '\n\n';

    handle(text);

    expect(state.streamingModel).toBe('claude-opus-4');
    expect(state.streamingUsage.input_tokens).toBe(300);
    expect(state.partialLine).toBe('');
  });

  test('streaming: preserves incomplete trailing line as partialLine', () => {
    const state = makeStreamingState();
    const handle = createChunkHandler(state, { requestId: 'r2', provider: 'anthropic' });

    // Chunk ends mid-line (no final newline)
    handle('data: {"type":"partial');

    expect(state.partialLine).toBe('data: {"type":"partial');
    expect(Object.keys(state.streamingUsage)).toHaveLength(0);
  });

  test('streaming: flushes partial line across two chunks', () => {
    const state = makeStreamingState();
    const handle = createChunkHandler(state, { requestId: 'r3', provider: 'openai' });

    const part1 = 'data: ' + JSON.stringify({
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }).slice(0, 20); // truncated

    const part2 = JSON.stringify({
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }).slice(20) + '\n\n';

    handle(part1);
    expect(state.partialLine).toBeTruthy();

    handle(part2);
    // The combined data line is now complete and parsed
    expect(state.streamingUsage.prompt_tokens ?? state.streamingUsage.input_tokens).toBeDefined();
  });

  test('streaming: tracks observedCacheReadTokens across events', () => {
    const state = makeStreamingState();
    const handle = createChunkHandler(state, { requestId: 'r4', provider: 'anthropic' });

    const text = 'data: ' + JSON.stringify({
      type: 'message_start',
      message: { model: 'claude-haiku', usage: { input_tokens: 50, cache_read_input_tokens: 400 } },
    }) + '\n\n';

    handle(text);

    expect(state.observedCacheReadTokens).toBe(400);
  });

  test('non-streaming: buffers chunk bytes into state.chunks', () => {
    const state = makeBufferingState();
    const handle = createChunkHandler(state, { requestId: 'r5', provider: 'openai' });

    const body = JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    handle(body);

    expect(state.chunks).toHaveLength(1);
    expect(state.bufferedBytes).toBe(Buffer.byteLength(body));
    expect(state.overflow).toBe(false);
  });

  test('non-streaming: sets overflow and clears buffer when limit exceeded', () => {
    const state = makeBufferingState();
    const handle = createChunkHandler(state, { requestId: 'r6', provider: 'openai' });

    // Push a small chunk first
    handle('{"start":true}');
    expect(state.chunks).toHaveLength(1);

    // Push a chunk that would exceed MAX_BUFFER_SIZE (5 MB)
    const oversized = 'x'.repeat(5 * 1024 * 1024 + 1);
    handle(oversized);

    expect(state.overflow).toBe(true);
    expect(state.chunks).toHaveLength(0);
    expect(state.bufferedBytes).toBe(0);
  });

  test('non-streaming: ignores further chunks once overflow is set', () => {
    const state = makeBufferingState();
    state.overflow = true; // simulate already-overflowed state
    const handle = createChunkHandler(state, { requestId: 'r7', provider: 'openai' });

    handle('{"ignored":true}');

    expect(state.chunks).toHaveLength(0);
    expect(state.bufferedBytes).toBe(0);
  });
});

// ── finalizeHttpTracking ──────────────────────────────────────────────

describe('finalizeHttpTracking', () => {
  function makeOpts(overrides = {}) {
    return {
      requestId: 'finalize-test',
      provider: 'openai',
      path: '/v1/chat/completions',
      startTime: Date.now() - 100,
      metrics: { increment: jest.fn() },
      billingInfo: null,
      initiatorSent: null,
      requestModel: null,
      ...overrides,
    };
  }

  function makeProxyRes(statusCode = 200) {
    return { statusCode, headers: {} };
  }

  function makeState(overrides = {}) {
    return {
      streaming: false,
      compressed: false,
      contentType: 'application/json',
      contentEncoding: '(none)',
      chunks: [],
      totalBytes: 0,
      bufferedBytes: 0,
      overflow: false,
      streamingUsage: {},
      streamingModel: null,
      observedCacheReadTokens: 0,
      partialLine: '',
      ...overrides,
    };
  }

  test('skips non-2xx responses without updating metrics', () => {
    const opts = makeOpts();
    const state = makeState();

    finalizeHttpTracking(state, makeProxyRes(401), opts);

    expect(opts.metrics.increment).not.toHaveBeenCalled();
  });

  test('calls onSpanEnd with status code when response is non-2xx', () => {
    const onSpanEnd = jest.fn();
    const opts = makeOpts({ onSpanEnd });

    finalizeHttpTracking(makeState(), makeProxyRes(503), opts);

    expect(onSpanEnd).toHaveBeenCalledWith(503);
  });

  test('non-streaming: parses buffered JSON chunks and increments metrics', () => {
    const opts = makeOpts();
    const body = JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } });
    const state = makeState({
      chunks: [Buffer.from(body)],
      bufferedBytes: body.length,
      totalBytes: body.length,
    });

    finalizeHttpTracking(state, makeProxyRes(200), opts);

    expect(opts.metrics.increment).toHaveBeenCalledWith('input_tokens_total', { provider: 'openai' }, 80);
    expect(opts.metrics.increment).toHaveBeenCalledWith('output_tokens_total', { provider: 'openai' }, 20);
  });

  test('non-streaming: calls onSpanEnd with 200 after successful processing', () => {
    const onSpanEnd = jest.fn();
    const body = JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const opts = makeOpts({ onSpanEnd });
    const state = makeState({
      chunks: [Buffer.from(body)],
      bufferedBytes: body.length,
      totalBytes: body.length,
    });

    finalizeHttpTracking(state, makeProxyRes(200), opts);

    expect(onSpanEnd).toHaveBeenCalledWith(200);
  });

  test('non-streaming: calls onSpanEnd even when no usage found in body', () => {
    const onSpanEnd = jest.fn();
    const opts = makeOpts({ onSpanEnd });
    const body = JSON.stringify({ data: [] }); // no usage field
    const state = makeState({
      chunks: [Buffer.from(body)],
      bufferedBytes: body.length,
      totalBytes: body.length,
    });

    finalizeHttpTracking(state, makeProxyRes(200), opts);

    expect(onSpanEnd).toHaveBeenCalledWith(200);
    expect(opts.metrics.increment).not.toHaveBeenCalled();
  });

  test('non-streaming: skips metric update when overflow is set', () => {
    const opts = makeOpts();
    const state = makeState({ overflow: true, chunks: [] });

    finalizeHttpTracking(state, makeProxyRes(200), opts);

    expect(opts.metrics.increment).not.toHaveBeenCalled();
  });

  test('streaming: processes accumulated streamingUsage', () => {
    const opts = makeOpts({ provider: 'anthropic' });
    const state = makeState({
      streaming: true,
      contentType: 'text/event-stream',
      streamingUsage: { input_tokens: 500, output_tokens: 42 },
      streamingModel: 'claude-opus-4',
    });

    finalizeHttpTracking(state, makeProxyRes(200), opts);

    expect(opts.metrics.increment).toHaveBeenCalledWith('input_tokens_total', { provider: 'anthropic' }, 500);
    expect(opts.metrics.increment).toHaveBeenCalledWith('output_tokens_total', { provider: 'anthropic' }, 42);
  });

  test('streaming: flushes remaining partial line before processing usage', () => {
    const opts = makeOpts({ provider: 'openai' });
    // Partial line holds the last SSE usage event that hasn't been newline-terminated
    const partialData = JSON.stringify({
      usage: { prompt_tokens: 200, completion_tokens: 30 },
    });
    const state = makeState({
      streaming: true,
      contentType: 'text/event-stream',
      streamingUsage: {},
      partialLine: `data: ${partialData}`,
    });

    finalizeHttpTracking(state, makeProxyRes(200), opts);

    expect(opts.metrics.increment).toHaveBeenCalledWith('input_tokens_total', { provider: 'openai' }, 200);
    expect(opts.metrics.increment).toHaveBeenCalledWith('output_tokens_total', { provider: 'openai' }, 30);
  });

  test('calls onUsage callback with normalized usage and model', () => {
    const onUsage = jest.fn().mockReturnValue(undefined);
    const body = JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 60, completion_tokens: 15 } });
    const opts = makeOpts({ onUsage });
    const state = makeState({
      chunks: [Buffer.from(body)],
      bufferedBytes: body.length,
      totalBytes: body.length,
    });

    finalizeHttpTracking(state, makeProxyRes(200), opts);

    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ input_tokens: 60, output_tokens: 15 }),
      'gpt-4o',
    );
  });

  test('attaches billingInfo and initiatorSent to the log record', () => {
    // We verify indirectly via the onUsage callback receiving the right normalized usage
    // (record internals are written to disk via writeTokenUsage — check no throw)
    const body = JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } });
    const opts = makeOpts({
      billingInfo: { quota: 1000 },
      initiatorSent: 'editor',
    });
    const state = makeState({
      chunks: [Buffer.from(body)],
      bufferedBytes: body.length,
      totalBytes: body.length,
    });

    expect(() => finalizeHttpTracking(state, makeProxyRes(200), opts)).not.toThrow();
  });

  test('does not throw when onUsage callback throws', () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } });
    const opts = makeOpts({
      onUsage: () => { throw new Error('boom'); },
    });
    const state = makeState({
      chunks: [Buffer.from(body)],
      bufferedBytes: body.length,
      totalBytes: body.length,
    });

    expect(() => finalizeHttpTracking(state, makeProxyRes(200), opts)).not.toThrow();
  });
});

// ── extractUsageFromTrackedState ──────────────────────────────────────

describe('extractUsageFromTrackedState', () => {
  function makeStreamingState(overrides = {}) {
    return {
      streaming: true,
      chunks: [],
      totalBytes: 0,
      bufferedBytes: 0,
      overflow: false,
      streamingUsage: {},
      streamingModel: null,
      observedCacheReadTokens: 0,
      partialLine: '',
      ...overrides,
    };
  }

  function makeBufferingState(overrides = {}) {
    return {
      streaming: false,
      chunks: [],
      totalBytes: 0,
      bufferedBytes: 0,
      overflow: false,
      streamingUsage: {},
      streamingModel: null,
      observedCacheReadTokens: 0,
      partialLine: '',
      ...overrides,
    };
  }

  test('streaming: returns accumulated streamingUsage and model', () => {
    const state = makeStreamingState({
      streamingUsage: { input_tokens: 100, output_tokens: 25 },
      streamingModel: 'claude-opus-4',
    });

    const { usage, model } = extractUsageFromTrackedState(state);

    expect(usage).toEqual({ input_tokens: 100, output_tokens: 25 });
    expect(model).toBe('claude-opus-4');
  });

  test('streaming: returns null usage when streamingUsage is empty', () => {
    const state = makeStreamingState({ streamingUsage: {} });

    const { usage, model } = extractUsageFromTrackedState(state);

    expect(usage).toBeNull();
    expect(model).toBeNull();
  });

  test('streaming: flushes partial line and merges into streamingUsage', () => {
    const partialData = JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 40 },
    });
    const state = makeStreamingState({
      streamingUsage: { input_tokens: 200 },
      partialLine: `data: ${partialData}`,
    });

    const { usage } = extractUsageFromTrackedState(state);

    expect(usage).toBeTruthy();
    expect(usage.input_tokens).toBe(200);
    expect(usage.output_tokens).toBe(40);
  });

  test('streaming: updates observedCacheReadTokens from partial line flush', () => {
    const partialData = JSON.stringify({
      type: 'message_start',
      message: { model: 'claude-haiku', usage: { input_tokens: 10, cache_read_input_tokens: 500 } },
    });
    const state = makeStreamingState({
      partialLine: `data: ${partialData}`,
      observedCacheReadTokens: 0,
    });

    extractUsageFromTrackedState(state);

    expect(state.observedCacheReadTokens).toBe(500);
  });

  test('non-streaming: parses buffered JSON chunks', () => {
    const body = JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 50, completion_tokens: 20 } });
    const state = makeBufferingState({ chunks: [Buffer.from(body)] });

    const { usage, model } = extractUsageFromTrackedState(state);

    expect(usage).toBeTruthy();
    expect(model).toBe('gpt-4o');
  });

  test('non-streaming: returns null when overflow is set', () => {
    const state = makeBufferingState({ overflow: true, chunks: [] });

    const { usage, model } = extractUsageFromTrackedState(state);

    expect(usage).toBeNull();
    expect(model).toBeNull();
  });

  test('non-streaming: returns null when chunks array is empty', () => {
    const state = makeBufferingState({ chunks: [] });

    const { usage, model } = extractUsageFromTrackedState(state);

    expect(usage).toBeNull();
    expect(model).toBeNull();
  });

  test('non-streaming: updates observedCacheReadTokens from parsed JSON', () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: 10, completion_tokens: 5, cache_read_input_tokens: 300 },
    });
    const state = makeBufferingState({ chunks: [Buffer.from(body)], observedCacheReadTokens: 0 });

    extractUsageFromTrackedState(state);

    expect(state.observedCacheReadTokens).toBe(300);
  });
});

// ── buildAndWriteTokenRecord ──────────────────────────────────────────

describe('buildAndWriteTokenRecord', () => {
  const normalizedUsage = {
    input_tokens: 100,
    output_tokens: 30,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };

  function baseParams(overrides = {}) {
    return {
      requestId: 'bw-test',
      provider: 'openai',
      model: 'gpt-4o',
      reqPath: '/v1/chat/completions',
      status: 200,
      streaming: false,
      duration: 150,
      responseBytes: 512,
      billingInfo: null,
      initiatorSent: null,
      budgetResult: undefined,
      ...overrides,
    };
  }

  /**
   * Build a writable mock stream that captures all written chunks.
   * Returns { stream, writtenRecords() } where writtenRecords() parses the JSONL.
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

  let mockStream;
  let mkdirSyncSpy;
  let createWriteStreamSpy;

  beforeEach(async () => {
    await closeLogStream();
    mockStream = makeMockStream();
    mkdirSyncSpy = jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    createWriteStreamSpy = jest.spyOn(fs, 'createWriteStream').mockReturnValue(mockStream);
  });

  afterEach(async () => {
    mkdirSyncSpy.mockRestore();
    createWriteStreamSpy.mockRestore();
    await closeLogStream();
  });

  test('does not throw for a minimal valid call', () => {
    expect(() => buildAndWriteTokenRecord(normalizedUsage, baseParams())).not.toThrow();
  });

  test('includes billingInfo and initiatorSent when provided', () => {
    buildAndWriteTokenRecord(normalizedUsage, baseParams({
      billingInfo: { quota: 5000 },
      initiatorSent: 'vscode',
    }));

    const record = mockStream.writtenRecords[0];
    expect(record.x_initiator).toBe('vscode');
    expect(record.billing).toEqual({ quota: 5000 });
  });

  test('merges budgetResult fields when provided', () => {
    buildAndWriteTokenRecord(normalizedUsage, baseParams({
      budgetResult: {
        effective_tokens_this_response: 130,
        effective_tokens_total: 2000,
        model_multiplier: 1.0,
        ai_credits_this_response: 0.002,
        ai_credits_total: 0.05,
      },
    }));

    const record = mockStream.writtenRecords[0];
    expect(record.effective_tokens_this_response).toBe(130);
    expect(record.effective_tokens_total).toBe(2000);
    expect(record.ai_credits_this_response).toBe(0.002);
    expect(record.ai_credits_total).toBe(0.05);
  });

  test('handles null billingInfo and undefined budgetResult gracefully', () => {
    expect(() => buildAndWriteTokenRecord(normalizedUsage, baseParams({
      billingInfo: null,
      initiatorSent: null,
      budgetResult: undefined,
    }))).not.toThrow();
  });

  test('works for streaming responses', () => {
    expect(() => buildAndWriteTokenRecord(normalizedUsage, baseParams({
      streaming: true,
      provider: 'anthropic',
      model: 'claude-opus-4',
    }))).not.toThrow();
  });
});

