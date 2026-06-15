'use strict';

const { EventEmitter } = require('events');

function makeReq(url, headers = {}) {
  const req = new EventEmitter();
  req.url = url;
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', ...headers };
  return req;
}

function makeRes() {
  const res = {
    headersSent: false,
    setHeader: jest.fn(),
    writeHead: jest.fn(() => {
      res.headersSent = true;
    }),
    end: jest.fn(),
    destroy: jest.fn(),
  };
  return res;
}

function makeProxyReq() {
  const proxyReq = new EventEmitter();
  proxyReq.end = jest.fn();
  proxyReq.write = jest.fn();
  proxyReq.destroy = jest.fn();
  return proxyReq;
}

function makeProxyRes(statusCode, headers = { 'content-type': 'application/json' }) {
  const proxyRes = new EventEmitter();
  proxyRes.statusCode = statusCode;
  proxyRes.headers = headers;
  proxyRes.pipe = jest.fn();
  return proxyRes;
}

function getStructuredLogs(writeSpy, eventName) {
  return writeSpy.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(entry => entry && entry.event === eventName);
}

function setupServerTestEnv(importFn) {
  const originalHttpsProxy = process.env.HTTPS_PROXY;
  let imported = {};

  beforeAll(() => {
    delete process.env.HTTPS_PROXY;
    jest.resetModules();
    imported = importFn() || {};
  });

  afterAll(() => {
    if (originalHttpsProxy === undefined) {
      delete process.env.HTTPS_PROXY;
    } else {
      process.env.HTTPS_PROXY = originalHttpsProxy;
    }
    jest.resetModules();
  });

  return { get: () => imported };
}

/**
 * Drain all pending microtasks / Promises so that async callbacks scheduled
 * inside `proxyRequest` (e.g. the collectRequestBody → then → dispatch chain)
 * have had a chance to run before test assertions.
 *
 * @returns {Promise<void>}
 */
function flushPromises() {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * Creates a mock upstream HTTP request cycle for testing proxyRequest guards.
 *
 * Sets up a `jest.spyOn` on `https.request` that captures the upstream response
 * handler callback and returns a pre-built mock upstream request.  After
 * `flushPromises()` has drained the async body-collection chain, callers can
 * access the captured callback via the `responseHandler` getter.
 *
 * @param {object} https - The `https` module to spy on (imported by the test file).
 * @returns {{ spy: jest.SpyInstance, upstreamRequest: EventEmitter, responseHandler: Function|undefined }}
 */
function createMockUpstreamCycle(https) {
  let responseHandler;
  const upstreamRequest = makeProxyReq();

  const spy = jest.spyOn(https, 'request').mockImplementation((_options, cb) => {
    responseHandler = cb;
    return upstreamRequest;
  });

  return {
    spy,
    upstreamRequest,
    /** The upstream response handler captured when https.request was called. */
    get responseHandler() { return responseHandler; },
  };
}

/**
 * Completes an upstream response cycle: invokes the captured response handler
 * with a mocked proxy response, optionally emits a data chunk containing a
 * JSON-serialised body, then emits `'end'`.
 *
 * @param {Function} responseHandler - The upstream response callback (e.g. `cycle.responseHandler`).
 * @param {object} [options]
 * @param {number} [options.statusCode=200] - HTTP status code of the upstream response.
 * @param {object|null} [options.body=null] - JSON-serialisable payload to emit as a data chunk.
 * @returns {EventEmitter} The mocked proxy response emitter.
 */
function completeUpstreamResponse(responseHandler, { statusCode = 200, body = null } = {}) {
  const proxyRes = makeProxyRes(statusCode);
  responseHandler(proxyRes);
  if (body !== null) {
    proxyRes.emit('data', Buffer.from(JSON.stringify(body)));
  }
  proxyRes.emit('end');
  return proxyRes;
}

module.exports = {
  makeReq,
  makeRes,
  makeProxyReq,
  makeProxyRes,
  getStructuredLogs,
  setupServerTestEnv,
  flushPromises,
  createMockUpstreamCycle,
  completeUpstreamResponse,
};
