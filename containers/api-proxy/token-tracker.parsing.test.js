/**
 * Tests for token-tracker.js
 */

const {
  extractUsageFromJson,
  extractUsageFromSseLine,
  parseSseDataLines,
  normalizeUsage,
  extractCopilotUsageBreakdown,
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

  test('extracts OpenAI Responses API cached tokens from input_tokens_details.cached_tokens (object form)', () => {
    // Ground-truth shape emitted by codex /responses streaming (see issue #5203):
    // usage.input_tokens_details is a plain object with a numeric cached_tokens field,
    // not prompt_tokens_details and not an array/details form.
    const body = Buffer.from(JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_cache_obj',
        model: 'gpt-5.4-mini',
        usage: {
          input_tokens: 20439,
          output_tokens: 168,
          total_tokens: 20607,
          input_tokens_details: {
            cached_tokens: 19968,
          },
        },
      },
    }));

    const result = extractUsageFromJson(body);
    expect(result.model).toBe('gpt-5.4-mini');
    expect(result.usage).toEqual({
      input_tokens: 20439,
      output_tokens: 168,
      total_tokens: 20607,
      cache_read_input_tokens: 19968,
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

// ── Copilot copilot_usage.token_details breakdown ─────────────────────

describe('extractCopilotUsageBreakdown', () => {
  test('returns null when copilot_usage is absent', () => {
    expect(extractCopilotUsageBreakdown({ usage: { prompt_tokens: 10 } })).toBeNull();
  });

  test('returns null when token_details is not an array', () => {
    expect(extractCopilotUsageBreakdown({ copilot_usage: { token_details: {} } })).toBeNull();
  });

  test('returns null when no recognizable token types are present', () => {
    expect(extractCopilotUsageBreakdown({
      copilot_usage: { token_details: [{ token_type: 'mystery', token_count: 5 }] },
    })).toBeNull();
  });

  test('extracts the full input/cache_read/cache_write/output split', () => {
    const result = extractCopilotUsageBreakdown({
      copilot_usage: {
        token_details: [
          { token_type: 'input', token_count: 3857 },
          { token_type: 'cache_read', token_count: 0 },
          { token_type: 'cache_write', token_count: 12539 },
          { token_type: 'output', token_count: 362 },
        ],
      },
    });
    expect(result).toEqual({
      input_tokens: 3857,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 12539,
      output_tokens: 362,
    });
  });

  test('reads copilot_usage nested under a response object', () => {
    const result = extractCopilotUsageBreakdown({
      response: {
        copilot_usage: { token_details: [{ token_type: 'input', token_count: 7 }] },
      },
    });
    expect(result).toEqual({ input_tokens: 7 });
  });

  test('sums repeated token types and ignores malformed entries', () => {
    const result = extractCopilotUsageBreakdown({
      copilot_usage: {
        token_details: [
          { token_type: 'input', token_count: 100 },
          { token_type: 'input', token_count: 50 },
          { token_type: 'output', token_count: 'nope' },
          null,
          { token_type: 'cache_write' },
        ],
      },
    });
    expect(result).toEqual({ input_tokens: 150 });
  });
});

// ── extractUsageFromJson + Copilot breakdown integration ──────────────

describe('extractUsageFromJson with copilot_usage', () => {
  // Real Claude-via-Copilot response shape: flattened usage.prompt_tokens
  // lumps fresh input (3857) with cache_write (12539); the authoritative
  // split lives only in copilot_usage.token_details.
  const copilotBody = () => Buffer.from(JSON.stringify({
    id: 'e6925ddf',
    model: 'claude-sonnet-4.6',
    choices: [{ message: { role: 'assistant', content: 'hi' } }],
    usage: {
      completion_tokens: 362,
      prompt_tokens: 16396,
      prompt_tokens_details: { cached_tokens: 0 },
      total_tokens: 16758,
    },
    copilot_usage: {
      token_details: [
        { token_type: 'input', token_count: 3857 },
        { token_type: 'cache_read', token_count: 0 },
        { token_type: 'cache_write', token_count: 12539 },
        { token_type: 'output', token_count: 362 },
      ],
      total_nano_aiu: 6402225000,
    },
  }));

  test('prefers the copilot_usage split over the lumped prompt_tokens', () => {
    const { usage, model } = extractUsageFromJson(copilotBody());
    expect(model).toBe('claude-sonnet-4.6');
    expect(usage.input_tokens).toBe(3857);
    expect(usage.cache_creation_input_tokens).toBe(12539);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(362);
    // The lumped prompt_tokens is dropped so normalization uses input_tokens.
    expect(usage.prompt_tokens).toBeUndefined();
  });

  test('normalizes to the correct cache_write split', () => {
    const { usage } = extractUsageFromJson(copilotBody());
    expect(normalizeUsage(usage)).toEqual({
      input_tokens: 3857,
      output_tokens: 362,
      cache_read_tokens: 0,
      cache_write_tokens: 12539,
      reasoning_tokens: 0,
    });
  });

  test('does not affect plain OpenAI responses without copilot_usage', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5',
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 30 },
      },
    }));
    expect(normalizeUsage(extractUsageFromJson(body).usage)).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
    });
  });

  test('uses copilot_usage even when the flattened usage object is absent', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'claude-sonnet-4.6',
      copilot_usage: {
        token_details: [
          { token_type: 'input', token_count: 200 },
          { token_type: 'output', token_count: 10 },
          { token_type: 'cache_write', token_count: 99 },
        ],
      },
    }));
    expect(normalizeUsage(extractUsageFromJson(body).usage)).toEqual({
      input_tokens: 200,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 99,
      reasoning_tokens: 0,
    });
  });

  test('infers input_tokens from prompt_tokens when copilot_usage has cache_write but no input', () => {
    // Edge case: token_details provides cache_write but omits input.
    // prompt_tokens = input + cache_write, so input must be inferred to avoid
    // double-counting cache_write in normalizeUsage.
    const body = Buffer.from(JSON.stringify({
      model: 'claude-sonnet-4.6',
      usage: {
        prompt_tokens: 500,
        completion_tokens: 50,
        total_tokens: 550,
      },
      copilot_usage: {
        token_details: [
          { token_type: 'cache_write', token_count: 300 },
          { token_type: 'output', token_count: 50 },
        ],
      },
    }));
    const { usage } = extractUsageFromJson(body);
    // prompt_tokens should be removed; input_tokens inferred as 500 - 300 = 200
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
