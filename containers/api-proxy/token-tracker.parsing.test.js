/**
 * Tests for token-tracker.js
 */

const {
  extractUsageFromJson,
  extractUsageFromSseLine,
  parseSseDataLines,
  normalizeUsage,
  looksLikeCompletionRequest,
} = require('./token-tracker');

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

  test('extracts OpenAI Responses API usage nested under response.usage', () => {
    const body = Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_123',
        model: 'gpt-5-mini',
        usage: {
          input_tokens: 1234,
          output_tokens: 567,
          total_tokens: 1801,
        },
      },
    }));

    const result = extractUsageFromJson(body);
    expect(result.model).toBe('gpt-5-mini');
    expect(result.usage).toEqual({
      input_tokens: 1234,
      output_tokens: 567,
      total_tokens: 1801,
    });
  });

  test('extracts OpenAI Responses API cached tokens from response.usage.prompt_tokens_details', () => {
    const body = Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_cache_123',
        model: 'gpt-5-mini',
        usage: {
          input_tokens: 40000,
          output_tokens: 64,
          total_tokens: 40064,
          prompt_tokens_details: {
            cached_tokens: 32128,
          },
        },
      },
    }));

    const result = extractUsageFromJson(body);
    expect(result.model).toBe('gpt-5-mini');
    expect(result.usage).toEqual({
      input_tokens: 40000,
      output_tokens: 64,
      total_tokens: 40064,
      cache_read_input_tokens: 32128,
    });
  });

  test('extracts cache_read tokens from token_type entries in usage details', () => {
    const body = Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: {
        model: 'gpt-5-mini',
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
          prompt_tokens_details: {
            details: [
              { token_type: 'text', token_count: 12 },
              { token_type: 'cache_read', token_count: 77 },
            ],
          },
        },
      },
    }));

    const result = extractUsageFromJson(body);
    expect(result.usage).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      cache_read_input_tokens: 77,
    });
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
      reasoning_tokens: 0,
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
      reasoning_tokens: 0,
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
      reasoning_tokens: 0,
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
      reasoning_tokens: 0,
    });
  });

  test('normalizes OpenAI cached_tokens via prompt_tokens_details.cached_tokens', () => {
    const result = normalizeUsage({
      prompt_tokens: 43977,
      completion_tokens: 24,
      total_tokens: 44001,
      prompt_tokens_details: {
        cached_tokens: 43894,
      },
    });
    expect(result).toEqual({
      input_tokens: 43977,
      output_tokens: 24,
      cache_read_tokens: 43894,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    });
  });
});

// ── looksLikeCompletionRequest ────────────────────────────────────────

describe('looksLikeCompletionRequest', () => {
  test.each([
    '/chat/completions',
    '/v1/chat/completions',
    '/responses',
    '/v1/responses',
    '/v1/messages',
    '/v1/completions',
    '/v1beta/models/gemini-pro:generateContent',
    '/v1beta/models/gemini-pro:streamGenerateContent',
    '/v1/chat/completions?foo=bar',
  ])('returns true for completion endpoint %s', (path) => {
    expect(looksLikeCompletionRequest(path)).toBe(true);
  });

  test.each([
    '/v1/models',
    '/models',
    '/health',
    '/',
    '',
    null,
    undefined,
  ])('returns false for non-completion path %s', (path) => {
    expect(looksLikeCompletionRequest(path)).toBe(false);
  });
});
