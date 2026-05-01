'use strict';

/**
 * Tests for containers/api-proxy/anthropic-transforms.js
 *
 * Coverage:
 *   - stripAnsi / applyAnsiStrip
 *   - applyToolDrop
 *   - injectCacheBreakpoints  (injection count ≤4, TTL values, rolling-tail logic)
 *   - upgradeEphemeralTtl     (TTL upgrade, tail detection)
 *   - makeAnthropicTransform  (composition, idempotency, Buffer I/O)
 *   - loadCustomTransform     (happy-path + error handling)
 */

const {
  stripAnsi,
  applyAnsiStrip,
  applyToolDrop,
  buildToolScrubPattern,
  injectCacheBreakpoints,
  upgradeEphemeralTtl,
  loadCustomTransform,
  makeAnthropicTransform,
  EXTENDED_CACHE_BETA,
  MAX_CACHE_BREAKPOINTS,
} = require('./anthropic-transforms');

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

function toBuffer(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

function fromBuffer(buf) {
  return JSON.parse(buf.toString('utf8'));
}

function applyTransform(obj, options) {
  const transform = makeAnthropicTransform(options);
  if (!transform) return obj;
  const result = transform(toBuffer(obj));
  return result ? fromBuffer(result) : obj;
}

// ── constants ─────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('EXTENDED_CACHE_BETA is the correct beta header value', () => {
    expect(EXTENDED_CACHE_BETA).toBe('extended-cache-ttl-2025-04-11');
  });

  it('MAX_CACHE_BREAKPOINTS is 4', () => {
    expect(MAX_CACHE_BREAKPOINTS).toBe(4);
  });
});

// ── stripAnsi ─────────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('strips basic SGR colour codes', () => {
    expect(stripAnsi('\x1B[31mred\x1B[0m')).toBe('red');
  });

  it('strips multi-param SGR sequences', () => {
    expect(stripAnsi('\x1B[1;32mbold-green\x1B[0m')).toBe('bold-green');
  });

  it('strips reset code alone', () => {
    expect(stripAnsi('\x1B[0m')).toBe('');
  });

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('removes multiple sequences throughout a string', () => {
    const input = '\x1B[31merror:\x1B[0m \x1B[33mwarning\x1B[0m text';
    expect(stripAnsi(input)).toBe('error: warning text');
  });

  it('does not strip non-SGR ESC sequences', () => {
    // ESC[?25l (cursor hide) doesn't end with 'm' — leave it untouched
    const input = '\x1B[?25l visible \x1B[?25h';
    expect(stripAnsi(input)).toBe('\x1B[?25l visible \x1B[?25h');
  });

  it('strips SGR sequences while preserving non-SGR ESC sequences in the same string', () => {
    // Mix of SGR (ends with 'm') and non-SGR (cursor hide, ends with 'l') sequences
    const input = '\x1B[?25l\x1B[31mred text\x1B[0m\x1B[?25h';
    // Only the SGR sequences should be stripped
    expect(stripAnsi(input)).toBe('\x1B[?25lred text\x1B[?25h');
  });
});

// ── applyAnsiStrip ────────────────────────────────────────────────────────────

describe('applyAnsiStrip', () => {
  it('strips ANSI from string tool_result content', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: '\x1B[32mok\x1B[0m',
            },
          ],
        },
      ],
    };
    const result = applyAnsiStrip(body);
    expect(result.messages[0].content[0].content).toBe('ok');
  });

  it('strips ANSI from array tool_result text sub-blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_2',
              content: [
                { type: 'text', text: '\x1B[31merr\x1B[0m' },
                { type: 'image', source: { type: 'base64', data: 'abc' } },
              ],
            },
          ],
        },
      ],
    };
    const result = applyAnsiStrip(body);
    const innerContent = result.messages[0].content[0].content;
    expect(innerContent[0].text).toBe('err');
    expect(innerContent[1]).toEqual({ type: 'image', source: { type: 'base64', data: 'abc' } });
  });

  it('does not touch non-tool_result blocks', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '\x1B[31mcoloured\x1B[0m text' }],
        },
      ],
    };
    const result = applyAnsiStrip(body);
    // Text blocks outside tool_result must not be modified
    expect(result.messages[0].content[0].text).toBe('\x1B[31mcoloured\x1B[0m text');
  });

  it('returns input unchanged when messages is absent', () => {
    const body = { model: 'claude-3', tools: [] };
    expect(applyAnsiStrip(body)).toBe(body);
  });

  it('returns a new object (does not mutate input)', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't', content: '\x1B[0m' }],
        },
      ],
    };
    const result = applyAnsiStrip(body);
    expect(result).not.toBe(body);
    expect(body.messages[0].content[0].content).toBe('\x1B[0m'); // original untouched
  });
});

// ── applyToolDrop ─────────────────────────────────────────────────────────────

describe('applyToolDrop', () => {
  function makeBody(toolNames, systemText = '') {
    return {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: toolNames.map(name => ({ name, description: `tool ${name}`, input_schema: {} })),
      system: systemText
        ? [{ type: 'text', text: systemText }]
        : undefined,
    };
  }

  it('drops specified tools by name', () => {
    const body = makeBody(['Bash', 'NotebookEdit', 'CronCreate']);
    const result = applyToolDrop(body, ['NotebookEdit', 'CronCreate']);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('Bash');
  });

  it('removes the tools key entirely when all tools are dropped', () => {
    const body = makeBody(['NotebookEdit']);
    const result = applyToolDrop(body, ['NotebookEdit']);
    expect(result.tools).toBeUndefined();
  });

  it('scrubs tool names from system prompt text blocks', () => {
    const body = makeBody(['NotebookEdit'], 'Use NotebookEdit to edit notebooks.');
    const result = applyToolDrop(body, ['NotebookEdit']);
    expect(result.system[0].text).not.toContain('NotebookEdit');
  });

  it('does not scrub a tool name that is a substring of another word', () => {
    // 'Monitor' should not scrub 'MonitorService'
    const body = makeBody(['Monitor'], 'Use MonitorService for monitoring.');
    const result = applyToolDrop(body, ['Monitor']);
    // 'MonitorService' must remain; standalone ' Monitor ' (if present) is removed
    expect(result.system[0].text).toContain('MonitorService');
  });

  it('returns input unchanged when toolNames is empty', () => {
    const body = makeBody(['Bash']);
    expect(applyToolDrop(body, [])).toBe(body);
  });

  it('does not mutate the input', () => {
    const body = makeBody(['Bash', 'NotebookEdit']);
    const originalLen = body.tools.length;
    applyToolDrop(body, ['NotebookEdit']);
    expect(body.tools).toHaveLength(originalLen);
  });

  it('handles bodies without a tools array', () => {
    const body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    const result = applyToolDrop(body, ['NotebookEdit']);
    expect(result.tools).toBeUndefined();
  });

  it('accepts a pre-compiled scrubPattern and uses it instead of building a new one', () => {
    const pattern = buildToolScrubPattern(['NotebookEdit']);
    const body = makeBody(['NotebookEdit'], 'Use NotebookEdit here.');
    const result = applyToolDrop(body, ['NotebookEdit'], pattern);
    expect(result.system[0].text).not.toContain('NotebookEdit');
    expect(result.tools).toBeUndefined();
  });
});

// ── buildToolScrubPattern ─────────────────────────────────────────────────────

describe('buildToolScrubPattern', () => {
  it('matches a standalone tool name', () => {
    const pattern = buildToolScrubPattern(['NotebookEdit']);
    expect('Use NotebookEdit here.'.replace(pattern, '')).toBe('Use  here.');
  });

  it('does not match the tool name as a substring of a longer identifier', () => {
    const pattern = buildToolScrubPattern(['Monitor']);
    expect('Use MonitorService.'.replace(pattern, '')).toBe('Use MonitorService.');
  });

  it('matches multiple tool names in a single pass', () => {
    const pattern = buildToolScrubPattern(['CronCreate', 'CronDelete']);
    const text = 'Use CronCreate and CronDelete.';
    expect(text.replace(pattern, '')).toBe('Use  and .');
  });

  it('is safe to reuse (String.replace resets lastIndex before each use)', () => {
    const pattern = buildToolScrubPattern(['Bash']);
    const input = 'Bash is available.';
    expect(input.replace(pattern, '')).toBe(' is available.');
    // Second call with the same pattern must still work
    expect(input.replace(pattern, '')).toBe(' is available.');
  });
});

// ── injectCacheBreakpoints ────────────────────────────────────────────────────

describe('injectCacheBreakpoints', () => {
  function makeTool(name) {
    return { name, description: 'a tool', input_schema: {} };
  }

  function makeSystemBlock(text) {
    return { type: 'text', text };
  }

  function makeMsg(role, ...texts) {
    return {
      role,
      content: texts.map(t => ({ type: 'text', text: t })),
    };
  }

  it('injects on the last tools entry (slot 1)', () => {
    const body = {
      messages: [],
      tools: [makeTool('A'), makeTool('B')],
    };
    const result = injectCacheBreakpoints(body);
    expect(result.tools[0].cache_control).toBeUndefined();
    expect(result.tools[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('injects on the last system block (slot 2)', () => {
    const body = {
      messages: [],
      system: [makeSystemBlock('s1'), makeSystemBlock('s2')],
    };
    const result = injectCacheBreakpoints(body);
    expect(result.system[0].cache_control).toBeUndefined();
    expect(result.system[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('injects on the last block of messages[0] (slot 3)', () => {
    const body = {
      messages: [makeMsg('user', 'block-a', 'block-b')],
    };
    const result = injectCacheBreakpoints(body);
    const content = result.messages[0].content;
    expect(content[0].cache_control).toBeUndefined();
    expect(content[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('injects rolling tail on last block of last message (slot 4, default 5m TTL)', () => {
    const body = {
      messages: [
        makeMsg('user', 'first-message'),
        makeMsg('assistant', 'response'),
        makeMsg('user', 'second-user', 'last-block'),
      ],
    };
    const result = injectCacheBreakpoints(body);
    const lastContent = result.messages[2].content;
    expect(lastContent[lastContent.length - 1].cache_control)
      .toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('rolling tail uses configurable tailTtl', () => {
    const body = {
      messages: [
        makeMsg('user', 'first'),
        makeMsg('user', 'tail'),
      ],
    };
    const result = injectCacheBreakpoints(body, '1h');
    const lastContent = result.messages[1].content;
    expect(lastContent[lastContent.length - 1].cache_control)
      .toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('does NOT inject rolling tail when there is only one message (avoids double-counting slot 3)', () => {
    const body = {
      messages: [makeMsg('user', 'only-message')],
    };
    const result = injectCacheBreakpoints(body);
    // Only slot 3 should be filled — no slot 4
    const slots = countBreakpoints(result);
    expect(slots).toBe(1);
  });

  it('injects at most MAX_CACHE_BREAKPOINTS slots total', () => {
    const body = {
      messages: [
        makeMsg('user', 'u1'),
        makeMsg('assistant', 'a1'),
        makeMsg('user', 'u2'),
      ],
      tools: [makeTool('T1')],
      system: [makeSystemBlock('sys')],
    };
    const result = injectCacheBreakpoints(body);
    expect(countBreakpoints(result)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
  });

  it('is idempotent (running twice yields same output as once)', () => {
    const body = {
      messages: [
        makeMsg('user', 'first'),
        makeMsg('user', 'last'),
      ],
      tools: [makeTool('T')],
      system: [makeSystemBlock('s')],
    };
    const once = injectCacheBreakpoints(body, '5m');
    const twice = injectCacheBreakpoints(once, '5m');
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('does not mutate the input body', () => {
    const body = {
      messages: [makeMsg('user', 'msg')],
      tools: [makeTool('T')],
    };
    const originalToolCC = body.tools[0].cache_control;
    injectCacheBreakpoints(body);
    expect(body.tools[0].cache_control).toBe(originalToolCC);
  });

  it('handles missing optional sections gracefully', () => {
    const body = { messages: [] };
    expect(() => injectCacheBreakpoints(body)).not.toThrow();
  });
});

// Helper: count total cache_control breakpoints in a body
function countBreakpoints(body) {
  let count = 0;
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) if (t.cache_control) count++;
  }
  if (Array.isArray(body.system)) {
    for (const b of body.system) if (b.cache_control) count++;
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) if (b && b.cache_control) count++;
      }
    }
  }
  return count;
}

// ── upgradeEphemeralTtl ───────────────────────────────────────────────────────

describe('upgradeEphemeralTtl', () => {
  function makeBlock(text, cc) {
    const b = { type: 'text', text };
    if (cc) b.cache_control = cc;
    return b;
  }

  it('upgrades ephemeral blocks without TTL to 1h in tools', () => {
    const body = {
      messages: [],
      tools: [
        { name: 'T', input_schema: {}, cache_control: { type: 'ephemeral' } },
      ],
    };
    const result = upgradeEphemeralTtl(body);
    expect(result.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('upgrades ephemeral blocks without TTL to 1h in system', () => {
    const body = {
      messages: [],
      system: [makeBlock('s', { type: 'ephemeral' })],
    };
    const result = upgradeEphemeralTtl(body);
    expect(result.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('keeps rolling tail at tailTtl (not upgraded to 1h)', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            makeBlock('static', { type: 'ephemeral' }),
            makeBlock('tail', { type: 'ephemeral' }), // this is the tail
          ],
        },
      ],
    };
    const result = upgradeEphemeralTtl(body, '5m');
    const content = result.messages[0].content;
    // Static block (not tail) → 1h
    expect(content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // Tail block → tailTtl
    expect(content[1].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('does not overwrite blocks that already have a TTL', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [makeBlock('b', { type: 'ephemeral', ttl: '1h' })],
        },
      ],
    };
    const result = upgradeEphemeralTtl(body, '5m');
    expect(result.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('is idempotent', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            makeBlock('a', { type: 'ephemeral' }),
            makeBlock('b', { type: 'ephemeral' }),
          ],
        },
      ],
    };
    const once = upgradeEphemeralTtl(body, '5m');
    const twice = upgradeEphemeralTtl(once, '5m');
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

// ── makeAnthropicTransform ────────────────────────────────────────────────────

describe('makeAnthropicTransform', () => {
  const SAMPLE_BODY = {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    tools: [
      { name: 'Bash', description: 'run shell', input_schema: {} },
      { name: 'NotebookEdit', description: 'edit nb', input_schema: {} },
    ],
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'First message.' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: '\x1B[32moutput\x1B[0m',
          },
        ],
      },
    ],
  };

  it('returns null when no options are enabled', () => {
    expect(makeAnthropicTransform()).toBeNull();
    expect(makeAnthropicTransform({ autoCache: false, dropTools: [], stripAnsiCodes: false })).toBeNull();
  });

  it('returns a function when at least one option is enabled', () => {
    expect(typeof makeAnthropicTransform({ autoCache: true })).toBe('function');
    expect(typeof makeAnthropicTransform({ stripAnsiCodes: true })).toBe('function');
    expect(typeof makeAnthropicTransform({ dropTools: ['Bash'] })).toBe('function');
  });

  it('transform function accepts a Buffer and returns a Buffer', () => {
    const transform = makeAnthropicTransform({ autoCache: true });
    const input = toBuffer(SAMPLE_BODY);
    const output = transform(input);
    expect(Buffer.isBuffer(output)).toBe(true);
  });

  it('transform function returns null for non-JSON input', () => {
    const transform = makeAnthropicTransform({ autoCache: true });
    const result = transform(Buffer.from('not json'));
    expect(result).toBeNull();
  });

  it('transform function returns null for bodies without a messages array', () => {
    const transform = makeAnthropicTransform({ autoCache: true });
    const result = transform(toBuffer({ model: 'claude', no_messages: true }));
    expect(result).toBeNull();
  });

  describe('autoCache', () => {
    it('injects cache breakpoints on tools, system, and messages', () => {
      const result = applyTransform(SAMPLE_BODY, { autoCache: true });
      expect(result.tools[result.tools.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      expect(result.system[result.system.length - 1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    });

    it('uses 5m TTL for the rolling tail by default', () => {
      const result = applyTransform(SAMPLE_BODY, { autoCache: true });
      const lastMsg = result.messages[result.messages.length - 1];
      const lastBlock = lastMsg.content[lastMsg.content.length - 1];
      expect(lastBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    });

    it('uses custom tailTtl when configured', () => {
      const result = applyTransform(SAMPLE_BODY, { autoCache: true, tailTtl: '1h' });
      const lastMsg = result.messages[result.messages.length - 1];
      const lastBlock = lastMsg.content[lastMsg.content.length - 1];
      expect(lastBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    });

    it('total breakpoints do not exceed MAX_CACHE_BREAKPOINTS', () => {
      const result = applyTransform(SAMPLE_BODY, { autoCache: true });
      expect(countBreakpoints(result)).toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
    });

    it('is idempotent end-to-end', () => {
      const once = applyTransform(SAMPLE_BODY, { autoCache: true });
      const twice = applyTransform(once, { autoCache: true });
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    });
  });

  describe('stripAnsiCodes', () => {
    it('strips ANSI from tool_result blocks', () => {
      const result = applyTransform(SAMPLE_BODY, { stripAnsiCodes: true });
      const trBlock = result.messages[1].content[0];
      expect(trBlock.content).toBe('output');
    });
  });

  describe('dropTools', () => {
    it('drops specified tools', () => {
      const result = applyTransform(SAMPLE_BODY, { dropTools: ['NotebookEdit'] });
      expect(result.tools.map(t => t.name)).toEqual(['Bash']);
    });
  });

  describe('composition', () => {
    it('applies all enabled transforms together', () => {
      const result = applyTransform(SAMPLE_BODY, {
        autoCache: true,
        stripAnsiCodes: true,
        dropTools: ['NotebookEdit'],
      });
      // Tool dropped
      expect(result.tools.every(t => t.name !== 'NotebookEdit')).toBe(true);
      // ANSI stripped from tool_result
      expect(result.messages[1].content[0].content).toBe('output');
      // Cache breakpoints injected
      expect(countBreakpoints(result)).toBeGreaterThan(0);
    });

    it('is idempotent when all transforms are enabled', () => {
      const opts = { autoCache: true, stripAnsiCodes: true, dropTools: ['NotebookEdit'] };
      const once = applyTransform(SAMPLE_BODY, opts);
      const twice = applyTransform(once, opts);
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    });
  });

  describe('customTransform', () => {
    it('custom transform function is called and its result used', () => {
      const custom = jest.fn(body => ({ ...body, custom_field: 'added' }));
      const result = applyTransform(SAMPLE_BODY, { customTransform: custom });
      expect(custom).toHaveBeenCalled();
      expect(result.custom_field).toBe('added');
    });

    it('custom transform errors are caught and body continues unchanged', () => {
      const custom = () => { throw new Error('oops'); };
      // Should not throw
      expect(() => applyTransform(SAMPLE_BODY, { customTransform: custom })).not.toThrow();
    });

    it('custom transform returning undefined keeps existing body', () => {
      const custom = jest.fn(() => undefined);
      // Should not throw and should return the body unchanged by customTransform
      expect(() => applyTransform(SAMPLE_BODY, { customTransform: custom })).not.toThrow();
    });
  });
});

// ── loadCustomTransform ───────────────────────────────────────────────────────

describe('loadCustomTransform', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-transforms-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns null for falsy path', () => {
    expect(loadCustomTransform(undefined)).toBeNull();
    expect(loadCustomTransform('')).toBeNull();
  });

  it('loads a module that exports a function directly', () => {
    const file = path.join(tmpDir, 'direct.js');
    fs.writeFileSync(file, 'module.exports = (b) => ({ ...b, injected: true });');
    const fn = loadCustomTransform(file);
    expect(typeof fn).toBe('function');
    expect(fn({ messages: [] })).toEqual({ messages: [], injected: true });
  });

  it('loads a module that exports { transform: fn }', () => {
    const file = path.join(tmpDir, 'named.js');
    fs.writeFileSync(file, 'module.exports.transform = (b) => ({ ...b, named: true });');
    const fn = loadCustomTransform(file);
    expect(typeof fn).toBe('function');
    expect(fn({ messages: [] })).toEqual({ messages: [], named: true });
  });

  it('returns null for a missing file', () => {
    expect(loadCustomTransform('/tmp/awf-nonexistent-transform-file.js')).toBeNull();
  });

  it('returns null when the module does not export a function', () => {
    const file = path.join(tmpDir, 'bad.js');
    fs.writeFileSync(file, 'module.exports = { notAFunction: 42 };');
    expect(loadCustomTransform(file)).toBeNull();
  });
});
