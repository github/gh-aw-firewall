'use strict';

/**
 * Regression test for the shared model-discovery buildRequest() dial path:
 * the Squid proxyAgent must be attached for both http:// and https:// targets
 * (it tunnels via CONNECT regardless of scheme, only upgrading to TLS when
 * dispatched through the `https` module), otherwise an explicit http://
 * target — already allowlisted on port 80 by the runner — would bypass
 * Squid and dial the host directly.
 */

describe('model-discovery buildRequest proxyAgent attachment', () => {
  const originalHttpsProxy = process.env.HTTPS_PROXY;

  beforeEach(() => {
    jest.resetModules();
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
  });

  afterEach(() => {
    if (originalHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = originalHttpsProxy;
  });

  function mockResponse() {
    const { EventEmitter } = require('events');
    const res = new EventEmitter();
    res.statusCode = 200;
    res.resume = jest.fn(() => setImmediate(() => res.emit('end')));
    return res;
  }

  it('attaches the proxy agent for an https:// target', async () => {
    const { proxyAgent } = require('./http-client');
    const { httpProbe } = require('./model-discovery');
    const https = require('https');

    let capturedOpts;
    jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
      capturedOpts = opts;
      const req = { on: jest.fn(), end: jest.fn(), write: jest.fn() };
      setImmediate(() => cb(mockResponse()));
      return req;
    });

    await httpProbe('https://api.openai.com/v1/models', { method: 'GET', headers: {} }, 1000);

    expect(capturedOpts.agent).toBe(proxyAgent);
    expect(capturedOpts.port).toBe(443);
  });

  it('also attaches the proxy agent for an explicit http:// target', async () => {
    const { proxyAgent } = require('./http-client');
    const { httpProbe } = require('./model-discovery');
    const http = require('http');

    let capturedOpts;
    jest.spyOn(http, 'request').mockImplementation((opts, cb) => {
      capturedOpts = opts;
      const req = { on: jest.fn(), end: jest.fn(), write: jest.fn() };
      setImmediate(() => cb(mockResponse()));
      return req;
    });

    await httpProbe('http://gateway.example.com/v1/models', { method: 'GET', headers: {} }, 1000);

    expect(capturedOpts.agent).toBe(proxyAgent);
    expect(capturedOpts.port).toBe(80);
  });
});
