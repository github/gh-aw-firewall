'use strict';

const { chatUsage, responsesUsage, created } = require('./responses');

function frame(value) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

const chatFrames = [
  { id: 'fixture_chat', model: 'fixture-model', choices: [{ delta: { role: 'assistant', content: 'hello ' } }] },
  { choices: [{ delta: { content: '🌍', refusal: 'cannot ' } }] },
  { choices: [{ delta: { refusal: 'do that', tool_calls: [
    { index: 0, id: 'call_1', type: 'function', function: { name: 'look', arguments: '{"q":' } },
    { index: 1, id: 'call_2', type: 'function', function: { name: 'second', arguments: '{' } },
  ] } }] },
  { choices: [{ delta: { tool_calls: [
    { index: 1, function: { arguments: '}' } },
    { index: 0, function: { name: 'up', arguments: '"x"}' } },
  ] }, finish_reason: 'tool_calls' }] },
  { choices: [], usage: chatUsage },
];
const responsesFrames = [
  { type: 'response.created', response: { id: 'fixture_response', model: 'fixture-model', created_at: created } },
  { type: 'response.output_text.delta', delta: 'hello ' },
  { type: 'response.output_text.delta', delta: '🌍' },
  { type: 'response.refusal.delta', delta: 'cannot do that' },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'lookup' } },
  { type: 'response.output_item.added', item: { type: 'function_call', id: 'item_2', call_id: 'call_2', name: 'second' } },
  { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"q":' },
  { type: 'response.function_call_arguments.delta', item_id: 'item_2', delta: '{}' },
  { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '"x"}' },
  { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call' }], usage: responsesUsage } },
];
const anthropicFrames = [
  { type: 'message_start', message: { id: 'fixture_message', model: 'fixture-model', usage: { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'hello ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '🌍' } },
  { type: 'content_block_start', index: 7, content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} } },
  { type: 'content_block_start', index: 9, content_block: { type: 'tool_use', id: 'call_2', name: 'second', input: {} } },
  { type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
  { type: 'content_block_delta', index: 9, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: '"x"}' } },
  { type: 'content_block_stop', index: 7 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
  { type: 'message_stop' },
];
const calls = [
  { id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
  { id: 'call_2', name: 'second', arguments: '{}' },
];

const cases = [
  {
    name: 'Chat SSE assembles partial text, refusal, parallel tool calls, usage and completion',
    contract: 'chat-to-responses-return', features: ['streaming', 'message_text', 'function_tools', 'usage', 'finish_reasons', 'refusal'],
    input: chatFrames.map(frame).join('') + 'data: [DONE]\n\n',
    summary: { text: 'hello 🌍', refusal: 'cannot do that', calls, finish: 'tool_calls', usage: responsesUsage, done: true, errors: [] },
  },
  {
    name: 'Responses SSE emits text, refusal, indexed tool deltas, usage and DONE',
    contract: 'responses-to-chat-return', features: ['streaming', 'message_text', 'function_tools', 'usage', 'finish_reasons', 'refusal'],
    input: responsesFrames.map(frame).join(''), includeUsage: true,
    summary: { text: 'hello 🌍', refusal: 'cannot do that', calls, finish: 'tool_calls', usage: chatUsage, done: true, errors: [] },
  },
  {
    name: 'Messages SSE emits text, indexed parallel tool deltas, cache usage and DONE',
    contract: 'messages-to-chat-return', features: ['streaming', 'message_text', 'function_tools', 'usage', 'finish_reasons'],
    input: anthropicFrames.map(frame).join(''), includeUsage: true,
    summary: {
      text: 'hello 🌍', refusal: '', calls, finish: 'tool_calls',
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 } }, done: true, errors: [],
    },
  },
];

for (const [contract, event, expectedError] of [
  ['chat-to-responses-return', { error: { code: 'fixture_error', message: 'upstream failed' } }, { code: 'fixture_error', message: 'upstream failed' }],
  ['responses-to-chat-return', { type: 'response.failed', response: { error: { code: 'fixture_error', message: 'upstream failed' } } },
    { type: 'response.failed', response: { error: { code: 'fixture_error', message: 'upstream failed' } } }],
  ['messages-to-chat-return', { type: 'error', error: { type: 'fixture_error', message: 'upstream failed' } },
    { type: 'fixture_error', message: 'upstream failed' }],
]) {
  cases.push({
    name: `${contract}: upstream error without synthetic completion`,
    contract, features: ['streaming'], input: frame(event),
    summary: { text: '', refusal: '', calls: [], finish: null, usage: undefined, done: false, errors: [expectedError] },
  });
}

const gaps = [
  {
    name: 'Responses SSE drops initial function-call arguments and ignores the final item',
    contract: 'responses-to-chat-return',
    input: [
      { type: 'response.created', response: { id: 'fixture_response', model: 'fixture-model', created_at: created } },
      { type: 'response.output_item.added', item: {
        type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"initial"}',
      } },
      { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"q":"delta"}' },
      { type: 'response.completed', response: { status: 'completed', output: [
        { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'lookup', arguments: '{"q":"final"}' },
      ] } },
    ].map(frame).join(''),
    calls: [{ id: 'call_1', name: 'lookup', arguments: '{"q":"delta"}' }],
  },
];

module.exports = { cases, gaps, frame, chatFrames, responsesFrames, anthropicFrames };
