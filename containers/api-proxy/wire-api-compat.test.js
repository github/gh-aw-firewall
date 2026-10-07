'use strict';

const { once } = require('events');
const {
  translateCopilotWireApi,
  replaceUpstreamEndpoint,
  transformWireApiResponseBody,
  createWireApiSseTransform,
} = require('./wire-api-compat');
const { createBodyHandler } = require('./body-handler');
const {
  parseProviderModelMetadata,
  replaceRuntimeModels,
  clearRuntimeModels,
} = require('./runtime-model-catalog');

function buffer(value) {
  return Buffer.from(JSON.stringify(value));
}

function json(value) {
  return JSON.parse(value.toString('utf8'));
}

function setModels() {
  replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
    data: [
      { id: 'claude-sonnet-5', supported_endpoints: ['/chat/completions'] },
      { id: 'gpt-5.4-mini', supported_endpoints: ['/responses'] },
      { id: 'both', supported_endpoints: ['/responses', '/chat/completions'] },
    ],
  }));
}

async function collect(transform, text) {
  const chunks = [];
  transform.on('data', chunk => chunks.push(chunk.toString('utf8')));
  transform.end(text);
  await once(transform, 'end');
  return chunks.join('');
}

describe('Copilot wire API compatibility', () => {
  beforeEach(setModels);
  afterEach(() => clearRuntimeModels());

  test('translates Chat Completions requests to Responses for Responses-only models', () => {
    const translated = translateCopilotWireApi(buffer({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: 'system rules' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', tool_calls: [{
          id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' },
        }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' },
      ],
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      reasoning_effort: 'high',
      max_completion_tokens: 4096,
      stream: true,
    }), '/v1/chat/completions');

    expect(translated.compatibility).toEqual({
      requestedEndpoint: '/chat/completions',
      upstreamEndpoint: '/responses',
      direction: 'chat_to_responses',
      includeUsage: false,
    });
    expect(json(translated.body)).toEqual({
      model: 'gpt-5.4-mini',
      input: [
        { role: 'user', content: 'hello' },
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'found' },
      ],
      instructions: 'system rules',
      tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }],
      reasoning: { effort: 'high' },
      max_output_tokens: 4096,
      stream: true,
    });
    expect(replaceUpstreamEndpoint('/v1/chat/completions?foo=1', translated.compatibility.upstreamEndpoint))
      .toBe('/v1/responses?foo=1');
  });

  test('translates Responses requests to Chat Completions for Chat-only models', () => {
    const translated = translateCopilotWireApi(buffer({
      model: 'claude-sonnet-5',
      instructions: 'be concise',
      input: [
        { role: 'user', content: 'hello' },
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'found' },
      ],
      tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }],
      reasoning: { effort: 'medium' },
      max_output_tokens: 2048,
      stream: false,
    }), '/responses');

    expect(translated.compatibility).toEqual({
      requestedEndpoint: '/responses',
      upstreamEndpoint: '/chat/completions',
      direction: 'responses_to_chat',
    });
    expect(json(translated.body)).toEqual({
      model: 'claude-sonnet-5',
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant', content: null, tool_calls: [{
            id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' },
      ],
      tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      reasoning_effort: 'medium',
      max_tokens: 2048,
      stream: false,
    });
  });

  test('accepts canonical Responses assistant output in a subsequent translated turn', () => {
    const previousOutput = [{
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: 'hello',
        annotations: [],
      }],
    }];
    const translated = translateCopilotWireApi(buffer({
      model: 'claude-sonnet-5',
      input: [
        { role: 'user', content: 'say hello' },
        ...previousOutput,
      ],
    }), '/responses');

    expect(json(translated.body).messages).toEqual([
      { role: 'user', content: 'say hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  test('preserves assistant text before translated tool calls', () => {
    const translated = translateCopilotWireApi(buffer({
      model: 'gpt-5.4-mini',
      messages: [
        {
          role: 'assistant',
          content: 'Searching now',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{}' },
          }],
        },
      ],
    }), '/chat/completions');

    expect(json(translated.body).input).toEqual([
      { role: 'assistant', content: 'Searching now' },
      { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
    ]);
  });

  test('requests upstream usage for translated streaming requests', () => {
    const translated = translateCopilotWireApi(buffer({
      model: 'claude-sonnet-5',
      input: 'hello',
      stream: true,
    }), '/responses');
    expect(json(translated.body)).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  test.each([
    ['an unknown model', { model: 'unknown', messages: [] }, '/chat/completions'],
    ['a model advertising both endpoints', { model: 'both', messages: [] }, '/chat/completions'],
    ['a model advertising neither requested nor alternate endpoint', { model: 'gpt-5.4-mini', input: 'hi' }, '/responses?x=1'],
  ])('passes through requests for %s unchanged', (_name, request, path) => {
    const body = buffer(request);
    expect(translateCopilotWireApi(body, path)).toBeNull();
  });

  test('keeps an already-supported request byte-for-byte unchanged in the body pipeline', async () => {
    const { transformRequestBody } = createBodyHandler({ handleRequestError() {}, otel: {} });
    const body = Buffer.from('{"model":"both","input":"hello","stream":false}');
    const result = await transformRequestBody(
      body,
      'copilot',
      { method: 'POST', url: '/responses' },
      'req-pass-through',
      null,
    );
    expect(result.body).toEqual(body);
    expect(result.wireApiCompatibility).toBeNull();
  });

  test.each([
    [{ model: 'claude-sonnet-5', input: 'hi', previous_response_id: 'resp_1' }, /previous_response_id/],
    [{ model: 'claude-sonnet-5', input: 'hi', tools: [{ type: 'browser_search' }] }, /tools\[browser_search\]/],
    [{ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }], stop: ['!'] }, /stop/],
  ])('fails clearly rather than dropping unsupported request features', (request, expected) => {
    expect(() => translateCopilotWireApi(buffer(request), request.model.startsWith('claude') ? '/responses' : '/chat/completions'))
      .toThrow(expected);
  });

  test('translates non-streaming responses and usage in both directions', () => {
    const chatCompatibility = { direction: 'responses_to_chat' };
    const asResponses = transformWireApiResponseBody(buffer({
      id: 'chatcmpl_1',
      model: 'claude-sonnet-5',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), chatCompatibility);
    expect(json(asResponses)).toMatchObject({
      id: 'chatcmpl_1',
      object: 'response',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });

    const asChat = transformWireApiResponseBody(buffer({
      id: 'resp_1',
      model: 'gpt-5.4-mini',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_2', name: 'search', arguments: '{}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }), { direction: 'chat_to_responses' });
    expect(json(asChat)).toMatchObject({
      id: 'resp_1',
      object: 'chat.completion',
      choices: [{
        message: {
          role: 'assistant',
          content: 'hello',
          tool_calls: [{ id: 'call_2', function: { name: 'search', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });

  test.each([
    ['responses_to_chat', [
      { id: 'chatcmpl_1', model: 'gpt-5.4-mini', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] },
      { id: 'chatcmpl_1', model: 'gpt-5.4-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'chatcmpl_1', model: 'gpt-5.4-mini', choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'],
    ['chat_to_responses', [
      { type: 'response.created', response: { id: 'resp_1', model: 'claude-sonnet-5', status: 'in_progress' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'hello' },
      { type: 'response.completed', response: { id: 'resp_1', model: 'claude-sonnet-5', output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')],
  ])('converts streaming %s responses, text, terminal status, and usage', async (direction, source) => {
    const result = await collect(createWireApiSseTransform({
      direction,
      includeUsage: true,
    }), source);
    if (direction === 'responses_to_chat') {
      expect(result).toContain('event: response.output_text.delta');
      expect(result).toContain('"delta":"hello"');
      expect(result).toContain('event: response.completed');
      expect(result).toContain('"input_tokens":2');
    } else {
      expect(result).toContain('"object":"chat.completion.chunk"');
      expect(result).toContain('"content":"hello"');
      expect(result).toContain('"prompt_tokens":2');
      expect(result).toContain('data: [DONE]');
    }
  });

  test('converts streaming function calls and arguments in both directions', async () => {
    const chatResponse = [
      {
        type: 'response.output_item.added', output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'search', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"q":"x"}',
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_1', model: 'claude-sonnet-5',
          output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1' }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const chatResult = await collect(
      createWireApiSseTransform({ direction: 'chat_to_responses', includeUsage: true }),
      chatResponse,
    );
    expect(chatResult).toContain('"index":0');
    expect(chatResult).toContain('"id":"call_1"');
    expect(chatResult).toContain('"arguments":"{\\"q\\":\\"x\\"}"');
    expect(chatResult).toContain('"finish_reason":"tool_calls"');
    expect(chatResult).toContain('"prompt_tokens":2');

    const responses = [
      {
        id: 'chatcmpl_1', model: 'gpt-5.4-mini',
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: 'call_2', type: 'function', function: { name: 'search', arguments: '{"q":' },
        }] }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_1', model: 'gpt-5.4-mini',
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, function: { arguments: '"x"}' },
        }] }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_1', model: 'gpt-5.4-mini',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
      {
        id: 'chatcmpl_1', model: 'gpt-5.4-mini',
        choices: [],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    const responsesResult = await collect(
      createWireApiSseTransform({ direction: 'responses_to_chat' }),
      responses,
    );
    expect(responsesResult).toContain('event: response.output_item.added');
    expect(responsesResult).toContain('event: response.function_call_arguments.delta');
    expect(responsesResult).toContain('"name":"search"');
    expect(responsesResult).toContain('"arguments":"{\\"q\\":\\"x\\"}"');
    expect(responsesResult).toContain('"output_tokens":1');
  });
});
