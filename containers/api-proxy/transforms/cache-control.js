'use strict';

/**
 * Anthropic prompt-cache control utilities.
 *
 * Implements the two caching transforms used by the AWF Anthropic adapter:
 *
 *   1. `injectCacheBreakpoints` — inject up to four standard cache-breakpoint
 *      slots into a /v1/messages request body.
 *   2. `upgradeEphemeralTtl` — upgrade any pre-existing ephemeral breakpoints
 *      (without a TTL) to 1-hour TTL, except for the rolling-tail slot.
 */

/** Maximum number of cache breakpoints Anthropic allows per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * The Anthropic beta-feature header value required to use 1-hour TTL caching.
 * Must be added to the `anthropic-beta` request header when AWF_ANTHROPIC_AUTO_CACHE=1.
 */
const EXTENDED_CACHE_BETA = 'extended-cache-ttl-2025-04-11';

/**
 * Return a new content block with `cache_control` set.
 * Any existing cache_control on the block is replaced.
 *
 * @param {object} block - Anthropic content block
 * @param {{ type: string, ttl: string }} cacheControl
 * @returns {object}
 */
function withCacheControl(block, cacheControl) {
  if (!block || typeof block !== 'object') return block;
  return { ...block, cache_control: cacheControl };
}

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
    const lastTool = tools[tools.length - 1];
    if (lastTool && typeof lastTool === 'object') {
      tools[tools.length - 1] = withCacheControl(lastTool, { type: 'ephemeral', ttl: '1h' });
      result.tools = tools;
      slotsUsed++;
    }
  }

  // Slot 2: last system block
  if (slotsUsed < MAX_CACHE_BREAKPOINTS &&
      Array.isArray(result.system) && result.system.length > 0) {
    const system = [...result.system];
    const lastSystemBlock = system[system.length - 1];
    if (lastSystemBlock && typeof lastSystemBlock === 'object') {
      system[system.length - 1] = withCacheControl(lastSystemBlock, { type: 'ephemeral', ttl: '1h' });
      result.system = system;
      slotsUsed++;
    }
  }

  // Slot 3: last block of messages[0]
  const msgs = result.messages;
  const firstMsg = Array.isArray(msgs) && msgs.length > 0 ? msgs[0] : null;
  if (slotsUsed < MAX_CACHE_BREAKPOINTS &&
      Array.isArray(msgs) && msgs.length > 0 &&
      firstMsg && typeof firstMsg === 'object' &&
      Array.isArray(firstMsg.content) && firstMsg.content.length > 0) {
    const content = [...firstMsg.content];
    content[content.length - 1] = withCacheControl(content[content.length - 1], { type: 'ephemeral', ttl: '1h' });
    const messages = [...msgs];
    messages[0] = { ...firstMsg, content };
    result.messages = messages;
    slotsUsed++;
  }

  // Slot 4: last block of the last message (rolling tail)
  // Only used when the last message is different from messages[0] (i.e. ≥2 messages).
  if (slotsUsed < MAX_CACHE_BREAKPOINTS &&
      Array.isArray(result.messages) && result.messages.length > 1) {
    const messages = result.messages;
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && typeof lastMsg === 'object' &&
        Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
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
      if (!msg || typeof msg !== 'object') continue;
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
      if (!tool || typeof tool !== 'object') return tool;
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
      if (!block || typeof block !== 'object') return block;
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
      if (!msg || typeof msg !== 'object') return msg;
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

module.exports = {
  withCacheControl,
  injectCacheBreakpoints,
  upgradeEphemeralTtl,
  MAX_CACHE_BREAKPOINTS,
  EXTENDED_CACHE_BETA,
};
