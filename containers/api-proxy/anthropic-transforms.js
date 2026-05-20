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
 *
 * Implementation is split across focused sub-modules:
 *   - transforms/ansi-strip.js    — ANSI escape-code stripping
 *   - transforms/cache-control.js — cache breakpoint injection and TTL upgrading
 *   - transforms/tool-drop.js     — tool removal and system-prompt scrubbing
 */

const path = require('path');

const { stripAnsi, applyAnsiStrip } = require('./transforms/ansi-strip');
const {
  withCacheControl,
  injectCacheBreakpoints,
  upgradeEphemeralTtl,
  MAX_CACHE_BREAKPOINTS,
  EXTENDED_CACHE_BETA,
} = require('./transforms/cache-control');
const { buildToolScrubPattern, applyToolDrop } = require('./transforms/tool-drop');

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

  // Pre-compile the tool-drop scrub pattern once so it is not rebuilt on every request.
  const toolScrubPattern = hasDropTools ? buildToolScrubPattern(dropTools) : null;

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
      body = applyToolDrop(body, dropTools, toolScrubPattern);
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
  buildToolScrubPattern,
  injectCacheBreakpoints,
  upgradeEphemeralTtl,
  loadCustomTransform,
  // Main entry point
  makeAnthropicTransform,
  // Constants
  EXTENDED_CACHE_BETA,
  MAX_CACHE_BREAKPOINTS,
};
