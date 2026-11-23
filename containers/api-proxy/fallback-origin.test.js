'use strict';

const { buildFallbackOrigin } = require('./fallback-origin');

function input(overrides = {}) {
  return {
    body: Buffer.from('{"model":"current","messages":[]}'),
    provider: 'openai',
    upstreamPath: '/v1/chat/completions',
    req: { url: '/v1/responses?stream=true' },
    requestHeaders: { 'content-type': 'application/json' },
    targetHost: 'api.openai.com', targetScheme: 'https',
    requestSigner: jest.fn(), codexCompatibility: true,
    wireApiCompatibility: { direction: 'responses_to_chat' },
    wireApiEndpointRetryAttempted: true,
    ...overrides,
  };
}

test('preserves the original protocol and pre-budget transport snapshot', () => {
  const params = input();
  const origin = buildFallbackOrigin(params);
  expect(origin).toEqual({
    provider: params.provider, protocol: 'responses', endpoint: '/responses',
    sourceBody: params.body, model: 'current', body: params.body,
    upstreamPath: params.upstreamPath, requestHeaders: params.requestHeaders,
    targetHost: params.targetHost, targetScheme: params.targetScheme,
    requestSigner: params.requestSigner, codexCompatibility: params.codexCompatibility,
    wireApiCompatibility: params.wireApiCompatibility, wireApiSourceBody: undefined,
    wireApiEndpointRetryAttempted: true, failures: [],
  });
  const originalBody = params.body;
  const originalHeaders = params.requestHeaders;
  params.body = Buffer.from('{"model":"current","max_tokens":99}');
  params.requestHeaders = { 'content-length': String(params.body.length) };
  expect(origin.body).toBe(originalBody);
  expect(origin.sourceBody).toBe(originalBody);
  expect(origin.requestHeaders).toBe(originalHeaders);
});

test('returns a supplied origin unchanged on subsequent attempts', () => {
  const fallbackOrigin = buildFallbackOrigin(input());
  expect(buildFallbackOrigin(input({ fallbackOrigin }))).toBe(fallbackOrigin);
});

test.each([
  [true, true, 'agent'],
  [false, true, 'wire'],
  [false, false, 'current'],
])('source body precedence: agent=%s, wire=%s', (agent, wire, expected) => {
  const params = input({
    req: { awfFallbackSourceBody: agent ? Buffer.from('agent') : null },
    wireApiSourceBody: wire ? Buffer.from('wire') : null,
  });
  const origin = buildFallbackOrigin(params);
  expect(origin.sourceBody).toBe(agent ? params.req.awfFallbackSourceBody
    : wire ? params.wireApiSourceBody : params.body);
  expect(origin.sourceBody.toString()).toContain(expected);
  expect(origin.protocol).toBe('chat');
  expect(origin.endpoint).toBe('/chat/completions');
});

test.each([
  [{ provider: 'openai', fromModel: 'resolved' }, [{ model: 'recovered' }], 'resolved'],
  [{ provider: 'anthropic', fromModel: 'resolved' }, [{ model: 'recovered' }], 'recovered'],
  [null, [{ model: 'recovered' }], 'recovered'],
  [null, null, 'current'],
])('model precedence preserves the first requested model: %j, %j', (resolver, attempts, expected) => {
  const failures = [{ provider: 'openai', model: 'failed', reason: 'upstream_5xx' }];
  const origin = buildFallbackOrigin(input({
    req: { awfResolverFallback: resolver, awfRecoveryAttempts: attempts, awfModelFallback: { failures } },
  }));
  expect(origin.model).toBe(expected);
  expect(origin.failures).toBe(failures);
});

test('uses path models and preserves unknown endpoint defaults', () => {
  const origin = buildFallbackOrigin(input({
    body: Buffer.from('{}'), req: {}, upstreamPath: '/v1/models/gemini-test:generateContent',
  }));
  expect(origin.model).toBe('gemini-test');
  expect(origin.protocol).toBeNull();
  expect(origin.endpoint).toBeNull();
  expect(buildFallbackOrigin(input({ body: Buffer.from('{}') })).model).toBeNull();
});
