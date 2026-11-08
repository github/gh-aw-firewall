'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { CONTRACTS, FEATURES, REVISION, assessFeature } = require('./protocol-compatibility');
const wire = require('./wire-api-compat');
const anthropic = require('./anthropic-chat-compat');
const requests = require('./fixtures/protocol-compatibility/requests');
const responses = require('./fixtures/protocol-compatibility/responses');
const streams = require('./fixtures/protocol-compatibility/streams');
const gaps = require('./fixtures/protocol-compatibility/gaps');

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function requestTranslator(id) {
  switch (id) {
    case 'chat-to-responses-request': return wire.translateChatRequest;
    case 'responses-to-chat-request': return wire.translateResponsesRequest;
    case 'chat-to-messages-request': return anthropic.chatRequestToAnthropic;
    default: throw new Error('Fixture has no implemented request direction');
  }
}

function wireReturnContext(id, includeUsage) {
  switch (id) {
    // The existing wire context names the REQUEST direction, not this return direction.
    case 'chat-to-responses-return': return { direction: 'responses_to_chat' };
    case 'responses-to-chat-return': return { direction: 'chat_to_responses', includeUsage };
    default: throw new Error('Fixture has no implemented wire return direction');
  }
}

function responseTranslator(id, body) {
  return id === 'messages-to-chat-return'
    ? anthropic.anthropicResponseToChat(body)
    : wire.transformWireApiResponseBody(body, wireReturnContext(id));
}

function streamTranslator(id, includeUsage = false) {
  return id === 'messages-to-chat-return'
    ? anthropic.createAnthropicToChatSseTransform({ includeUsage })
    : wire.createWireApiSseTransform(wireReturnContext(id, includeUsage));
}

async function collectStream(id, input, chunkSize, includeUsage = false) {
  const transform = streamTranslator(id, includeUsage);
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    transform.on('data', chunk => chunks.push(chunk));
    transform.on('end', resolve);
    transform.on('error', reject);
  });
  const bytes = Buffer.from(input);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    transform.write(bytes.subarray(offset, offset + chunkSize));
  }
  transform.end();
  await done;
  return Buffer.concat(chunks).toString('utf8');
}

function parseFrames(output) {
  return output.split(/\r?\n\r?\n/).filter(Boolean).map(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}

function summarize(frames) {
  const result = { text: '', refusal: '', calls: [], finish: null, usage: undefined, done: false, errors: [] };
  const calls = new Map();
  for (const event of frames) {
    if (event === '[DONE]') { result.done = true; continue; }
    if (event.error) { result.errors.push(event.error); continue; }
    if (event.type === 'response.completed') {
      result.done = true;
      result.usage = event.response.usage;
      for (const item of event.response.output) {
        if (item.type === 'message') {
          expect(item.role).toBe('assistant');
          for (const part of item.content) {
            if (part.type === 'output_text') result.text += part.text;
            if (part.type === 'refusal') result.refusal += part.refusal;
          }
        } else if (item.type === 'function_call') {
          result.calls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
          expect(item.id).toBe(item.call_id);
        }
      }
      result.finish = result.calls.length ? 'tool_calls' : event.response.status === 'incomplete'
        ? event.response.incomplete_details.reason === 'content_filter' ? 'content_filter' : 'length'
        : 'stop';
    }
    if (event.choices) {
      if (event.usage) result.usage = event.usage;
      for (const choice of event.choices) {
        if (choice.finish_reason) result.finish = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.role) expect(delta.role).toBe('assistant');
        result.text += delta.content || '';
        result.refusal += delta.refusal || '';
        for (const call of delta.tool_calls || []) {
          const previous = calls.get(call.index) || { id: undefined, name: '', arguments: '' };
          if (call.id) previous.id = call.id;
          previous.name += call.function?.name || '';
          previous.arguments += call.function?.arguments || '';
          calls.set(call.index, previous);
        }
      }
    }
  }
  if (calls.size) result.calls = [...calls.values()];
  return result;
}

describe('directed protocol compatibility contracts', () => {
  test('enumerates only implemented request and return directions', () => {
    expect(CONTRACTS.map(({ source, target, direction }) => [source, target, direction])).toEqual([
      ['chat_completions', 'responses', 'request'],
      ['responses', 'chat_completions', 'request'],
      ['chat_completions', 'anthropic_messages', 'request'],
      ['chat_completions', 'responses', 'return_response'],
      ['responses', 'chat_completions', 'return_response'],
      ['anthropic_messages', 'chat_completions', 'return_response'],
    ]);
    expect(new Set(CONTRACTS.map(contract => contract.id)).size).toBe(CONTRACTS.length);
    for (const contract of CONTRACTS) {
      expect(contract.features.map(row => row.feature)).toEqual(FEATURES);
      expect(contract.revision).toBe(REVISION);
      for (const row of contract.features) {
        expect(row.reason.length).toBeGreaterThan(0);
        if (row.status === 'conditional') expect(row.conditions.length).toBeGreaterThan(0);
      }
    }
  });

  test('pins evidence to the actual implementation bytes and exported boundaries', () => {
    for (const contract of CONTRACTS) {
      const implementationPath = path.join(__dirname, contract.implementation.file);
      const hash = createHash('sha256').update(fs.readFileSync(implementationPath)).digest('hex');
      expect(hash).toBe(contract.implementation.sha256);
      const implementation = require(implementationPath);
      for (const name of contract.entryPoints) expect(typeof implementation[name]).toBe('function');
    }
  });

  test('documentation matrix agrees with every executable feature row', () => {
    const documentation = fs.readFileSync(path.resolve(__dirname, '../../docs/api-proxy-sidecar.md'), 'utf8');
    const statuses = { supported: 'S', conditional: 'C', rejected: 'R', unknown: 'U' };
    for (const feature of FEATURES) {
      const line = documentation.split('\n').find(candidate => candidate.startsWith(`| \`${feature}\` |`));
      expect(line).toBeDefined();
      const cells = line.split('|').slice(2, -1).map(cell => cell.trim());
      expect(cells).toEqual([0, 1, 2, 3, 5].map(index =>
        statuses[CONTRACTS[index].features.find(row => row.feature === feature).status]));
      expect(CONTRACTS[3].features.find(row => row.feature === feature).status)
        .toBe(CONTRACTS[4].features.find(row => row.feature === feature).status);
    }
  });

  test('assessment is immutable, deterministic and does not consult model discovery', () => {
    const discovery = jest.spyOn(require('./runtime-model-catalog'), 'findRuntimeModel');
    const query = deepFreeze({
      source: 'chat_completions', target: 'responses', direction: 'request', feature: 'function_tools',
    });
    const first = assessFeature(query);
    expect(assessFeature(query)).toEqual(first);
    expect(first.status).toBe('conditional');
    expect(discovery).not.toHaveBeenCalled();
    expect(() => { first.status = 'supported'; }).toThrow(TypeError);
    expect(() => { first.evidence.conditions.push('anything'); }).toThrow(TypeError);
    expect(() => { first.contract.implementation.sha256 = 'anything'; }).toThrow(TypeError);
    expect(() => { CONTRACTS.push(first.contract); }).toThrow(TypeError);
    discovery.mockRestore();
  });

  test.each([
    ['anthropic_messages', 'chat_completions', 'request', 'message_text'],
    ['responses', 'anthropic_messages', 'request', 'message_text'],
    ['chat_completions', 'anthropic_messages', 'return_response', 'message_text'],
    ['chat_completions', 'chat_completions', 'request', 'message_text'],
    ['chat_completions', 'responses', 'request', 'future_feature_with_private_value'],
    ['chat_completions', 'responses', 'return_response', 'reasoning_content'],
    ['anthropic_messages', 'chat_completions', 'return_response', 'image_input'],
  ])('does not infer compatibility for %s → %s %s %s', (source, target, direction, feature) => {
    const result = assessFeature({ source, target, direction, feature });
    expect(result.status).toBe('unknown');
    expect(result).not.toHaveProperty('compatible');
    expect(result.reason).not.toContain('private_value');
  });

  test('missing assessment input does not imply compatibility', () => {
    expect(assessFeature().status).toBe('unknown');
    expect(assessFeature(null).status).toBe('unknown');
    expect(assessFeature(42).status).toBe('unknown');
  });
});

describe('pre-existing semantic gaps are evidence, not support claims (Phase 6 #10296)', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(responses.created * 1000));
  afterEach(() => jest.restoreAllMocks());

  test.each(gaps)('$name', fixture => {
    const contract = CONTRACTS.find(candidate => candidate.id === fixture.contract);
    const input = deepFreeze(structuredClone(fixture.input));
    const output = contract.direction === 'request'
      ? requestTranslator(contract.id)(input)
      : JSON.parse(responseTranslator(contract.id, Buffer.from(JSON.stringify(input))));
    expect(output).toEqual(fixture.output);
    expect(assessFeature({ ...contract, feature: fixture.feature }).status).toBe('unknown');
  });

  test('Messages SSE loses nonempty initial tool input and ignores thinking/signature deltas', async () => {
    const input = [
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'lost' } } },
      { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: 'lost' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'lost' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ].map(streams.frame).join('');
    const result = summarize(parseFrames(await collectStream('messages-to-chat-return', input, 1)));
    expect(result).toEqual({
      text: '', refusal: '', calls: [{ id: 'call_1', name: 'lookup', arguments: '' }],
      finish: 'tool_calls', usage: undefined, done: true, errors: [],
    });
    expect(assessFeature({
      source: 'anthropic_messages', target: 'chat_completions', direction: 'return_response', feature: 'reasoning_content',
    }).status).toBe('unknown');
    expect(assessFeature({
      source: 'anthropic_messages', target: 'chat_completions', direction: 'return_response', feature: 'initial_tool_input',
    }).status).toBe('unknown');
  });

  test.each(streams.gaps)('$name', async fixture => {
    const frames = parseFrames(await collectStream(fixture.contract, fixture.input, 1));
    expect(summarize(frames).calls).toEqual(fixture.calls);
  });

  test('Chat return treats comment-only frames as completion; comments are not declared supported', async () => {
    const frames = parseFrames(await collectStream('chat-to-responses-return', ': ping\n\n', 1));
    expect(frames.find(event => event.type === 'response.completed').response.status).toBe('completed');
    expect(assessFeature({
      source: 'chat_completions', target: 'responses', direction: 'return_response', feature: 'sse_comments',
    }).status).toBe('unknown');
  });

  test('Responses response.incomplete is currently ignored, not a supported completion event', async () => {
    const input = streams.frame({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    });
    expect(await collectStream('responses-to-chat-return', input, 1)).toBe('');
    expect(assessFeature({
      source: 'responses', target: 'chat_completions', direction: 'return_response', feature: 'response.incomplete',
    }).status).toBe('unknown');
  });
});

describe('executable request fixtures', () => {
  test.each(requests.cases)('$name', fixture => {
    const translate = requestTranslator(fixture.contract);
    const input = deepFreeze(structuredClone(fixture.input));
    const before = JSON.stringify(input);
    if (fixture.error) {
      let error;
      try { translate(input); } catch (caught) { error = caught; }
      expect(error).toMatchObject(fixture.error);
      expect(error.name).toBe(fixture.error.code === 'unsupported_wire_api_feature'
        ? 'WireApiCompatibilityError' : 'ProtocolTranslationError');
    } else {
      expect(translate(input)).toEqual(fixture.output);
    }
    expect(JSON.stringify(input)).toBe(before);
    const contract = CONTRACTS.find(candidate => candidate.id === fixture.contract);
    for (const feature of fixture.features) {
      const assessment = assessFeature({ ...contract, feature });
      expect(assessment.evidence).not.toBeNull();
      expect(assessment.status).not.toBe('unknown');
      if (assessment.status === 'rejected') {
        expect(fixture.error?.code).toBe(assessment.evidence.rejectionCode);
      }
    }
  });

  describe('executable JSON return and usage fixtures', () => {
    beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(responses.created * 1000));
    afterEach(() => jest.restoreAllMocks());

    test.each(responses.cases)('$name', fixture => {
      const body = Buffer.from(JSON.stringify(fixture.input));
      const before = Buffer.from(body);
      expect(JSON.parse(responseTranslator(fixture.contract, body))).toEqual(fixture.output);
      expect(body).toEqual(before);
    });

    test.each(['not-json', 'null', '[]', '{}', '{"error":{"code":"fixture_error"}}'])(
      'malformed/error JSON is not a success-shaped adaptation: %s', input => {
        for (const contract of CONTRACTS.filter(candidate => candidate.direction === 'return_response')) {
          expect(responseTranslator(contract.id, Buffer.from(input))).toBeNull();
        }
      });

    test('direct Messages usage retains cache read/write counting and missing-counter defaults', () => {
      expect(anthropic.anthropicUsageToChat({
        input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2,
      })).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3 } });
      expect(anthropic.anthropicUsageToChat({})).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      expect(anthropic.anthropicUsageToChat(null)).toBeUndefined();
    });

    test('every declared return feature has executing JSON/SSE evidence', () => {
      for (const contract of CONTRACTS.filter(candidate => candidate.direction === 'return_response')) {
        for (const row of contract.features.filter(candidate => candidate.status !== 'unknown')) {
          const evidence = [...responses.cases, ...streams.cases].filter(fixture =>
            fixture.contract === contract.id && fixture.features.includes(row.feature));
          expect({ id: contract.id, feature: row.feature, covered: evidence.length > 0 })
            .toEqual({ id: contract.id, feature: row.feature, covered: true });
        }
      }
    });
  });

  describe('executable SSE return fixtures', () => {
    beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(responses.created * 1000));
    afterEach(() => jest.restoreAllMocks());

    test.each(streams.cases)('$name (UTF-8, CRLF and final-frame boundaries)', async fixture => {
      for (const chunkSize of [1, 7, 65536]) {
        // Final complete frames need not end in a blank line; flush must still process them.
        const input = fixture.input.replace(/\n/g, '\r\n').replace(/\r\n\r\n$/, '');
        const output = await collectStream(fixture.contract, input, chunkSize, fixture.includeUsage);
        const frames = parseFrames(output);
        expect(summarize(frames)).toEqual(fixture.summary);
        if (fixture.contract === 'chat-to-responses-return' && fixture.summary.done) {
          expect(frames.filter(event => event.type === 'response.completed')).toHaveLength(1);
          expect(frames.filter(event => event.type === 'response.function_call_arguments.done').map(event => event.arguments))
            .toEqual(['{"q":"x"}', '{}']);
        } else if (fixture.summary.done) {
          expect(frames.filter(event => event === '[DONE]')).toHaveLength(1);
        }
      }
    });

    test.each(['responses-to-chat-return', 'messages-to-chat-return'])(
      '%s only emits usage when explicitly requested', async id => {
        const fixture = streams.cases.find(candidate => candidate.contract === id && candidate.summary.done);
        const frames = parseFrames(await collectStream(id, fixture.input, 5, false));
        expect(frames.some(event => event.usage)).toBe(false);
        expect(summarize(frames)).toEqual({ ...fixture.summary, usage: undefined });
      });

    test.each(['chat-to-responses-return', 'responses-to-chat-return', 'messages-to-chat-return'])(
      '%s does not synthesize completion at EOF', async id => {
        const event = id === 'chat-to-responses-return' ? streams.chatFrames[0]
          : id === 'responses-to-chat-return' ? streams.responsesFrames[0] : streams.anthropicFrames[0];
        const frames = parseFrames(await collectStream(id, streams.frame(event), 1));
        expect(summarize(frames).done).toBe(false);
        expect(summarize(frames).finish).toBeNull();
      });

    test.each(['responses-to-chat-return', 'messages-to-chat-return'])(
      '%s ignores unknown/malformed frames, without implying feature support', async id => {
        const malformed = 'data: {partial-json\n\n';
        const unknown = streams.frame({ type: 'future_event', private_field: 'fixture' });
        expect(await collectStream(id, malformed + unknown, 1)).toBe('');
        const contract = CONTRACTS.find(candidate => candidate.id === id);
        expect(assessFeature({ ...contract, feature: 'future_event' }).status).toBe('unknown');
      });

    test('Chat return preserves malformed SSE bytes rather than declaring them translated', async () => {
      const malformed = 'data: {partial-json\n\n';
      expect(await collectStream('chat-to-responses-return', malformed, 1)).toBe(malformed);
    });

    test.each([
      ['chat-to-responses-return', 'length', 'length'],
      ['chat-to-responses-return', 'content_filter', 'content_filter'],
      ['responses-to-chat-return', 'max_output_tokens', 'length'],
      ['responses-to-chat-return', 'content_filter', 'content_filter'],
      ['messages-to-chat-return', 'max_tokens', 'length'],
      ['messages-to-chat-return', 'model_context_window_exceeded', 'length'],
      ['messages-to-chat-return', 'refusal', 'content_filter'],
    ])('%s SSE preserves characterized terminal outcome %s', async (id, reason, finish) => {
      const input = id === 'chat-to-responses-return'
        ? streams.frame({ choices: [{ delta: { content: 'hello' }, finish_reason: reason }] }) + 'data: [DONE]\n\n'
        : id === 'responses-to-chat-return'
          ? streams.frame({ type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason }, output: [] } })
          : streams.frame({ type: 'message_delta', delta: { stop_reason: reason } }) + streams.frame({ type: 'message_stop' });
      const result = summarize(parseFrames(await collectStream(id, input, 1)));
      expect(result.finish).toBe(finish);
      expect(result.done).toBe(true);
    });
  });

  test('each declared request feature has executable evidence, including actual rejection codes', () => {
    for (const contract of CONTRACTS.filter(candidate => candidate.direction === 'request')) {
      for (const row of contract.features.filter(candidate => candidate.status !== 'unknown')) {
        const evidence = requests.cases.filter(fixture => fixture.contract === contract.id && fixture.features.includes(row.feature));
        expect({ id: contract.id, feature: row.feature, covered: evidence.length > 0 })
          .toEqual({ id: contract.id, feature: row.feature, covered: true });
        if (row.status === 'supported' || row.status === 'conditional') {
          expect(evidence.some(fixture => !fixture.error)).toBe(true);
        } else {
          expect(evidence.some(fixture => fixture.error?.code === row.rejectionCode)).toBe(true);
        }
      }
    }
  });

  test('outer wire adapter retains requested usage separately without using discovery facts', () => {
    const input = { ...requests.chat, stream: true, stream_options: { include_usage: true } };
    const result = wire.translateCopilotWireApi(Buffer.from(JSON.stringify(input)), '/v1/chat/completions', { upstreamEndpoint: '/responses' });
    expect(JSON.parse(result.body)).toEqual(wire.translateChatRequest(input));
    expect(result.compatibility).toEqual({
      requestedEndpoint: '/chat/completions', upstreamEndpoint: '/responses',
      direction: 'chat_to_responses', includeUsage: true,
    });
  });

  test.each(['not-json', 'null', '[]', '{}', '{"model":42}', '{"model":"fixture-model","input":"hello"}'])(
    'malformed/inapplicable wire input stays a null adaptation, not a support verdict: %s', body => {
      expect(wire.translateCopilotWireApi(Buffer.from(body), '/chat/completions')).toBeNull();
    });

  test('same-protocol return passthrough never creates a translator or support evidence', () => {
    const body = Buffer.from('{"future_feature":true}');
    expect(wire.transformWireApiResponseBody(body, { passthrough: true })).toBeNull();
    expect(wire.createWireApiSseTransform({ passthrough: true })).toBeNull();
    expect(wire.transformWireApiResponseBody(body, null)).toBeNull();
    expect(wire.createWireApiSseTransform(null)).toBeNull();
    expect(wire.translateCopilotWireApi(body, '/unimplemented')).toBeNull();
  });

  test.each([
    ['chat-to-responses-request', { messages: null }, 'messages'],
    ['responses-to-chat-request', { input: null }, 'input'],
    ['chat-to-messages-request', null, 'body'],
    ['chat-to-messages-request', { messages: [null] }, 'messages'],
  ])('malformed direct input: %s', (id, input, feature) => {
    expect(() => requestTranslator(id)(input)).toThrow();
    try { requestTranslator(id)(input); } catch (error) { expect(error.feature).toBe(feature); }
  });
});
