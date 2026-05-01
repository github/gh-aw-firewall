'use strict';

/**
 * Anthropic-specific body transforms for the AWF API proxy.
 *
 * Implements cost and caching optimisations inspired by alxsuv/pino.
 * All features are opt-in via environment variables read by server.js.
 *
 * 1. Auto-inject prompt-cache breakpoints  (AWF_ANTHROPIC_AUTO_CACHE=1)
 * 2. Upgrade ephemeral TTL 5m → 1h         (implied by AWF_ANTHROPIC_AUTO_CACHE)
 *    - tail TTL configurable via             AWF_ANTHROPIC_CACHE_TAIL_TTL ('5m'|'1h')
 * 3. Drop unused tools                      (AWF_ANTHROPIC_DROP_TOOLS=Tool1,Tool2)
 * 4. Strip ANSI escape codes                (AWF_ANTHROPIC_STRIP_ANSI=1)
 * 5. Custom body-transform hook             (AWF_ANTHROPIC_TRANSFORM_FILE=/path/to/file.js)
 *
 * All transforms are pure functions (no I/O, no side-effects) and are
 * idempotent: applying them twice yields the same result as applying once.
 */

const path = require('path');

/** Maximum number of cache breakpoints Anthropic allows per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * The Anthropic beta-feature header value required to use 1-hour TTL caching.
 * Must be added to the `anthropic-beta` request header when AWF_ANTHROPIC_AUTO_CACHE=1.
 */
const EXTENDED_CACHE_BETA = 'extended-cache-ttl-2025-04-11';

// ── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Strip ANSI SGR (Select Graphic Rendition) escape sequences from a string.
 * These are the colour/formatting codes of the form ESC [ <params> m.
 *
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  // ESC [ followed by any mix of digits and semicolons, ending with 'm'
  return text.replace(/\x1B\[[\d;]*m/g, '');
}

/**
 * Return a new content block with `cache_control` set.
 * Any existing cache_control on the block is replaced.
 *
 * @param {object} block - Anthropic content block
 * @param {{ type: string, ttl: string }} cacheControl
 * @returns {object}
 */
function withCacheControl(block, cacheControl) {
  return { ...block, cache_control: cacheControl };
}

// ── Feature 4: Strip ANSI from tool_result blocks ────────────────────────────

/**
 * Walk every `tool_result` content block in a /v1/messages body and strip
 * ANSI SGR escape sequences from text content.
 *
 * Roughly halves token counts in colour-heavy terminal outputs and enables
 * cache hits across turns that differ only in escape codes.
 *
 * @param {object} body - Parsed /v1/messages request body
 * @returns {object} New body object with ANSI stripped from tool_result blocks
 */
function applyAnsiStrip(body) {
  if (!Array.isArray(body.messages)) return body;

  const messages = body.messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;

    const content = msg.content.map(block => {
      if (block.type !== 'tool_result') return block;

      // tool_result.content may be a plain string …
      if (typeof block.content === 'string') {
        return { ...block, content: stripAnsi(block.content) };
      }

      // … or an array of typed sub-blocks
      if (Array.isArray(block.content)) {
        const inner = block.content.map(b => {
          if (b.type === 'text' && typeof b.text === 'string') {
            return { ...b, text: stripAnsi(b.text) };
          }
          return b;
        });
        return { ...block, content: inner };
      }

      return block;
    });

    return { ...msg, content };
  });

  return { ...body, messages };
}

// ── Feature 3: Drop unused tools ─────────────────────────────────────────────

/**
 * Remove named tools from the `tools` array and scrub their names from
 * `system` prompt text blocks.
 *
 * Independent of caching: with caching in place, dropping tools also shrinks
 * each cache-write slot.
 *
 * @param {object} body - Parsed /v1/messages request body
 * @param {string[]} toolNames - Tool names to drop (exact string match)
 * @returns {object} New body object with the specified tools removed
 */
function applyToolDrop(body, toolNames) {
  if (!toolNames || toolNames.length === 0) return body;

  const dropSet = new Set(toolNames);
  let result = { ...body };

  // Remove matching entries from the tools array
  if (Array.isArray(result.tools)) {
    const filtered = result.tools.filter(tool => !dropSet.has(tool.name));
    if (filtered.length < result.tools.length) {
      if (filtered.length === 0) {
        result = { ...result };
        delete result.tools;
      } else {
        result.tools = filtered;
      }
    }
  }

  // Scrub tool-name references from system-prompt text blocks.
  // We remove bare occurrences; surrounding punctuation/whitespace is left intact
  // to avoid corrupting sentence structure.
  if (Array.isArray(result.system)) {
    const escapedNames = [...dropSet].map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(?<![\\w])(?:${escapedNames.join('|')})(?![\\w])`, 'g');
    result.system = result.system.map(block => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block;
      const scrubbed = block.text.replace(pattern, '');
      return scrubbed === block.text ? block : { ...block, text: scrubbed };
    });
  }

  return result;
}

// ── Feature 1: Inject cache breakpoints ──────────────────────────────────────

/**
 * Inject up to {@link MAX_CACHE_BREAKPOINTS} prompt-cache breakpoints into a
 * /v1/messages request body.
 *
 * Slot allocation (high-value → low-value, in priority order):
 *
 *   Slot 1 — last entry in `tools`             → 1h TTL  (~24 k tokens / turn)
 *   Slot 2 — last block in `system`            → 1h TTL  (~8 k tokens / turn)
 *   Slot 3 — last block of `messages[0]`       → 1h TTL  (~5 k tokens / turn)
 *   Slot 4 — last block of last message        → tailTtl (~15 k tokens / turn)
 *             (rolling tail; skipped when same position as slot 3)
 *
 * Running this function twice on the same body produces the same result as
 * running it once (idempotent).
 *
 * @param {object} body     - Parsed /v1/messages request body
 * @param {string} tailTtl  - TTL for the rolling-tail slot ('5m' | '1h')
 * @returns {object} New body with cache_control injected at the chosen slots
 */
function injectCacheBreakpoints(body, tailTtl = '5m') {
  let result = { ...body };
  let slotsUsed = 0;

  // Slot 1: last tools entry
  if (slotsUsed < MAX_CACHE_BREAKPOINTS &&
      Array.isArray(result.tools) && result.tools.length > 0) {
    const tools = [...result.tools];
    tools[tools.length - 1] = withCacheControl(tools[tools.length - 1], { type: 'ephemeral', ttl: '1h' });
    result.tools = tools;
    slotsUsed++;
  }

  // Slot 2: last system block
  if (slotsUsed < MAX_CACHE_BREAKPOINTS &&
      Array.isArray(result.system) && result.system.length > 0) {
    const system = [...result.system];
    system[system.length - 1] = withCacheControl(system[system.length - 1], { type: 'ephemeral', ttl: '1h' });
    result.system = system;
    slotsUsed++;
  }

  // Slot 3: last block of messages[0]
  const msgs = result.messages;
  if (slotsUsed < MAX_CACHE_BREAKPOINTS &&
      Array.isArray(msgs) && msgs.length > 0 &&
      Array.isArray(msgs[0].content) && msgs[0].content.length > 0) {
    const content = [...msgs[0].content];
    content[content.length - 1] = withCacheControl(content[content.length - 1], { type: 'ephemeral', ttl: '1h' });
    const messages = [...msgs];
    messages[0] = { ...msgs[0], content };
    result.messages = messages;
    slotsUsed++;
  }

  // Slot 4: last block of the last message (rolling tail)
  // Only used when the last message is different from messages[0] (i.e. ≥2 messages).
  if (slotsUsed < MAX_CACHE_BREAKPOINTS &&
      Array.isArray(result.messages) && result.messages.length > 1) {
    const messages = result.messages;
    const lastMsg = messages[messages.length - 1];
    if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      const content = [...lastMsg.content];
      content[content.length - 1] = withCacheControl(
        content[content.length - 1],
        { type: 'ephemeral', ttl: tailTtl }
      );
      const newMessages = [...messages];
      newMessages[newMessages.length - 1] = { ...lastMsg, content };
      result.messages = newMessages;
      slotsUsed++;
    }
  }

  return result;
}

// ── Feature 2: Upgrade existing ephemeral TTLs ────────────────────────────────

/**
 * Upgrade any existing `{type: "ephemeral"}` cache breakpoints that lack a
 * `ttl` field to use a 1-hour TTL — except for the rolling tail.
 *
 * The "rolling tail" is defined as the last cache_control block found in the
 * `messages` array (scanning backwards).  Because this breakpoint moves every
 * turn it is kept at `tailTtl` to avoid paying the 2× cache-write surcharge
 * on a breakpoint that never stabilises.
 *
 * Blocks that already have a `ttl` set are left unchanged.
 *
 * @param {object} body    - Parsed /v1/messages request body
 * @param {string} tailTtl - TTL for the rolling tail ('5m' | '1h')
 * @returns {object} New body with upgraded ephemeral TTLs
 */
function upgradeEphemeralTtl(body, tailTtl = '5m') {
  // Locate the rolling-tail position: last ephemeral cache_control in messages[]
  let tailMsgIdx = -1;
  let tailBlockIdx = -1;
  if (Array.isArray(body.messages)) {
    outer: for (let i = body.messages.length - 1; i >= 0; i--) {
      const msg = body.messages[i];
      if (!Array.isArray(msg.content)) continue;
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const b = msg.content[j];
        if (b && b.cache_control && b.cache_control.type === 'ephemeral') {
          tailMsgIdx = i;
          tailBlockIdx = j;
          break outer;
        }
      }
    }
  }

  let result = { ...body };

  // Upgrade tools — these are always static, so always use 1h
  if (Array.isArray(result.tools)) {
    const tools = result.tools.map(tool => {
      if (!tool.cache_control ||
          tool.cache_control.type !== 'ephemeral' ||
          tool.cache_control.ttl) return tool;
      return withCacheControl(tool, { type: 'ephemeral', ttl: '1h' });
    });
    result.tools = tools;
  }

  // Upgrade system blocks — also static, always use 1h
  if (Array.isArray(result.system)) {
    const system = result.system.map(block => {
      if (!block.cache_control ||
          block.cache_control.type !== 'ephemeral' ||
          block.cache_control.ttl) return block;
      return withCacheControl(block, { type: 'ephemeral', ttl: '1h' });
    });
    result.system = system;
  }

  // Upgrade messages — tail keeps tailTtl; everything else gets 1h
  if (Array.isArray(result.messages)) {
    const messages = result.messages.map((msg, mi) => {
      if (!Array.isArray(msg.content)) return msg;
      const content = msg.content.map((block, bi) => {
        if (!block ||
            !block.cache_control ||
            block.cache_control.type !== 'ephemeral' ||
            block.cache_control.ttl) return block;
        const isTail = (mi === tailMsgIdx && bi === tailBlockIdx);
        return withCacheControl(block, { type: 'ephemeral', ttl: isTail ? tailTtl : '1h' });
      });
      return { ...msg, content };
    });
    result.messages = messages;
  }

  return result;
}

// ── Feature 5: Custom transform hook ─────────────────────────────────────────

/**
 * Load a custom JS transform from a file path.
 *
 * The module must export either:
 *   - A function directly:         `module.exports = (body) => body`
 *   - A named `transform` export:  `module.exports.transform = (body) => body`
 *
 * The function receives a parsed body object and must return the (possibly
 * modified) body object.  Returning `undefined` or throwing will cause the
 * transform to be skipped for that request.
 *
 * @param {string|undefined} filePath - Absolute or relative path to the JS file
 * @returns {((body: object) => object) | null} Transform function or null on failure
 */
function loadCustomTransform(filePath) {
  if (!filePath) return null;
  try {
    const absolutePath = path.resolve(filePath);
    const mod = require(absolutePath);
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod.transform === 'function') return mod.transform;
    // eslint-disable-next-line no-console
    console.error(
      `[anthropic-transforms] AWF_ANTHROPIC_TRANSFORM_FILE "${filePath}" must export ` +
      'a function or { transform: function } — custom transform disabled'
    );
    return null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[anthropic-transforms] Failed to load AWF_ANTHROPIC_TRANSFORM_FILE "${filePath}": ` +
      `${err.message} — custom transform disabled`
    );
    return null;
  }
}

// ── Composer ─────────────────────────────────────────────────────────────────

/**
 * Build the composed Anthropic body-transform function.
 *
 * Transforms are applied in this order (when enabled):
 *   1. Strip ANSI from tool_result blocks
 *   2. Drop named tools
 *   3. Upgrade existing ephemeral TTLs
 *   4. Inject cache breakpoints at up to 4 standard slots
 *   5. Apply custom transform file
 *
 * Returns `null` when no transforms are enabled (fast path: no-op).
 * The returned function accepts a raw Buffer, parses it as JSON, applies the
 * configured transforms, and re-serialises the result.  It returns `null` when
 * the body is unchanged (callers must preserve the original buffer in that case).
 *
 * @param {{
 *   autoCache?:       boolean,
 *   tailTtl?:         string,
 *   dropTools?:       string[],
 *   stripAnsiCodes?:  boolean,
 *   customTransform?: ((body: object) => object) | null,
 * }} options
 * @returns {((body: Buffer) => Buffer | null) | null}
 */
function makeAnthropicTransform(options = {}) {
  const {
    autoCache = false,
    tailTtl = '5m',
    dropTools = [],
    stripAnsiCodes = false,
    customTransform = null,
  } = options;

  const hasDropTools = Array.isArray(dropTools) && dropTools.length > 0;

  if (!autoCache && !hasDropTools && !stripAnsiCodes && !customTransform) {
    return null; // Nothing to do
  }

  return (bodyBuffer) => {
    let parsed;
    try {
      parsed = JSON.parse(bodyBuffer.toString('utf8'));
    } catch {
      return null; // Not valid JSON — pass through unchanged
    }

    // Only apply Anthropic-specific transforms to /v1/messages requests.
    // The `messages` array is the canonical discriminator for that endpoint.
    if (!parsed || !Array.isArray(parsed.messages)) {
      return null;
    }

    let body = parsed;

    if (stripAnsiCodes) {
      body = applyAnsiStrip(body);
    }

    if (hasDropTools) {
      body = applyToolDrop(body, dropTools);
    }

    if (autoCache) {
      // Step 1: upgrade any existing ephemeral breakpoints that lack a TTL
      body = upgradeEphemeralTtl(body, tailTtl);
      // Step 2: inject/overwrite the four standard cache-breakpoint slots
      body = injectCacheBreakpoints(body, tailTtl);
    }

    if (customTransform) {
      try {
        const result = customTransform(body);
        if (result !== undefined) body = result;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[anthropic-transforms] Custom transform threw: ${err.message}`);
        // Continue with body as modified by the built-in transforms
      }
    }

    const newBuffer = Buffer.from(JSON.stringify(body), 'utf8');
    // Return null (no-op signal) when the serialised form is unchanged
    if (newBuffer.equals(bodyBuffer)) return null;
    return newBuffer;
  };
}

module.exports = {
  // Low-level helpers (exported for testing)
  stripAnsi,
  applyAnsiStrip,
  applyToolDrop,
  injectCacheBreakpoints,
  upgradeEphemeralTtl,
  loadCustomTransform,
  // Main entry point
  makeAnthropicTransform,
  // Constants
  EXTENDED_CACHE_BETA,
  MAX_CACHE_BREAKPOINTS,
};
