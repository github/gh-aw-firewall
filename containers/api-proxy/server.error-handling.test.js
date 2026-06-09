/**
 * Tests for proxyRequest error handling: client stream errors,
 * upstream response stream errors, and upstream connection errors.
 *
 * Extracted from server.proxy.test.js.
 */

const https = require('https');
const { EventEmitter } = require('events');
const {
  makeReq: makeReqFactory,
  makeRes,
  getStructuredLogs,
  setupServerTestEnv,
  flushPromises,
} = require('./test-helpers/server-mock-factories');

let proxyRequest;
let healthResponse;

setupServerTestEnv(() => {
  ({ proxyRequest, healthResponse } = require('./server'));
  return { proxyRequest, healthResponse };
});

describe('proxyRequest error handling', () => {
  function makeReq(headers = {}) {
    return makeReqFactory('/v1/chat/completions', headers);
  }

  function getRequestErrorLog(writeSpy) {
    return getStructuredLogs(writeSpy, 'request_error')[0] || null;
  }

  let stdoutWriteSpy;

  beforeEach(() => {
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 400 when the client request stream errors', () => {
    const before = healthResponse().metrics_summary;
    const req = makeReq();
    const res = makeRes();

    proxyRequest(req, res, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req.emit('error', new Error('client stream failed\ninjected'));

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      error: 'Client error',
      message: 'client stream failed\ninjected',
    });
    const after = healthResponse().metrics_summary;
    expect(after.total_errors).toBe(before.total_errors + 1);
    expect(after.active_requests).toBe(before.active_requests);
    const errorLog = getRequestErrorLog(stdoutWriteSpy);
    expect(errorLog).toMatchObject({
      event: 'request_error',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      error: 'client stream failedinjected',
      upstream_host: 'api.openai.com',
    });
  });

  it('destroys response when upstream response stream errors after headers are sent', async () => {
    const before = healthResponse().metrics_summary;
    let responseHandler;
    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    jest.spyOn(https, 'request').mockImplementation((_options, cb) => {
      responseHandler = cb;
      return upstreamRequest;
    });

    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req.emit('end');
    await flushPromises();

    const proxyRes = new EventEmitter();
    proxyRes.statusCode = 200;
    proxyRes.headers = {};
    proxyRes.pipe = jest.fn();
    responseHandler(proxyRes);
    proxyRes.emit('error', new Error('upstream stream failed'));

    expect(res.writeHead).toHaveBeenNthCalledWith(1, 200, { 'x-request-id': expect.any(String) });
    expect(res.writeHead).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(res.destroy).toHaveBeenCalledWith(expect.any(Error));
    const after = healthResponse().metrics_summary;
    expect(after.total_errors).toBe(before.total_errors + 1);
    expect(after.active_requests).toBe(before.active_requests);
    const errorLog = getRequestErrorLog(stdoutWriteSpy);
    expect(errorLog).toMatchObject({
      event: 'request_error',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      error: 'upstream stream failed',
      upstream_host: 'api.openai.com',
    });
  });

  it('returns 502 when the upstream proxy request errors', async () => {
    const before = healthResponse().metrics_summary;
    const upstreamRequest = new EventEmitter();
    upstreamRequest.end = jest.fn();
    upstreamRequest.write = jest.fn();
    upstreamRequest.destroy = jest.fn();

    jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

    const req = makeReq();
    const res = makeRes();
    proxyRequest(req, res, 'api.openai.com', { Authorization: 'Bearer token' }, 'openai');
    req.emit('end');
    await flushPromises();
    upstreamRequest.emit('error', new Error('upstream connect failed'));

    expect(res.writeHead).toHaveBeenCalledWith(502, { 'Content-Type': 'application/json' });
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      error: 'Proxy error',
      message: 'upstream connect failed',
    });
    const after = healthResponse().metrics_summary;
    expect(after.total_errors).toBe(before.total_errors + 1);
    expect(after.total_requests).toBe(before.total_requests + 1);
    expect(after.active_requests).toBe(before.active_requests);
    const errorLog = getRequestErrorLog(stdoutWriteSpy);
    expect(errorLog).toMatchObject({
      event: 'request_error',
      provider: 'openai',
      method: 'POST',
      path: '/v1/chat/completions',
      error: 'upstream connect failed',
      upstream_host: 'api.openai.com',
    });
  });
});
