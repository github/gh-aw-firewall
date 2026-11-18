'use strict';

const { createProtocolTranslation, assessCrossProviderFailure } = require('./upstream-protocol-translation');

function setup(overrides = {}, deps = {}) {
  const body = Buffer.from('{"model":"current","messages":[],"max_tokens":123}');
  const originBody = Buffer.from('{"model":"original","messages":[]}');
  const codexCompatibility = { customTools: new Set(['apply_patch']) };
  const wireApiCompatibility = { passthrough: true };
  const origin = {
    provider: 'openai', protocol: 'chat', sourceBody: originBody, body: originBody,
    upstreamPath: '/v1/chat/completions', targetHost: 'origin.example', targetScheme: 'https',
    requestHeaders: { 'Content-Length': '1', 'Transfer-Encoding': 'chunked', original: 'header' },
    requestSigner: jest.fn(), codexCompatibility, wireApiCompatibility,
    wireApiEndpointRetryAttempted: false,
  };
  const context = {
    body, targetHost: 'current.example', upstreamPath: '/v1/chat/completions',
    req: { method: 'POST', url: '/v1/chat/completions' }, res: {},
    provider: 'anthropic', requestId: 'translate-test', startTime: 123, span: {},
    requestSigner: jest.fn(), hasRetried: true, modelNotSupportedRetryCount: 2,
    targetScheme: 'http', codexCompatibility, wireApiCompatibility,
    wireApiEndpointRetryAttempted: true,
    protocolTranslation: { source: 'chat', target: 'messages' },
    requestHeaders: { 'Content-Length': '1', 'Transfer-Encoding': 'chunked' },
    current: { model: 'current', location: 'body' }, origin,
    chain: ['anthropic/next', 'openai/back'],
    nextAttempts: candidate => [{ provider: candidate.provider, model: candidate.model }],
    nextOrigin: { ...origin, failures: [{ model: 'current' }] },
    ...overrides,
  };
  const sendUpstreamRequest = jest.fn();
  const assessCandidate = jest.fn(() => ({ compatibility: { status: 'compatible' } }));
  return {
    context, sendUpstreamRequest, assessCandidate,
    ...createProtocolTranslation(context, { sendUpstreamRequest, assessCandidate, ...deps }),
  };
}

test('same-provider retry rewrites the current body and preserves attempt state and compatibility', () => {
  const { buildSameProviderAttempt, context, sendUpstreamRequest } = setup();
  const candidate = { provider: 'anthropic', model: 'next', entry: 'anthropic/next' };
  const built = buildSameProviderAttempt(candidate);
  expect(sendUpstreamRequest).not.toHaveBeenCalled();
  built.dispatch();
  const [headers, retry] = sendUpstreamRequest.mock.calls[0];
  expect(JSON.parse(retry.body)).toEqual({ model: 'next', messages: [], max_tokens: 123 });
  expect(headers).toEqual({ 'content-length': String(retry.body.length) });
  expect(retry).toMatchObject({
    provider: 'anthropic', hasRetried: true, modelNotSupportedRetryCount: 2,
    requestSigner: context.requestSigner, fallbackOrigin: context.nextOrigin,
    protocolTranslation: context.protocolTranslation, wireApiEndpointRetryAttempted: true,
    requestBytes: retry.body.length,
  });
  expect(retry.codexCompatibility).toBe(context.codexCompatibility);
  expect(retry.wireApiCompatibility).toBe(context.wireApiCompatibility);
});

test('origin retry rebuilds the saved original request and resets provider-specific retry state', () => {
  const { buildOriginAttempt, context, sendUpstreamRequest } = setup();
  buildOriginAttempt({ provider: 'openai', model: 'back', entry: 'openai/back' }).dispatch();
  const [headers, retry] = sendUpstreamRequest.mock.calls[0];
  expect(JSON.parse(retry.body)).toEqual({ model: 'back', messages: [] });
  expect(headers).toEqual({ original: 'header', 'content-length': String(retry.body.length) });
  expect(retry).toMatchObject({
    provider: 'openai', targetHost: 'origin.example', targetScheme: 'https',
    requestSigner: context.origin.requestSigner, hasRetried: false,
    modelNotSupportedRetryCount: 0, protocolTranslation: null,
    wireApiEndpointRetryAttempted: false,
  });
  expect(retry.codexCompatibility).toBe(context.origin.codexCompatibility);
  expect(retry.wireApiCompatibility).toBe(context.origin.wireApiCompatibility);
});

test('incompatible same-provider candidates are not rebuilt or dispatched', () => {
  const assessment = { compatibility: { status: 'incompatible' } };
  const { buildSameProviderAttempt, sendUpstreamRequest } = setup({}, {
    assessCandidate: () => assessment,
  });
  expect(buildSameProviderAttempt({ provider: 'anthropic', model: 'next', entry: 'anthropic/next' }))
    .toEqual({ assessment });
  expect(sendUpstreamRequest).not.toHaveBeenCalled();
});

test('cross-provider builds remain undispatched until accepted and restore origin compatibility', async () => {
  const adapter = {
    name: 'anthropic', isEnabled: () => true,
    getTargetHost: () => 'api.anthropic.com', getTargetScheme: () => 'https',
    getBasePath: () => '', getAuthHeaders: () => ({}), getBodyTransform: () => null,
  };
  const { buildCrossProviderAttempt, dispatchCrossProviderAttempt, sendUpstreamRequest, context } =
    setup({}, { getProviderAdapter: () => adapter });
  const candidate = { provider: 'anthropic', model: 'next', entry: 'anthropic/next' };
  const built = await buildCrossProviderAttempt(candidate, () => ({ status: 'compatible' }));
  expect(sendUpstreamRequest).not.toHaveBeenCalled();
  dispatchCrossProviderAttempt(built, candidate);
  const [, retry] = sendUpstreamRequest.mock.calls[0];
  expect(JSON.parse(retry.body).model).toBe('next');
  expect(retry).toMatchObject({
    provider: 'anthropic', targetHost: 'api.anthropic.com',
    hasRetried: false, modelNotSupportedRetryCount: 0,
    fallbackOrigin: context.nextOrigin,
  });
  expect(retry.codexCompatibility).toBe(context.origin.codexCompatibility);
});

test('failed cross-provider builds downgrade otherwise compatible evidence without mutating it', () => {
  const assessment = { compatibility: { status: 'compatible', features: ['message_text'], reasons: [] } };
  const result = assessCrossProviderFailure({}, new Error('build failed'), assessment, {});
  expect(result.compatibility).toEqual({
    status: 'unverified', features: ['message_text', 'unknown_fields'],
    reasons: [{ feature: 'unknown_fields', code: 'request_build_failed' }],
  });
  expect(assessment.compatibility.status).toBe('compatible');
});

test('missing cross-provider evidence uses the protocol endpoint and adapter authority', () => {
  const assessCandidate = jest.fn(() => ({ compatibility: { status: 'incompatible' } }));
  const candidate = { provider: 'anthropic', model: 'next' };
  const req = {};
  const assessment = assessCrossProviderFailure(candidate, { code: 'unsupported_protocol_feature' }, null, {
    origin: { protocol: 'chat' }, req, assessCandidate,
    getProviderAdapter: () => ({ getTargetHost: () => 'custom.example', getTargetScheme: () => 'http' }),
  });
  expect(assessCandidate).toHaveBeenCalledWith(candidate, '/v1/messages', 'custom.example', 'http');
  expect(assessment.compatibility.status).toBe('incompatible');
});
