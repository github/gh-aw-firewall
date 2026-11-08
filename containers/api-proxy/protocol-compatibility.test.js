'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { CONTRACTS, FEATURES, REVISION, assessFeature } = require('./protocol-compatibility');
const wire = require('./wire-api-compat');
const anthropic = require('./anthropic-chat-compat');
const requests = require('./fixtures/protocol-compatibility/requests');

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
