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

module.exports = {
  makeReq,
  makeRes,
  makeProxyReq,
  makeProxyRes,
  getStructuredLogs,
  setupServerTestEnv,
  flushPromises,
};
