'use strict';

const https = require('https');
const { TextDecoder } = require('util');
const { HttpsProxyAgent } = require('https-proxy-agent');

const MAX_BYTES = 65536;
const RENEWAL_MARGIN_MS = 30000;
const MESSAGES = Object.freeze({
  CONFIGURATION: 'Token broker configuration is invalid.',
  OIDC: 'Token broker identity acquisition failed.',
  UNAUTHORIZED: 'Token broker authorization failed.',
  UNSUPPORTED: 'Token broker capability is unsupported.',
  UNAVAILABLE: 'Token broker is unavailable.',
  MALFORMED_RESPONSE: 'Token broker response is invalid.',
});

function failure(kind) {
  return Object.assign(new Error(MESSAGES[kind]), { code: `ERR_TOKEN_BROKER_${kind}` });
}

function isTokenBrokerEnabled(env = process.env) {
  return env.AWF_COPILOT_TOKEN_BROKER === 'true';
}

function httpsUrl(value, kind = 'CONFIGURATION') {
  try {
    if (typeof value !== 'string' || !/^https:\/\//i.test(value)
      || /[\s\\#]/u.test(value) || /^https:\/\/[^/?]*@/i.test(value)) throw failure(kind);
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) throw failure(kind);
    return parsed;
  } catch {
    throw failure(kind);
  }
}

function isCredential(value) {
  return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);
}

function expiration(value) {
  if (typeof value !== 'string') throw failure('MALFORMED_RESPONSE');
  const parts = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) throw failure('MALFORMED_RESPONSE');
  const [, year, month, day, hour, minute, second, offset] = parts;
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (+month < 1 || +month > 12 || +day < 1 || +day > days[+month - 1]
    || +hour > 23 || +minute > 59 || +second > 59
    || (offset.length > 1 && (+offset.slice(1, 3) > 23 || +offset.slice(4) > 59))) {
    throw failure('MALFORMED_RESPONSE');
  }
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw failure('MALFORMED_RESPONSE');
  return result;
}

function decodeJson(body) {
  if (!Buffer.isBuffer(body) || body.length > MAX_BYTES) throw failure('MALFORMED_RESPONSE');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
}

function validateResponse(response, now) {
  try {
    if (!/^application\/json(?:\s*;.*)?$/i.test(response.headers['content-type'] || '')
      || !(response.headers['cache-control'] || '').split(',').some(v => v.trim().toLowerCase() === 'no-store')
      || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
      throw failure('MALFORMED_RESPONSE');
    }
    const text = decodeJson(response.body);
    // Exactly two string pairs also rejects duplicate members hidden by JSON.parse.
    const string = '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
    const pair = `${string}\\s*:\\s*${string}`;
    if (!new RegExp(`^[\\t\\n\\r ]*\\{\\s*${pair}\\s*,\\s*${pair}\\s*\\}[\\t\\n\\r ]*$`).test(text)) {
      throw failure('MALFORMED_RESPONSE');
    }
    const result = JSON.parse(text);
    if (Object.keys(result).length !== 2 || !Object.hasOwn(result, 'token')
      || !Object.hasOwn(result, 'expires_at') || !isCredential(result.token)) throw failure('MALFORMED_RESPONSE');
    const expiresAt = expiration(result.expires_at);
    if (expiresAt <= now() + RENEWAL_MARGIN_MS) throw failure('MALFORMED_RESPONSE');
    return { token: result.token, expiresAt };
  } catch {
    throw failure('MALFORMED_RESPONSE');
  }
}

/**
 * Bounded, non-redirecting HTTPS transport. A shared signal covers DNS, proxy
 * connection, TLS, and both response reads, not just socket inactivity.
 */
function requestHttps({ url, method = 'GET', headers, body, signal, proxyUrl }) {
  return new Promise((resolve, reject) => {
    let req;
    let response;
    let agent;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) {
        response?.destroy();
        req?.destroy();
      }
      agent?.destroy();
      if (error) reject(failure('UNAVAILABLE'));
      else resolve(result);
    };
    const abort = () => finish(true);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { signal }) : undefined;
      req = https.request(url, {
        method,
        headers: {
          ...headers,
          'Accept-Encoding': 'identity',
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
        agent,
        signal,
      }, res => {
        response = res;
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          finish(true);
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) { finish(true); return; }
          chunks.push(chunk);
        });
        res.on('end', () => finish(false, {
          statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
        }));
        res.on('error', () => finish(true));
        res.on('aborted', () => finish(true));
        res.on('close', () => { if (!res.complete) finish(true); });
      });
      req.on('error', () => finish(true));
      req.end(body);
    } catch {
      finish(true);
    }
  });
}

/**
 * One immutable, trusted execution context per instance; no global/disk cache.
 * Environment context partitions local state, but is not server authorization.
 */
function createTokenBrokerProvider(env = process.env, { now = Date.now, request = requestHttps } = {}) {
  const snapshot = { ...env };
  if (!isTokenBrokerEnabled(snapshot)) throw failure('CONFIGURATION');
  const endpoint = snapshot.GH_AW_TOKEN_BROKER_URL;
  httpsUrl(endpoint);
  const oidcUrl = httpsUrl(snapshot.ACTIONS_ID_TOKEN_REQUEST_URL, 'OIDC');
  const bootstrap = snapshot.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!isCredential(bootstrap)) throw failure('OIDC');
  for (const key of ['GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB']) {
    if (typeof snapshot[key] !== 'string' || !snapshot[key].trim()) throw failure('CONFIGURATION');
  }
  oidcUrl.searchParams.set('audience', endpoint);
  const proxyUrl = snapshot.HTTPS_PROXY || snapshot.HTTP_PROXY;
  let cached;
  let pending;
  let controller;
  let stopped = false;

  const hasToken = () => !stopped && !!cached && cached.expiresAt > now() + RENEWAL_MARGIN_MS;

  async function exchange(signal) {
    let identity;
    try {
      const response = await request({
        url: oidcUrl.toString(), headers: { Authorization: ['Bearer', bootstrap].join(' '), Accept: 'application/json' },
        signal, proxyUrl,
      });
      if (response.statusCode !== 200) throw failure('OIDC');
      const data = JSON.parse(decodeJson(response.body));
      identity = data.value;
      if (typeof identity !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(identity)) throw failure('OIDC');
      const payload = JSON.parse(decodeJson(Buffer.from(identity.split('.')[1], 'base64url')));
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
        || payload.exp * 1000 <= now() || payload.aud !== endpoint) throw failure('OIDC');
    } catch {
      throw failure('OIDC');
    }
    if (signal.aborted || stopped) throw failure('UNAVAILABLE');
    let response;
    try {
      const body = JSON.stringify({ token_type: 'copilot-request', provider: 'github', oidc_token: identity });
      if (Buffer.byteLength(body) > MAX_BYTES) throw failure('OIDC');
      response = await request({
        url: endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store' },
        body, signal, proxyUrl,
      });
    } catch {
      throw failure('UNAVAILABLE');
    }
    if (response.statusCode !== 200) {
      if ([401, 403].includes(response.statusCode)) throw failure('UNAUTHORIZED');
      if ([400, 404, 422, 501].includes(response.statusCode)) throw failure('UNSUPPORTED');
      throw failure('UNAVAILABLE');
    }
    const credential = validateResponse(response, now);
    if (signal.aborted || stopped) throw failure('UNAVAILABLE');
    cached = credential;
    return credential.token;
  }

  function getToken() {
    if (stopped) return Promise.reject(failure('UNAVAILABLE'));
    if (hasToken()) return Promise.resolve(cached.token);
    cached = undefined;
    if (pending) return pending;
    controller = new AbortController();
    const signal = controller.signal;
    let timer;
    const cancelled = new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(failure('UNAVAILABLE')), { once: true });
      timer = setTimeout(() => controller.abort(), 10000);
    });
    pending = Promise.race([exchange(signal), cancelled]).finally(() => {
      clearTimeout(timer);
      pending = undefined;
      controller = undefined;
    });
    return pending;
  }

  function shutdown() {
    stopped = true;
    cached = undefined;
    controller?.abort();
  }

  return { getToken, hasToken, shutdown };
}

module.exports = { createTokenBrokerProvider, isTokenBrokerEnabled };
