'use strict';

const { createAttemptRecovery } = require('./upstream-attempt-recovery');

function setup({ chain = ['blocked', 'next'], reqOverrides = {}, body: liveBody } = {}) {
  const body = Buffer.from('{"model":"first","messages":[]}');
  const req = { method: 'POST', url: '/v1/chat/completions', ...reqOverrides };
  const cancellation = { cancelled: false };
  const sendUpstreamRequest = jest.fn();
  const logRequest = jest.fn();
  const getFallbackModels = jest.fn(() => chain);
  const headers = { 'content-length': String(body.length) };
  const recovery = createAttemptRecovery({
    body, targetHost: 'api.openai.com', upstreamPath: req.url, req, res: {},
    provider: 'openai', requestId: 'recovery-test', startTime: 123, span: {},
    requestHeaders: headers, cancellation,
  }, {
    getBody: () => liveBody || body,
    getRequestHeaders: () => headers,
    getFallbackModels,
    isFallbackModelPermitted: model => model !== 'blocked',
    sendUpstreamRequest, logRequest,
    metrics: { gaugeDec: jest.fn(), gaugeInc: jest.fn(), increment: jest.fn() },
    otel: { endSpan: jest.fn() },
  });
  return { ...recovery, body, req, cancellation, sendUpstreamRequest, logRequest, getFallbackModels };
}

test('ordered recovery skips rejected entries, accepts the next candidate, and runs once', () => {
  const { onModelFallback, req, sendUpstreamRequest, logRequest } = setup();
  expect(onModelFallback({ reason: 'upstream_connection_error' })).toBe(true);
  expect(sendUpstreamRequest).toHaveBeenCalledTimes(1);
  expect(req.awfModelFallback).toMatchObject({
    from_model: 'first', model: 'next', reason: 'upstream_connection_error', attempt: 1,
  });
  expect(logRequest).toHaveBeenCalledWith('warn', 'model_fallback_skipped', expect.objectContaining({
    candidate_model: 'blocked', reason: 'guard_rejected',
  }));
  expect(onModelFallback()).toBe(false);
  expect(sendUpstreamRequest).toHaveBeenCalledTimes(1);
});

test('origin is pre-budget while same-provider recovery reads the final body lazily', () => {
  const liveBody = Buffer.from('{"model":"first","messages":[],"max_tokens":99}');
  const { origin, body, onModelFallback, sendUpstreamRequest } = setup({ body: liveBody });
  expect(origin.body).toBe(body);
  expect(origin.sourceBody).toBe(body);
  expect(onModelFallback()).toBe(true);
  expect(JSON.parse(sendUpstreamRequest.mock.calls[0][1].body)).toEqual({
    model: 'next', messages: [], max_tokens: 99,
  });
});

test('exhausted ordered chains return control to the original failure handler', () => {
  const { onModelFallback, sendUpstreamRequest } = setup({ chain: ['blocked'] });
  const abandon = jest.fn();
  expect(onModelFallback({ reason: 'upstream_5xx', statusCode: 503, abandon })).toBe(false);
  expect(sendUpstreamRequest).not.toHaveBeenCalled();
  expect(abandon).not.toHaveBeenCalled();
});

test('cancelled requests do not select or dispatch another candidate', () => {
  const { cancellation, onModelFallback, sendUpstreamRequest, logRequest } = setup();
  cancellation.cancelled = true;
  expect(onModelFallback()).toBe(false);
  expect(sendUpstreamRequest).not.toHaveBeenCalled();
  expect(logRequest).not.toHaveBeenCalled();
});

test.each([
  { awfScopedAuto: true },
  { awfTrustedService: true },
  { awfRequestContext: { purpose: 'routing_classification' } },
])('does not install ordered recovery for internal request %j', reqOverrides => {
  const { onModelFallback, getFallbackModels } = setup({ reqOverrides });
  expect(onModelFallback).toBeNull();
  expect(getFallbackModels).not.toHaveBeenCalled();
});
