'use strict';

const { parseBodyAsObject } = require('../body-utils');

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

function transformWireApiResponseBody(body, compatibility) {
  if (!compatibility || compatibility.passthrough) return null;
  return compatibility.direction === 'responses_to_chat'
    ? transformChatResponse(body)
    : transformResponsesResponse(body);
}

module.exports = {
  usageToResponses,
  usageToChat,
  transformChatResponse,
  transformResponsesResponse,
  transformWireApiResponseBody,
};
