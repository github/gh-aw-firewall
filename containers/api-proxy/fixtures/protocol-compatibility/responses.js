'use strict';

const created = 1700000000;
const chatUsage = {
  prompt_tokens: 10, completion_tokens: 4, total_tokens: 14,
  prompt_tokens_details: { cached_tokens: 3 },
  completion_tokens_details: { reasoning_tokens: 2 },
};
const responsesUsage = {
  input_tokens: 10, output_tokens: 4, total_tokens: 14,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens_details: { reasoning_tokens: 2 },
};
const chatMessage = {
  role: 'assistant', content: 'hello 🌍', refusal: 'cannot do that',
  tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
};
const responseOutput = [
  { type: 'message', id: 'msg_0', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello 🌍', annotations: [] }] },
  { type: 'message', id: 'msg_refusal_0', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'cannot do that' }] },
  { type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}', status: 'completed' },
];
const cases = [
  {
    name: 'Chat JSON to Responses: text, refusal, function IDs and detailed usage',
    contract: 'chat-to-responses-return',
    features: ['message_text', 'function_tools', 'usage', 'finish_reasons', 'refusal'],
    input: { id: 'fixture_chat', created, model: 'fixture-model', choices: [{ index: 0, message: chatMessage, finish_reason: 'tool_calls' }], usage: chatUsage },
    output: { id: 'fixture_chat', object: 'response', created_at: created, status: 'completed', model: 'fixture-model', output: responseOutput, usage: responsesUsage },
  },
  {
    name: 'Responses JSON to Chat: text, refusal, call_id precedence and detailed usage',
    contract: 'responses-to-chat-return',
    features: ['message_text', 'function_tools', 'usage', 'finish_reasons', 'refusal'],
    input: {
      id: 'fixture_response', created_at: created, model: 'fixture-model', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: responseOutput.map(item => item.type === 'function_call' ? { ...item, id: 'transport_item' } : item),
      usage: responsesUsage,
    },
    output: {
      id: 'fixture_response', object: 'chat.completion', created, model: 'fixture-model',
      choices: [{ index: 0, message: chatMessage, finish_reason: 'tool_calls' }], usage: chatUsage,
    },
  },
  {
    name: 'Messages JSON to Chat: text concatenation, function IDs and cache usage',
    contract: 'messages-to-chat-return',
    features: ['message_text', 'function_tools', 'usage', 'finish_reasons'],
    input: {
      id: 'fixture_message', model: 'fixture-model', stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: '🌍' }, { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }],
      usage: { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 },
    },
    output: {
      id: 'fixture_message', object: 'chat.completion', created, model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello 🌍', tool_calls: chatMessage.tool_calls }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 } },
    },
  },
];

for (const finish of ['stop', 'length', 'content_filter']) {
  cases.push({
    name: `Chat JSON finish: ${finish}`, contract: 'chat-to-responses-return', features: ['finish_reasons'],
    input: { id: 'fixture_chat', created, model: 'fixture-model', choices: [{ message: { content: 'text' }, finish_reason: finish }], usage: {} },
    output: {
      id: 'fixture_chat', object: 'response', created_at: created, model: 'fixture-model',
      status: finish === 'stop' ? 'completed' : 'incomplete',
      ...(finish === 'stop' ? {} : { incomplete_details: { reason: finish === 'length' ? 'max_output_tokens' : 'content_filter' } }),
      output: [{ type: 'message', id: 'msg_0', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'text', annotations: [] }] }],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });
}

for (const [status, reason, finish] of [['completed', undefined, 'stop'], ['incomplete', 'max_output_tokens', 'length'], ['incomplete', 'content_filter', 'content_filter']]) {
  cases.push({
    name: `Responses JSON finish: ${finish}`, contract: 'responses-to-chat-return', features: ['finish_reasons', 'usage'],
    input: { id: 'fixture_response', created_at: created, model: 'fixture-model', status, ...(reason ? { incomplete_details: { reason } } : {}), output: [], usage: {} },
    output: {
      id: 'fixture_response', object: 'chat.completion', created, model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: finish }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  });
}

for (const [stop_reason, finish] of [
  ['end_turn', 'stop'], ['stop_sequence', 'stop'], ['max_tokens', 'length'],
  ['model_context_window_exceeded', 'length'], ['refusal', 'content_filter'],
]) {
  cases.push({
    name: `Messages JSON finish: ${stop_reason}`, contract: 'messages-to-chat-return', features: ['finish_reasons', 'usage'],
    input: { id: 'fixture_message', model: 'fixture-model', stop_reason, content: [], usage: {} },
    output: {
      id: 'fixture_message', object: 'chat.completion', created, model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: finish }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
  });
}

module.exports = { cases, chatUsage, responsesUsage, created };
