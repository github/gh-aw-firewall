'use strict';

const { Transform } = require('stream');
const { StringDecoder } = require('string_decoder');
const { findRuntimeModel } = require('./runtime-model-catalog');
const { parseBodyAsObject } = require('./body-utils');

const RESPONSES_ENDPOINT = '/responses';
const CHAT_ENDPOINT = '/chat/completions';

class WireApiCompatibilityError extends Error {
  constructor(feature) {
    super(`Cannot translate Copilot request feature '${feature}' between Responses and Chat Completions.`);
    this.name = 'WireApiCompatibilityError';
    this.statusCode = 400;
    this.code = 'unsupported_wire_api_feature';
  }
}

function endpointForPath(path) {
  if (typeof path !== 'string') return null;
  const pathname = path.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  if (pathname.endsWith(RESPONSES_ENDPOINT)) return RESPONSES_ENDPOINT;
  if (pathname.endsWith(CHAT_ENDPOINT)) return CHAT_ENDPOINT;
  return null;
}

function advertisedEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return null;
  if (endpoint.endsWith(RESPONSES_ENDPOINT)) return RESPONSES_ENDPOINT;
  if (endpoint.endsWith(CHAT_ENDPOINT)) return CHAT_ENDPOINT;
  return null;
}

function failIfPresent(body, keys) {
  for (const key of keys) {
    if (Object.hasOwn(body, key) && body[key] !== undefined && body[key] !== null && body[key] !== false) {
      throw new WireApiCompatibilityError(key);
    }
  }
}

function ensureOnlyFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new WireApiCompatibilityError(key);
  }
}

function translateChatContent(content) {
  if (typeof content === 'string' || content === null) return content;
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'text') return { ...part, type: 'input_text' };
    if (part.type === 'image_url') {
      return {
        type: 'input_image',
        image_url: typeof part.image_url === 'string' ? part.image_url : part.image_url?.url,
        ...(part.image_url?.detail ? { detail: part.image_url.detail } : {}),
      };
    }
    throw new WireApiCompatibilityError(`messages.content[${part.type || 'unknown'}]`);
  });
}

function translateChatMessages(messages) {
  const input = [];
  const instructions = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') throw new WireApiCompatibilityError('messages');
    ensureOnlyFields(message, new Set([
      'role', 'content', 'tool_calls', 'tool_call_id',
    ]));
    if (message.role === 'system' || message.role === 'developer') {
      if (typeof message.content !== 'string') throw new WireApiCompatibilityError(`messages[${message.role}].content`);
      const text = message.content;
      if (text) instructions.push(text);
      continue;
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) {
        throw new WireApiCompatibilityError('messages[tool].tool_call_id');
      }
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      });
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new WireApiCompatibilityError(`messages[${message.role || 'unknown'}]`);
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (message.content) {
        input.push({ role: 'assistant', content: translateChatContent(message.content) });
      }
      for (const call of message.tool_calls) {
        if (call?.type !== 'function' || !call.function) throw new WireApiCompatibilityError('tool_calls');
        ensureOnlyFields(call, new Set(['id', 'type', 'function']));
        ensureOnlyFields(call.function, new Set(['name', 'arguments']));
        if (typeof call.function.name !== 'string' || !call.function.name) {
          throw new WireApiCompatibilityError('tool_calls.function.name');
        }
        input.push({
          type: 'function_call',
          ...(call.id ? { call_id: call.id } : {}),
          name: call.function.name,
          arguments: typeof call.function.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call.function.arguments ?? {}),
        });
      }
      continue;
    }
    input.push({ role: message.role, content: translateChatContent(message.content) });
  }
  return { input, instructions: instructions.join('\n\n') };
}

function translateChatTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map(tool => {
    if (tool?.type !== 'function' || !tool.function) throw new WireApiCompatibilityError(`tools[${tool?.type || 'unknown'}]`);
    ensureOnlyFields(tool.function, new Set(['name', 'description', 'parameters', 'strict']));
    if (typeof tool.function.name !== 'string' || !tool.function.name) {
      throw new WireApiCompatibilityError('tools.function.name');
    }
    return { type: 'function', ...tool.function };
  });
}

function translateChatToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return choice;
  if (choice.type === 'function' && choice.function?.name) {
    return { type: 'function', name: choice.function.name };
  }
  return choice;
}

function translateChatRequest(body) {
  const allowed = new Set([
    'model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort',
    'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'temperature', 'top_p',
    'response_format', 'service_tier', 'n',
  ]);
  ensureOnlyFields(body, allowed);
  failIfPresent(body, ['stop', 'logprobs', 'top_logprobs', 'logit_bias', 'seed', 'presence_penalty', 'frequency_penalty']);
  if (body.n !== undefined && body.n !== 1) throw new WireApiCompatibilityError('n');
  if (!Array.isArray(body.messages)) throw new WireApiCompatibilityError('messages');
  if (body.stream_options) {
    ensureOnlyFields(body.stream_options, new Set(['include_usage']));
    if (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean') {
      throw new WireApiCompatibilityError('stream_options.include_usage');
    }
  }

  const { input, instructions } = translateChatMessages(body.messages);
  const result = { model: body.model, input };
  if (instructions) result.instructions = instructions;
  if (body.tools) result.tools = translateChatTools(body.tools);
  if (body.tool_choice !== undefined) result.tool_choice = translateChatToolChoice(body.tool_choice);
  for (const field of ['parallel_tool_calls', 'stream', 'temperature', 'top_p', 'service_tier']) {
    if (body[field] !== undefined) result[field] = body[field];
  }
  if (body.max_tokens !== undefined || body.max_completion_tokens !== undefined) {
    result.max_output_tokens = body.max_completion_tokens ?? body.max_tokens;
  }
  if (body.reasoning_effort !== undefined) result.reasoning = { effort: body.reasoning_effort };
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (format.type === 'json_object') {
      result.text = { format: { type: 'json_object' } };
    } else if (format.type === 'json_schema' && format.json_schema) {
      result.text = {
        format: {
          type: 'json_schema',
          name: format.json_schema.name,
          schema: format.json_schema.schema,
          ...(format.json_schema.strict !== undefined ? { strict: format.json_schema.strict } : {}),
        },
      };
    } else {
      throw new WireApiCompatibilityError('response_format');
    }
  }
  return result;
}

function translateResponseContent(content) {
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'input_text') return { ...part, type: 'text' };
    if (part.type === 'input_image') {
      return {
        type: 'image_url',
        image_url: {
          url: part.image_url,
          ...(part.detail ? { detail: part.detail } : {}),
        },
      };
    }
    throw new WireApiCompatibilityError(`input.content[${part.type || 'unknown'}]`);
  });
}

function responseInputToMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (!Array.isArray(input)) throw new WireApiCompatibilityError('input');
  const messages = [];
  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== 'object') throw new WireApiCompatibilityError(`input[${index}]`);
    if (item.type === 'function_call') {
      ensureOnlyFields(item, new Set(['type', 'id', 'call_id', 'name', 'arguments', 'status']));
      if (typeof item.call_id !== 'string' || !item.call_id) {
        throw new WireApiCompatibilityError(`input[${index}].call_id`);
      }
      if (typeof item.name !== 'string' || !item.name) {
        throw new WireApiCompatibilityError(`input[${index}].name`);
      }
      const previous = messages[messages.length - 1];
      const toolCall = {
        type: 'function',
        ...(item.call_id ? { id: item.call_id } : {}),
        function: { name: item.name, arguments: item.arguments || '{}' },
      };
      if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) previous.tool_calls.push(toolCall);
      else messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
      continue;
    }
    if (item.type === 'function_call_output') {
      ensureOnlyFields(item, new Set(['type', 'id', 'call_id', 'output', 'status']));
      if (typeof item.call_id !== 'string' || !item.call_id) {
        throw new WireApiCompatibilityError(`input[${index}].call_id`);
      }
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
      continue;
    }
    if (item.type && item.type !== 'message') {
      throw new WireApiCompatibilityError(`input[${index}].type=${item.type}`);
    }
    ensureOnlyFields(item, new Set(['type', 'role', 'content']));
    const role = item.role || 'user';
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) {
      throw new WireApiCompatibilityError(`input[${index}].role=${role}`);
    }
    messages.push({ role, content: translateResponseContent(item.content) });
  }
  return messages;
}

function translateResponsesToolChoice(choice) {
  if (!choice || typeof choice !== 'object') return choice;
  return choice.type === 'function' && choice.name
    ? { type: 'function', function: { name: choice.name } }
    : choice;
}

function translateResponsesRequest(body) {
  const allowed = new Set([
    'model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls',
    'reasoning', 'max_output_tokens', 'stream', 'temperature', 'top_p', 'text',
    'service_tier', 'store', 'metadata', 'truncation', 'previous_response_id',
    'include', 'prompt_cache_key',
  ]);
  ensureOnlyFields(body, allowed);
  failIfPresent(body, ['previous_response_id', 'include', 'prompt_cache_key', 'metadata', 'truncation']);
  if (body.store === true) throw new WireApiCompatibilityError('store');
  if (body.reasoning && (body.reasoning.encrypted_content || body.reasoning.summary)) {
    throw new WireApiCompatibilityError(body.reasoning.encrypted_content ? 'reasoning.encrypted_content' : 'reasoning.summary');
  }
  if (body.reasoning) ensureOnlyFields(body.reasoning, new Set(['effort']));
  if (body.instructions !== undefined && typeof body.instructions !== 'string') {
    throw new WireApiCompatibilityError('instructions');
  }
  const messages = responseInputToMessages(body.input);
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.unshift({ role: 'system', content: body.instructions });
  }
  const result = { model: body.model, messages };
  if (Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => {
      if (tool?.type !== 'function') throw new WireApiCompatibilityError(`tools[${tool?.type || 'unknown'}]`);
      ensureOnlyFields(tool, new Set(['type', 'name', 'description', 'parameters', 'strict']));
      return {
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        },
      };
    });
  }
  if (body.tool_choice !== undefined) result.tool_choice = translateResponsesToolChoice(body.tool_choice);
  for (const field of ['parallel_tool_calls', 'stream', 'temperature', 'top_p', 'service_tier']) {
    if (body[field] !== undefined) result[field] = body[field];
  }
  if (body.stream === true) result.stream_options = { include_usage: true };
  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  if (body.reasoning?.effort !== undefined) result.reasoning_effort = body.reasoning.effort;
  if (body.text?.format) {
    const format = body.text.format;
    if (format.type === 'json_object') result.response_format = { type: 'json_object' };
    else if (format.type === 'json_schema') {
      result.response_format = {
        type: 'json_schema',
        json_schema: {
          name: format.name,
          schema: format.schema,
          ...(format.strict !== undefined ? { strict: format.strict } : {}),
        },
      };
    } else {
      throw new WireApiCompatibilityError(`text.format[${format.type || 'unknown'}]`);
    }
  }
  if (body.text) ensureOnlyFields(body.text, new Set(['format']));
  return result;
}

function translateCopilotWireApi(body, path) {
  const requestedEndpoint = endpointForPath(path);
  if (!requestedEndpoint) return null;
  const parsed = parseBodyAsObject(body);
  if (!parsed || typeof parsed.model !== 'string') return null;
  const model = findRuntimeModel('copilot', parsed.model);
  if (!Array.isArray(model?.supportedEndpoints)) return null;
  const endpoints = new Set(model.supportedEndpoints.map(advertisedEndpoint).filter(Boolean));
  const upstreamEndpoint = requestedEndpoint === RESPONSES_ENDPOINT ? CHAT_ENDPOINT : RESPONSES_ENDPOINT;
  if (endpoints.has(requestedEndpoint) || !endpoints.has(upstreamEndpoint)) return null;

  const translated = requestedEndpoint === RESPONSES_ENDPOINT
    ? translateResponsesRequest(parsed)
    : translateChatRequest(parsed);
  return {
    body: Buffer.from(JSON.stringify(translated)),
    compatibility: {
      requestedEndpoint,
      upstreamEndpoint,
      direction: requestedEndpoint === RESPONSES_ENDPOINT ? 'responses_to_chat' : 'chat_to_responses',
      ...(requestedEndpoint === CHAT_ENDPOINT
        ? { includeUsage: parsed.stream_options?.include_usage === true }
        : {}),
    },
  };
}

function replaceUpstreamEndpoint(path, endpoint) {
  const queryIndex = path.indexOf('?');
  const pathname = queryIndex < 0 ? path : path.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : path.slice(queryIndex);
  const replaced = pathname.replace(/\/(?:chat\/completions|responses)\/?$/, endpoint);
  return `${replaced}${query}`;
}

function usageToResponses(usage) {
  if (!usage) return undefined;
  return {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
    ...(usage.prompt_tokens_details?.cached_tokens !== undefined
      ? { input_tokens_details: { cached_tokens: usage.prompt_tokens_details.cached_tokens } }
      : {}),
    ...(usage.completion_tokens_details?.reasoning_tokens !== undefined
      ? { output_tokens_details: { reasoning_tokens: usage.completion_tokens_details.reasoning_tokens } }
      : {}),
  };
}

function usageToChat(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens || 0,
    completion_tokens: usage.output_tokens || 0,
    total_tokens: usage.total_tokens || ((usage.input_tokens || 0) + (usage.output_tokens || 0)),
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens } }
      : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens } }
      : {}),
  };
}

function chatChoiceToOutput(choice) {
  const message = choice?.message || {};
  const output = [];
  if (typeof message.content === 'string' && message.content) {
    output.push({
      type: 'message', id: `msg_${choice.index || 0}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }
  if (typeof message.refusal === 'string' && message.refusal) {
    output.push({
      type: 'message', id: `msg_refusal_${choice.index || 0}`, role: 'assistant', status: 'completed',
      content: [{ type: 'refusal', refusal: message.refusal }],
    });
  }
  for (const [index, call] of (message.tool_calls || []).entries()) {
    output.push({
      type: 'function_call', id: call.id || `fc_${index}`, call_id: call.id,
      name: call.function?.name, arguments: call.function?.arguments || '{}', status: 'completed',
    });
  }
  return output;
}

function transformChatResponse(body) {
  const parsed = parseBodyAsObject(body);
  if (!parsed || !Array.isArray(parsed.choices)) return null;
  const choice = parsed.choices[0] || {};
  const incomplete = choice.finish_reason === 'length' || choice.finish_reason === 'content_filter';
  return Buffer.from(JSON.stringify({
    id: parsed.id || `resp_${Date.now()}`,
    object: 'response',
    created_at: parsed.created || Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incomplete_details: { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}),
    model: parsed.model,
    output: chatChoiceToOutput(choice),
    ...(usageToResponses(parsed.usage) ? { usage: usageToResponses(parsed.usage) } : {}),
  }));
}

function responseOutputToChat(parsed) {
  let content = '';
  let refusal = null;
  const toolCalls = [];
  for (const item of parsed.output || []) {
    if (item?.type === 'message') {
      for (const part of item.content || []) {
        if (part?.type === 'output_text' && typeof part.text === 'string') content += part.text;
        if (part?.type === 'refusal' && typeof part.refusal === 'string') refusal = part.refusal;
      }
    } else if (item?.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments || '{}' },
      });
    }
  }
  return {
    role: 'assistant',
    content: content || null,
    ...(refusal ? { refusal } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function transformResponsesResponse(body) {
  const parsed = parseBodyAsObject(body);
  if (!parsed || !Array.isArray(parsed.output)) return null;
  const message = responseOutputToChat(parsed);
  const finishReason = message.tool_calls ? 'tool_calls'
    : parsed.status === 'incomplete'
      ? (parsed.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length')
      : 'stop';
  return Buffer.from(JSON.stringify({
    id: parsed.id || `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: parsed.created_at || Math.floor(Date.now() / 1000),
    model: parsed.model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usageToChat(parsed.usage) ? { usage: usageToChat(parsed.usage) } : {}),
  }));
}

function sseEvent(event, data) {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}

function parseSseBlock(block) {
  let event = null;
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

function createResponsesToChatSseTransform(includeUsage) {
  const state = { pending: '', decoder: new StringDecoder('utf8'), id: 'chatcmpl_awf', model: null, created: 0, toolIndexes: new Map(), done: false };
  return createSseTransform(state, (block, current) => {
    const { data } = parseSseBlock(block);
    if (!data || data === '[DONE]') return '';
    let event;
    try { event = JSON.parse(data); } catch { return ''; }
    if (event.type === 'response.created' || event.type === 'response.in_progress') {
      const response = event.response || {};
      current.id = response.id || current.id;
      current.model = response.model || current.model;
      current.created = response.created_at || current.created || Math.floor(Date.now() / 1000);
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
    }
    if (event.type === 'response.output_text.delta') {
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{ index: 0, delta: { content: event.delta || '' }, finish_reason: null }],
      });
    }
    if (event.type === 'response.refusal.delta') {
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{ index: 0, delta: { refusal: event.delta || '' }, finish_reason: null }],
      });
    }
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const index = current.toolIndexes.size;
      current.toolIndexes.set(event.item.id || event.item.call_id, index);
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{
            index, id: event.item.call_id || event.item.id, type: 'function',
            function: { name: event.item.name, arguments: '' },
          }] },
          finish_reason: null,
        }],
      });
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const key = event.item_id || event.call_id;
      const index = current.toolIndexes.get(key) ?? event.output_index ?? 0;
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta || '' } }] }, finish_reason: null }],
      });
    }
    if (event.type === 'response.completed') {
      const response = event.response || {};
      current.done = true;
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: response.output?.some(item => item.type === 'function_call')
            ? 'tool_calls'
            : response.status === 'incomplete'
              ? (response.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length')
              : 'stop',
        }],
        ...(includeUsage && usageToChat(response.usage) ? { usage: usageToChat(response.usage) } : {}),
      }) + 'data: [DONE]\n\n';
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      current.done = true;
      return sseEvent(null, { error: event.error || event });
    }
    return '';
  });
}

function createChatToResponsesSseTransform() {
  const state = {
    pending: '', decoder: new StringDecoder('utf8'), id: 'resp_awf', model: null,
    created: Math.floor(Date.now() / 1000), responseStarted: false, text: '', refusal: '', textIndex: null,
    tools: new Map(), output: [], nextOutputIndex: 0, finishReason: null, done: false,
  };
  function start(current) {
    if (current.responseStarted) return '';
    current.responseStarted = true;
    return sseEvent('response.created', {
      type: 'response.created',
      response: { id: current.id, object: 'response', status: 'in_progress', model: current.model, output: [] },
    });
  }
  function ensureMessageItem(current) {
    if (current.textIndex !== null) return '';
    current.textIndex = current.nextOutputIndex++;
    return sseEvent('response.output_item.added', {
      type: 'response.output_item.added', output_index: current.textIndex,
      item: { type: 'message', id: `msg_${current.id}`, role: 'assistant', status: 'in_progress', content: [] },
    });
  }
  function finish(current, usage) {
    if (current.done) return '';
    current.done = true;
    let events = start(current);
    if (current.textIndex !== null) {
      const content = [
        ...(current.text ? [{ type: 'output_text', text: current.text, annotations: [] }] : []),
        ...(current.refusal ? [{ type: 'refusal', refusal: current.refusal }] : []),
      ];
      const item = {
        type: 'message', id: `msg_${current.id}`, role: 'assistant', status: 'completed',
        content,
      };
      if (current.text) {
        events += sseEvent('response.output_text.done', {
          type: 'response.output_text.done', item_id: item.id, output_index: current.textIndex, content_index: 0, text: current.text,
        });
        events += sseEvent('response.content_part.done', {
          type: 'response.content_part.done', item_id: item.id, output_index: current.textIndex, content_index: 0,
          part: item.content[0],
        });
      }
      if (current.refusal) {
        events += sseEvent('response.refusal.done', {
          type: 'response.refusal.done', item_id: item.id, output_index: current.textIndex, content_index: content.length - 1,
          refusal: current.refusal,
        });
      }
      events += sseEvent('response.output_item.done', {
        type: 'response.output_item.done', output_index: current.textIndex, item,
      });
      current.output[current.textIndex] = item;
    }
    for (const tool of current.tools.values()) {
      const index = tool.outputIndex;
      const item = {
        type: 'function_call', id: tool.id, call_id: tool.id, name: tool.name,
        arguments: tool.arguments, status: 'completed',
      };
      events += sseEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done', item_id: tool.id, output_index: index, arguments: tool.arguments,
      });
      events += sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
      current.output[index] = item;
    }
    const response = {
      id: current.id, object: 'response',
      status: current.finishReason === 'length' || current.finishReason === 'content_filter' ? 'incomplete' : 'completed',
      ...(current.finishReason === 'length' || current.finishReason === 'content_filter'
        ? { incomplete_details: { reason: current.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } }
        : {}),
      created_at: current.created,
      model: current.model, output: current.output.filter(Boolean),
      ...(usageToResponses(usage) ? { usage: usageToResponses(usage) } : {}),
    };
    return events + sseEvent('response.completed', { type: 'response.completed', response });
  }
  return createSseTransform(state, (block, current) => {
    const { data } = parseSseBlock(block);
    if (!data || data === '[DONE]') return finish(current, null);
    let event;
    try { event = JSON.parse(data); } catch { return `${block}\n\n`; }
    if (event.error) {
      current.done = true;
      return sseEvent('error', { type: 'error', error: event.error });
    }
    const choice = event.choices?.[0];
    if (!choice) {
      if (event.usage) return finish(current, event.usage);
      return '';
    }
    current.id = event.id || current.id;
    current.model = event.model || current.model;
    let output = start(current);
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      output += ensureMessageItem(current);
      if (current.text.length === 0) {
        output += sseEvent('response.content_part.added', {
          type: 'response.content_part.added', item_id: `msg_${current.id}`, output_index: current.textIndex, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      }
      current.text += delta.content;
      output += sseEvent('response.output_text.delta', {
        type: 'response.output_text.delta', item_id: `msg_${current.id}`, output_index: current.textIndex, content_index: 0, delta: delta.content,
      });
    }
    if (typeof delta.refusal === 'string' && delta.refusal) {
      output += ensureMessageItem(current);
      current.refusal += delta.refusal;
      output += sseEvent('response.refusal.delta', {
        type: 'response.refusal.delta', item_id: `msg_${current.id}`, output_index: current.textIndex,
        content_index: current.text ? 1 : 0, delta: delta.refusal,
      });
    }
    for (const call of delta.tool_calls || []) {
      const callIndex = Number(call.index || 0);
      let tool = current.tools.get(callIndex);
      if (!tool) {
        tool = {
          id: call.id || `call_${current.id}_${current.nextOutputIndex}`,
          name: '',
          arguments: '',
          outputIndex: current.nextOutputIndex++,
        };
        current.tools.set(callIndex, tool);
        output += sseEvent('response.output_item.added', {
          type: 'response.output_item.added', output_index: tool.outputIndex,
          item: { type: 'function_call', id: tool.id, call_id: tool.id, name: '', arguments: '', status: 'in_progress' },
        });
      }
      if (call.id) tool.id = call.id;
      if (call.function?.name) tool.name += call.function.name;
      if (call.function?.arguments) {
        tool.arguments += call.function.arguments;
        output += sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: tool.outputIndex, delta: call.function.arguments,
        });
      }
    }
    if (choice.finish_reason) current.finishReason = choice.finish_reason;
    return output;
  });
}

function createSseTransform(state, translate) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      state.pending += state.decoder.write(chunk);
      const blocks = state.pending.split(/\r?\n\r?\n/);
      state.pending = blocks.pop() || '';
      try {
        for (const block of blocks) if (block) this.push(translate(block, state));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      state.pending += state.decoder.end();
      try {
        if (state.pending) this.push(translate(state.pending, state));
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

function transformWireApiResponseBody(body, compatibility) {
  if (!compatibility) return null;
  return compatibility.direction === 'responses_to_chat'
    ? transformChatResponse(body)
    : transformResponsesResponse(body);
}

function createWireApiSseTransform(compatibility) {
  if (!compatibility) return null;
  return compatibility.direction === 'responses_to_chat'
    ? createChatToResponsesSseTransform()
    : createResponsesToChatSseTransform(compatibility.includeUsage);
}

function carryForwardWireApiCompatibility(compatibility) {
  return compatibility || null;
}

module.exports = {
  WireApiCompatibilityError,
  translateCopilotWireApi,
  replaceUpstreamEndpoint,
  transformWireApiResponseBody,
  createWireApiSseTransform,
  carryForwardWireApiCompatibility,
  _testing: {
    endpointForPath,
    translateChatRequest,
    translateResponsesRequest,
    transformChatResponse,
    transformResponsesResponse,
  },
};
