'use strict';

/**
 * ANSI escape-code stripping utilities.
 *
 * Generic utility — not Anthropic-specific — so it can be reused across
 * multiple provider adapters (e.g. OpenAI, Copilot).
 *
 * The only sequences stripped are ANSI SGR (Select Graphic Rendition) codes of
 * the form ESC [ <params> m (i.e. colour/formatting codes).  Other escape
 * sequences (cursor movement, terminal modes, etc.) are left intact.
 */

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

module.exports = { stripAnsi, applyAnsiStrip };
