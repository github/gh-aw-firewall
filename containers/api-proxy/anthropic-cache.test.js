/**
 * Tests for anthropic-cache.js
 *
 * Covers the Anthropic prompt-cache optimization layer:
 *   - injectBreakpointIfAbsent (tools / system / messages[0] / tail)
 *   - rewriteCacheControl (TTL upgrade to 1h, tail-skip)
 *   - normalizeTailBreakpoints
 *   - stripSmallSystemBreakpoints
 *   - ensureBetaHeader
 *   - stripAnsiFromMessages
 *   - applyAnthropicCacheOptimizations (integration)
 */

'use strict';

const {
  BETA_FLAG,
  MIN_SYSTEM_CACHE_CHARS,
  BREAKPOINT_CEILING,
  hasBreakpoint,
  countCacheBreakpoints,
  stripSmallSystemBreakpoints,
  normalizeTailBreakpoints,
  rewriteCacheControl,
  injectBreakpointIfAbsent,
  ensureBetaHeader,
  stripAnsiFromMessages,
  applyAnthropicCacheOptimizations,
} = require('./anthropic-cache');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTool(name = 'Bash') {
  return { name, description: `Tool ${name}`, input_schema: { type: 'object', properties: {} } };
}

function makeTextBlock(text = 'hello', withBreakpoint = false) {
  const b = { type: 'text', text };
  if (withBreakpoint) b.cache_control = { type: 'ephemeral' };
  return b;
}

function makeToolResultBlock(content = 'result') {
  return { type: 'tool_result', tool_use_id: 'id1', content };
}

// ── hasBreakpoint ────────────────────────────────────────────────────────────

describe('hasBreakpoint', () => {
  it('returns false for undefined', () => {
    expect(hasBreakpoint(undefined)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(hasBreakpoint([])).toBe(false);
  });

  it('returns false when no cache_control present', () => {
    expect(hasBreakpoint([{ name: 'Bash' }])).toBe(false);
  });

  it('returns true when an entry has ephemeral cache_control', () => {
    expect(hasBreakpoint([{ cache_control: { type: 'ephemeral' } }])).toBe(true);
  });

  it('returns false for non-ephemeral cache_control type', () => {
    expect(hasBreakpoint([{ cache_control: { type: 'other' } }])).toBe(false);
  });
});

// ── countCacheBreakpoints ─────────────────────────────────────────────────────

describe('countCacheBreakpoints', () => {
  it('returns 0 for empty body', () => {
    expect(countCacheBreakpoints({})).toBe(0);
  });

  it('counts nested ephemeral cache_control entries', () => {
    const body = {
      tools: [{ cache_control: { type: 'ephemeral' } }],
      messages: [{ content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }],
    };
    expect(countCacheBreakpoints(body)).toBe(2);
  });
});

// ── stripSmallSystemBreakpoints ───────────────────────────────────────────────

describe('stripSmallSystemBreakpoints', () => {
  it('returns 0 when system is not an array', () => {
    expect(stripSmallSystemBreakpoints({})).toBe(0);
  });

  it('strips breakpoints on blocks shorter than MIN_SYSTEM_CACHE_CHARS', () => {
    const smallText = 'x'.repeat(MIN_SYSTEM_CACHE_CHARS - 1);
    const body = {
      system: [
        { type: 'text', text: smallText, cache_control: { type: 'ephemeral' } },
      ],
    };
    const stripped = stripSmallSystemBreakpoints(body);
    expect(stripped).toBe(1);
    expect(body.system[0].cache_control).toBeUndefined();
  });

  it('keeps breakpoints on blocks >= MIN_SYSTEM_CACHE_CHARS', () => {
    const bigText = 'x'.repeat(MIN_SYSTEM_CACHE_CHARS);
    const body = {
      system: [
        { type: 'text', text: bigText, cache_control: { type: 'ephemeral' } },
      ],
    };
    const stripped = stripSmallSystemBreakpoints(body);
    expect(stripped).toBe(0);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('skips blocks without cache_control', () => {
    const body = { system: [{ type: 'text', text: 'short' }] };
    expect(stripSmallSystemBreakpoints(body)).toBe(0);
  });
});

// ── normalizeTailBreakpoints ──────────────────────────────────────────────────

describe('normalizeTailBreakpoints', () => {
  it('returns empty Set when messages is absent', () => {
    const result = normalizeTailBreakpoints({}, '5m');
    expect(result.size).toBe(0);
  });

  it('returns empty Set when messages is empty', () => {
    const result = normalizeTailBreakpoints({ messages: [] }, '5m');
    expect(result.size).toBe(0);
  });

  it('finds ephemeral breakpoints in the last message and sets tailTtl', () => {
    const block = makeTextBlock('msg', true);
    const body = {
      messages: [
        { role: 'user', content: [makeTextBlock('older')] },
        { role: 'user', content: [block] },
      ],
    };
    const result = normalizeTailBreakpoints(body, '5m');
    expect(result.size).toBe(1);
    expect(result.has(block)).toBe(true);
    expect(block.cache_control.ttl).toBe('5m');
  });

  it('does not touch breakpoints in earlier messages', () => {
    const older = makeTextBlock('older', true);
    older.cache_control.ttl = '1h';
    const body = {
      messages: [
        { role: 'user', content: [older] },
        { role: 'user', content: [makeTextBlock('latest')] },
      ],
    };
    normalizeTailBreakpoints(body, '5m');
    expect(older.cache_control.ttl).toBe('1h');
  });
});

// ── rewriteCacheControl ───────────────────────────────────────────────────────

describe('rewriteCacheControl', () => {
  it('upgrades ephemeral breakpoint to 1h', () => {
    const node = { cache_control: { type: 'ephemeral' } };
    const counter = { rewritten: 0, alreadySet: 0, skipped: 0 };
    rewriteCacheControl(node, counter, new Set());
    expect(node.cache_control.ttl).toBe('1h');
    expect(counter.rewritten).toBe(1);
  });

  it('skips nodes in the skip set', () => {
    const node = { cache_control: { type: 'ephemeral' } };
    const counter = { rewritten: 0, alreadySet: 0, skipped: 0 };
    rewriteCacheControl(node, counter, new Set([node]));
    expect(node.cache_control.ttl).toBeUndefined();
    expect(counter.skipped).toBe(1);
  });

  it('counts already-1h breakpoints', () => {
    const node = { cache_control: { type: 'ephemeral', ttl: '1h' } };
    const counter = { rewritten: 0, alreadySet: 0, skipped: 0 };
    rewriteCacheControl(node, counter, new Set());
    expect(counter.alreadySet).toBe(1);
    expect(counter.rewritten).toBe(0);
  });

  it('recurses into arrays', () => {
    const a = { cache_control: { type: 'ephemeral' } };
    const b = { cache_control: { type: 'ephemeral' } };
    const counter = { rewritten: 0, alreadySet: 0, skipped: 0 };
    rewriteCacheControl([a, b], counter, new Set());
    expect(a.cache_control.ttl).toBe('1h');
    expect(b.cache_control.ttl).toBe('1h');
    expect(counter.rewritten).toBe(2);
  });
});

// ── injectBreakpointIfAbsent ──────────────────────────────────────────────────

describe('injectBreakpointIfAbsent', () => {
  it('returns tag="none" when nothing to inject', () => {
    const body = { messages: [] };
    const { tag } = injectBreakpointIfAbsent(body);
    expect(tag).toBe('none');
  });

  it('injects tools breakpoint when absent', () => {
    const body = { tools: [makeTool()], messages: [] };
    const { tag } = injectBreakpointIfAbsent(body);
    expect(tag).toContain('tools');
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('does not inject tools breakpoint when already present', () => {
    const tool = makeTool();
    tool.cache_control = { type: 'ephemeral', ttl: '1h' };
    const body = { tools: [tool], messages: [] };
    const { tag } = injectBreakpointIfAbsent(body);
    expect(tag).not.toContain('tools');
  });

  it('injects system breakpoint for array system', () => {
    const body = {
      system: [{ type: 'text', text: 'sys' }],
      messages: [],
    };
    injectBreakpointIfAbsent(body);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('converts string system to array with breakpoint', () => {
    const body = { system: 'be helpful', messages: [] };
    const { tag } = injectBreakpointIfAbsent(body);
    expect(tag).toContain('system-string');
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('injects messages[0] breakpoint when more than one message', () => {
    const body = {
      messages: [
        { role: 'user', content: [makeTextBlock('reminders')] },
        { role: 'user', content: [makeTextBlock('latest')] },
      ],
    };
    const { tag } = injectBreakpointIfAbsent(body);
    expect(tag).toContain('msg0');
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('injects tail breakpoint with 5m TTL by default', () => {
    const body = {
      messages: [
        { role: 'user', content: [makeTextBlock('msg1')] },
      ],
    };
    const { tag, tailBlocks } = injectBreakpointIfAbsent(body);
    expect(tag).toContain('tail:5m');
    expect(tailBlocks.size).toBe(1);
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('respects BREAKPOINT_CEILING (max 4)', () => {
    // Pre-fill 4 breakpoints
    const tools = Array.from({ length: BREAKPOINT_CEILING }, (_, i) => {
      const t = makeTool(`Tool${i}`);
      if (i === BREAKPOINT_CEILING - 1) t.cache_control = { type: 'ephemeral' };
      return t;
    });
    const body = {
      tools,
      system: [
        { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: [makeTextBlock('x', true)] },
        { role: 'user', content: [makeTextBlock('y', true)] },
      ],
    };
    const before = countCacheBreakpoints(body);
    expect(before).toBe(BREAKPOINT_CEILING);
    injectBreakpointIfAbsent(body);
    // Should not exceed ceiling
    expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(BREAKPOINT_CEILING);
  });

  it('strips small system breakpoints before injecting', () => {
    const smallText = 'x'.repeat(MIN_SYSTEM_CACHE_CHARS - 1);
    const body = {
      system: [{ type: 'text', text: smallText, cache_control: { type: 'ephemeral' } }],
      messages: [],
    };
    const { tag } = injectBreakpointIfAbsent(body);
    expect(tag).toContain('strip-sys:1');
  });
});

// ── ensureBetaHeader ──────────────────────────────────────────────────────────

describe('ensureBetaHeader', () => {
  it('adds header when absent', () => {
    const headers = {};
    const result = ensureBetaHeader(headers);
    expect(result).toBe('added');
    expect(headers['anthropic-beta']).toBe(BETA_FLAG);
  });

  it('returns "present" when flag already in header', () => {
    const headers = { 'anthropic-beta': BETA_FLAG };
    const result = ensureBetaHeader(headers);
    expect(result).toBe('present');
    expect(headers['anthropic-beta']).toBe(BETA_FLAG);
  });

  it('appends flag when header exists with other values', () => {
    const headers = { 'anthropic-beta': 'interleaved-thinking-2025-05-14' };
    const result = ensureBetaHeader(headers);
    expect(result).toBe('appended');
    expect(headers['anthropic-beta']).toBe(`interleaved-thinking-2025-05-14,${BETA_FLAG}`);
  });

  it('is case-insensitive for existing header key', () => {
    const headers = { 'Anthropic-Beta': BETA_FLAG };
    const result = ensureBetaHeader(headers);
    expect(result).toBe('present');
  });
});

// ── stripAnsiFromMessages ─────────────────────────────────────────────────────

describe('stripAnsiFromMessages', () => {
  it('returns 0 when messages is absent', () => {
    expect(stripAnsiFromMessages({})).toBe(0);
  });

  it('strips ANSI from string content', () => {
    const body = {
      messages: [{ role: 'user', content: '\x1b[31mhello\x1b[0m' }],
    };
    const count = stripAnsiFromMessages(body);
    expect(count).toBe(1);
    expect(body.messages[0].content).toBe('hello');
  });

  it('strips ANSI from text blocks', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '\x1b[1mbold\x1b[0m' }] },
      ],
    };
    stripAnsiFromMessages(body);
    expect(body.messages[0].content[0].text).toBe('bold');
  });

  it('strips ANSI from tool_result content', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'id1',
              content: '\x1b[32mgreen\x1b[0m',
            },
          ],
        },
      ],
    };
    stripAnsiFromMessages(body);
    expect(body.messages[0].content[0].content).toBe('green');
  });

  it('strips ANSI from nested tool_result content array', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'id1',
              content: [{ type: 'text', text: '\x1b[33myellow\x1b[0m' }],
            },
          ],
        },
      ],
    };
    stripAnsiFromMessages(body);
    expect(body.messages[0].content[0].content[0].text).toBe('yellow');
  });

  it('does not count strings without ANSI', () => {
    const body = { messages: [{ role: 'user', content: 'plain text' }] };
    expect(stripAnsiFromMessages(body)).toBe(0);
  });
});

// ── applyAnthropicCacheOptimizations (integration) ───────────────────────────

describe('applyAnthropicCacheOptimizations', () => {
  it('injects tools + tail breakpoints and adds beta header', () => {
    const body = {
      tools: [makeTool('Bash'), makeTool('Read')],
      messages: [
        { role: 'user', content: [makeTextBlock('please help')] },
      ],
    };
    const headers = { 'x-api-key': 'key' };

    const result = applyAnthropicCacheOptimizations(body, headers);

    expect(result.injected).toContain('tools');
    expect(result.injected).toContain('tail');
    expect(result.betaHeader).toBe('added');
    expect(headers['anthropic-beta']).toBe(BETA_FLAG);
    // Last tool should have 1h breakpoint
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('upgrades existing 5m-default (no ttl) breakpoints to 1h, except tail', () => {
    const tool = makeTool('Bash');
    tool.cache_control = { type: 'ephemeral' }; // no ttl → 5m default
    const tailBlock = makeTextBlock('tail');
    const body = {
      tools: [tool],
      messages: [
        { role: 'user', content: [tailBlock] },
      ],
    };
    const headers = {};
    applyAnthropicCacheOptimizations(body, headers, { tailTtl: '5m' });

    // Tool breakpoint should be 1h
    expect(body.tools[0].cache_control.ttl).toBe('1h');
    // Tail should keep 5m
    expect(body.messages[0].content[0].cache_control.ttl).toBe('5m');
  });

  it('strips ANSI and reports count', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '\x1b[31mred\x1b[0m' }] },
      ],
    };
    const result = applyAnthropicCacheOptimizations(body, {});
    expect(result.ansiCleaned).toBe(1);
    expect(body.messages[0].content[0].text).toBe('red');
  });

  it('reports rewritten count', () => {
    const tool = makeTool();
    tool.cache_control = { type: 'ephemeral' }; // implicit 5m → will be rewritten
    const body = { tools: [tool], messages: [{ role: 'user', content: [] }] };
    const result = applyAnthropicCacheOptimizations(body, {});
    expect(result.rewritten).toBeGreaterThan(0);
  });

  it('preserves existing 1h breakpoints and reports alreadySet path', () => {
    const tool = makeTool();
    tool.cache_control = { type: 'ephemeral', ttl: '1h' };
    const body = { tools: [tool], messages: [] };
    const result = applyAnthropicCacheOptimizations(body, {});
    // Nothing should be newly rewritten
    expect(result.rewritten).toBe(0);
  });
});
