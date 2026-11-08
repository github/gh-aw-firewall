'use strict';

const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false };
const fn = { name: 'lookup', description: 'Lookup', parameters: schema, strict: true };
const chat = { model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }] };
const responses = { model: 'fixture-model', input: 'hello' };
const chatId = 'chat-to-responses-request';
const responsesId = 'responses-to-chat-request';
const anthropicId = 'chat-to-messages-request';
const commonFeatures = [
  'message_text', 'message_roles', 'function_tools', 'tool_choice',
  'parallel_tool_calls', 'structured_output', 'image_input', 'streaming',
  'reasoning_fields', 'token_limits', 'transport_fields',
];

const cases = [
  {
    name: 'Chat roles, strict schemas, images, calls/results, limits and transport',
    contract: chatId, features: commonFeatures,
    input: {
      ...chat,
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'developer', content: 'guidance' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'low' } }] },
        { role: 'assistant', content: 'checking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: { result: 'ok' } },
      ],
      tools: [{ type: 'function', function: fn }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      parallel_tool_calls: false, reasoning_effort: 'opaque-fixture-effort',
      max_tokens: 30, max_completion_tokens: 20, stream: true, stream_options: { include_usage: true }, n: 1,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } },
    },
    output: {
      model: 'fixture-model',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'https://example.test/a.png', detail: 'low' }] },
        { role: 'assistant', content: 'checking' },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"result":"ok"}' },
      ],
      instructions: 'rules\n\nguidance', tools: [{ type: 'function', ...fn }],
      tool_choice: { type: 'function', name: 'lookup' }, parallel_tool_calls: false,
      reasoning: { effort: 'opaque-fixture-effort' }, max_output_tokens: 20, stream: true,
      text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } },
    },
  },
  {
    name: 'Responses roles, IDs, strict schemas, images, calls/results and no-op fields',
    contract: responsesId, features: commonFeatures,
    input: {
      ...responses, instructions: 'rules',
      input: [
        { type: 'message', id: 'transport-id', status: 'completed', role: 'developer', content: 'guidance' },
        { content: [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'https://example.test/a.png', detail: 'low' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
        { type: 'function_call', id: 'item_1', status: 'completed', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '' },
        { type: 'function_call_output', call_id: 'call_1', output: { result: 'ok' } },
      ],
      tools: [{ type: 'function', ...fn }], tool_choice: { type: 'function', name: 'lookup' },
      parallel_tool_calls: true, reasoning: { effort: 'opaque-fixture-effort' },
      max_output_tokens: 20, stream: true, store: false, metadata: null, include: false,
      truncation: null, previous_response_id: false, prompt_cache_key: null,
      text: { format: { type: 'json_schema', name: 'answer', schema, strict: true } },
    },
    output: {
      model: 'fixture-model',
      messages: [
        { role: 'system', content: 'rules' }, { role: 'developer', content: 'guidance' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'low' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'checking' }] },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } },
          { id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"result":"ok"}' },
      ],
      tools: [{ type: 'function', function: fn }], tool_choice: { type: 'function', function: { name: 'lookup' } },
      parallel_tool_calls: true, reasoning_effort: 'opaque-fixture-effort', max_tokens: 20,
      stream: true, stream_options: { include_usage: true },
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } },
    },
  },
  {
    name: 'Messages role merging, function calls/results, images and transport no-ops',
    contract: anthropicId,
    features: ['message_text', 'message_roles', 'function_tools', 'tool_choice', 'parallel_tool_calls', 'image_input', 'streaming', 'token_limits', 'transport_fields', 'unknown_fields'],
    input: {
      ...chat, messages: [
        { role: 'system', content: 'rules' }, { role: 'developer', content: [{ type: 'text', text: 'guidance' }] },
        { role: 'user', content: '' },
        { role: 'user', content: 'hello' }, { role: 'user', content: [
          { type: 'image_url', image_url: 'https://example.test/a.png' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
        ] },
        { role: 'assistant', content: 'checking', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'ok' }, { type: 'text', text: '!' }] },
      ],
      tools: [{ type: 'function', function: fn }], tool_choice: 'required',
      parallel_tool_calls: false, max_tokens: 30, max_completion_tokens: 20,
      temperature: 0.5, top_p: 0.9, stop: ['END'], stream: true, user: 'fixture-user',
      stream_options: { include_usage: true }, n: 1, logprobs: false, response_format: { type: 'text' }, future_field: null,
    },
    output: {
      model: 'fixture-model', system: 'rules\n\nguidance',
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'hello' },
          { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } },
        ] },
        { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok!' }] },
      ],
      max_tokens: 20, temperature: 0.5, top_p: 0.9, stop_sequences: ['END'], stream: true,
      metadata: { user_id: 'fixture-user' },
      tools: [{ name: 'lookup', description: 'Lookup', strict: true, input_schema: schema }],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
    },
  },
];

for (const [contract, base, field] of [[chatId, chat, 'response_format'], [responsesId, responses, 'text']]) {
  cases.push({
    name: `${contract}: json_object`, contract, features: ['structured_output'],
    input: { ...base, [field]: contract === chatId ? { type: 'json_object' } : { format: { type: 'json_object' } } },
    output: contract === chatId
      ? { model: base.model, input: [{ role: 'user', content: 'hello' }], text: { format: { type: 'json_object' } } }
      : { model: base.model, messages: [{ role: 'user', content: 'hello' }], response_format: { type: 'json_object' } },
  });
}

for (const max_tokens of [undefined, 0, -1, 1.5]) {
  cases.push({
    name: `Messages limit default: ${max_tokens}`, contract: anthropicId, features: ['token_limits'],
    input: { ...chat, max_tokens },
    output: { model: chat.model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], max_tokens: 8192 },
  });
}

for (const choice of ['auto', 'none', 'required', { type: 'function', function: { name: 'lookup' } }]) {
  const mapped = typeof choice === 'object' ? { type: 'tool', name: 'lookup' } : { type: choice === 'required' ? 'any' : choice };
  cases.push({
    name: `Messages tool choice: ${mapped.type}`, contract: anthropicId, features: ['tool_choice', 'parallel_tool_calls', 'function_tools'],
    input: { ...chat, tools: [{ type: 'function', function: { name: 'lookup' } }], tool_choice: choice, parallel_tool_calls: false },
    output: {
      model: chat.model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], max_tokens: 8192,
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { ...mapped, ...(mapped.type === 'none' ? {} : { disable_parallel_tool_use: true }) },
    },
  });
}

const rejections = [];
function reject(contract, input, feature, evidence) {
  rejections.push({
    name: `${contract}: rejects ${feature}`, contract, features: [evidence], input,
    error: { code: contract === anthropicId ? 'unsupported_protocol_feature' : 'unsupported_wire_api_feature', feature },
  });
}

for (const [contract, base] of [[chatId, chat], [responsesId, responses], [anthropicId, chat]]) {
  reject(contract, { ...base, tools: [{ type: 'web_search' }] }, 'tools[web_search]', 'hosted_tools');
  reject(contract, { ...base, tools: [{ type: 'custom', name: 'run' }] }, 'tools[custom]', 'hosted_tools');
  reject(contract, { ...base, audio: { voice: 'fixture' } }, 'audio', 'audio');
  reject(contract, { ...base, future_feature: true }, 'future_feature', 'unknown_fields');
  reject(contract, { ...base, previous_response_id: 'resp_previous' }, 'previous_response_id', 'stateful_fields');
  for (const [type, evidence] of [['input_audio', 'audio'], ['video', 'other_modalities'], ['reasoning', 'reasoning_content'], ['future_content', 'other_modalities']]) {
    const input = contract === responsesId
      ? { ...base, input: [{ role: 'user', content: [{ type }] }] }
      : { ...base, messages: [{ role: 'user', content: [{ type }] }] };
    const feature = contract === responsesId ? `input.content[${type}]`
      : contract === chatId ? `messages.content[${type}]` : `messages[user].content[${type}]`;
    reject(contract, input, feature, evidence);
  }
}

for (const field of ['store', 'metadata', 'truncation', 'include', 'prompt_cache_key']) {
  reject(responsesId, { ...responses, [field]: field === 'store' ? true : 'active' }, field, 'stateful_fields');
}
reject(chatId, { ...chat, store: true }, 'store', 'stateful_fields');
reject(chatId, { ...chat, n: 2 }, 'n', 'transport_fields');
reject(chatId, { ...chat, stream_options: { include_usage: 'yes' } }, 'stream_options.include_usage', 'transport_fields');
reject(chatId, { ...chat, stream_options: { future_option: true } }, 'future_option', 'transport_fields');
reject(chatId, { ...chat, response_format: { type: 'text' } }, 'response_format', 'structured_output');
reject(chatId, { ...chat, messages: [{ role: 'system', content: [{ type: 'text', text: 'rules' }] }] }, 'messages[system].content', 'message_roles');
reject(responsesId, { ...responses, input: [{ type: 'reasoning', encrypted_content: 'fixture' }] }, 'input[0].type=reasoning', 'reasoning_content');
reject(responsesId, { ...responses, reasoning: { summary: 'auto' } }, 'reasoning.summary', 'reasoning_fields');
reject(responsesId, { ...responses, reasoning: { encrypted_content: 'fixture' } }, 'reasoning.encrypted_content', 'reasoning_fields');
reject(responsesId, { ...responses, reasoning: { future_reasoning: true } }, 'future_reasoning', 'reasoning_fields');
reject(responsesId, { ...responses, input: [{ type: 'function_call', name: 'lookup', arguments: '{}' }] }, 'input[0].call_id', 'function_tools');
for (const contract of [chatId, anthropicId]) {
  reject(contract, { ...chat, messages: [{ role: 'tool', content: 'ok' }] }, 'messages[tool].tool_call_id', 'function_tools');
  reject(contract, { ...chat, messages: [{ role: 'future_role', content: 'hello' }] }, 'messages[future_role]', 'message_roles');
}
reject(anthropicId, { ...chat, reasoning_effort: 'opaque-fixture-effort' }, 'reasoning_effort', 'reasoning_fields');
reject(anthropicId, { ...chat, response_format: { type: 'json_schema', json_schema: { schema, strict: true } } }, 'response_format', 'structured_output');
reject(anthropicId, { ...chat, response_format: { type: 'json_object' } }, 'response_format', 'structured_output');
reject(anthropicId, { ...chat, tool_choice: 'required' }, 'tool_choice', 'tool_choice');
reject(anthropicId, { ...chat, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'http://example.test/a.png' }] }] }, 'messages.content[image_url]', 'image_input');
reject(anthropicId, { ...chat, messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '[1]' } }] }] }, 'messages.tool_calls.function.arguments', 'function_tools');

module.exports = { cases: [...cases, ...rejections], chat, responses };
