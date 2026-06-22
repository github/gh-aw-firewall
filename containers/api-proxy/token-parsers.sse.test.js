/**
 * Tests for SSE usage parsing in token-tracker.js
 */

const {
  extractUsageFromSseLine,
  parseSseDataLines,
  normalizeUsage,
} = require('./token-tracker');

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

  test('extracts OpenAI Responses API response.completed usage', () => {
    const line = JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-5',
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          total_tokens: 1801,
        },
      },
    });

    const result = extractUsageFromSseLine(line);
    expect(result.model).toBe('gpt-5');
    expect(result.usage).toEqual({
      input_tokens: 1234,
      output_tokens: 567,
      total_tokens: 1801,
    });
  });

  test('extracts reasoning and cache tokens from OpenAI Responses API response.completed usage', () => {
    const line = JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-5',
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          completion_tokens_details: {
            reasoning_tokens: 7,
          },
          prompt_tokens_details: {
            cached_tokens: 33,
          },
        },
      },
    });

    const result = extractUsageFromSseLine(line);
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125,
      reasoning_tokens: 7,
      cache_read_input_tokens: 33,
    });
  });

  test('extracts cache tokens from OpenAI Responses API token_type entries', () => {
    const line = JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-5',
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          prompt_tokens_details: {
            details: [
              { token_type: 'cache_read', token_count: 55 },
            ],
          },
        },
      },
    });

    const result = extractUsageFromSseLine(line);
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125,
      cache_read_input_tokens: 55,
    });
  });

  test('extracts cache tokens from OpenAI Responses API input_tokens_details (streaming)', () => {
    // Real /responses streaming final event: cached tokens live under
    // input_tokens_details.cached_tokens (object), not prompt_tokens_details.
    const line = JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-5.4-mini',
        usage: {
          input_tokens: 37484,
          output_tokens: 619,
          total_tokens: 38103,
          input_tokens_details: {
            cached_tokens: 34816,
          },
          output_tokens_details: {
            reasoning_tokens: 128,
          },
        },
      },
    });

    const result = extractUsageFromSseLine(line);
    expect(result.usage).toEqual({
      input_tokens: 37484,
      output_tokens: 619,
      total_tokens: 38103,
      reasoning_tokens: 128,
      cache_read_input_tokens: 34816,
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

  // Regression for gh-aw run 27784259295: the Copilot /responses endpoint
  // streams a chat.completion-shaped final chunk that carries both
  // prompt_tokens_details.cached_tokens AND the authoritative per-type split
  // in copilot_usage.token_details. The copilot_usage breakdown must win so
  // the input/cache_read split is exact. That run reported cache_read_tokens: 0
  // on every request despite ~1.43M cached reads in aggregate.
  //
  // Each fixture below is a real request captured from the agent's process log
  // for that run, in chronological order (cache reads grow as the prompt is
  // re-sent). `input` + `cacheRead` === `promptTokens` for every entry.
  describe('Copilot /responses streaming cache reads (run 27784259295)', () => {
    const REQUESTS = [
      { promptTokens: 19158, completionTokens: 1304, cachedTokens: 0, reasoningTokens: 516, input: 19158, cacheRead: 0, output: 1304 },
      { promptTokens: 10852, completionTokens: 168, cachedTokens: 0, reasoningTokens: 94, input: 10852, cacheRead: 0, output: 168 },
      { promptTokens: 16601, completionTokens: 124, cachedTokens: 10752, reasoningTokens: 14, input: 5849, cacheRead: 10752, output: 124 },
      { promptTokens: 23055, completionTokens: 559, cachedTokens: 18944, reasoningTokens: 516, input: 4111, cacheRead: 18944, output: 559 },
      { promptTokens: 24429, completionTokens: 978, cachedTokens: 22528, reasoningTokens: 455, input: 1901, cacheRead: 22528, output: 978 },
      { promptTokens: 26055, completionTokens: 1405, cachedTokens: 24064, reasoningTokens: 904, input: 1991, cacheRead: 24064, output: 1405 },
      { promptTokens: 28551, completionTokens: 1306, cachedTokens: 25600, reasoningTokens: 941, input: 2951, cacheRead: 25600, output: 1306 },
      { promptTokens: 33145, completionTokens: 1636, cachedTokens: 28160, reasoningTokens: 938, input: 4985, cacheRead: 28160, output: 1636 },
      { promptTokens: 39144, completionTokens: 921, cachedTokens: 32768, reasoningTokens: 595, input: 6376, cacheRead: 32768, output: 921 },
      { promptTokens: 41728, completionTokens: 372, cachedTokens: 38912, reasoningTokens: 193, input: 2816, cacheRead: 38912, output: 372 },
      { promptTokens: 44382, completionTokens: 735, cachedTokens: 41472, reasoningTokens: 488, input: 2910, cacheRead: 41472, output: 735 },
      { promptTokens: 45677, completionTokens: 335, cachedTokens: 44032, reasoningTokens: 83, input: 1645, cacheRead: 44032, output: 335 },
      { promptTokens: 46386, completionTokens: 363, cachedTokens: 45568, reasoningTokens: 119, input: 818, cacheRead: 45568, output: 363 },
      { promptTokens: 48174, completionTokens: 376, cachedTokens: 46080, reasoningTokens: 139, input: 2094, cacheRead: 46080, output: 376 },
      { promptTokens: 48980, completionTokens: 211, cachedTokens: 47616, reasoningTokens: 62, input: 1364, cacheRead: 47616, output: 211 },
      { promptTokens: 65247, completionTokens: 424, cachedTokens: 48640, reasoningTokens: 313, input: 16607, cacheRead: 48640, output: 424 },
      { promptTokens: 68930, completionTokens: 267, cachedTokens: 65024, reasoningTokens: 114, input: 3906, cacheRead: 65024, output: 267 },
      { promptTokens: 69642, completionTokens: 138, cachedTokens: 68608, reasoningTokens: 24, input: 1034, cacheRead: 68608, output: 138 },
      { promptTokens: 75433, completionTokens: 138, cachedTokens: 69120, reasoningTokens: 22, input: 6313, cacheRead: 69120, output: 138 },
      { promptTokens: 78451, completionTokens: 131, cachedTokens: 75264, reasoningTokens: 73, input: 3187, cacheRead: 75264, output: 131 },
      { promptTokens: 78808, completionTokens: 56, cachedTokens: 78336, reasoningTokens: 0, input: 472, cacheRead: 78336, output: 56 },
      { promptTokens: 79128, completionTokens: 56, cachedTokens: 78336, reasoningTokens: 0, input: 792, cacheRead: 78336, output: 56 },
      { promptTokens: 79320, completionTokens: 2799, cachedTokens: 78848, reasoningTokens: 2522, input: 472, cacheRead: 78848, output: 2799 },
      { promptTokens: 82221, completionTokens: 3408, cachedTokens: 78848, reasoningTokens: 2243, input: 3373, cacheRead: 78848, output: 3408 },
      { promptTokens: 91547, completionTokens: 1400, cachedTokens: 81920, reasoningTokens: 1333, input: 9627, cacheRead: 81920, output: 1400 },
      { promptTokens: 93125, completionTokens: 201, cachedTokens: 91136, reasoningTokens: 113, input: 1989, cacheRead: 91136, output: 201 },
      { promptTokens: 93675, completionTokens: 423, cachedTokens: 92672, reasoningTokens: 366, input: 1003, cacheRead: 92672, output: 423 },
      { promptTokens: 94114, completionTokens: 161, cachedTokens: 93184, reasoningTokens: 60, input: 930, cacheRead: 93184, output: 161 },
    ];

    const buildChunk = (r) => JSON.stringify({
      object: 'chat.completion.chunk',
      model: 'gpt-5.4-2026-03-05',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        completion_tokens: r.completionTokens,
        prompt_tokens: r.promptTokens,
        total_tokens: r.promptTokens + r.completionTokens,
        prompt_tokens_details: { cached_tokens: r.cachedTokens },
        completion_tokens_details: { reasoning_tokens: r.reasoningTokens },
      },
      copilot_usage: {
        token_details: [
          { token_count: r.input, token_type: 'input' },
          { token_count: r.cacheRead, token_type: 'cache_read' },
          { token_count: r.output, token_type: 'output' },
        ],
      },
    });

    test.each(REQUESTS)(
      'request prompt=$promptTokens recovers cache_read=$cacheRead',
      (r) => {
        const normalized = normalizeUsage(extractUsageFromSseLine(buildChunk(r)).usage);
        expect(normalized).toEqual({
          input_tokens: r.input,
          output_tokens: r.output,
          cache_read_tokens: r.cacheRead,
          cache_write_tokens: 0,
          reasoning_tokens: r.reasoningTokens,
        });
        // The copilot_usage split must reconstruct the lumped prompt_tokens.
        expect(normalized.input_tokens + normalized.cache_read_tokens).toBe(r.promptTokens);
      },
    );

    test('recovers the full aggregate cache-read total the run reported as 0', () => {
      const totals = REQUESTS.reduce(
        (acc, r) => {
          const n = normalizeUsage(extractUsageFromSseLine(buildChunk(r)).usage);
          acc.cacheRead += n.cache_read_tokens;
          acc.input += n.input_tokens;
          return acc;
        },
        { cacheRead: 0, input: 0 },
      );
      expect(totals.cacheRead).toBe(1426432);
      expect(totals.input).toBe(119526);
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

// ── extractUsageFromSseLine with copilot_usage ────────────────────────

describe('extractUsageFromSseLine with copilot_usage', () => {
  test('applies the copilot_usage split in a streaming final chunk', () => {
    const line = JSON.stringify({
      model: 'claude-sonnet-4.6',
      usage: { prompt_tokens: 16396, completion_tokens: 362, total_tokens: 16758 },
      copilot_usage: {
        token_details: [
          { token_type: 'input', token_count: 3857 },
          { token_type: 'cache_write', token_count: 12539 },
          { token_type: 'output', token_count: 362 },
        ],
      },
    });
    const { usage } = extractUsageFromSseLine(line);
    expect(usage.input_tokens).toBe(3857);
    expect(usage.cache_creation_input_tokens).toBe(12539);
    expect(usage.prompt_tokens).toBeUndefined();
  });

  test('infers input_tokens from prompt_tokens when streaming copilot_usage has cache_write but no input', () => {
    // Same double-count guard as non-streaming: if token_details omits input but
    // provides cache_write, prompt_tokens must not survive alongside cache_creation_input_tokens.
    const line = JSON.stringify({
      model: 'claude-sonnet-4.6',
      usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 },
      copilot_usage: {
        token_details: [
          { token_type: 'cache_write', token_count: 300 },
          { token_type: 'output', token_count: 50 },
        ],
      },
    });
    const { usage } = extractUsageFromSseLine(line);
    expect(usage.prompt_tokens).toBeUndefined();
    expect(usage.input_tokens).toBe(200);
    expect(usage.cache_creation_input_tokens).toBe(300);
    expect(normalizeUsage(usage)).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_write_tokens: 300,
      reasoning_tokens: 0,
    });
  });
});
