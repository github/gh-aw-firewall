const { EventEmitter } = require('events');
const zlib = require('zlib');
const { createUpstreamResponseHandlers } = require('./upstream-response');
const { createRoutingObservation } = require('./routing-observation');
const { createCopilotAdapter } = require('./providers/copilot');
const { buildRequestHeaders } = require('./request-headers');

function createDependencies() {
  return {
    metrics: {
      statusClass: jest.fn(() => '5xx'),
      gaugeDec: jest.fn(),
      increment: jest.fn(),
      observe: jest.fn(),
    },
    logRequest: jest.fn(),
    sanitizeForLog: (value, maxLen = 200) => String(value || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLen),
    otel: { endSpan: jest.fn(), endSpanError: jest.fn(), setTokenAttributes: jest.fn(), setBudgetAttributes: jest.fn() },
    handleRequestError: jest.fn(),
    trackTokenUsage: jest.fn(),
    applyMaxRunsInvocation: jest.fn(),
    applyPermissionDenied: jest.fn(),
    extractBillingHeaders: jest.fn(() => null),
    parseDeprecatedHeaderFromBody: jest.fn(() => null),
    learnAndStripDeprecatedHeaderValue: jest.fn(() => false),
  };
}

function createProxyRes({ statusCode, headers }) {
  const proxyRes = new EventEmitter();
  proxyRes.statusCode = statusCode;
  proxyRes.headers = headers;
  proxyRes.pipe = jest.fn((dest) => {
    const chunks = [];
    proxyRes.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    proxyRes.on('end', () => dest.end(Buffer.concat(chunks)));
    return dest;
  });
  return proxyRes;
}

describe('upstream-response', () => {
  test.each([200, 400, 401, 403])('retains real wire auth context and original response classification for %s', statusCode => {
    const deps = createDependencies();
    const { handleUpstreamResponse } = createUpstreamResponseHandlers(deps);
    const req = { method: 'POST', url: '/responses', headers: { 'copilot-integration-id': 'copilot-developer-cli' } };
    const adapter = createCopilotAdapter({
      AWF_ENCLAVE_PROXY_DIAGNOSTICS: '1',
      COPILOT_GITHUB_TOKEN: 'github_pat_SYNTHETIC_PRIVATE_CREDENTIAL',
    });
    const body = Buffer.from('{"model":"test","messages":[]}');
    const headers = buildRequestHeaders(body, body.length, req, {
      injectHeaders: adapter.getAuthHeaders(req), provider: 'copilot',
      targetHost: adapter.getTargetHost(req), requestId: 'synthetic-test',
    });
    const proxyRes = createProxyRes({ statusCode, headers: { 'content-type': 'application/json' } });
    const res = { writeHead: jest.fn(), end: jest.fn() };
    handleUpstreamResponse(proxyRes, headers, {
      body, res, provider: 'copilot', requestId: 'synthetic-test', req,
      targetHost: adapter.getTargetHost(req), upstreamPath: '/chat/completions',
      startTime: Date.now(), span: {}, requestBytes: body.length,
      hasRetried: true, modelNotSupportedRetryCount: 2,
    });
    const response = Buffer.from(statusCode === 200 ? '{}' : '{"error":{"code":"expired_token"}}');
    proxyRes.emit('data', response);
    proxyRes.emit('end');
    const auth = deps.logRequest.mock.calls.filter(([, event]) => event === 'copilot_auth_diagnostic');
    expect(auth).toHaveLength(1);
    expect(auth[0][2]).toMatchObject({
      status: statusCode, credential_source: 'github_token', credential_kind: 'fine_grained_pat',
      target: 'standard', target_match: 'yes', method: 'post', endpoint: 'chat_completions',
      authorization: 'bearer', authorization_match: 'yes', integration: 'cli', integration_match: 'no',
      error_class: statusCode === 200 ? 'none' : 'expired',
    });
    expect(JSON.stringify(auth)).not.toContain('SYNTHETIC_PRIVATE_CREDENTIAL');
    expect(res.end).toHaveBeenCalledWith(response);
  });

  test('translates a buffered upstream Chat Completions response back to Responses', () => {
    const deps = createDependencies();
    const { handleUpstreamResponse } = createUpstreamResponseHandlers(deps);
    const proxyRes = createProxyRes({
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'content-length': '80' },
    });
    const res = { writeHead: jest.fn(), end: jest.fn() };
    const body = Buffer.from(JSON.stringify({
      model: 'claude-haiku-4.5',
      input: 'hello',
    }));
    const upstreamBody = Buffer.from(JSON.stringify({
      id: 'chatcmpl_1',
      model: 'claude-haiku-4.5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));

    handleUpstreamResponse(proxyRes, {}, {
      body,
      res,
      provider: 'copilot',
      requestId: 'wire-api-req',
      req: { method: 'POST', url: '/responses' },
      targetHost: 'api.githubcopilot.com',
      startTime: Date.now() - 10,
      span: {},
      requestBytes: body.length,
      hasRetried: false,
      onRetry: jest.fn(),
      wireApiCompatibility: {
        requestedEndpoint: '/responses',
        upstreamEndpoint: '/chat/completions',
        direction: 'responses_to_chat',
      },
    });

    proxyRes.emit('data', upstreamBody);
    proxyRes.emit('end');

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.not.objectContaining({
      'content-length': '80',
    }));
    expect(JSON.parse(res.end.mock.calls[0][0].toString('utf8'))).toMatchObject({
      object: 'response',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'hello' }],
      }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  });

  test('captures non-2xx upstream body/headers without altering plain-text response', () => {
    const deps = createDependencies();
    const { handleUpstreamResponse } = createUpstreamResponseHandlers(deps);
    const proxyRes = createProxyRes({
      statusCode: 500,
      headers: {
        'content-type': 'text/plain',
        'x-request-id': 'upstream-req-1',
        'set-cookie': 'session=abc',
      },
    });
    const res = { writeHead: jest.fn(), end: jest.fn() };
    const body = Buffer.from('{"model":"gpt-5.4"}');
    const upstreamBody = Buffer.from('upstream failure token=abc123');

    handleUpstreamResponse(proxyRes, {}, {
      body,
      res,
      provider: 'openai',
      requestId: 'local-req-1',
      req: { method: 'POST', url: '/v1/responses' },
      targetHost: 'api.openai.com',
      startTime: Date.now() - 10,
      span: {},
      requestBytes: body.length,
      hasRetried: false,
      onRetry: jest.fn(),
    });

    proxyRes.emit('data', upstreamBody);
    proxyRes.emit('end');

    expect(res.writeHead).toHaveBeenCalledWith(500, expect.objectContaining({
      'x-request-id': 'local-req-1',
      'content-type': 'text/plain',
    }));
    expect(res.end).toHaveBeenCalledWith(upstreamBody);
    expect(deps.logRequest).toHaveBeenCalledWith('warn', 'upstream_error_response', expect.objectContaining({
      request_id: 'local-req-1',
      status: 500,
      upstream_request_ids: { 'x-request-id': 'upstream-req-1' },
      response_streaming: false,
      response_content_type: 'text/plain',
    }));
    const logFields = deps.logRequest.mock.calls.find(([, event]) => event === 'upstream_error_response')[2];
    expect(logFields.response_headers['set-cookie']).toBeUndefined();
    expect(logFields.response_body).toContain('[REDACTED]');
  });

  test('summarises the request tool surface on an error response', () => {
    const deps = createDependencies();
    const { handleUpstreamResponse } = createUpstreamResponseHandlers(deps);
    const proxyRes = createProxyRes({ statusCode: 400, headers: { 'content-type': 'application/json' } });
    const res = { writeHead: jest.fn(), end: jest.fn() };
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5.6-sol',
      tools: [
        { type: 'function', function: { name: 'github-list_issues' } },
        { type: 'function', name: 'safeoutputs-create_issue' },
        { type: 'function' },
        { type: 'function', function: { name: '   ' } },
        { type: 'function', name: '' },
      ],
    }));

    handleUpstreamResponse(proxyRes, {}, {
      body,
      res,
      provider: 'openai',
      requestId: 'local-req-3',
      req: { method: 'POST', url: '/v1/chat/completions' },
      targetHost: 'api.openai.com',
      startTime: Date.now() - 10,
      span: {},
      requestBytes: body.length,
      hasRetried: false,
      onRetry: jest.fn(),
    });

    proxyRes.emit('data', Buffer.from('{"error":"bad request"}'));
    proxyRes.emit('end');

    expect(deps.logRequest).toHaveBeenCalledWith('warn', 'upstream_error_response', expect.objectContaining({
      model: 'gpt-5.6-sol',
      request_tool_count: 5,
      request_tool_names: ['github-list_issues', 'safeoutputs-create_issue'],
      request_unnamed_tool_count: 3,
    }));
  });

  test('omits tool fields when the request carries no tool surface', () => {
    const { _testing } = require('./upstream-response');
    expect(_testing.summarizeRequestTools(Buffer.from('{"model":"gpt-5.6-sol"}'))).toBeNull();
    expect(_testing.summarizeRequestTools(Buffer.from('not json'))).toBeNull();
    expect(_testing.summarizeRequestTools(Buffer.alloc(0))).toBeNull();
  });

  test('captures streaming error payload diagnostics while forwarding payload unchanged', () => {
    const deps = createDependencies();
    const { handleUpstreamResponse } = createUpstreamResponseHandlers(deps);
    const proxyRes = createProxyRes({
      statusCode: 429,
      headers: {
        'content-type': 'text/event-stream',
        'x-correlation-id': 'corr-123',
      },
    });
    const res = { writeHead: jest.fn(), end: jest.fn() };
    const chunkA = Buffer.from('data: {"error":"rate');
    const chunkB = Buffer.from(' limited"}\n\n');

    handleUpstreamResponse(proxyRes, {}, {
      body: Buffer.from('{"model":"gpt-5.4"}'),
      res,
      provider: 'copilot',
      requestId: 'local-req-2',
      req: { method: 'POST', url: '/v1/responses' },
      targetHost: 'api.githubcopilot.com',
      startTime: Date.now() - 10,
      span: {},
      requestBytes: 20,
      hasRetried: false,
      onRetry: jest.fn(),
    });

    proxyRes.emit('data', chunkA);
    proxyRes.emit('data', chunkB);
    proxyRes.emit('end');

    expect(res.end).toHaveBeenCalledWith(Buffer.concat([chunkA, chunkB]));
    expect(deps.logRequest).toHaveBeenCalledWith('warn', 'upstream_error_response', expect.objectContaining({
      request_id: 'local-req-2',
      status: 429,
      response_streaming: true,
      upstream_request_ids: { 'x-correlation-id': 'corr-123' },
    }));
  });

  test.each([400, 503])('streams oversized %i fallback errors without inspecting the full response', (statusCode) => {
    const deps = createDependencies();
    const { handleUpstreamResponse } = createUpstreamResponseHandlers(deps);
    const proxyRes = createProxyRes({
      statusCode,
      headers: { 'content-type': 'application/json', 'content-length': '65547' },
    });
    const res = { writeHead: jest.fn(), write: jest.fn(() => true), end: jest.fn(), once: jest.fn() };
    const prefix = Buffer.alloc(64 * 1024, 'a');
    const overflow = Buffer.from('overflow');
    const tail = Buffer.from('tail');
    const onModelFallback = jest.fn(() => true);

    handleUpstreamResponse(proxyRes, {}, {
      body: Buffer.from('{"model":"gpt-5.4"}'),
      res,
      provider: 'openai',
      requestId: 'local-req-4',
      req: { method: 'POST', url: '/v1/chat/completions' },
      targetHost: 'api.openai.com',
      startTime: Date.now() - 10,
      span: {},
      requestBytes: 20,
      hasRetried: false,
      onRetry: jest.fn(),
      onModelFallback,
    });

    proxyRes.emit('data', prefix);
    proxyRes.emit('data', overflow);
    proxyRes.emit('data', tail);
    proxyRes.emit('end');

    expect(onModelFallback).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(statusCode, expect.objectContaining({
      'x-request-id': 'local-req-4',
      'content-length': '65547',
    }));
    expect(res.write).toHaveBeenNthCalledWith(1, prefix);
    expect(res.write).toHaveBeenNthCalledWith(2, overflow);
    expect(proxyRes.pipe).toHaveBeenCalledWith(res);
    expect(deps.logRequest).toHaveBeenCalledWith('warn', 'upstream_error_response', expect.objectContaining({
      response_body_bytes: prefix.length + overflow.length + tail.length,
      response_body_truncated: true,
    }));
  });

  // Recorded verbatim from github/gh-aw run 38327292581 (upstream-errors.jsonl).
  const INVALID_REASONING_EFFORT_BODY = '{"error":{"message":"output_config.effort \\"high\\" was provided, but model claude-haiku-4.5 does not support reasoning effort","code":"invalid_reasoning_effort"}}';

  test.each([
    ['gzip', zlib.gzipSync, 'copilot'],
    ['gzip', zlib.gzipSync, 'openai'],
    ['br', zlib.brotliCompressSync, 'copilot'],
    ['deflate', zlib.deflateSync, 'openai'],
  ])('records error fields from a %s-encoded 400 forwarded by %s unchanged', (encoding, compress, provider) => {
    const deps = createDependencies();
    const { handleUpstreamResponse } = createUpstreamResponseHandlers(deps);
    const records = [];
    const observation = createRoutingObservation({
      getSelection: () => ({
        provider,
        endpoint: '/v1/messages',
        choice: { effort: 'high' },
        wire_model: 'claude-haiku-4.5',
      }),
      recordFailure: jest.fn(),
      observer: { record: record => records.push(record) },
      generateRequestId: () => 'local-req-5',
    });
    const chunks = [];
    const res = new EventEmitter();
    res.statusCode = 200;
    res.writableFinished = false;
    res.writeHead = jest.fn(function(statusCode) { this.statusCode = statusCode; });
    res.write = jest.fn(chunk => { chunks.push(Buffer.from(chunk)); return true; });
    res.end = jest.fn(function(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
      this.writableFinished = true;
      this.emit('finish');
    });
    const req = { method: 'POST', url: '/v1/messages', headers: {} };
    observation.observeRequest(req, res, { name: provider });
    const upstreamBody = compress(Buffer.from(INVALID_REASONING_EFFORT_BODY));
    const proxyRes = createProxyRes({
      statusCode: 400,
      headers: { 'content-type': 'application/json', 'content-encoding': encoding },
    });
    const body = Buffer.from('{"model":"claude-haiku-4.5","output_config":{"effort":"high"}}');

    handleUpstreamResponse(proxyRes, {}, {
      body,
      res,
      provider,
      requestId: 'local-req-5',
      req,
      targetHost: 'api.example.com',
      startTime: Date.now() - 10,
      span: {},
      requestBytes: body.length,
      hasRetried: false,
      onRetry: jest.fn(),
    });
    proxyRes.emit('data', upstreamBody);
    proxyRes.emit('end');

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.objectContaining({ 'content-encoding': encoding }));
    expect(Buffer.concat(chunks).equals(upstreamBody)).toBe(true);
    expect(records).toEqual([expect.objectContaining({
      request_id: 'local-req-5',
      outcome: 'failed',
      status: 400,
      error_code: 'invalid_reasoning_effort',
      error_source: 'upstream',
    })]);
    expect(records[0]).not.toHaveProperty('error_type');
    expect(JSON.stringify(records[0])).not.toContain('does not support');
  });
});
