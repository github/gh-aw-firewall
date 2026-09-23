'use strict';

const { Readable, Writable } = require('stream');
const { getCurrentGuardChecks } = require('./proxy-guards');
const { parseModelEndpointBlockedFromBody, parseModelNotSupportedFromBody } = require('./upstream-response');
const { createRoutingError } = require('./routing-errors');

const MAX_CLASSIFIER_RESPONSE_BYTES = 1_048_576;

class BufferedResponse extends Writable {
  constructor(maxBytes) {
    super();
    this.maxBytes = maxBytes;
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
    this.bytes = 0;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
    return this;
  }

  _write(chunk, _encoding, callback) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.bytes + buffer.length > this.maxBytes) {
      callback(createRoutingError('routing_contract_error', 'The classifier response exceeded its size limit'));
      return;
    }
    this.bytes += buffer.length;
    this.chunks.push(buffer);
    callback();
  }

  result() {
    return { statusCode: this.statusCode, headers: { ...this.headers }, body: Buffer.concat(this.chunks, this.bytes) };
  }
}

function parseErrorBody(body) {
  try {
    const value = JSON.parse(body.toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function normalizeResult(result) {
  if (result.statusCode >= 200 && result.statusCode < 300) return result;
  if (result.statusCode >= 500 || parseModelNotSupportedFromBody(result.body) || parseModelEndpointBlockedFromBody(result.body)) {
    return { ...result, availabilityFailure: true };
  }
  const providerError = parseErrorBody(result.body)?.error;
  const code = typeof providerError?.code === 'string'
    ? providerError.code
    : (typeof providerError?.type === 'string' ? providerError.type : 'provider_unavailable');
  return { ...result, terminal: { code, detail: `Classifier execution was rejected with ${code}` } };
}

function createRoutingProviderExecutor({ getCopilotAdapter, proxyRequest, checkRateLimit, getGuardChecks = getCurrentGuardChecks }) {
  if (typeof getCopilotAdapter !== 'function' || typeof proxyRequest !== 'function' || typeof checkRateLimit !== 'function') {
    throw createRoutingError('routing_configuration_error', 'The Copilot provider executor is incomplete');
  }
  return Object.freeze({
    checkBeforePrimary({ selection }) {
      for (const guard of getGuardChecks(selection.wire_model, 'copilot')) {
        if (!guard.isBlocked(guard.block)) continue;
        const envelope = guard.buildError(guard.block);
        const error = envelope?.error || envelope;
        const code = error?.type || error?.code || guard.eventName;
        throw createRoutingError(code, error?.message || `Model routing is blocked by ${code}`);
      }
    },

    execute(request, { signal } = {}) {
      if (request?.purpose !== 'routing_classification') {
        return Promise.reject(createRoutingError('routing_configuration_error', 'The provider executor requires a trusted routing purpose'));
      }
      const adapter = getCopilotAdapter();
      if (!adapter || adapter.name !== 'copilot' || !adapter.isEnabled() ||
        adapter.getRoutingProviderIdentity?.() !== 'github-copilot') {
        return Promise.reject(createRoutingError('provider_unavailable', 'The Copilot provider is not configured'));
      }
      const body = Buffer.from(JSON.stringify(request.body), 'utf8');
      const req = Readable.from([body]);
      req.method = 'POST';
      req.url = request.path;
      req.complete = false;
      req.headers = { accept: 'application/json', 'content-type': 'application/json', 'content-length': String(body.length) };
      req.awfRequestContext = Object.freeze({ purpose: 'routing_classification', signal });
      const res = new BufferedResponse(MAX_CLASSIFIER_RESPONSE_BYTES);
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          fn(value);
        };
        const onAbort = () => {
          const error = createRoutingError('routing_cancelled', 'Model routing was cancelled');
          req.destroy();
          res.destroy();
          settle(reject, error);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        res.once('error', error => settle(reject, error));
        res.once('finish', () => settle(resolve, normalizeResult(res.result())));
        try {
          if (checkRateLimit(req, res, 'copilot', body.length)) return;
          proxyRequest(
            req, res, adapter.getTargetHost(req), adapter.getAuthHeaders(req), 'copilot',
            adapter.getBasePath(req), null, adapter.getRequestSigner ? adapter.getRequestSigner() : null,
            adapter.getTargetScheme ? adapter.getTargetScheme(req) : 'https',
          );
        } catch (error) {
          settle(reject, error);
        }
      });
    },
  });
}

module.exports = { MAX_CLASSIFIER_RESPONSE_BYTES, createRoutingProviderExecutor };
