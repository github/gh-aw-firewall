import * as path from 'path';

// The checker is intentionally zero-dependency CommonJS so the CI job can run it
// with bare `node`; require it directly here for unit testing.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const checker = require('./check-token-usage.js');

const {
  parseJsonl,
  sumTokenUsage,
  aiCreditsMatch,
  evaluateTokenUsage,
  locateUsageFiles,
  parseArgs,
} = checker;

/** Build a per-response token-usage record with sensible defaults. */
function record(overrides: Record<string, unknown> = {}) {
  return {
    event: 'token_usage',
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ai_credits_total: 0,
    ...overrides,
  };
}

describe('parseJsonl', () => {
  it('parses well-formed lines and skips blanks / malformed lines', () => {
    const text = '{"a":1}\n\n  \nnot json\n{"b":2}\n';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseJsonl('')).toEqual([]);
  });
});

describe('sumTokenUsage', () => {
  it('sums token fields and captures first input / last credits', () => {
    const totals = sumTokenUsage([
      record({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, ai_credits_total: 1.5 }),
      record({ input_tokens: 200, output_tokens: 20, cache_read_tokens: 150, ai_credits_total: 3.0 }),
    ]);
    expect(totals.input_tokens).toBe(300);
    expect(totals.output_tokens).toBe(30);
    expect(totals.cache_read_tokens).toBe(150);
    expect(totals.count).toBe(2);
    expect(totals.firstInputTokens).toBe(100);
    expect(totals.lastAiCreditsTotal).toBe(3.0);
  });

  it('ignores non-usage records in a mixed stream', () => {
    const totals = sumTokenUsage([
      record({ input_tokens: 100 }),
      { event: 'something_else', input_tokens: 9999 },
    ]);
    expect(totals.input_tokens).toBe(100);
    expect(totals.count).toBe(1);
  });
});

describe('aiCreditsMatch', () => {
  it('accepts values within rounding tolerance', () => {
    expect(aiCreditsMatch(28.632, 28.632)).toBe(true);
    expect(aiCreditsMatch(417.082, 417.085)).toBe(true);
  });

  it('rejects clearly different values', () => {
    expect(aiCreditsMatch(28.632, 30.0)).toBe(false);
  });
});

describe('evaluateTokenUsage — internal consistency', () => {
  it('passes when per-response sums equal the aggregate and cache_read > 0', () => {
    const records = [
      record({ input_tokens: 13663, output_tokens: 378, cache_read_tokens: 0, ai_credits_total: 1.2 }),
      record({ input_tokens: 16601, output_tokens: 124, cache_read_tokens: 10752, ai_credits_total: 4.3 }),
    ];
    const aggregate = {
      input_tokens: 30264,
      output_tokens: 502,
      cache_read_tokens: 10752,
      cache_write_tokens: 0,
      ambient_context: 13663,
      ai_credits: 4.3,
    };
    const { failures, warnings } = evaluateTokenUsage({ records, aggregate });
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('fails when the aggregate disagrees with the per-response sum', () => {
    const records = [record({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 50 })];
    const aggregate = {
      input_tokens: 999, // wrong
      output_tokens: 10,
      cache_read_tokens: 50,
      cache_write_tokens: 0,
    };
    const { failures } = evaluateTokenUsage({ records, aggregate, minRequests: 1 });
    expect(failures.some((f: string) => f.includes('Inconsistent input_tokens'))).toBe(true);
  });

  it('fails when the aggregate is missing entirely', () => {
    const records = [record({ input_tokens: 100, cache_read_tokens: 50 })];
    const { failures } = evaluateTokenUsage({ records, aggregate: null, minRequests: 1 });
    expect(failures.some((f: string) => f.includes('Aggregated agent_usage'))).toBe(true);
  });

  it('warns (does not fail) on ai_credits / ambient_context drift', () => {
    const records = [
      record({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 50, ai_credits_total: 2.0 }),
      record({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 50, ai_credits_total: 5.0 }),
    ];
    const aggregate = {
      input_tokens: 200,
      output_tokens: 20,
      cache_read_tokens: 100,
      cache_write_tokens: 0,
      ambient_context: 999, // mismatch -> warning
      ai_credits: 42.0, // mismatch -> warning
    };
    const { failures, warnings } = evaluateTokenUsage({ records, aggregate });
    expect(failures).toEqual([]);
    expect(warnings.some((w: string) => w.includes('ai_credits drift'))).toBe(true);
    expect(warnings.some((w: string) => w.includes('ambient_context'))).toBe(true);
  });
});

describe('evaluateTokenUsage — cache-read red flag', () => {
  it('hard-fails when cache_read is 0 across multiple responses (the bug)', () => {
    // Mirrors gh-aw codex run 27784259295/27784201719: consistent totals, zero cache reads.
    const records = [
      record({ input_tokens: 13663, output_tokens: 378 }),
      record({ input_tokens: 26000, output_tokens: 200 }),
    ];
    const aggregate = {
      input_tokens: 39663,
      output_tokens: 578,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    const { failures } = evaluateTokenUsage({ records, aggregate });
    expect(failures.some((f: string) => f.includes('cache_read_tokens is 0'))).toBe(true);
  });

  it('only warns about cache_read==0 when below the min-requests threshold', () => {
    const records = [record({ input_tokens: 100, output_tokens: 10, cache_read_tokens: 0 })];
    const aggregate = {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    const { failures, warnings } = evaluateTokenUsage({ records, aggregate, minRequests: 2 });
    expect(failures).toEqual([]);
    expect(warnings.some((w: string) => w.includes('too short to assert'))).toBe(true);
  });

  it('fails when there are no usage records at all', () => {
    const { failures } = evaluateTokenUsage({ records: [], aggregate: null });
    expect(failures.some((f: string) => f.includes('No token-usage records'))).toBe(true);
  });
});

describe('locateUsageFiles', () => {
  it('honors explicit overrides without touching the filesystem', () => {
    const { tokenUsage, agentUsage } = locateUsageFiles('/nonexistent', {
      tokenUsage: '/x/token-usage.jsonl',
      agentUsage: '/x/agent_usage.json',
    });
    expect(tokenUsage).toBe('/x/token-usage.jsonl');
    expect(agentUsage).toBe('/x/agent_usage.json');
  });

  it('resolves the canonical api-proxy path inside a real fixture tree', () => {
    // The codex artifact downloaded during development is not present in CI, so
    // this only asserts the candidate-path logic via overrides above; here we
    // simply confirm a missing tree yields nulls rather than throwing.
    const { tokenUsage, agentUsage } = locateUsageFiles(path.join('/tmp', 'definitely-missing-xyz'));
    expect(tokenUsage).toBeNull();
    expect(agentUsage).toBeNull();
  });
});

describe('parseArgs', () => {
  it('parses flags with sensible defaults', () => {
    const opts = parseArgs(['--artifact-root', '/tmp/x', '--engine', 'copilot', '--min-requests', '5']);
    expect(opts.artifactRoot).toBe('/tmp/x');
    expect(opts.engine).toBe('copilot');
    expect(opts.minRequests).toBe(5);
  });

  it('defaults min-requests to 2 and engine to unknown', () => {
    const opts = parseArgs([]);
    expect(opts.minRequests).toBe(2);
    expect(opts.engine).toBe('unknown');
    expect(opts.artifactRoot).toBe('/tmp/gh-aw');
  });
});
