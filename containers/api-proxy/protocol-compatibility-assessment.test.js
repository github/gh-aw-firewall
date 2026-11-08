'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { assessRequestCompatibility, REASON_CODES } = require('./protocol-compatibility/assessment');
const { resolveReasoning } = require('./catalogue-contract/reasoning');
const { identity } = require('./catalogue-contract/identity');
const gaps = require('./fixtures/protocol-compatibility/gaps');
const { getRequestReasoning } = require('./model-reasoning');

const candidate = { provider: 'copilot', model: 'fixture-model' };
const chat = () => ({ model: candidate.model, messages: [{ role: 'user', content: 'hello' }] });
const responses = () => ({ model: candidate.model, input: 'hello' });
const pins = { eligibilityRevision: 7, catalogueRevision: 'a'.repeat(64) };
const scope = { provider: candidate.provider, channel: 'copilot-api' };
function reasoning(rawEfforts, mode) {
  const exact = identity(candidate.provider, candidate.model);
  return resolveReasoning({ identity: exact, scope, facts: rawEfforts === undefined ? [] : [{
    identity: exact, scope, active: true, authority: 'provider',
    support: rawEfforts.length ? 'supported' : 'unsupported', rawEfforts, mode,
  }] });
}
function assess(body, target = 'responses', options = {}) {
  return assessRequestCompatibility({
    body, source: 'chat_completions', target, candidate, pins, ...options,
  });
}
const functionTool = () => ({
  type: 'function', function: { name: 'lookup', description: 'lookup', strict: true, parameters: {
    type: 'object', properties: { cache_control: { type: 'string' } }, required: ['cache_control'],
  } },
});

describe('actual automatic fallback request assessment', () => {
  test.each([
    ['chat-to-responses', chat(), 'chat_completions', 'responses', 'chat-to-responses-request'],
    ['responses-to-chat', responses(), 'responses', 'chat_completions', 'responses-to-chat-request'],
    ['chat-to-messages', chat(), 'chat_completions', 'anthropic_messages', 'chat-to-messages-request'],
    ['responses-to-messages composed', responses(), 'responses', 'anthropic_messages', 'chat-to-messages-request'],
  ])('%s resolves the implemented request and corresponding return only', (_name, body, source, target, id) => {
    const result = assessRequestCompatibility({ body, source, target, candidate, pins });
    expect(result.status).toBe('compatible');
    expect(result.contracts.some(contract => contract.id === id)).toBe(true);
    expect(result.contracts.filter(contract => contract.id.endsWith('-return')).length)
      .toBe(source === 'responses' && target === 'anthropic_messages' ? 2 : 1);
    expect(result.returnConditions).toBe('provider_response_unobserved');
    expect(result.pins).toEqual(pins);
  });

  test('passthrough does not invent a contract or native capability evidence', () => {
    const body = { ...chat(), native_field: { content: 'private' } };
    const result = assess(body, 'chat_completions', { reasoning: reasoning(undefined) });
    expect(result.status).toBe('compatible');
    expect(result.contracts).toEqual([]);
    expect(result.reasoning.code).toBe('reasoning_direct_unknown_passthrough');
    expect(result.returnConditions).toBe('not_applicable');
    expect(JSON.stringify(result)).not.toContain('private');
  });

  test('a Messages return adapter does not authorize a reverse Messages request', () => {
    const result = assessRequestCompatibility({ body: chat(), source: 'anthropic_messages', target: 'chat_completions' });
    expect(result.status).toBe('incompatible');
    expect(result.reasons).toContainEqual({ feature: 'unknown_fields', code: 'direction_unimplemented' });
  });

  test('an unrecognized endpoint is unverified, not verified native support', () => {
    expect(assess(chat(), null).status).toBe('unverified');
  });

  test('Messages ignoring an unknown null field is unverified, not a translator rejection', () => {
    const result = assess({ ...chat(), unrecognized: null }, 'anthropic_messages');
    expect(result.status).toBe('unverified');
    expect(result.reasons).toContainEqual({ feature: 'unknown_fields', code: 'condition_unverified' });
  });

  test('explicitly established native passthrough needs no new directed contract', () => {
    const body = { contents: [{ parts: [{ text: 'hello' }] }] };
    const result = assessRequestCompatibility({ body, source: null, target: null,
      nativePassthrough: true, candidate: { provider: 'gemini', model: 'gemini-fixture' } });
    expect(result.status).toBe('compatible');
    expect(result.contracts).toEqual([]);
    expect(result.source).toBeNull();
    expect(result.target).toBeNull();
    expect(assessRequestCompatibility({ body, source: null, target: null }).status).toBe('unverified');
  });

  test('known function definitions, schemas, strict flags, choices and parallel false survive', () => {
    for (const target of ['responses', 'anthropic_messages']) {
      const body = { ...chat(), tools: [functionTool()], tool_choice: {
        type: 'function', function: { name: 'lookup' },
      }, parallel_tool_calls: false };
      expect(assess(body, target).status).toBe('compatible');
    }
  });

  test.each([
    ['nested tool field', body => { body.tools = [{ ...functionTool(), future_field: 'secret' }]; }, 'unknown_nested_field'],
    ['nested choice field', body => { body.tool_choice = { type: 'function', function: { name: 'lookup', extra: true } }; }, 'tool_choice_invalid'],
    ['hosted tool', body => { body.tools = [{ type: 'web_search' }]; }, 'translator_rejected'],
    ['missing call identity', body => { body.messages = [{ role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'lookup', arguments: '{}' } }] }]; }, 'tool_shape_invalid'],
    ['call identifier on non-tool role', body => { body.messages[0].tool_call_id = 'call1'; }, 'tool_shape_invalid'],
    ['empty assistant turn with empty calls', body => { body.messages = [{ role: 'assistant', content: null, tool_calls: [] }]; }, 'turn_boundary_loss'],
    ['unknown message field', body => { body.messages[0].extra = false; }, 'unknown_nested_field'],
    ['cached text', body => { body.messages[0].content = [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]; }, 'cache_controls_unverified'],
    ['reasoning content', body => { body.messages[0].content = [{ type: 'thinking', thinking: 'secret' }]; }, 'modality_unsupported'],
    ['audio', body => { body.messages[0].content = [{ type: 'input_audio', input_audio: {} }]; }, 'modality_unsupported'],
    ['video', body => { body.messages[0].content = [{ type: 'video', url: 'private' }]; }, 'modality_unsupported'],
    ['invalid parallel type', body => { body.parallel_tool_calls = 'true'; }, 'condition_unverified'],
    ['invalid stream type', body => { body.stream = 'true'; }, 'condition_unverified'],
    ['unknown stream option', body => { body.stream_options = { include_usage: true, private: true }; }, 'stream_options_invalid'],
    ['invalid token limit', body => { body.max_tokens = 0; }, 'token_limit_invalid'],
    ['unknown null field', body => { body.unrecognized = null; }, 'translator_rejected'],
  ])('%s cannot be approved from feature-level labels', (_name, change, code) => {
    const body = chat();
    change(body);
    const result = assess(body);
    expect(result.status).not.toBe('compatible');
    expect(result.reasons.some(reason => reason.code === code)).toBe(true);
  });

  test.each(['system', 'developer'])('wire %s role collapse is not transport-only', role => {
    expect(assess({ ...chat(), messages: [{ role, content: 'instruction' }, ...chat().messages] }).reasons)
      .toContainEqual({ feature: 'message_roles', code: 'role_priority_loss' });
  });

  test('Responses instructions and transport item IDs retain defined semantics', () => {
    const body = { ...responses(), instructions: 'system', input: [{
      id: 'transport-id', status: 'completed', type: 'message', content: [{ type: 'input_text', text: 'hello' }],
    }] };
    expect(assess(body, 'chat_completions', { source: 'responses' }).status).toBe('compatible');
  });

  test('Messages only accepts preserved role boundaries and authorized missing-limit default', () => {
    expect(assess({ ...chat(), messages: [{ role: 'system', content: 'system' }, ...chat().messages] },
      'anthropic_messages').status).toBe('compatible');
    for (const messages of [
      [{ role: 'developer', content: 'system' }, ...chat().messages],
      [...chat().messages, { role: 'system', content: 'late system' }],
      [...chat().messages, ...chat().messages],
      [{ role: 'user', content: '' }],
    ]) expect(assess({ ...chat(), messages }, 'anthropic_messages').status).not.toBe('compatible');
    expect(assess(chat(), 'anthropic_messages').status).toBe('compatible');
    expect(assess({ ...chat(), max_tokens: -1 }, 'anthropic_messages').status).toBe('incompatible');
    expect(assess({ ...chat(), temperature: 1.7 }, 'anthropic_messages').reasons)
      .toContainEqual({ feature: 'unknown_fields', code: 'sampling_altered' });
    expect(assess({ ...chat(), stop: ['END', 42] }, 'anthropic_messages').status).toBe('incompatible');
  });

  test('positive limit precedence and object argument encoding retain established normalization', () => {
    const body = { ...chat(), max_tokens: 100, max_completion_tokens: 200, messages: [{
      role: 'assistant', content: null, tool_calls: [{
        id: 'call1', type: 'function', function: { name: 'lookup', arguments: { key: 'value' } },
      }],
    }] };
    expect(assess(body).status).toBe('compatible');
    expect(assess(body, 'anthropic_messages').status).toBe('compatible');
    expect(assess({ ...chat(), messages: [{
      role: 'tool', tool_call_id: 'call1', content: { key: 'value' },
    }] }).status).toBe('compatible');
    expect(assess({ ...responses(), input: [{
      type: 'function_call_output', call_id: 'call1', output: { key: 'value' },
    }] }, 'chat_completions', { source: 'responses' }).status).toBe('compatible');
  });

  test('Messages does not claim parallel true or a lost disable flag as verified', () => {
    for (const body of [
      { ...chat(), tools: [functionTool()], parallel_tool_calls: true },
      { ...chat(), tools: [functionTool()], parallel_tool_calls: false, tool_choice: 'none' },
      { ...chat(), parallel_tool_calls: false },
    ]) expect(assess(body, 'anthropic_messages').status).toBe('unverified');
  });

  test('known tool call/result sequence retains IDs and object arguments in Messages', () => {
    const body = { ...chat(), messages: [
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call1', type: 'function', function: { name: 'lookup', arguments: '{"key":"value"}' },
      }] },
      { role: 'tool', tool_call_id: 'call1', content: 'result' },
    ] };
    expect(assess(body, 'anthropic_messages').status).toBe('compatible');
    body.messages[0].tool_calls[0].function.arguments = '[]';
    expect(assess(body, 'anthropic_messages').status).toBe('incompatible');
  });

  test('structured output known nesting survives wire mapping, descriptions do not', () => {
    const body = { ...chat(), response_format: { type: 'json_schema', json_schema: {
      name: 'answer', schema: { type: 'object' }, strict: true,
    } } };
    expect(assess(body).status).toBe('compatible');
    expect(assess(body, 'anthropic_messages').status).toBe('incompatible');
    body.response_format.json_schema.description = 'private';
    expect(assess(body).status).toBe('incompatible');
  });

  test('image URL/detail wire mapping is verified but Messages image detail is lost', () => {
    const body = { ...chat(), messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'https://example.test/a.png', detail: 'high' } },
    ] }] };
    expect(assess(body).status).toBe('compatible');
    expect(assess(body, 'anthropic_messages').reasons)
      .toContainEqual({ feature: 'image_input', code: 'image_fields_lost' });
    delete body.messages[0].content[0].image_url.detail;
    expect(assess(body, 'anthropic_messages').status).toBe('compatible');
  });

  test('Responses image URLs cannot borrow Chat nested-image evidence', () => {
    const body = { ...responses(), input: [{ role: 'user', content: [{
      type: 'input_image', image_url: { url: 'https://example.test/a.png', detail: 'high' },
    }] }] };
    const result = assess(body, 'chat_completions', { source: 'responses' });
    expect(result.status).toBe('unverified');
    expect(result.reasons).toContainEqual({ feature: 'image_input', code: 'request_shape_unverified' });
    body.input[0].content[0] = { type: 'input_image', image_url: 'https://example.test/a.png', detail: 'high' };
    expect(assess(body, 'chat_completions', { source: 'responses' }).status).toBe('compatible');
  });

  test.each(['previous_response_id', 'metadata', 'include', 'truncation', 'prompt_cache_key'])(
    'stateful %s is not silently removed', field => {
      expect(assess({ ...responses(), [field]: 'private' }, 'chat_completions', { source: 'responses' }).status)
        .toBe('incompatible');
    });

  test('reasoning translation and exact-model support remain separate', () => {
    const body = { ...chat(), reasoning_effort: 'high' };
    expect(assess(body, 'responses', { reasoning: reasoning(['high']) }).status).toBe('compatible');
    expect(assess(body, 'responses', { reasoning: reasoning(['low']) }).reasons)
      .toContainEqual({ feature: 'reasoning_fields', code: 'reasoning_effort_unsupported' });
    expect(assess(body, 'responses', { reasoning: reasoning(undefined) }).status).toBe('unverified');
    expect(assess(body, 'anthropic_messages', { reasoning: reasoning(['high']) }).status).toBe('incompatible');
    expect(assess(chat(), 'chat_completions', { reasoning: reasoning(['high'], 'required') }).status).toBe('incompatible');
    expect(assess(body, 'chat_completions', { reasoning: reasoning([]) }).status).toBe('incompatible');
  });

  test('refresh affects subsequent requests, not already pinned reasoning evidence', () => {
    const req = {};
    const records = { copilot: [{ id: candidate.model, supportedReasoningEfforts: ['high'] }] };
    const captured = getRequestReasoning(candidate.model, 'copilot', records, req);
    records.copilot = [{ id: candidate.model, supportedReasoningEfforts: ['low'] }];
    const body = { ...chat(), reasoning_effort: 'high' };
    expect(getRequestReasoning(candidate.model, 'copilot', records, req)).toBe(captured);
    expect(assess(body, 'responses', { reasoning: captured }).status).toBe('compatible');
    const next = getRequestReasoning(candidate.model, 'copilot', records, {});
    expect(assess(body, 'responses', { reasoning: next }).status).toBe('incompatible');
  });

  test('known return requirements are bounded and do not verify future usage or terminal events', () => {
    const result = assess({ ...chat(), stream: true, stream_options: { include_usage: true } }, 'responses', {
      requiredResponseFeatures: ['streaming', 'usage', 'function_tools'],
    });
    expect(result.status).toBe('compatible');
    expect(result.returnConditions).toBe('provider_response_unobserved');
    expect(assess({ ...chat(), stream: true }, 'responses', { requiredResponseFeatures: ['usage'] }).status)
      .toBe('incompatible');
    expect(assess(chat(), 'responses', { requiredResponseFeatures: ['private-feature'] }).reasons)
      .toContainEqual({ feature: 'unknown_fields', code: 'unknown_required_feature' });
    expect(assess(chat(), 'responses', { requiredResponseFeatures: ['reasoning_content'] }).status).toBe('unverified');
  });

  test.each(gaps.filter(gap => gap.contract.endsWith('-request')))(
    'characterized gap is not relabeled lossless: $name', gap => {
      const result = assess(gap.input, gap.contract === 'chat-to-messages-request' ? 'anthropic_messages'
        : gap.contract === 'responses-to-chat-request' ? 'chat_completions' : 'responses', {
        source: gap.contract === 'responses-to-chat-request' ? 'responses' : 'chat_completions',
      });
      expect(result.status).not.toBe('compatible');
    });

  test('bounded immutable result never retains raw data, arbitrary reason strings or input references', () => {
    const body = chat();
    body.messages[0].content = 'credential private/path https://private.test';
    const before = JSON.stringify(body);
    const result = assess(Buffer.from(before));
    expect(assess(body)).toEqual(result);
    expect(JSON.stringify(body)).toBe(before);
    expect(JSON.stringify(result)).not.toMatch(/credential|private/);
    expect(() => { result.pins.eligibilityRevision = 100; }).toThrow(TypeError);
    expect(result.reasons.every(reason => REASON_CODES.includes(reason.code))).toBe(true);
    expect(assess({ ...chat(), messages: Array.from({ length: 9000 }, () => ({ role: 'user', content: 'x' })) }).status)
      .toBe('unverified');
    const cyclic = chat(); cyclic.loop = cyclic;
    expect(assess(cyclic).status).toBe('unverified');
    expect(assess(Buffer.from('invalid-json')).status).toBe('unverified');
  });

  test('stale translator bytes fail closed in the shipped layout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-assessment-drift-'));
    try {
      const proxy = __dirname;
      const dockerfile = fs.readFileSync(path.join(proxy, 'Dockerfile'), 'utf8').replace(/\\\n/g, ' ');
      for (const line of dockerfile.split('\n')) {
        const copy = /^COPY (.+) (\.\/\S*)$/.exec(line);
        if (!copy) continue;
        for (const source of copy[1].trim().split(/\s+/)) {
          if (source === 'package*.json') continue;
          fs.cpSync(path.join(proxy, source),
            copy[2] === './' ? path.join(root, path.basename(source)) : path.join(root, copy[2]), { recursive: true });
        }
      }
      fs.appendFileSync(path.join(root, 'wire-api-compat.js'), '\n// drift\n');
      const script = `
        const {assessRequestCompatibility} = require('./protocol-compatibility/assessment');
        const result = assessRequestCompatibility({body:{model:'fixture',messages:[]},
          source:'chat_completions',target:'responses'});
        require('assert/strict').equal(result.status,'unverified');
        require('assert/strict').equal(result.reasons[0].code,'implementation_drift');
      `;
      const result = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
