'use strict';

/**
 * Tool-dropping utilities for the AWF Anthropic adapter.
 *
 * Removes named tools from the `tools` array and scrubs their names from
 * `system` prompt text blocks.  Independent of caching: with caching in
 * place, dropping tools also shrinks each cache-write slot.
 */

/**
 * Build a regex that matches any of the given tool names as whole words
 * (not as substrings of longer identifiers).
 *
 * Note: JavaScript's `g`-flag RegExp objects track `lastIndex` but
 * `String.prototype.replace` resets it to 0 before each use, so the
 * same compiled pattern is safe to reuse across multiple calls.
 *
 * @param {string[]} toolNames
 * @returns {RegExp}
 */
function buildToolScrubPattern(toolNames) {
  const escaped = toolNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\w])(?:${escaped.join('|')})(?![\\w])`, 'g');
}

/**
 * Remove named tools from the `tools` array and scrub their names from
 * `system` prompt text blocks.
 *
 * @param {object} body - Parsed /v1/messages request body
 * @param {string[]} toolNames - Tool names to drop (exact string match)
 * @param {RegExp} [scrubPattern] - Pre-compiled regex for system-prompt scrubbing.
 *   When omitted the pattern is derived from toolNames on each call.
 *   Pass a pre-compiled pattern (from makeAnthropicTransform) to avoid per-request
 *   regex compilation overhead.
 * @returns {object} New body object with the specified tools removed
 */
function applyToolDrop(body, toolNames, scrubPattern = null) {
  if (!toolNames || toolNames.length === 0) return body;

  const dropSet = new Set(toolNames);
  let result = { ...body };

  // Remove matching entries from the tools array
  if (Array.isArray(result.tools)) {
    const filtered = result.tools.filter(tool => {
      if (!tool || typeof tool !== 'object') return true;
      return !dropSet.has(tool.name);
    });
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
    const pattern = scrubPattern || buildToolScrubPattern([...dropSet]);
    result.system = result.system.map(block => {
      if (!block || typeof block !== 'object') return block;
      if (block.type !== 'text' || typeof block.text !== 'string') return block;
      const scrubbed = block.text.replace(pattern, '');
      return scrubbed === block.text ? block : { ...block, text: scrubbed };
    });
  }

  return result;
}

module.exports = { buildToolScrubPattern, applyToolDrop };
