'use strict';

const crypto = require('crypto');
const { URL } = require('url');

const MAX_INVOCATION_STATES = 10_000;
const MAX_MODEL_REQUESTS = 10_000;
const MAX_MODEL_TOKENS = 10_000_000;
const CLAIM_KEYS = ['v', 'invocationId', 'maxRequests', 'maxTokens'];

function decodeCapability(authorization, secret, onRejected = () => {}) {
  const reject = reason => { onRejected(reason); return null; };
  if (typeof authorization !== 'string' || authorization.length === 0) return reject('missing');
  if (!authorization.startsWith('Bearer ')) return reject('scheme');
  const token = authorization.slice(7);
  if (token.length > 2048) return reject('format');
  const parts = token.split('.');
  if (parts.length !== 2) return reject('format');
  const [payload, signature] = parts;
  const key = Buffer.from(secret, 'hex');
  const expected = crypto.createHmac('sha256', key).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return reject('signature');
  }
  if (
    actual.length !== expected.length ||
    actual.toString('base64url') !== signature ||
    !crypto.timingSafeEqual(actual, expected)
  ) return reject('signature');

  let claims;
  try {
    const encoded = Buffer.from(payload, 'base64url');
    if (encoded.toString('base64url') !== payload) return reject('claims');
    claims = JSON.parse(encoded.toString('utf8'));
  } catch {
    return reject('claims');
  }
  if (
    !claims || typeof claims !== 'object' || Array.isArray(claims) ||
    Object.keys(claims).sort().join(',') !== [...CLAIM_KEYS].sort().join(',') ||
    claims.v !== 1 ||
    typeof claims.invocationId !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(claims.invocationId) ||
    (claims.maxRequests !== null &&
      (!Number.isSafeInteger(claims.maxRequests) || claims.maxRequests < 1 ||
        claims.maxRequests > MAX_MODEL_REQUESTS)) ||
    (claims.maxTokens !== null &&
      (!Number.isSafeInteger(claims.maxTokens) || claims.maxTokens < 1 ||
        claims.maxTokens > MAX_MODEL_TOKENS)) ||
    (claims.maxRequests === null && claims.maxTokens === null)
  ) return reject('claims');
  return claims;
}

function inferenceEndpoint(method, requestPath) {
  if (method !== 'POST') return null;
  let pathname;
  try {
    pathname = new URL(requestPath, 'http://localhost').pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
  if (/\/(?:health|status)$/.test(pathname)) return null;
  if (/\/chat\/completions$/.test(pathname)) return 'chat';
  if (/\/responses$/.test(pathname)) return 'responses';
  return 'unsupported';
}

function applyTokenCeiling(body, endpoint, remainingTokens, onRejected = () => {}) {
  const reject = reason => { onRejected(reason); return null; };
  if (!Buffer.isBuffer(body)) return reject('body_missing');
  if (body.length >= remainingTokens) return reject('input_reservation');
  let request;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    return reject('request_json');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return reject('request_shape');

  const outputAllowance = remainingTokens - body.length;
  if (outputAllowance < 1) return reject('input_reservation');
  if (endpoint === 'chat') {
    if (
      request.max_tokens !== undefined &&
      request.max_completion_tokens !== undefined
    ) return reject('output_conflict');
    const key = request.max_completion_tokens !== undefined
      ? 'max_completion_tokens'
      : 'max_tokens';
    const current = request[key];
    if (current !== undefined && (!Number.isSafeInteger(current) || current < 1)) return reject('output_shape');
    request[key] = current === undefined ? outputAllowance : Math.min(current, outputAllowance);
    if (request.stream === true) {
      if (
        request.stream_options !== undefined &&
        (!request.stream_options || typeof request.stream_options !== 'object' ||
          Array.isArray(request.stream_options))
      ) return reject('stream_options');
      request.stream_options = {
        ...(request.stream_options && typeof request.stream_options === 'object'
          ? request.stream_options
          : {}),
        include_usage: true,
      };
    }
  } else {
    const current = request.max_output_tokens;
    if (current !== undefined && (!Number.isSafeInteger(current) || current < 1)) return reject('output_shape');
    request.max_output_tokens = current === undefined
      ? outputAllowance
      : Math.min(current, outputAllowance);
  }
  return Buffer.from(JSON.stringify(request), 'utf8');
}

function usageTokenCount(usage) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) ||
      !Number.isSafeInteger(usage.output_tokens) ||
      !Number.isSafeInteger(usage.cache_read_tokens) ||
      !Number.isSafeInteger(usage.cache_write_tokens) ||
      usage.input_tokens < 0 || usage.output_tokens < 0 ||
      usage.cache_read_tokens < 0 || usage.cache_write_tokens < 0 ||
      (usage.input_tokens_include_cache !== undefined &&
        typeof usage.input_tokens_include_cache !== 'boolean')) return null;
  const count = usage.input_tokens + usage.output_tokens +
    (usage.input_tokens_include_cache ? 0 : usage.cache_read_tokens + usage.cache_write_tokens);
  return Number.isSafeInteger(count) ? count : null;
}

function createInvocationModelBudget(secret, { maxStates = MAX_INVOCATION_STATES } = {}) {
  if (secret === undefined || secret === '') {
    return { beginAttempt: () => ({ allowed: true, body: null, settle: () => {}, settleMissing: () => {} }) };
  }
  if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error('AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET must be 32-byte lowercase hex');
  }

  const invocations = new Map();
  function beginAttempt({ authorization, method, path: requestPath, body }) {
    const endpoint = inferenceEndpoint(method, requestPath);
    if (endpoint === null) {
      return { allowed: true, body: null, settle: () => {}, settleMissing: () => {} };
    }
    let capabilityFailure;
    const claims = decodeCapability(authorization, secret, reason => { capabilityFailure = reason; });
    if (!claims) return { allowed: false, reason: 'invalid_capability', capabilityFailure };
    if (endpoint === 'unsupported' && claims.maxTokens !== null) {
      return { allowed: false, reason: 'unsupported_token_accounting' };
    }

    let state = invocations.get(claims.invocationId);
    if (state && (
      state.maxRequests !== claims.maxRequests ||
      state.maxTokens !== claims.maxTokens
    )) return { allowed: false, reason: 'invalid_capability', capabilityFailure: 'claims_changed' };
    if (!state) {
      if (invocations.size >= maxStates) return { allowed: false, reason: 'accounting_capacity' };
      state = {
        maxRequests: claims.maxRequests,
        maxTokens: claims.maxTokens,
        requests: 0,
        tokens: 0,
        active: false,
        exhausted: false,
      };
      invocations.set(claims.invocationId, state);
    }
    if (state.maxRequests !== null && state.requests >= state.maxRequests) {
      return { allowed: false, reason: 'request_limit' };
    }
    if (state.maxTokens !== null) {
      if (state.exhausted || state.tokens >= state.maxTokens) {
        return { allowed: false, reason: 'token_limit', tokenFailure: 'budget_exhausted' };
      }
      if (state.active) return { allowed: false, reason: 'token_request_in_flight' };
    }

    let tokenFailure;
    const boundedBody = state.maxTokens === null
      ? null
      : applyTokenCeiling(body, endpoint, state.maxTokens - state.tokens, reason => { tokenFailure = reason; });
    if (state.maxTokens !== null && !boundedBody) {
      return { allowed: false, reason: 'token_limit', tokenFailure };
    }

    state.requests += 1;
    if (state.maxTokens !== null) state.active = true;
    let settled = false;
    const settle = (usage) => {
      if (settled) return;
      settled = true;
      if (state.maxTokens === null) return;
      state.active = false;
      const count = usageTokenCount(usage);
      if (count === null) {
        state.exhausted = true;
        state.tokens = state.maxTokens;
        return;
      }
      state.tokens += count;
      if (state.tokens >= state.maxTokens) state.exhausted = true;
    };
    const settleMissing = () => {
      if (settled) return;
      settled = true;
      if (state.maxTokens !== null) {
        state.active = false;
        state.exhausted = true;
        state.tokens = state.maxTokens;
      }
    };
    return { allowed: true, body: boundedBody, settle, settleMissing };
  }

  return { beginAttempt };
}

module.exports = {
  applyTokenCeiling,
  createInvocationModelBudget,
  decodeCapability,
  inferenceEndpoint,
  usageTokenCount,
};
