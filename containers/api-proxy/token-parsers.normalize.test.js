/**
 * Tests for usage normalization helpers in token-tracker.js
 */

const {
  normalizeUsage,
  extractCopilotUsageBreakdown,
} = require('./token-tracker');

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

  test('normalizes OpenAI Responses API cached_tokens via input_tokens_details.cached_tokens', () => {
    const result = normalizeUsage({
      input_tokens: 707301,
      output_tokens: 12096,
      total_tokens: 719397,
      input_tokens_details: {
        cached_tokens: 672256,
      },
      reasoning_tokens: 7715,
    });
    expect(result).toEqual({
      input_tokens: 707301,
      output_tokens: 12096,
      cache_read_tokens: 672256,
      cache_write_tokens: 0,
      reasoning_tokens: 7715,
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
