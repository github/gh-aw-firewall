'use strict';

const http = require('http');
const { createRoutingError } = require('./routing-errors');
const { MAX_PLANNING_REQUEST_BYTES } = require('./routing-contract');

const DEFAULT_ROUTER_URL = 'http://gh-aw-router:8737';
const MAX_ROUTER_RESPONSE_BYTES = 1_048_576;

function parseBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw createRoutingError('routing_configuration_error', 'The router URL is invalid');
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash ||
    (url.pathname && url.pathname !== '/')) {
    throw createRoutingError('routing_configuration_error', 'The router URL must be a plain HTTP origin');
  }
  return url;
}

function responseError(statusCode, body) {
  const error = new Error(`Router returned HTTP ${statusCode}`);
  error.statusCode = statusCode;
  error.transient = statusCode >= 500;
  try {
    error.body = JSON.parse(body.toString('utf8'));
  } catch {
    error.body = body;
  }
  return error;
}

function transportError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.transient = true;
  return error;
}

function createRoutingRouterClient({
  baseUrl = DEFAULT_ROUTER_URL,
  transport = http,
  maxResponseBytes = MAX_ROUTER_RESPONSE_BYTES,
} = {}) {
  const origin = parseBaseUrl(baseUrl);
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw createRoutingError('routing_configuration_error', 'The router response limit is invalid');
  }

  function request(path, { method, value, signal, timeoutMs }) {
    if (signal?.aborted) {
      return Promise.reject(createRoutingError('routing_cancelled', 'Model routing was cancelled'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(createRoutingError('routing_configuration_error', 'The router timeout is invalid'));
    }
    const body = value === undefined ? null : Buffer.from(JSON.stringify(value), 'utf8');
    if (body && body.length > MAX_PLANNING_REQUEST_BYTES) {
      return Promise.reject(createRoutingError(
        'routing_input_too_large',
        `The serialized routing request exceeds ${MAX_PLANNING_REQUEST_BYTES} bytes`,
      ));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let upstream;
      const settle = (fn, result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        fn(result);
      };
      const onAbort = () => {
        settle(reject, createRoutingError('routing_cancelled', 'Model routing was cancelled'));
        upstream?.destroy();
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        upstream = transport.request({
          protocol: 'http:',
          hostname: origin.hostname,
          port: origin.port || 80,
          method,
          path,
          headers: body
            ? { accept: 'application/json', 'content-type': 'application/json', 'content-length': String(body.length) }
            : { accept: 'application/json' },
        }, response => {
          const chunks = [];
          let responseBytes = 0;
          let ended = false;
          response.on('data', chunk => {
            if (settled) return;
            responseBytes += chunk.length;
            if (responseBytes > maxResponseBytes) {
              settle(reject, createRoutingError('routing_contract_error', 'The router response exceeded its size limit'));
              response.destroy();
              upstream.destroy();
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.on('end', () => {
            ended = true;
            if (settled) return;
            const responseBody = Buffer.concat(chunks, responseBytes);
            if (response.statusCode < 200 || response.statusCode >= 300) {
              settle(reject, responseError(response.statusCode, responseBody));
              return;
            }
            if (path === '/healthz') {
              if (response.statusCode !== 204 || responseBody.length !== 0) {
                settle(reject, createRoutingError('routing_contract_error', 'The router health response is invalid'));
                return;
              }
              settle(resolve, 204);
              return;
            }
            if (response.statusCode !== 200) {
              settle(reject, createRoutingError('routing_contract_error', 'The router returned an unexpected status'));
              return;
            }
            try {
              const parsed = JSON.parse(responseBody.toString('utf8'));
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError();
              settle(resolve, parsed);
            } catch {
              settle(reject, createRoutingError('routing_contract_error', 'The router returned malformed JSON'));
            }
          });
          response.on('aborted', () => settle(reject, transportError('The router response was interrupted', 'ECONNRESET')));
          response.on('error', error => settle(reject, error));
          response.on('close', () => {
            if (!ended) settle(reject, transportError('The router response closed early', 'ECONNRESET'));
          });
        });
      } catch (error) {
        settle(reject, error);
        return;
      }

      upstream.setTimeout(timeoutMs, () => {
        settle(reject, transportError('Router request timed out', 'ETIMEDOUT'));
        upstream.destroy();
      });
      upstream.on('error', error => settle(reject, error));
      if (body) upstream.write(body);
      upstream.end();
    });
  }

  return Object.freeze({
    health(options = {}) { return request('/healthz', { ...options, method: 'GET' }); },
    capabilities(options = {}) { return request('/capabilities', { ...options, method: 'GET' }); },
    classify(value, options = {}) { return request('/classify', { ...options, method: 'POST', value }); },
    route(value, options = {}) { return request('/route', { ...options, method: 'POST', value }); },
  });
}

module.exports = { DEFAULT_ROUTER_URL, MAX_ROUTER_RESPONSE_BYTES, createRoutingRouterClient };
