'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const { createRoutingObservation } = require('./routing-observation');
const {
  makeReq,
  makeRes,
  setupServerTestEnv,
  flushPromises,
  createMockUpstreamCycle,
} = require('./test-helpers/server-mock-factories');

let proxyRequest;
setupServerTestEnv(() => {
  process.env.AWF_ALLOWED_MODELS = JSON.stringify(['gpt-5.6-sol']);
  ({ proxyRequest } = require('./server'));
  return { proxyRequest };
});

afterAll(() => {
  delete process.env.AWF_ALLOWED_MODELS;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('proxyRequest model allowlist', () => {
  it.each(['routing-policy-123', undefined])('records a rejected fallback with the proxy request ID (%s)', async clientRequestId => {
    const upstream = createMockUpstreamCycle(https);
    const req = makeReq('/v1/responses', clientRequestId ? { 'x-request-id': clientRequestId } : {});
    const res = Object.assign(new EventEmitter(), makeRes());
    res.statusCode = 200;
    res.writeHead.mockImplementation(status => { res.statusCode = status; res.headersSent = true; });
    res.end.mockImplementation(() => { res.writableFinished = true; res.emit('finish'); });
    const endResponse = res.end;
    const records = [];
    const observation = createRoutingObservation({
      getSelection: () => ({
        provider: 'openai',
        choice: { model: 'openai/gpt-5.4' },
        wire_model: 'gpt-5.4',
        endpoint: '/responses',
      }),
      recordFailure: () => {},
      observer: { record: record => records.push(record) },
    });
    observation.observeRequest(req, res, { name: 'openai' });
    proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai', '', req.awfRouting.bodyTransform);
    req.emit('data', Buffer.from('{"model":"gpt-5.4","input":"hello"}'));
    expect(records).toEqual([]);
    req.emit('end');
    await flushPromises();

    expect(upstream.spy).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(JSON.parse(endResponse.mock.calls[0][0])).toEqual({
      error: {
        type: 'model_policy_violation',
        message: "Model 'gpt-5.4' is not permitted: it does not match the allowed models policy.",
        model: 'gpt-5.4',
        reason: 'not_allowed',
      },
    });
    const requestId = res.setHeader.mock.calls.find(([name]) => name === 'X-Request-ID')[1];
    expect(requestId).toEqual(expect.any(String));
    if (clientRequestId) expect(requestId).toBe(clientRequestId);
    res.emit('close');
    expect(records).toEqual([expect.objectContaining({
      stage: 'request',
      request_id: requestId,
      outcome: 'rejected',
      status: 403,
      requested_model: 'gpt-5.4',
      routed: 'as_selected',
    })]);
    await observation.drain();
  });

  it('forwards a sanctioned model', async () => {
    const upstream = createMockUpstreamCycle(https);
    const req = makeReq('/v1/responses');
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai');
    req.emit('data', Buffer.from('{"model":"gpt-5.6-sol","input":"hello"}'));
    req.emit('end');
    await flushPromises();

    expect(upstream.spy).toHaveBeenCalledTimes(1);
  });
});
