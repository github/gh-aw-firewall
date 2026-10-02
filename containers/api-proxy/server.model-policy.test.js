'use strict';

const https = require('https');
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
  it('rejects an unsanctioned harness fallback before forwarding to the provider', async () => {
    const upstream = createMockUpstreamCycle(https);
    const req = makeReq('/v1/responses');
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: '******' }, 'openai');
    req.emit('data', Buffer.from('{"model":"gpt-5.4","input":"hello"}'));
    req.emit('end');
    await flushPromises();

    expect(upstream.spy).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      error: {
        type: 'model_policy_violation',
        message: "Model 'gpt-5.4' is not permitted: it does not match the allowed models policy.",
        model: 'gpt-5.4',
        reason: 'not_allowed',
      },
    });
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
