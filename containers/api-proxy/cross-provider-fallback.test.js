'use strict';

const {
  ANTHROPIC_VERSION,
  protocolForPath,
  getCrossProviderRejection,
  buildCrossProviderRequest,
  needsResponseTranslation,
  transformProtocolResponseBody,
  createProtocolSseTransforms,
} = require('./cross-provider-fallback');

const bearer = token => ['Bearer', token].join(' ');

function makeAdapter(name, overrides = {}) {
  const hosts = { openai: 'api.openai.com', anthropic: 'api.anthropic.com', copilot: 'api.githubcopilot.com' };
  const auth = {
    openai: { Authorization: bearer('openai-test-key') },
    anthropic: { 'x-api-key': 'anthropic-key' },
    copilot: { Authorization: bearer('copilot-test-token') },
  };
  return {
    name,
    isEnabled: () => true,
    getTargetHost: () => hosts[name],
    getBasePath: () => (name === 'openai' ? '/v1' : ''),
    getAuthHeaders: () => ({ ...auth[name] }),
    getBodyTransform: () => null,
    ...overrides,
  };
}

function makeAgentReq(url, headers = {}) {
  return {
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      authorization: bearer('agent-token'),
      'copilot-integration-id': 'agentic-workflows',
      'x-initiator': 'agent',
      'openai-intent': 'conversation-agent',
      'anthropic-beta': 'tools-2024',
      'user-agent': 'agent/1.0',
      ...headers,
    },
  };
}

const CHAT_BODY = Buffer.from(JSON.stringify({
  model: 'grok-4.7',
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'hi' }],
}));

describe('protocolForPath', () => {
  it.each([
    ['/v1/chat/completions', 'chat'],
    ['/chat/completions?x=1', 'chat'],
    ['/v1/responses', 'responses'],
    ['/v1/messages', 'messages'],
    ['/v1/embeddings', null],
    [undefined, null],
  ])('%s → %s', (path, protocol) => {
    expect(protocolForPath(path)).toBe(protocol);
  });
});

describe('getCrossProviderRejection', () => {
  it('accepts configured providers that can serve the protocol', () => {
    expect(getCrossProviderRejection({ protocol: 'chat', targetProvider: 'anthropic', adapter: makeAdapter('anthropic') })).toBeNull();
    expect(getCrossProviderRejection({ protocol: 'messages', targetProvider: 'copilot', adapter: makeAdapter('copilot') })).toBeNull();
  });

  it('explains why a candidate cannot be routed', () => {
    expect(getCrossProviderRejection({ protocol: 'chat', targetProvider: 'gemini', adapter: makeAdapter('openai') }))
      .toBe('provider_unsupported');
    expect(getCrossProviderRejection({ protocol: 'messages', targetProvider: 'openai', adapter: makeAdapter('openai') }))
      .toBe('protocol_unsupported');
    expect(getCrossProviderRejection({ protocol: null, targetProvider: 'openai', adapter: makeAdapter('openai') }))
      .toBe('protocol_unsupported');
    expect(getCrossProviderRejection({ protocol: 'chat', targetProvider: 'openai', adapter: null }))
      .toBe('provider_not_configured');
    expect(getCrossProviderRejection({
      protocol: 'chat', targetProvider: 'openai', adapter: makeAdapter('openai', { isEnabled: () => false }),
    })).toBe('provider_not_configured');
  });
});

describe('buildCrossProviderRequest', () => {
  it('routes a Copilot chat request to OpenAI with OpenAI credentials only', async () => {
    const built = await buildCrossProviderRequest({
      sourceBody: CHAT_BODY,
      protocol: 'chat',
      originProvider: 'copilot',
      targetProvider: 'openai',
      model: 'gpt-5.4',
      adapter: makeAdapter('openai'),
      req: makeAgentReq('/chat/completions'),
      requestId: 'req-1',
    });

    expect(built.targetHost).toBe('api.openai.com');
    expect(built.upstreamPath).toBe('/v1/chat/completions');
    expect(JSON.parse(built.body.toString())).toMatchObject({ model: 'gpt-5.4', stream: true });
    expect(built.headers.Authorization).toBe(bearer('openai-test-key'));
    expect(built.headers.authorization).toBeUndefined();
    expect(built.headers['copilot-integration-id']).toBeUndefined();
    expect(built.headers['x-initiator']).toBeUndefined();
    expect(built.headers['openai-intent']).toBeUndefined();
    expect(built.headers['anthropic-beta']).toBeUndefined();
    expect(built.headers['user-agent']).toBe('agent/1.0');
    expect(built.headers['content-length']).toBe(String(built.body.length));
    expect(built.protocolTranslation).toMatchObject({ kind: 'passthrough', originProvider: 'copilot', targetProvider: 'openai' });
    expect(needsResponseTranslation(built.protocolTranslation)).toBe(false);
  });

  it('translates a chat request into the Anthropic Messages protocol', async () => {
    const built = await buildCrossProviderRequest({
      sourceBody: CHAT_BODY,
      protocol: 'chat',
      originProvider: 'copilot',
      targetProvider: 'anthropic',
      model: 'claude-sonnet-4.6',
      adapter: makeAdapter('anthropic'),
      req: makeAgentReq('/chat/completions'),
      requestId: 'req-1',
    });

    expect(built.targetHost).toBe('api.anthropic.com');
    expect(built.upstreamPath).toBe('/v1/messages');
    expect(built.headers['x-api-key']).toBe('anthropic-key');
    expect(built.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(built.headers['accept-encoding']).toBe('identity');
    expect(JSON.parse(built.body.toString())).toEqual({
      model: 'claude-sonnet-4.6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 8192,
      stream: true,
    });
    expect(built.protocolTranslation).toMatchObject({ kind: 'anthropic_to_chat', includeUsage: true });
  });

  it('translates a Responses request into Anthropic via chat completions', async () => {
    const built = await buildCrossProviderRequest({
      sourceBody: Buffer.from(JSON.stringify({ model: 'gpt-5.4', input: 'hello', instructions: 'Be terse.' })),
      protocol: 'responses',
      originProvider: 'openai',
      targetProvider: 'anthropic',
      model: 'claude-sonnet-4.6',
      adapter: makeAdapter('anthropic'),
      req: makeAgentReq('/v1/responses'),
      requestId: 'req-1',
    });
    expect(JSON.parse(built.body.toString())).toMatchObject({
      model: 'claude-sonnet-4.6',
      system: 'Be terse.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    expect(built.protocolTranslation).toMatchObject({ kind: 'anthropic_to_responses', includeUsage: true });
  });

  it('keeps anthropic-* headers for a Messages request served by Copilot', async () => {
    const built = await buildCrossProviderRequest({
      sourceBody: Buffer.from(JSON.stringify({ model: 'claude-x', max_tokens: 10, messages: [] })),
      protocol: 'messages',
      originProvider: 'anthropic',
      targetProvider: 'copilot',
      model: 'claude-sonnet-4.6',
      adapter: makeAdapter('copilot'),
      req: makeAgentReq('/v1/messages', { 'anthropic-version': '2023-06-01' }),
      requestId: 'req-1',
    });
    expect(built.upstreamPath).toBe('/v1/messages');
    expect(built.headers['anthropic-version']).toBe('2023-06-01');
    expect(built.headers['anthropic-beta']).toBe('tools-2024');
    expect(built.headers.Authorization).toBe(bearer('copilot-test-token'));
    expect(built.protocolTranslation.kind).toBe('passthrough');
  });

  it('pins the configured model when a target body transform substitutes another one', async () => {
    const adapter = makeAdapter('openai', {
      getBodyTransform: () => (body) => {
        const parsed = JSON.parse(body.toString());
        parsed.model = 'gpt-4o';
        parsed.injected = true;
        return Buffer.from(JSON.stringify(parsed));
      },
    });
    const built = await buildCrossProviderRequest({
      sourceBody: CHAT_BODY,
      protocol: 'chat',
      originProvider: 'copilot',
      targetProvider: 'openai',
      model: 'gpt-5.4',
      adapter,
      req: makeAgentReq('/chat/completions'),
      requestId: 'req-1',
    });
    expect(JSON.parse(built.body.toString())).toMatchObject({ model: 'gpt-5.4', injected: true });
    expect(built.substitutedModel).toBe('gpt-4o');
  });

  it('rejects requests that cannot be translated faithfully', async () => {
    await expect(buildCrossProviderRequest({
      sourceBody: Buffer.from(JSON.stringify({ model: 'a', n: 3, messages: [{ role: 'user', content: 'hi' }] })),
      protocol: 'chat',
      originProvider: 'copilot',
      targetProvider: 'anthropic',
      model: 'claude-sonnet-4.6',
      adapter: makeAdapter('anthropic'),
      req: makeAgentReq('/chat/completions'),
      requestId: 'req-1',
    })).rejects.toMatchObject({ code: 'unsupported_protocol_feature', feature: 'n' });
  });
});

describe('response translation', () => {
  const ANTHROPIC_RESPONSE = Buffer.from(JSON.stringify({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4.6',
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 1 },
  }));

  it('leaves passthrough responses untouched', () => {
    expect(transformProtocolResponseBody(ANTHROPIC_RESPONSE, { kind: 'passthrough' })).toBeNull();
    expect(transformProtocolResponseBody(ANTHROPIC_RESPONSE, null)).toBeNull();
    expect(createProtocolSseTransforms({ kind: 'passthrough' })).toEqual([]);
  });

  it('translates Anthropic responses into chat completions', () => {
    const chat = JSON.parse(transformProtocolResponseBody(ANTHROPIC_RESPONSE, { kind: 'anthropic_to_chat' }).toString());
    expect(chat).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
  });

  it('translates Anthropic responses into Responses API objects', () => {
    const response = JSON.parse(transformProtocolResponseBody(ANTHROPIC_RESPONSE, { kind: 'anthropic_to_responses' }).toString());
    expect(response).toMatchObject({
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    });
  });

  it('creates one SSE transform for chat and two for responses', () => {
    expect(createProtocolSseTransforms({ kind: 'anthropic_to_chat', includeUsage: false })).toHaveLength(1);
    expect(createProtocolSseTransforms({ kind: 'anthropic_to_responses', includeUsage: true })).toHaveLength(2);
  });
});
