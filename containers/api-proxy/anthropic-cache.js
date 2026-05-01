/**
 * Anthropic prompt-cache optimizations for the AWF API proxy.
 *
 * Implements the same strategy as https://github.com/alxsuv/pino:
 *   1. Auto-inject cache breakpoints (tools, system, messages[0], rolling tail)
 *   2. Upgrade TTL to 1h on stable breakpoints (tools / system / messages[0])
 *      leaving the rolling tail at a configurable shorter TTL (default 5m)
 *   3. Strip existing ephemeral breakpoints on tiny system blocks (<500 chars)
 *      that waste one of the 4 available breakpoint slots
 *   4. Add the `anthropic-beta: extended-cache-ttl-2025-04-11` header so the
 *      1h TTL feature is honoured by the API
 *   5. Strip ANSI SGR escape sequences from message text and tool results so
 *      terminal output caches cleanly
 *
 * All mutations are applied in-place on the parsed body object / headers map.
 * The caller is responsible for JSON serialisation and content-length update.
 *
 * Enabled by setting AWF_ANTHROPIC_AUTO_CACHE=1 in the proxy environment.
 */

'use strict';

// The beta flag that enables extended (1h) cache TTL on the Anthropic API.
const BETA_FLAG = 'extended-cache-ttl-2025-04-11';

// System blocks shorter than this (in chars) are not worth caching — they save
// ~125 tokens at the cost of burning a full breakpoint slot.
const MIN_SYSTEM_CACHE_CHARS = 500;

// Anthropic allows at most 4 cache breakpoints per request.
const BREAKPOINT_CEILING = 4;

// ANSI SGR escape sequence pattern (covers colours, bold, reset, etc.)
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Returns true if the array contains at least one ephemeral cache_control entry.
 * @param {Array|undefined} arr
 * @returns {boolean}
 */
function hasBreakpoint(arr) {
  return Array.isArray(arr) && arr.some(
    (x) => x && typeof x === 'object' && x.cache_control && x.cache_control.type === 'ephemeral',
  );
}

/**
 * Count all ephemeral cache breakpoints in the body (deep walk).
 * @param {object} body
 * @returns {number}
 */
function countCacheBreakpoints(body) {
  let n = 0;
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.cache_control && x.cache_control.type === 'ephemeral') n++;
    for (const k of Object.keys(x)) walk(x[k]);
  };
  walk(body);
  return n;
}

/**
 * Remove ephemeral breakpoints from system blocks that are smaller than
 * MIN_SYSTEM_CACHE_CHARS characters — they waste a slot to cache ~125 tokens.
 *
 * @param {object} body
 * @returns {number} Number of breakpoints stripped
 */
function stripSmallSystemBreakpoints(body) {
  if (!Array.isArray(body.system)) return 0;
  let stripped = 0;
  for (const block of body.system) {
    if (!block || typeof block !== 'object') continue;
    if (!block.cache_control || block.cache_control.type !== 'ephemeral') continue;
    const len = typeof block.text === 'string' ? block.text.length : 0;
    if (len < MIN_SYSTEM_CACHE_CHARS) {
      delete block.cache_control;
      stripped++;
    }
  }
  return stripped;
}

/**
 * Find the last cacheable content block in a single message.
 * Cacheable types: text, tool_result, image.
 *
 * If the message content is a plain string it is first normalised to a
 * [{type:"text", text:…}] array so a breakpoint can be attached.
 *
 * @param {object} m
 * @returns {object|null}
 */
function findLastCacheableBlockInMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const c = m.content;
  if (Array.isArray(c)) {
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (b && typeof b === 'object' &&
          (b.type === 'text' || b.type === 'tool_result' || b.type === 'image')) {
        return b;
      }
    }
  } else if (typeof c === 'string' && c.length > 0) {
    m.content = [{ type: 'text', text: c }];
    return m.content[0];
  }
  return null;
}

/**
 * Find the last cacheable content block across all messages.
 * @param {object} body
 * @returns {object|null}
 */
function findLastCacheableMessageBlock(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const b = findLastCacheableBlockInMessage(body.messages[i]);
    if (b) return b;
  }
  return null;
}

// ── Exported functions ─────────────────────────────────────────────────────

/**
 * Collect all ephemeral breakpoints from the final message into a Set and set
 * their TTL to `tailTtl`.  These are excluded from the blanket 1h rewrite pass
 * because the tail moves every turn — overpaying the 2.0× write multiplier on
 * a breakpoint that moves constantly is wasteful.
 *
 * @param {object} body
 * @param {string} tailTtl - '5m' or '1h'
 * @returns {Set<object>} The tail breakpoint nodes
 */
function normalizeTailBreakpoints(body, tailTtl) {
  const out = new Set();
  if (!Array.isArray(body.messages) || body.messages.length === 0) return out;
  const last = body.messages[body.messages.length - 1];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.cache_control && n.cache_control.type === 'ephemeral') {
      n.cache_control.ttl = tailTtl;
      out.add(n);
    }
    if (Array.isArray(n)) n.forEach(walk);
    else {
      for (const k of Object.keys(n)) {
        if (k !== 'cache_control') walk(n[k]);
      }
    }
  };
  walk(last);
  return out;
}

/**
 * Rewrite all ephemeral cache breakpoints to `ttl: "1h"`, skipping nodes in
 * the `skip` set (tail breakpoints that should keep their shorter TTL).
 *
 * @param {object} node - Any JSON node (array, object, or primitive)
 * @param {{ rewritten: number, alreadySet: number, skipped: number }} counter
 * @param {Set<object>} skip - Nodes to skip
 */
function rewriteCacheControl(node, counter, skip) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) rewriteCacheControl(item, counter, skip);
    return;
  }
  if (node.cache_control && node.cache_control.type === 'ephemeral') {
    if (skip && skip.has(node)) {
      counter.skipped++;
    } else {
      if (node.cache_control.ttl !== '1h') {
        node.cache_control.ttl = '1h';
        counter.rewritten++;
      } else {
        counter.alreadySet++;
      }
    }
  }
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (v && typeof v === 'object') rewriteCacheControl(v, counter, skip);
  }
}

/**
 * Inject prompt-cache breakpoints into `body` where they are absent, and
 * rewrite existing ephemeral breakpoints to `ttl: "1h"` (except the tail).
 *
 * Placement order (up to 4 breakpoint ceiling):
 *   1. Last tools entry          → 1h TTL
 *   2. Last system block         → 1h TTL
 *   3. Last cacheable block in messages[0] → 1h TTL
 *   4. Rolling tail (last message) → tailTtl (default 5m)
 *
 * @param {object} body - Parsed /v1/messages request body (mutated in-place)
 * @param {{ tailTtl?: string }} [opts]
 * @returns {{ tag: string, tailBlocks: Set<object> }}
 *   `tag` summarises what was injected (for logging).
 *   `tailBlocks` is the set of tail breakpoint nodes (passed to rewriteCacheControl skip list).
 */
function injectBreakpointIfAbsent(body, opts = {}) {
  const { tailTtl = '5m' } = opts;
  const tags = [];

  // Step 0: strip wasteful tiny system breakpoints
  const stripped = stripSmallSystemBreakpoints(body);
  if (stripped > 0) tags.push(`strip-sys:${stripped}`);

  // Step 1: tools
  if (Array.isArray(body.tools) && body.tools.length > 0 && !hasBreakpoint(body.tools)) {
    const last = body.tools[body.tools.length - 1];
    if (last && typeof last === 'object') {
      last.cache_control = { type: 'ephemeral', ttl: '1h' };
      tags.push('tools');
    }
  }

  // Step 2: system
  if (Array.isArray(body.system) && body.system.length > 0 && !hasBreakpoint(body.system)) {
    const last = body.system[body.system.length - 1];
    if (last && typeof last === 'object') {
      last.cache_control = { type: 'ephemeral', ttl: '1h' };
      tags.push('system');
    }
  } else if (typeof body.system === 'string' && body.system.length > 0) {
    body.system = [{ type: 'text', text: body.system, cache_control: { type: 'ephemeral', ttl: '1h' } }];
    tags.push('system-string');
  }

  // Step 3: messages[0] static reminders (CLAUDE.md, skills catalog, deferred tools)
  // Only place when there is a distinct tail message to follow; otherwise the
  // tail step below covers it.
  if (
    Array.isArray(body.messages) &&
    body.messages.length > 1 &&
    countCacheBreakpoints(body) < BREAKPOINT_CEILING
  ) {
    const first = findLastCacheableBlockInMessage(body.messages[0]);
    if (first && !first.cache_control) {
      first.cache_control = { type: 'ephemeral', ttl: '1h' };
      tags.push('msg0');
    }
  }

  // Step 4: rolling tail — mark tail blocks first so the 1h rewrite skips them
  const tailBlocks = new Set();
  if (countCacheBreakpoints(body) < BREAKPOINT_CEILING) {
    const tail = findLastCacheableMessageBlock(body);
    if (tail && !tail.cache_control) {
      tail.cache_control = { type: 'ephemeral', ttl: tailTtl };
      tailBlocks.add(tail);
      tags.push(`tail:${tailTtl}`);
    }
  }

  return { tag: tags.length ? tags.join('+') : 'none', tailBlocks };
}

/**
 * Ensure the `anthropic-beta` header includes the extended-cache-ttl flag.
 *
 * @param {Record<string,string>} headers - Request headers map (mutated in-place)
 * @returns {'added'|'appended'|'present'}
 */
function ensureBetaHeader(headers) {
  const keys = Object.keys(headers);
  const betaKey = keys.find((k) => k.toLowerCase() === 'anthropic-beta');
  if (!betaKey) {
    headers['anthropic-beta'] = BETA_FLAG;
    return 'added';
  }
  const existing = String(headers[betaKey]);
  if (existing.split(',').map((s) => s.trim()).includes(BETA_FLAG)) {
    return 'present';
  }
  headers[betaKey] = `${existing},${BETA_FLAG}`;
  return 'appended';
}

/**
 * Strip ANSI SGR escape sequences from all text content in messages.
 * Terminal colour output in tool results would otherwise prevent cache hits
 * because identical tool results with different ANSI codes hash differently.
 *
 * @param {object} body - Parsed /v1/messages request body (mutated in-place)
 * @returns {number} Number of strings cleaned
 */
function stripAnsiFromMessages(body) {
  if (!Array.isArray(body.messages)) return 0;
  let count = 0;

  function clean(s) {
    if (typeof s !== 'string') return s;
    const cleaned = s.replace(ANSI_RE, '');
    if (cleaned !== s) count++;
    return cleaned;
  }

  for (const m of body.messages) {
    const c = m && m.content;
    if (typeof c === 'string') {
      m.content = clean(c);
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      if (typeof b.text === 'string') b.text = clean(b.text);
      if (typeof b.content === 'string') b.content = clean(b.content);
      if (Array.isArray(b.content)) {
        for (const rc of b.content) {
          if (rc && typeof rc === 'object' && typeof rc.text === 'string') {
            rc.text = clean(rc.text);
          }
        }
      }
    }
  }
  return count;
}

/**
 * Apply all Anthropic prompt-cache optimizations to a parsed /v1/messages body
 * and its request headers.
 *
 * Mutations applied (all in-place):
 *   - Cache breakpoints injected on tools / system / messages[0] / tail
 *   - Existing ephemeral breakpoints upgraded from 5m default to 1h
 *     (tail breakpoints kept at tailTtl)
 *   - `anthropic-beta` header ensured to contain the extended-cache-ttl flag
 *   - ANSI escape sequences stripped from message text / tool results
 *
 * @param {object} body - Parsed /v1/messages request body (mutated in-place)
 * @param {Record<string,string>} headers - Outgoing request headers (mutated in-place)
 * @param {{ tailTtl?: string }} [opts]
 * @returns {{
 *   injected: string,       // tags from injectBreakpointIfAbsent (e.g. "tools+system+tail:5m")
 *   rewritten: number,      // breakpoints upgraded from implicit-5m to 1h
 *   betaHeader: string,     // 'added' | 'appended' | 'present'
 *   ansiCleaned: number,    // strings stripped of ANSI codes
 * }}
 */
function applyAnthropicCacheOptimizations(body, headers, opts = {}) {
  const { tailTtl = '5m' } = opts;

  // 1. Normalise tail breakpoints (so they keep their short TTL)
  const tailBlocks = normalizeTailBreakpoints(body, tailTtl);

  // 2. Inject missing breakpoints
  const { tag: injected, tailBlocks: newTailBlocks } = injectBreakpointIfAbsent(body, { tailTtl });

  // Combine tail sets: pre-existing tails + newly injected tail
  const allTailBlocks = new Set([...tailBlocks, ...newTailBlocks]);

  // 3. Upgrade all remaining ephemeral breakpoints to 1h (skip tail blocks)
  const counter = { rewritten: 0, alreadySet: 0, skipped: 0 };
  rewriteCacheControl(body, counter, allTailBlocks);

  // 4. Ensure the beta header is present
  const betaHeader = ensureBetaHeader(headers);

  // 5. Strip ANSI from message content
  const ansiCleaned = stripAnsiFromMessages(body);

  return {
    injected,
    rewritten: counter.rewritten,
    betaHeader,
    ansiCleaned,
  };
}

module.exports = {
  // Individual helpers (exported for testing)
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
  // Main entry point
  applyAnthropicCacheOptimizations,
};
