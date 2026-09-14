const { EventEmitter } = require('events');
const { createUpstreamResponseHandlers } = require('./upstream-response');

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
});
