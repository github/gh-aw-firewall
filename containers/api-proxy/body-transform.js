'use strict';

const { parseBodyAsObject } = require('./body-utils');

/**
 * Sanitize OpenAI-compatible request history where tool_calls[].type is null.
 *
 * Normalizes null type to "function" when a function payload is present.
 * Otherwise, drops the malformed tool_call entry.
 *
 * @param {Buffer} body
 * @returns {{ body: Buffer, normalizedCount: number, droppedCount: number }|null}
 */
function sanitizeNullToolCallTypes(body) {
  const parsed = parseBodyAsObject(body);
  if (!parsed || !Array.isArray(parsed.messages)) {
    return null;
  }

  let changed = false;
  let normalizedCount = 0;
  let droppedCount = 0;

  for (const message of parsed.messages) {
    if (!message || typeof message !== 'object' || !Array.isArray(message.tool_calls)) {
      continue;
    }

    const nextToolCalls = [];
    for (const toolCall of message.tool_calls) {
      if (
        toolCall &&
        typeof toolCall === 'object' &&
        Object.hasOwn(toolCall, 'type') &&
        toolCall.type === null
      ) {
        if (toolCall.function && typeof toolCall.function === 'object') {
          nextToolCalls.push({ ...toolCall, type: 'function' });
          normalizedCount += 1;
        } else {
          droppedCount += 1;
        }
        changed = true;
        continue;
      }
      nextToolCalls.push(toolCall);
    }

    message.tool_calls = nextToolCalls;
  }

  if (!changed) {
    return null;
  }

  return {
    body: Buffer.from(JSON.stringify(parsed)),
    normalizedCount,
    droppedCount,
  };
}

/**
 * Inject a token-budget warning message into a request body.
 *
 * Handles three JSON body formats:
 *   - Anthropic  (/v1/messages)          — appends a text block to `system`
 *   - Gemini     (/v1beta/…generateContent) — appends a part to `systemInstruction`
 *   - OpenAI     (/v1/chat/completions)  — inserts a system message after any
 *                                           existing system messages
 *
 * Returns a new Buffer containing the modified body, or null when the body
 * cannot be parsed or injection is not applicable.
 *
 * @param {Buffer} body       - Raw request body
 * @param {string} provider   - Provider name ('anthropic' | 'gemini' | 'openai' | 'copilot')
 * @param {string} message    - Warning text to inject
 * @returns {Buffer|null}
 */
function injectSteeringMessage(body, provider, message) {
  let parsed = parseBodyAsObject(body);
  if (!parsed) return null;

  if (provider === 'anthropic') {
    if (typeof parsed.system === 'string') {
      parsed = { ...parsed, system: parsed.system + '\n\n' + message };
    } else if (Array.isArray(parsed.system)) {
      parsed = { ...parsed, system: [...parsed.system, { type: 'text', text: message }] };
    } else {
      parsed = { ...parsed, system: message };
    }
  } else if (provider === 'gemini') {
    const existing = parsed.systemInstruction;
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      const parts = Array.isArray(existing.parts)
        ? [...existing.parts, { text: message }]
        : [{ text: message }];
      parsed = { ...parsed, systemInstruction: { ...existing, parts } };
    } else {
      parsed = { ...parsed, systemInstruction: { parts: [{ text: message }] } };
    }
  } else {
    if (!Array.isArray(parsed.messages)) return null;
    const systemMsg = { role: 'system', content: message };
    const lastSystemIdx = parsed.messages.reduce(
      (last, m, i) => (m && m.role === 'system' ? i : last),
      -1
    );
    const insertAt = lastSystemIdx + 1;
    const msgs = [...parsed.messages];
    msgs.splice(insertAt, 0, systemMsg);
    parsed = { ...parsed, messages: msgs };
  }

  return Buffer.from(JSON.stringify(parsed));
}

/**
 * Inject `stream_options: { include_usage: true }` into OpenAI-compatible
 * streaming requests so that the final SSE chunk includes token usage data.
 * This is required for the token tracker (and OTEL spans) to capture usage.
 *
 * Only modifies the body when `stream: true` is present and `stream_options`
 * is not already set.  Anthropic and Gemini use different mechanisms and are
 * skipped.
 *
 * @param {Buffer} body
 * @param {string} provider - 'openai' | 'copilot' | 'anthropic' | 'gemini'
 * @param {string} [requestPath] - Incoming request path (e.g. /v1/chat/completions)
 * @returns {{ body: Buffer, injected: boolean }|null}
 */
function injectStreamOptions(body, provider, requestPath = '') {
  // Only applies to OpenAI-compatible providers
  if (provider === 'anthropic' || provider === 'gemini') return null;

  // The OpenAI Responses API rejects stream_options.include_usage.
  // Skip injection for /responses and /vN/responses routes.
  // The leading slash is optional because some clients omit it (e.g. Codex CLI).
  const pathOnly = typeof requestPath === 'string' ? requestPath.split('?')[0] : '';
  if (/^\/?(?:v\d+\/)?responses(?:\/|$)/.test(pathOnly)) return null;

  const parsed = parseBodyAsObject(body);
  if (!parsed) return null;
  if (!parsed.stream) return null;
  if (parsed.stream_options) return null;

  // Secondary guard: Responses API bodies have an 'input' field but no 'messages' array.
  // This catches requests that arrive with an unrecognised path form.
  if (parsed.input !== undefined && !Array.isArray(parsed.messages)) return null;

  parsed.stream_options = { include_usage: true };
  return { body: Buffer.from(JSON.stringify(parsed)), injected: true };
}


module.exports = {
  sanitizeNullToolCallTypes,
  injectSteeringMessage,
  injectStreamOptions,
};
