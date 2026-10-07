/**
 * Server-level tests for cross-provider ordered model fallback: a
 * provider-qualified AWF_FALLBACK_MODELS entry moves a failed request to
 * another configured provider (endpoint + credentials), translating the
 * protocol when necessary, while the agent keeps its original protocol.
 */

const https = require('https');
const { PassThrough } = require('stream');
const {
  makeReq: makeReqFactory,
  makeRes,
  makeProxyReq,
  makeProxyRes,
  getStructuredLogs,
  setupServerTestEnv,
  flushPromises,
} = require('./test-helpers/server-mock-factories');

const bearer = token => ['Bearer', token].join(' ');

const ENV_KEYS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COPILOT_GITHUB_TOKEN', 'AWF_DISALLOWED_MODELS', 'AWF_FALLBACK_MODELS',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

let proxyRequest;
let validateFallbackModelsConfig;
let _setSleepForTests;
let _resetSleepForTests;

setupServerTestEnv(() => {
  process.env.OPENAI_API_KEY = 'sk-openai-test';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.COPILOT_GITHUB_TOKEN = 'ghu_copilot_test';
  // Model policy is evaluated for the *target* provider of each candidate.
  process.env.AWF_DISALLOWED_MODELS = JSON.stringify(['openai/blocked-*']);
  ({ proxyRequest, validateFallbackModelsConfig } = require('./server'));
  ({ _setSleepForTests, _resetSleepForTests } = require('./proxy-request'));
  _setSleepForTests(() => Promise.resolve());
  return { proxyRequest };
});

afterAll(() => {
  _resetSleepForTests();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const COPILOT = {
  provider: 'copilot',
  host: 'api.githubcopilot.com',
  headers: { Authorization: bearer('copilot-session-token') },
};

const CHAT_TOOLS_BODY = {
  model: 'grok-4.7',
  messages: [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'Weather in Paris?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
  ],
  tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }],
};

function sse(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** A response object that records everything written to it. */
function makeStreamingRes() {
  const res = new PassThrough();
  res.headersSent = false;
  res.setHeader = jest.fn();
  res.writeHead = jest.fn(() => {
    res.headersSent = true;
  });
  let output = '';
  res.on('data', (chunk) => { output += chunk.toString('utf8'); });
  res.output = () => output;
  return res;
}

describe('proxyRequest cross-provider fallback chain', () => {
  let stdoutWriteSpy;
  let responseHandlers;
  let capturedOptions;
  let proxyReqs;

  beforeEach(() => {
    process.env.AWF_FALLBACK_MODELS = 'openai/gpt-5.4, anthropic/claude-sonnet-4.6';
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    responseHandlers = [];
    capturedOptions = [];
    proxyReqs = [];

    jest.spyOn(https, 'request').mockImplementation((options, cb) => {
      capturedOptions.push(options);
      responseHandlers.push(cb);
      const proxyReq = makeProxyReq();
      proxyReqs.push(proxyReq);
      return proxyReq;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.AWF_FALLBACK_MODELS;
  });

  function sentBody(index) {
    const written = proxyReqs[index].write.mock.calls.map(([chunk]) => chunk);
    return JSON.parse(Buffer.concat(written).toString('utf8'));
  }

  function header(index, name) {
    const headers = capturedOptions[index].headers;
    const key = Object.keys(headers).find(h => h.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : headers[key];
  }

  async function startRequest({ path = '/chat/completions', body = CHAT_TOOLS_BODY, res = makeRes(), origin = COPILOT, reqHeaders = {} } = {}) {
    const req = makeReqFactory(path, reqHeaders);
    proxyRequest(req, res, origin.host, origin.headers, origin.provider);
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
    await flushPromises();
    return { req, res };
  }

  function respond(index, status, body, headers) {
    const proxyRes = makeProxyRes(status, headers);
    responseHandlers[index](proxyRes);
    if (body) proxyRes.emit('data', Buffer.from(body));
    proxyRes.emit('end');
    return proxyRes;
  }

  it('walks Copilot → OpenAI → Anthropic with each provider\'s endpoint, credentials, and protocol', async () => {
    const { req, res } = await startRequest();
    expect(capturedOptions[0].hostname).toBe('api.githubcopilot.com');
    expect(sentBody(0).model).toBe('grok-4.7');

    respond(0, 503, '{"error":"overloaded"}');
    await flushPromises();

    // OpenAI attempt: OpenAI endpoint and key, no Copilot integration headers.
    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].hostname).toBe('api.openai.com');
    expect(capturedOptions[1].path).toBe('/v1/chat/completions');
    expect(header(1, 'authorization')).toBe(bearer('sk-openai-test'));
    expect(header(1, 'copilot-integration-id')).toBeUndefined();
    expect(sentBody(1)).toMatchObject({ model: 'gpt-5.4', tools: CHAT_TOOLS_BODY.tools });

    respond(1, 500, '{"error":{"message":"internal"}}');
    await flushPromises();

    // Anthropic attempt: Messages protocol, Anthropic key, tool call/result translated.
    expect(capturedOptions).toHaveLength(3);
    expect(capturedOptions[2].hostname).toBe('api.anthropic.com');
    expect(capturedOptions[2].path).toBe('/v1/messages');
    expect(header(2, 'x-api-key')).toBe('sk-ant-test');
    expect(header(2, 'anthropic-version')).toBe('2023-06-01');
    expect(header(2, 'authorization')).toBeUndefined();
    expect(sentBody(2)).toMatchObject({
      model: 'claude-sonnet-4.6',
      system: 'You are an agent.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }] },
      ],
      tools: [{ name: 'weather', input_schema: { type: 'object' } }],
    });

    respond(2, 200, JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4.6',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'weather', input: { city: 'Lyon' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 5 },
    }));
    await flushPromises();

    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    const chat = JSON.parse(res.end.mock.calls[0][0].toString('utf8'));
    expect(chat).toMatchObject({
      object: 'chat.completion',
      choices: [{
        message: { tool_calls: [{ id: 'toolu_2', function: { name: 'weather', arguments: '{"city":"Lyon"}' } }] },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });

    expect(req.awfModelFallback).toEqual({
      requested_model: 'grok-4.7',
      requested_provider: 'copilot',
      model: 'claude-sonnet-4.6',
      provider: 'anthropic',
      attempt: 2,
      reason: 'upstream_5xx',
      status: 500,
      from_model: 'gpt-5.4',
      from_provider: 'openai',
      failures: [
        { provider: 'copilot', model: 'grok-4.7', reason: 'upstream_5xx', status: 503 },
        { provider: 'openai', model: 'gpt-5.4', reason: 'upstream_5xx', status: 500 },
      ],
    });
    const fallbackLogs = getStructuredLogs(stdoutWriteSpy, 'model_fallback');
    expect(fallbackLogs.map(log => [log.from_provider, log.to_provider])).toEqual([
      ['copilot', 'openai'],
      ['openai', 'anthropic'],
    ]);
  });

  it('translates a streaming Anthropic response, including tool calls, back to chat chunks', async () => {
    process.env.AWF_FALLBACK_MODELS = 'anthropic/claude-sonnet-4.6';
    const res = makeStreamingRes();
    await startRequest({ res, body: { ...CHAT_TOOLS_BODY, stream: true, stream_options: { include_usage: true } } });

    respond(0, 502, '{"error":"bad gateway"}');
    await flushPromises();
    expect(capturedOptions[1].hostname).toBe('api.anthropic.com');
    expect(sentBody(1)).toMatchObject({ stream: true });
    expect(sentBody(1).stream_options).toBeUndefined();

    const proxyRes = new PassThrough();
    proxyRes.statusCode = 200;
    proxyRes.headers = { 'content-type': 'text/event-stream' };
    responseHandlers[1](proxyRes);
    proxyRes.write(sse('message_start', { message: { id: 'msg_1', model: 'claude-sonnet-4.6', usage: { input_tokens: 9, output_tokens: 0 } } }));
    proxyRes.write(sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'weather', input: {} } }));
    proxyRes.write(sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"Nice"}' } }));
    proxyRes.write(sse('content_block_stop', { index: 0 }));
    proxyRes.write(sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }));
    proxyRes.end(sse('message_stop', {}));
    await new Promise(resolve => res.on('end', resolve));

    expect(res.writeHead.mock.calls[0][0]).toBe(200);
    const frames = res.output().split('\n\n').filter(Boolean).map(frame => frame.replace(/^data: /, ''));
    expect(frames[frames.length - 1]).toBe('[DONE]');
    const chunks = frames.slice(0, -1).map(frame => JSON.parse(frame));
    expect(chunks.every(chunk => chunk.object === 'chat.completion.chunk')).toBe(true);
    const toolDeltas = chunks.flatMap(chunk => chunk.choices[0]?.delta?.tool_calls || []);
    expect(toolDeltas[0]).toMatchObject({ id: 'toolu_1', function: { name: 'weather' } });
    expect(toolDeltas.map(delta => delta.function.arguments || '').join('')).toBe('{"city":"Nice"}');
    expect(chunks[chunks.length - 1].usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 3 });
  });

  it('translates a Responses API request served by Anthropic back into a Responses object', async () => {
    process.env.AWF_FALLBACK_MODELS = 'anthropic/claude-sonnet-4.6';
    const { res } = await startRequest({
      path: '/responses',
      body: { model: 'gpt-5.4', input: 'hello', instructions: 'Be terse.' },
    });

    respond(0, 500, '{"error":"boom"}');
    await flushPromises();
    expect(capturedOptions[1].path).toBe('/v1/messages');
    expect(sentBody(1)).toMatchObject({ system: 'Be terse.', messages: [{ role: 'user' }] });

    respond(1, 200, JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4.6',
      content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 },
    }));
    await flushPromises();

    expect(JSON.parse(res.end.mock.calls[0][0].toString('utf8'))).toMatchObject({
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    });
  });

  it('surfaces the last upstream failure when the cross-provider chain is exhausted', async () => {
    const { req, res } = await startRequest();
    respond(0, 503, '{"error":"copilot down"}');
    await flushPromises();
    respond(1, 503, '{"error":"openai down"}');
    await flushPromises();
    const last = respond(2, 529, '{"type":"error","error":{"type":"overloaded_error"}}');
    await flushPromises();

    // No candidate remains, so the final failure is streamed to the agent as-is.
    expect(capturedOptions).toHaveLength(3);
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(res.writeHead.mock.calls[0][0]).toBe(529);
    expect(res.end).toHaveBeenCalledWith(Buffer.from('{"type":"error","error":{"type":"overloaded_error"}}'));
    expect(req.awfModelFallback).toMatchObject({ provider: 'anthropic', attempt: 2 });
  });

  it.each([
    [401, '{"error":"bad credentials"}'],
    [403, '{"error":"forbidden"}'],
    [429, '{"error":"rate limited"}'],
  ])('does not switch providers after a %s response', async (status, body) => {
    const { req, res } = await startRequest();
    respond(0, status, body);
    await flushPromises();
    expect(capturedOptions).toHaveLength(1);
    expect(res.writeHead.mock.calls[0][0]).toBe(status);
    expect(req.awfModelFallback).toBeUndefined();
  });

  it('does not switch providers on a generic validation error', async () => {
    await startRequest();
    respond(0, 400, '{"error":{"message":"messages: field required","code":"invalid_request"}}');
    await flushPromises();
    expect(capturedOptions).toHaveLength(1);
  });

  it('skips a candidate vetoed by model policy for its target provider', async () => {
    process.env.AWF_FALLBACK_MODELS = 'openai/blocked-model, anthropic/claude-sonnet-4.6';
    const { req } = await startRequest();
    respond(0, 503, '{"error":"overloaded"}');
    await flushPromises();

    expect(capturedOptions).toHaveLength(2);
    expect(capturedOptions[1].hostname).toBe('api.anthropic.com');
    expect(req.awfModelFallback).toMatchObject({ provider: 'anthropic', attempt: 1 });
    const skipped = getStructuredLogs(stdoutWriteSpy, 'model_fallback_skipped');
    expect(skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ entry: 'openai/blocked-model', candidate_provider: 'openai', reason: 'guard_rejected' }),
    ]));
  });

  it('does not route around a policy veto when every remaining candidate is blocked', async () => {
    process.env.AWF_FALLBACK_MODELS = 'openai/blocked-model';
    const { res } = await startRequest();
    respond(0, 503, '{"error":"overloaded"}');
    await flushPromises();
    expect(capturedOptions).toHaveLength(1);
    expect(res.writeHead.mock.calls[0][0]).toBe(503);
    expect(getStructuredLogs(stdoutWriteSpy, 'model_fallback_skipped')).toEqual(expect.arrayContaining([
      expect.objectContaining({ entry: 'openai/blocked-model', reason: 'guard_rejected' }),
    ]));
  });

  it('skips providers that cannot serve the protocol and logs why', async () => {
    process.env.AWF_FALLBACK_MODELS = 'gemini/gemini-2.5-pro, openai/gpt-5.4';
    const { req } = await startRequest();
    respond(0, 500, '{"error":"boom"}');
    await flushPromises();
    expect(capturedOptions[1].hostname).toBe('api.openai.com');
    expect(req.awfModelFallback).toMatchObject({ provider: 'openai' });
    expect(getStructuredLogs(stdoutWriteSpy, 'model_fallback_skipped')).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidate_provider: 'gemini', reason: 'provider_unsupported' }),
    ]));
  });

  it('skips a candidate whose request cannot be translated faithfully and keeps the original error', async () => {
    process.env.AWF_FALLBACK_MODELS = 'anthropic/claude-sonnet-4.6';
    const { res } = await startRequest({ body: { ...CHAT_TOOLS_BODY, n: 2 } });
    respond(0, 503, '{"error":"overloaded"}');
    await flushPromises();
    await flushPromises();
    expect(capturedOptions).toHaveLength(1);
    expect(res.writeHead.mock.calls[0][0]).toBe(503);
    expect(res.end.mock.calls[0][0].toString()).toContain('overloaded');
    expect(getStructuredLogs(stdoutWriteSpy, 'model_fallback_skipped')).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidate_provider: 'anthropic', reason: 'protocol_translation_failed: n' }),
    ]));
  });

  it('returns to the receiving provider for unqualified entries after a cross-provider attempt', async () => {
    process.env.AWF_FALLBACK_MODELS = 'openai/gpt-5.4, gpt-5-mini';
    const { req } = await startRequest();
    respond(0, 503, '{"error":"overloaded"}');
    await flushPromises();
    respond(1, 503, '{"error":"overloaded"}');
    await flushPromises();

    expect(capturedOptions).toHaveLength(3);
    expect(capturedOptions[2].hostname).toBe('api.githubcopilot.com');
    expect(header(2, 'authorization')).toBe(bearer('copilot-session-token'));
    expect(sentBody(2).model).toBe('gpt-5-mini');
    expect(req.awfModelFallback).toMatchObject({ provider: 'copilot', model: 'gpt-5-mini', from_provider: 'openai', attempt: 2 });
  });

  it('serves an Anthropic Messages request through Copilot without translation', async () => {
    process.env.AWF_FALLBACK_MODELS = 'copilot/claude-sonnet-4.6';
    const { res } = await startRequest({
      path: '/v1/messages',
      origin: { provider: 'anthropic', host: 'api.anthropic.com', headers: { 'x-api-key': 'sk-ant-test' } },
      reqHeaders: { 'anthropic-version': '2023-06-01' },
      body: { model: 'claude-opus-4.1', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
    });
    respond(0, 529, '{"type":"error","error":{"type":"overloaded_error"}}');
    await flushPromises();

    expect(capturedOptions[1].hostname).toBe('api.githubcopilot.com');
    expect(capturedOptions[1].path).toBe('/v1/messages');
    expect(header(1, 'x-api-key')).toBeUndefined();
    expect(header(1, 'anthropic-version')).toBe('2023-06-01');
    expect(sentBody(1)).toMatchObject({ model: 'claude-sonnet-4.6', max_tokens: 100 });

    const passthrough = '{"type":"message","content":[]}';
    respond(1, 200, passthrough);
    await flushPromises();
    expect(res.writeHead.mock.calls[0][0]).toBe(200);
  });

  it('keeps unqualified chains on the same provider', async () => {
    process.env.AWF_FALLBACK_MODELS = 'fallback-a';
    const { req } = await startRequest();
    respond(0, 503, '{"error":"overloaded"}');
    await flushPromises();
    expect(capturedOptions[1].hostname).toBe('api.githubcopilot.com');
    expect(sentBody(1).model).toBe('fallback-a');
    expect(req.awfModelFallback).toMatchObject({ provider: 'copilot', requested_provider: 'copilot', attempt: 1 });
  });
});

describe('validateFallbackModelsConfig', () => {
  it('accepts provider-qualified entries for configured providers', () => {
    expect(validateFallbackModelsConfig({ AWF_FALLBACK_MODELS: 'openai/gpt-5.4,anthropic/claude-sonnet-4.6,gpt-5-mini' }))
      .toEqual([]);
  });

  it('reports entries whose provider has no credentials', () => {
    const errors = validateFallbackModelsConfig({ AWF_FALLBACK_MODELS: 'gemini/gemini-2.5-pro' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('GEMINI_API_KEY');
  });
});
