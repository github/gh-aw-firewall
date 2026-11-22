'use strict';

const { findRuntimeModel } = require('../runtime-model-catalog');
const { parseBodyAsObject } = require('../body-utils');
const {
  RESPONSES_ENDPOINT, CHAT_ENDPOINT, WireApiCompatibilityError,
  endpointForPath, advertisedEndpoint, failIfPresent, ensureOnlyFields,
} = require('./shared');

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
  if (body.response_format !== undefined && body.response_format !== null) {
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
    if (part.type === 'output_text') return { type: 'text', text: part.text };
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
    ensureOnlyFields(item, new Set(['type', 'id', 'status', 'role', 'content']));
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

function translateCopilotWireApi(body, path, { upstreamEndpoint: overrideEndpoint = null } = {}) {
  const requestedEndpoint = endpointForPath(path);
  if (!requestedEndpoint) return null;
  const parsed = parseBodyAsObject(body);
  if (!parsed || typeof parsed.model !== 'string') return null;
  const model = findRuntimeModel('copilot', parsed.model);
  if (!overrideEndpoint && !Array.isArray(model?.supportedEndpoints)) return null;
  const endpoints = new Set((model?.supportedEndpoints || []).map(advertisedEndpoint).filter(Boolean));
  const upstreamEndpoint = requestedEndpoint === RESPONSES_ENDPOINT ? CHAT_ENDPOINT : RESPONSES_ENDPOINT;
  if (overrideEndpoint !== upstreamEndpoint &&
      (endpoints.has(requestedEndpoint) || !endpoints.has(upstreamEndpoint))) return null;

  let translated;
  try {
    translated = requestedEndpoint === RESPONSES_ENDPOINT
      ? translateResponsesRequest(parsed)
      : translateChatRequest(parsed);
  } catch (err) {
    if (err instanceof WireApiCompatibilityError) {
      err.message += ` Routing model "${parsed.model}" to ${upstreamEndpoint} is incompatible: this request needs ` +
        `${requestedEndpoint} to preserve '${err.feature}'. Choose a model supporting ${requestedEndpoint} ` +
        'for this request, or use function tools/features supported by both APIs. ' +
        'AWF will not drop request features or silently select another model.';
    }
    throw err;
  }
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

module.exports = {
  translateCopilotWireApi,
  translateChatRequest,
  translateResponsesRequest,
};
