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

function isMessagesRequest(requestPath) {
  if (typeof requestPath !== 'string') return false;
  const path = requestPath.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return path.endsWith('/messages');
}

function isResponsesRequest(requestPath) {
  if (typeof requestPath !== 'string') return false;
  const path = requestPath.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return path === '/responses' || path.endsWith('/responses');
}

/**
 * Inject a token-budget warning message into a request body.
 *
 * Handles four JSON body formats. The notice always goes at the end of the
 * conversation, after the last tool result, and never changes the top-level
 * system prompt or instructions, so the provider prompt-cache prefix is kept:
 *   - Messages   (/v1/messages)          — appends a text block to the final
 *                                           user message, after any
 *                                           `tool_result` blocks
 *                                           (Anthropic and Copilot)
 *   - Gemini     (/v1beta/…generateContent) — appends a text part to the final
 *                                           user turn, after any function
 *                                           responses
 *   - OpenAI     (/v1/chat/completions)  — appends a final user message
 *   - Responses  (/v1/responses)         — appends a final developer message to
 *                                           `input`
 *
 * Returns a new Buffer containing the modified body, or null when the body
 * cannot be parsed or injection is not applicable. For Messages, Chat
 * Completions and Gemini this includes a conversation that is empty or does
 * not end in a user/tool turn (e.g. an assistant prefill).
 *
 * @param {Buffer} body       - Raw request body
 * @param {string} provider   - Provider name ('anthropic' | 'gemini' | 'openai' | 'copilot')
 * @param {string} message    - Warning text to inject
 * @param {string} [requestPath] - Incoming request path
 * @returns {Buffer|null}
 */
function injectSteeringMessage(body, provider, message, requestPath = '') {
  // Evaluation evidence must not be changed by conversational budget warnings.
  if (typeof requestPath === 'string') {
    try {
      const path = new URL(requestPath, 'https://localhost').pathname.replace(/\/+$/, '');
      if (path.endsWith('/decisions')) return null;
    } catch {
      return null;
    }
  }
  let parsed = parseBodyAsObject(body);
  if (!parsed) return null;

  if (provider === 'anthropic' || isMessagesRequest(requestPath)) {
    // Append after the tool_result blocks of the final user message so the
    // system prompt, tools and conversation prefix (and any cache breakpoint
    // on the last existing block) stay byte-identical.
    // Known limitation: with extended thinking on models before Opus 4.5
    // this text starts a new assistant loop, so the notice request misses
    // the cache once (documented).
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;
    const last = parsed.messages[parsed.messages.length - 1];
    if (!last || typeof last !== 'object' || last.role !== 'user') return null;
    let content;
    if (typeof last.content === 'string') {
      content = [{ type: 'text', text: last.content }, { type: 'text', text: message }];
    } else if (Array.isArray(last.content)) {
      content = [...last.content, { type: 'text', text: message }];
    } else {
      return null;
    }
    const messages = [...parsed.messages];
    messages[messages.length - 1] = { ...last, content };
    parsed = { ...parsed, messages };
  } else if (provider === 'gemini') {
    // Append after the function responses of the final user turn, leaving
    // systemInstruction and earlier contents unchanged.
    if (!Array.isArray(parsed.contents) || parsed.contents.length === 0) return null;
    const last = parsed.contents[parsed.contents.length - 1];
    if (!last || typeof last !== 'object' || last.role === 'model') return null;
    const contents = [...parsed.contents];
    if (last.role === undefined || last.role === 'user') {
      if (!Array.isArray(last.parts)) return null;
      contents[contents.length - 1] = { ...last, parts: [...last.parts, { text: message }] };
    } else {
      contents.push({ role: 'user', parts: [{ text: message }] });
    }
    parsed = { ...parsed, contents };
  } else if (
    isResponsesRequest(requestPath) ||
    (parsed.input !== undefined && !Array.isArray(parsed.messages))
  ) {
    if (typeof parsed.input !== 'string' && !Array.isArray(parsed.input)) return null;
    if (parsed.instructions !== undefined && parsed.instructions !== null && typeof parsed.instructions !== 'string') return null;
    const input = typeof parsed.input === 'string'
      ? [{ role: 'user', content: parsed.input }]
      : parsed.input;
    parsed = { ...parsed, input: [...input, { type: 'message', role: 'developer', content: message }] };
  } else {
    // Append a final user message after the last tool message. A user message
    // keeps its position when translated to Responses (system/developer
    // messages would be moved into the top-level `instructions`).
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null;
    const last = parsed.messages[parsed.messages.length - 1];
    if (!last || typeof last !== 'object' || last.role === 'assistant') return null;
    parsed = { ...parsed, messages: [...parsed.messages, { role: 'user', content: message }] };
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
 * @param {string} provider - 'openai' | 'copilot' | 'anthropic' | 'gemini' | 'vertex'
 * @param {string} [requestPath] - Incoming request path (e.g. /v1/chat/completions)
 * @returns {{ body: Buffer, injected: boolean }|null}
 */
function injectStreamOptions(body, provider, requestPath = '') {
  // Only applies to OpenAI-compatible providers
  if (provider === 'anthropic' || provider === 'gemini') return null;

  let pathOnly = '';
  if (typeof requestPath === 'string') {
    try {
      const originForm = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
      if (!originForm.startsWith('//')) {
        pathOnly = new URL(originForm, 'https://api-proxy.invalid').pathname;
      }
    } catch {
      // Unparseable paths are not eligible for route-specific exclusions.
    }
  }

  // The OpenAI Responses API rejects stream_options.include_usage.
  // Skip injection for exact /responses and /vN/responses routes.
  if (/^\/(?:v\d+\/)?responses\/?$/.test(pathOnly)) return null;

  // The Anthropic Messages API rejects stream_options.include_usage.
  // Skip injection for exact /messages and /vN/messages routes regardless of
  // provider, since the Copilot provider also fronts the Messages API
  // (e.g. api.githubcopilot.com/v1/messages).
  if (/^\/(?:v\d+\/)?messages\/?$/.test(pathOnly)) return null;

  // Anthropic models on Vertex use the Messages schema and reject stream_options.
  if (/\/publishers\/anthropic\/models\/[^/:]+:(?:rawPredict|streamRawPredict)\/?$/.test(pathOnly)) return null;

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
