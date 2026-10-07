'use strict';

/**
 * Chat Completions ⇄ Anthropic Messages protocol translation.
 *
 * Used by the cross-provider ordered fallback chain (cross-provider-fallback.js)
 * when an OpenAI-compatible request (Copilot or OpenAI listener) falls back to
 * an Anthropic model: the request is translated to the Messages API, and the
 * Messages response (JSON or SSE) is translated back so the agent keeps
 * speaking its original protocol.
 *
 * Translation is strict: a request feature that has no faithful Messages API
 * equivalent raises ProtocolTranslationError instead of being silently dropped,
 * so the fallback candidate is skipped rather than served with altered
 * semantics.
 */

const { StringDecoder } = require('string_decoder');
const { Transform } = require('stream');
const { parseBodyAsObject } = require('./body-utils');

/** Default `max_tokens` when the Chat request does not set one (Messages requires it). */
const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;

class ProtocolTranslationError extends Error {
  constructor(feature, from = 'chat_completions', to = 'anthropic_messages') {
    super(`Cannot translate request feature '${feature}' from ${from} to ${to}.`);
    this.name = 'ProtocolTranslationError';
    this.code = 'unsupported_protocol_feature';
    this.feature = feature;
  }
}

/** Chat request fields that are mapped to a Messages API equivalent. */
const MAPPED_CHAT_FIELDS = new Set([
  'model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_tokens',
  'max_completion_tokens', 'temperature', 'top_p', 'stop', 'stream', 'user',
]);

/**
 * Transport-only fields that do not affect inference and may be dropped.
 */
const DROPPABLE_CHAT_FIELDS = new Set(['stream_options']);

function textFromChatContent(content, feature) {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  if (!Array.isArray(content)) throw new ProtocolTranslationError(feature);
  return content.map((part) => {
    if (part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
      return part.text;
    }
    throw new ProtocolTranslationError(`${feature}[${part?.type || 'unknown'}]`);
  }).join('');
}

function translateImagePart(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (typeof url !== 'string' || !url) throw new ProtocolTranslationError('messages.content[image_url]');
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataUrl) {
    return { type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } };
  }
  if (/^https:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
  throw new ProtocolTranslationError('messages.content[image_url]');
}

function chatContentToBlocks(content, feature) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (content === null || content === undefined) return [];
  if (!Array.isArray(content)) throw new ProtocolTranslationError(feature);
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') throw new ProtocolTranslationError(feature);
    if ((part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      blocks.push(translateImagePart(part));
    } else {
      throw new ProtocolTranslationError(`${feature}[${part.type || 'unknown'}]`);
    }
  }
  return blocks;
}

function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  throw new ProtocolTranslationError('messages.tool_calls.function.arguments');
}

function pushMessage(messages, role, blocks) {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  // The Messages API requires alternating roles; merge consecutive turns.
  if (last && last.role === role) {
    last.content.push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

function translateChatMessages(chatMessages) {
  if (!Array.isArray(chatMessages)) throw new ProtocolTranslationError('messages');
  const system = [];
  const messages = [];
  for (const message of chatMessages) {
    if (!message || typeof message !== 'object') throw new ProtocolTranslationError('messages');
    const { role } = message;
    if (role === 'system' || role === 'developer') {
      const text = textFromChatContent(message.content, `messages[${role}].content`);
      if (text) system.push(text);
      continue;
    }
    if (role === 'user') {
      pushMessage(messages, 'user', chatContentToBlocks(message.content, 'messages[user].content'));
      continue;
    }
    if (role === 'assistant') {
      const blocks = chatContentToBlocks(message.content, 'messages[assistant].content');
      if (typeof message.refusal === 'string' && message.refusal) blocks.push({ type: 'text', text: message.refusal });
      for (const call of message.tool_calls || []) {
        if (!call || (call.type && call.type !== 'function') || typeof call.function?.name !== 'string') {
          throw new ProtocolTranslationError(`messages.tool_calls[${call?.type || 'unknown'}]`);
        }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments),
        });
      }
      pushMessage(messages, 'assistant', blocks);
      continue;
    }
    if (role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) {
        throw new ProtocolTranslationError('messages[tool].tool_call_id');
      }
      const text = textFromChatContent(message.content, 'messages[tool].content');
      pushMessage(messages, 'user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: text }]);
      continue;
    }
    throw new ProtocolTranslationError(`messages[${role || 'unknown'}]`);
  }
  return { system: system.join('\n\n'), messages };
}

function translateChatTools(tools) {
  if (!Array.isArray(tools)) throw new ProtocolTranslationError('tools');
  return tools.map((tool) => {
    if (!tool || tool.type !== 'function' || typeof tool.function?.name !== 'string') {
      throw new ProtocolTranslationError(`tools[${tool?.type || 'unknown'}]`);
    }
    return {
      name: tool.function.name,
      ...(typeof tool.function.description === 'string' ? { description: tool.function.description } : {}),
      ...(typeof tool.function.strict === 'boolean' ? { strict: tool.function.strict } : {}),
      input_schema: tool.function.parameters && typeof tool.function.parameters === 'object'
        ? tool.function.parameters
        : { type: 'object', properties: {} },
    };
  });
}

function translateChatToolChoice(choice) {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (choice && typeof choice === 'object' && choice.type === 'function' && typeof choice.function?.name === 'string') {
    return { type: 'tool', name: choice.function.name };
  }
  throw new ProtocolTranslationError('tool_choice');
}

/**
 * Translate a Chat Completions request body into an Anthropic Messages request.
 *
 * @param {object} chat - Parsed Chat Completions request
 * @returns {object} Messages API request body
 * @throws {ProtocolTranslationError}
 */
function chatRequestToAnthropic(chat) {
  if (!chat || typeof chat !== 'object') throw new ProtocolTranslationError('body');
  for (const key of Object.keys(chat)) {
    if (MAPPED_CHAT_FIELDS.has(key) || DROPPABLE_CHAT_FIELDS.has(key)) continue;
    const value = chat[key];
    if (value === undefined || value === null) continue;
    if (key === 'n' && value === 1) continue;
    if (key === 'response_format' && value?.type === 'text') continue;
    if ((key === 'logprobs' || key === 'parallel_tool_calls') && value === false) continue;
    throw new ProtocolTranslationError(key);
  }
  const { system, messages } = translateChatMessages(chat.messages);
  const maxTokens = chat.max_completion_tokens ?? chat.max_tokens;
  const result = {
    model: chat.model,
    ...(system ? { system } : {}),
    messages,
    max_tokens: Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_ANTHROPIC_MAX_TOKENS,
  };
  if (typeof chat.temperature === 'number') result.temperature = Math.min(Math.max(chat.temperature, 0), 1);
  if (typeof chat.top_p === 'number') result.top_p = chat.top_p;
  if (typeof chat.stop === 'string') result.stop_sequences = [chat.stop];
  else if (Array.isArray(chat.stop) && chat.stop.length > 0) result.stop_sequences = chat.stop.filter(s => typeof s === 'string');
  if (chat.stream === true) result.stream = true;
  if (typeof chat.user === 'string' && chat.user) result.metadata = { user_id: chat.user };
  if (Array.isArray(chat.tools) && chat.tools.length > 0) {
    result.tools = translateChatTools(chat.tools);
    if (chat.tool_choice !== undefined && chat.tool_choice !== null) {
      result.tool_choice = translateChatToolChoice(chat.tool_choice);
    }
    if (chat.parallel_tool_calls === false && result.tool_choice?.type !== 'none') {
      result.tool_choice = { ...(result.tool_choice || { type: 'auto' }), disable_parallel_tool_use: true };
    }
  } else if (chat.tool_choice !== undefined && chat.tool_choice !== null && chat.tool_choice !== 'none' && chat.tool_choice !== 'auto') {
    throw new ProtocolTranslationError('tool_choice');
  }
  return result;
}

/**
 * Map an Anthropic `stop_reason` to a Chat Completions `finish_reason`.
 *
 * @param {string|null|undefined} stopReason
 * @returns {string}
 */
function finishReasonFromStopReason(stopReason) {
  switch (stopReason) {
    case 'tool_use': return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded': return 'length';
    case 'refusal': return 'content_filter';
    default: return 'stop';
  }
}

/**
 * Convert Anthropic usage into Chat Completions usage. Anthropic reports
 * cache reads/writes separately from `input_tokens`; Chat `prompt_tokens`
 * includes them.
 *
 * @param {object|null|undefined} usage
 * @returns {object|undefined}
 */
function anthropicUsageToChat(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const promptTokens = (usage.input_tokens || 0) + cacheRead + cacheWrite;
  const completionTokens = usage.output_tokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    ...(cacheRead ? { prompt_tokens_details: { cached_tokens: cacheRead } } : {}),
  };
}

/**
 * Translate a non-streaming Anthropic Messages response into a Chat
 * Completions response.
 *
 * @param {Buffer} body
 * @returns {Buffer|null} Translated body, or null when the body is not a Messages response
 */
function anthropicResponseToChat(body) {
  const parsed = parseBodyAsObject(body);
  if (!parsed || !Array.isArray(parsed.content)) return null;
  let text = '';
  const toolCalls = [];
  for (const block of parsed.content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const usage = anthropicUsageToChat(parsed.usage);
  return Buffer.from(JSON.stringify({
    id: parsed.id || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: parsed.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: finishReasonFromStopReason(parsed.stop_reason),
    }],
    ...(usage ? { usage } : {}),
  }));
}

function sseData(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function parseSseBlock(block) {
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return data.join('\n');
}

/**
 * Create a Transform that converts an Anthropic Messages SSE stream into a
 * Chat Completions chunk stream (terminated by `data: [DONE]`).
 *
 * @param {{ includeUsage?: boolean }} [options]
 * @returns {import('stream').Transform}
 */
function createAnthropicToChatSseTransform({ includeUsage = false } = {}) {
  const state = {
    pending: '',
    decoder: new StringDecoder('utf8'),
    id: 'chatcmpl_awf',
    model: null,
    created: Math.floor(Date.now() / 1000),
    usage: {},
    stopReason: null,
    toolIndexes: new Map(),
    done: false,
  };

  function chunk(delta, finishReason = null) {
    return sseData({
      id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  }

  function finish() {
    if (state.done) return '';
    state.done = true;
    let out = chunk({}, finishReasonFromStopReason(state.stopReason));
    const usage = anthropicUsageToChat(state.usage);
    if (includeUsage && usage) {
      out += sseData({ id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model, choices: [], usage });
    }
    return `${out}data: [DONE]\n\n`;
  }

  function translate(block) {
    const data = parseSseBlock(block);
    if (!data) return '';
    let event;
    try { event = JSON.parse(data); } catch { return ''; }
    switch (event.type) {
      case 'message_start': {
        const message = event.message || {};
        state.id = message.id || state.id;
        state.model = message.model || state.model;
        if (message.usage) Object.assign(state.usage, message.usage);
        return chunk({ role: 'assistant', content: '' });
      }
      case 'content_block_start': {
        const contentBlock = event.content_block || {};
        if (contentBlock.type === 'tool_use') {
          const toolIndex = state.toolIndexes.size;
          state.toolIndexes.set(event.index, toolIndex);
          return chunk({
            tool_calls: [{
              index: toolIndex, id: contentBlock.id, type: 'function',
              function: { name: contentBlock.name, arguments: '' },
            }],
          });
        }
        if (contentBlock.type === 'text' && contentBlock.text) return chunk({ content: contentBlock.text });
        return '';
      }
      case 'content_block_delta': {
        const delta = event.delta || {};
        if (delta.type === 'text_delta' && typeof delta.text === 'string') return chunk({ content: delta.text });
        if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const toolIndex = state.toolIndexes.get(event.index);
          if (toolIndex === undefined) return '';
          return chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] });
        }
        return '';
      }
      case 'message_delta': {
        if (event.delta?.stop_reason) state.stopReason = event.delta.stop_reason;
        if (event.usage) Object.assign(state.usage, event.usage);
        return '';
      }
      case 'message_stop':
        return finish();
      case 'error':
        state.done = true;
        return sseData({ error: event.error || { type: 'api_error', message: 'Upstream stream error' } });
      default:
        return '';
    }
  }

  return new Transform({
    transform(chunkData, _encoding, callback) {
      state.pending += state.decoder.write(chunkData);
      const blocks = state.pending.split(/\r?\n\r?\n/);
      state.pending = blocks.pop() || '';
      try {
        for (const block of blocks) if (block) this.push(translate(block));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      state.pending += state.decoder.end();
      try {
        if (state.pending) this.push(translate(state.pending));
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

module.exports = {
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  ProtocolTranslationError,
  chatRequestToAnthropic,
  anthropicResponseToChat,
  anthropicUsageToChat,
  createAnthropicToChatSseTransform,
  finishReasonFromStopReason,
};
