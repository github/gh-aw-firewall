'use strict';

const { PassThrough } = require('stream');
const {
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  ProtocolTranslationError,
  chatRequestToAnthropic,
  anthropicResponseToChat,
  anthropicUsageToChat,
  createAnthropicToChatSseTransform,
  finishReasonFromStopReason,
} = require('./anthropic-chat-compat');

function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

async function runTransform(transform, input, chunkSize = 13) {
  const source = new PassThrough();
  let output = '';
  const done = new Promise((resolve, reject) => {
    source.pipe(transform);
    transform.on('data', (chunk) => { output += chunk.toString('utf8'); });
    transform.on('end', resolve);
    transform.on('error', reject);
  });
  for (let i = 0; i < input.length; i += chunkSize) source.write(input.slice(i, i + chunkSize));
  source.end();
  await done;
  return output;
}

function parseChatChunks(output) {
  return output
    .split('\n\n')
    .map(frame => frame.trim())
    .filter(frame => frame.startsWith('data: '))
    .map(frame => frame.slice('data: '.length))
    .map(data => (data === '[DONE]' ? data : JSON.parse(data)));
}

describe('chatRequestToAnthropic', () => {
  it('translates system prompts, tool calls, tool results, and tools', () => {
    const result = chatRequestToAnthropic({
      model: 'claude-sonnet-4.6',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'developer', content: [{ type: 'text', text: 'Use tools.' }] },
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: 'Checking.',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
      tools: [{ type: 'function', function: { name: 'weather', description: 'Get weather', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      parallel_tool_calls: false,
      max_completion_tokens: 512,
      temperature: 1.7,
      stop: 'END',
      stream: true,
      stream_options: { include_usage: true },
      user: 'agent-1',
    });

    expect(result).toEqual({
      model: 'claude-sonnet-4.6',
      system: 'Be terse.\n\nUse tools.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What is the weather?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Paris' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }] },
      ],
      max_tokens: 512,
      temperature: 1,
      stop_sequences: ['END'],
      stream: true,
      metadata: { user_id: 'agent-1' },
      tools: [{ name: 'weather', description: 'Get weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
    });
  });

  it('defaults max_tokens because the Messages API requires it', () => {
    const result = chatRequestToAnthropic({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.max_tokens).toBe(DEFAULT_ANTHROPIC_MAX_TOKENS);
  });

  it('maps a named tool_choice to an Anthropic tool choice', () => {
    const result = chatRequestToAnthropic({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    });
    expect(result.tool_choice).toEqual({ type: 'tool', name: 'lookup' });
  });

  it.each([
    ['n', { n: 2 }],
    ['response_format', { response_format: { type: 'json_schema', json_schema: {} } }],
    ['logprobs', { logprobs: true }],
    ['audio', { audio: { voice: 'x' } }],
  ])('rejects the unsupported %s field instead of silently changing the request', (feature, extra) => {
    expect(() => chatRequestToAnthropic({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra }))
      .toThrow(ProtocolTranslationError);
    try {
      chatRequestToAnthropic({ model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra });
    } catch (err) {
      expect(err.code).toBe('unsupported_protocol_feature');
      expect(err.feature).toBe(feature);
    }
  });
});

describe('anthropicResponseToChat', () => {
  it('translates text, tool_use blocks, stop reason, and usage', () => {
    const translated = anthropicResponseToChat(Buffer.from(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4.6',
      content: [
        { type: 'text', text: 'Calling.' },
        { type: 'tool_use', id: 'toolu_1', name: 'weather', input: { city: 'Paris' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 6 },
    })));
    const chat = JSON.parse(translated.toString('utf8'));
    expect(chat).toMatchObject({
      id: 'msg_1',
      object: 'chat.completion',
      model: 'claude-sonnet-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Calling.',
          tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 14, completion_tokens: 6, total_tokens: 20, prompt_tokens_details: { cached_tokens: 4 } },
    });
  });

  it('returns null for bodies that are not Messages responses', () => {
    expect(anthropicResponseToChat(Buffer.from('{"error":{}}'))).toBeNull();
    expect(anthropicResponseToChat(Buffer.from('not json'))).toBeNull();
  });
});

describe('anthropicUsageToChat / finishReasonFromStopReason', () => {
  it('counts cache writes and reads as prompt tokens', () => {
    expect(anthropicUsageToChat({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }))
      .toEqual({ prompt_tokens: 6, completion_tokens: 4, total_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } });
    expect(anthropicUsageToChat(null)).toBeUndefined();
  });

  it.each([
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'length'],
    ['refusal', 'content_filter'],
    ['end_turn', 'stop'],
    [null, 'stop'],
  ])('maps %s to %s', (stopReason, finishReason) => {
    expect(finishReasonFromStopReason(stopReason)).toBe(finishReason);
  });
});

describe('createAnthropicToChatSseTransform', () => {
  const STREAM = [
    sse('message_start', { message: { id: 'msg_1', model: 'claude-sonnet-4.6', usage: { input_tokens: 7, output_tokens: 0 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'weather', input: {} } }),
    sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } }),
    sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
    sse('message_stop', {}),
  ].join('');

  it('streams text and tool-call deltas as chat completion chunks', async () => {
    const chunks = parseChatChunks(await runTransform(createAnthropicToChatSseTransform({ includeUsage: true }), STREAM));
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
    const objects = chunks.filter(chunk => chunk !== '[DONE]');
    expect(objects.every(chunk => chunk.object === 'chat.completion.chunk' && chunk.id === 'msg_1')).toBe(true);

    const text = objects.map(chunk => chunk.choices[0]?.delta?.content || '').join('');
    expect(text).toBe('Hello');

    const toolDeltas = objects.flatMap(chunk => chunk.choices[0]?.delta?.tool_calls || []);
    expect(toolDeltas[0]).toMatchObject({ index: 0, id: 'toolu_1', type: 'function', function: { name: 'weather' } });
    expect(toolDeltas.map(delta => delta.function.arguments || '').join('')).toBe('{"city":"Paris"}');

    expect(objects.find(chunk => chunk.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    expect(objects[objects.length - 1]).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
    });
  });

  it('omits the usage chunk unless requested', async () => {
    const chunks = parseChatChunks(await runTransform(createAnthropicToChatSseTransform({ includeUsage: false }), STREAM));
    expect(chunks.filter(chunk => chunk !== '[DONE]' && chunk.usage)).toHaveLength(0);
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
  });

  it('forwards upstream stream errors as an OpenAI-style error event', async () => {
    const output = await runTransform(
      createAnthropicToChatSseTransform({ includeUsage: false }),
      sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
    );
    const chunks = parseChatChunks(output);
    expect(chunks[0]).toMatchObject({ error: { message: 'Overloaded', type: 'overloaded_error' } });
  });
});
