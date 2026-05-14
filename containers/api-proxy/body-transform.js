'use strict';

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
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
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
 * @param {string} provider   - Provider name ('anthropic' | 'gemini' | 'openai' | 'copilot' | 'opencode')
 * @param {string} message    - Warning text to inject
 * @returns {Buffer|null}
 */
function injectSteeringMessage(body, provider, message) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

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

module.exports = {
  sanitizeNullToolCallTypes,
  injectSteeringMessage,
};
