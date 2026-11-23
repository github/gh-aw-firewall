'use strict';

const { EventEmitter } = require('events');
jest.mock('./reasoning-effort-validation');
const { validateReasoningEffort } = require('./reasoning-effort-validation');
const { redactCredentialText } = require('./credential-protection');
const { createDispatchUpstreamRequest } = require('./upstream-dispatch');

function setup() {
  const body = Buffer.from('{"model":"fixture","messages":[]}');
  const req = { method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'invocation' } };
  const res = Object.assign(new EventEmitter(), {
    writeHead: jest.fn(), end: jest.fn(), destroy: jest.fn(),
  });
  const context = {
    body, req, res, targetHost: 'api.example.com', upstreamPath: req.url,
    provider: 'openai', requestId: 'dispatch-test', startTime: Date.now(), span: {},
    requestBytes: body.length,
  };
  const attempt = { allowed: true, settleMissing: jest.fn() };
  const proxyReq = Object.assign(new EventEmitter(), { write: jest.fn(), end: jest.fn() });
  const dependencies = {
    http: { request: jest.fn(() => proxyReq) },
    https: { request: jest.fn(() => proxyReq) },
    proxyAgent: {},
    modelBudget: { beginAttempt: jest.fn(() => attempt) },
    handleUpstreamResponse: jest.fn(), handleRequestError: jest.fn(),
    sendUpstreamRequest: jest.fn(), failBrokerAuth: jest.fn(), sleep: jest.fn(),
    getFallbackModels: jest.fn(() => []), logRequest: jest.fn(),
    metrics: { gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() },
    otel: { endSpan: jest.fn(), endSpanError: jest.fn() },
  };
  return {
    context, attempt, proxyReq, ...dependencies,
    dispatch: createDispatchUpstreamRequest(dependencies),
  };
}

beforeEach(() => validateReasoningEffort.mockReset());

test.each([
  ['invalid_capability', 'capabilityFailure', 'missing', 'capability_missing'],
  ['invalid_capability', 'capabilityFailure', 'scheme', 'capability_scheme'],
  ['invalid_capability', 'capabilityFailure', 'format', 'capability_format'],
  ['invalid_capability', 'capabilityFailure', 'signature', 'capability_signature'],
  ['invalid_capability', 'capabilityFailure', 'claims', 'capability_claims'],
  ['invalid_capability', 'capabilityFailure', 'claims_changed', 'capability_claims_changed'],
  ['token_limit', 'tokenFailure', 'body_missing', 'token_body_missing'],
  ['token_limit', 'tokenFailure', 'input_reservation', 'token_input_reservation'],
  ['token_limit', 'tokenFailure', 'request_json', 'token_request_json'],
  ['token_limit', 'tokenFailure', 'request_shape', 'token_request_shape'],
  ['token_limit', 'tokenFailure', 'output_conflict', 'token_output_conflict'],
  ['token_limit', 'tokenFailure', 'output_shape', 'token_output_shape'],
  ['token_limit', 'tokenFailure', 'stream_options', 'token_stream_options'],
  ['token_limit', 'tokenFailure', 'budget_exhausted', 'token_budget_exhausted'],
  ['request_limit', null, null, null],
  ['invalid_capability', 'capabilityFailure', 'unknown', null],
  ['token_limit', 'tokenFailure', 'unknown', null],
])('rejects %s/%s/%s before signing or transport', (reason, field, failure, event) => {
  const h = setup();
  const requestSigner = jest.fn();
  h.modelBudget.beginAttempt.mockReturnValue({ allowed: false, reason, [field]: failure });
  const status = reason === 'invalid_capability' ? 403 : 429;

  h.dispatch({}, { ...h.context, requestSigner });

  expect(h.modelBudget.beginAttempt).toHaveBeenCalledWith({
    authorization: 'invocation', method: 'POST', path: h.context.upstreamPath, body: h.context.body,
  });
  expect(requestSigner).not.toHaveBeenCalled();
  expect(h.https.request).not.toHaveBeenCalled();
  expect(h.http.request).not.toHaveBeenCalled();
  expect(h.metrics.gaugeDec).toHaveBeenCalledTimes(1);
  expect(h.metrics.gaugeDec).toHaveBeenCalledWith('active_requests', { provider: 'openai' });
  expect(h.metrics.increment).toHaveBeenCalledWith('requests_total', {
    provider: 'openai', method: 'POST', status_class: '4xx',
  });
  expect(h.otel.endSpan).toHaveBeenCalledWith(h.context.span, status);
  expect(h.logRequest).toHaveBeenCalledWith('warn', 'enclave_model_budget_rejected', {
    request_id: 'dispatch-test', provider: 'openai', reason,
  });
  if (reason === 'token_limit') {
    expect(h.logRequest).toHaveBeenCalledWith('warn', 'enclave_model_token_limit', { status });
  }
  if (event) {
    expect(h.logRequest).toHaveBeenCalledWith('warn', `enclave_model_${event}`, { status });
  }
  expect(h.logRequest).toHaveBeenCalledTimes(1 + Number(reason === 'token_limit') + Number(Boolean(event)));
  expect(h.context.res.writeHead).toHaveBeenCalledWith(status, {
    'Content-Type': 'application/json', 'X-Request-ID': 'dispatch-test',
  });
  expect(JSON.parse(h.context.res.end.mock.calls[0][0])).toEqual({
    error: {
      message: 'Enclave model budget exhausted or invalid',
      type: 'awf_enclave_model_budget_error',
      code: `awf_enclave_model_budget_${reason}`,
    },
  });
});

test('destroys an already-started response on budget rejection without writing headers', () => {
  const h = setup();
  h.context.res.headersSent = true;
  h.modelBudget.beginAttempt.mockReturnValue({ allowed: false, reason: 'request_limit' });
  h.dispatch({}, h.context);
  expect(h.context.res.destroy).toHaveBeenCalledTimes(1);
  expect(h.context.res.writeHead).not.toHaveBeenCalled();
  expect(h.context.res.end).not.toHaveBeenCalled();
  expect(h.otel.endSpan).toHaveBeenCalledWith(h.context.span, 429);
});

test('rejects unsupported reasoning effort before beginning a budget attempt', () => {
  const h = setup();
  const error = Object.assign(new Error('Unsupported effort'), { code: 'unsupported_reasoning_effort' });
  validateReasoningEffort.mockImplementation(() => { throw error; });
  h.context.req.awfRouting = {};
  h.dispatch({}, h.context);
  expect(validateReasoningEffort).toHaveBeenCalledWith(
    h.context.body, 'openai', h.context.upstreamPath, undefined, h.context.req,
    { targetHost: h.context.targetHost, targetScheme: 'https' },
  );
  expect(h.modelBudget.beginAttempt).not.toHaveBeenCalled();
  expect(h.https.request).not.toHaveBeenCalled();
  expect(h.context.req.awfRouting.localError).toEqual({
    code: error.code, type: 'invalid_request_error',
  });
  expect(h.otel.endSpan).toHaveBeenCalledWith(h.context.span, 400);
  expect(h.logRequest).toHaveBeenCalledWith('warn', 'request_validation_failed', expect.objectContaining({
    error_code: error.code, status: 400, path: h.context.req.url,
  }));
  expect(JSON.parse(h.context.res.end.mock.calls[0][0])).toEqual({
    error: { message: error.message, code: error.code, type: 'invalid_request_error' },
  });
});

test('does not swallow unrelated validation errors', () => {
  const h = setup();
  const error = new Error('unexpected validator failure');
  validateReasoningEffort.mockImplementation(() => { throw error; });
  expect(() => h.dispatch({}, h.context)).toThrow(error);
  expect(h.modelBudget.beginAttempt).not.toHaveBeenCalled();
  expect(h.context.res.end).not.toHaveBeenCalled();
});

test('signs the budget-rewritten body and remembers only credential-bearing signed headers', () => {
  const h = setup();
  const rewritten = Buffer.from('{"model":"fixture","messages":[],"max_tokens":12}');
  h.attempt.body = rewritten;
  const signed = {
    Authorization: ['Bearer', 'fixture-signed-value'].join(' '),
    'X-Amz-Security-Token': 'fixture-session-value',
    host: 'api.example.com',
  };
  const requestSigner = jest.fn(() => signed);
  h.dispatch({ 'Content-Length': '1', 'Transfer-Encoding': 'chunked', host: 'api.example.com' }, {
    ...h.context, requestSigner,
  });
  expect(requestSigner).toHaveBeenCalledWith({
    method: 'POST', path: h.context.upstreamPath, body: rewritten, targetHost: h.context.targetHost,
    headers: { host: 'api.example.com', 'content-length': String(rewritten.length) },
  });
  expect(h.https.request).toHaveBeenCalledWith(expect.objectContaining({ headers: signed }), expect.any(Function));
  expect(h.proxyReq.write).toHaveBeenCalledWith(rewritten);
  expect(h.proxyReq.end).toHaveBeenCalledTimes(1);
  expect(h.context.req.awfEnclaveModelBudgetAttempt).toBe(h.attempt);
  for (const value of ['fixture-signed-value', 'fixture-session-value']) {
    expect(redactCredentialText(h.context.req, value)).not.toContain(value);
  }
  expect(redactCredentialText(h.context.req, signed.host)).toBe(signed.host);
  expect(h.attempt.settleMissing).not.toHaveBeenCalled();
});

test('settles the attempt and reports signing failure without starting transport', () => {
  const h = setup();
  const error = new Error('signer unavailable');
  h.dispatch({}, { ...h.context, requestSigner: () => { throw error; } });
  expect(h.attempt.settleMissing).toHaveBeenCalledTimes(1);
  expect(h.otel.endSpanError).toHaveBeenCalledWith(h.context.span, error, 503);
  expect(h.handleRequestError).toHaveBeenCalledWith(error, expect.objectContaining({
    res: h.context.res, req: h.context.req, requestId: 'dispatch-test', provider: 'openai',
    targetHost: h.context.targetHost, startTime: h.context.startTime,
    statusCode: 503, clientMessage: 'AWS request signing unavailable',
  }));
  h.handleRequestError.mock.calls[0][1].extraMetrics();
  expect(h.metrics.increment).toHaveBeenCalledWith('requests_total', {
    provider: 'openai', method: 'POST', status_class: '5xx',
  });
  expect(h.https.request).not.toHaveBeenCalled();
  expect(h.http.request).not.toHaveBeenCalled();
});

test('settles an attempt cancelled during budget admission before signing', () => {
  const h = setup();
  const requestSigner = jest.fn();
  h.modelBudget.beginAttempt.mockImplementation(() => {
    h.context.req.awfUpstreamCancellation.cancel();
    return h.attempt;
  });
  h.dispatch({}, { ...h.context, requestSigner });
  expect(h.attempt.settleMissing).toHaveBeenCalledTimes(1);
  expect(requestSigner).not.toHaveBeenCalled();
  expect(h.https.request).not.toHaveBeenCalled();
});

test.each([
  ['https', 'api.example.com', 'api.example.com', 443, false],
  ['http', 'localhost', 'localhost', 80, false],
  ['https', '[::1]:8443', '::1', 8443, true],
  ['http', '[::1]:8080', '::1', 8080, false],
])('constructs unsigned %s transport options for %s', (targetScheme, targetHost, hostname, port, trusted) => {
  const h = setup();
  h.context.req.awfTrustedService = trusted;
  const headers = { host: targetHost };
  h.dispatch(headers, { ...h.context, targetScheme, targetHost });
  const transport = targetScheme === 'http' ? h.http : h.https;
  const otherTransport = targetScheme === 'http' ? h.https : h.http;
  expect(transport.request).toHaveBeenCalledWith({
    hostname, port, path: h.context.upstreamPath, method: 'POST', headers,
    agent: h.proxyAgent, signal: h.context.req.awfUpstreamCancellation.controller.signal,
    ...(trusted ? { rejectUnauthorized: true } : {}),
  }, expect.any(Function));
  expect(otherTransport.request).not.toHaveBeenCalled();
  expect(h.proxyReq.write).toHaveBeenCalledWith(h.context.body);
  expect(h.proxyReq.end).toHaveBeenCalledTimes(1);
});
