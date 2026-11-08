'use strict';

/**
 * Existing semantic discrepancies, not declarations of supported translation.
 * Reviewed enforcement/translator changes are deferred to Phase 6 (#10296).
 */
module.exports = [
  {
    name: 'Messages drops image detail, text cache_control and unknown nested message fields',
    contract: 'chat-to-messages-request', feature: 'cache_controls',
    input: {
      model: 'fixture-model', messages: [{ role: 'user', future_field: 'fixture', content: [
        { type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
        { type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'high' } },
      ] }],
    },
    output: {
      model: 'fixture-model', max_tokens: 8192,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'hello' },
        { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
      ] }],
    },
  },
  {
    name: 'Messages clamps temperature, filters non-string stops and appends refusal as text',
    contract: 'chat-to-messages-request', feature: 'sampling_out_of_range',
    input: {
      model: 'fixture-model', messages: [{ role: 'assistant', content: 'hello', refusal: 'no' }],
      temperature: 1.7, stop: ['END', 42],
    },
    output: {
      model: 'fixture-model', max_tokens: 8192, temperature: 1, stop_sequences: ['END'],
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'no' }] }],
    },
  },
  {
    name: 'Chat wire drops unknown outer tool fields while mapping known function fields',
    contract: 'chat-to-responses-request', feature: 'nested_tool_metadata',
    input: {
      model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', future_field: 'fixture', function: { name: 'lookup' } }],
    },
    output: { model: 'fixture-model', input: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', name: 'lookup' }] },
  },
  {
    name: 'Responses request drops output_text annotations and format description',
    contract: 'responses-to-chat-request', feature: 'output_annotations',
    input: {
      model: 'fixture-model', input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [{ type: 'fixture' }] }] }],
      text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, description: 'fixture' } },
    },
    output: {
      model: 'fixture-model', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } },
    },
  },
  {
    name: 'Chat JSON return uses first choice and ignores reasoning content',
    contract: 'chat-to-responses-return', feature: 'reasoning_content',
    input: {
      id: 'fixture_chat', created: 1700000000, model: 'fixture-model',
      choices: [{ message: { content: 'hello', reasoning_content: 'fixture reasoning' }, finish_reason: 'stop' }, { message: { content: 'lost second choice' } }],
    },
    output: {
      id: 'fixture_chat', object: 'response', created_at: 1700000000, model: 'fixture-model', status: 'completed',
      output: [{ type: 'message', id: 'msg_0', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
    },
  },
  {
    name: 'Responses JSON return ignores reasoning, unknown items and output annotations',
    contract: 'responses-to-chat-return', feature: 'reasoning_content',
    input: {
      id: 'fixture_response', created_at: 1700000000, model: 'fixture-model', status: 'completed',
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'fixture reasoning' }] }, { type: 'future_item' },
        { type: 'message', content: [{ type: 'output_text', text: 'hello', annotations: [{ type: 'fixture' }] }] }],
    },
    output: {
      id: 'fixture_response', object: 'chat.completion', created: 1700000000, model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    },
  },
  {
    name: 'Responses JSON return keeps only the last of multiple refusal parts',
    contract: 'responses-to-chat-return', feature: 'multiple_refusal_parts',
    input: {
      id: 'fixture_response', created_at: 1700000000, model: 'fixture-model', status: 'completed',
      output: [{ type: 'message', content: [
        { type: 'refusal', refusal: 'lost first refusal' }, { type: 'refusal', refusal: 'last refusal' },
      ] }],
    },
    output: {
      id: 'fixture_response', object: 'chat.completion', created: 1700000000, model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'last refusal' }, finish_reason: 'stop' }],
    },
  },
  {
    name: 'Messages JSON return ignores thinking, signatures and future output blocks',
    contract: 'messages-to-chat-return', feature: 'reasoning_content',
    input: {
      id: 'fixture_message', model: 'fixture-model', stop_reason: 'future_stop',
      content: [{ type: 'thinking', thinking: 'fixture reasoning', signature: 'fixture' }, { type: 'future_block' }, { type: 'text', text: 'hello' }],
    },
    output: {
      id: 'fixture_message', object: 'chat.completion', created: 1700000000, model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    },
  },
];
