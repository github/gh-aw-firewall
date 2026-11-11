'use strict';

const { validateHeaderValue } = require('http');
const { isIP } = require('net');
const { markCredentialHeaders, getHeaderCredentials } = require('./credential-protection');
const TRUSTED_SERVICE = Symbol.for('awf.trustedService');
const TRUSTED_SERVICE_HEADERS = Symbol.for('awf.trustedServiceHeaders');
const secretValues = new Set();
const reserved = new Set([
  'authorization', 'authentication-info', 'www-authenticate', 'x-api-key', 'api-key',
  'x-goog-api-key', 'host', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
  'transfer-encoding', 'content-length', 'content-type', 'content-encoding',
  'expect', 'via', 'forwarded', 'cookie', 'set-cookie', 'range', 'accept-encoding',
  'anthropic-version', 'anthropic-beta', 'x-request-id',
  'x-original-url', 'x-rewrite-url', 'x-http-method-override', 'x-method-override',
  'x-real-ip', 'x-host', 'origin', 'referer', 'destination', 'max-forwards',
  'http2-settings', 'content-range', 'x-url-scheme', 'x-scheme',
]);

function readTrustedService(env, provider) {
  const raw = env[`AWF_${provider.toUpperCase()}_TRUSTED_SERVICE`];
  if (!raw) return null;
  const fail = () => new Error('Invalid trustedService configuration or missing runner secret');
  let service;
  try { service = JSON.parse(raw); } catch { throw fail(); }
  if (!service || typeof service.endpoint !== 'string' ||
      service.endpoint !== service.endpoint.trim() ||
      !/^https:\/\/[a-z0-9.-]+(?::443)?(?:\/[a-z0-9/_~-]*)?$/i.test(service.endpoint) ||
      service.endpoint.split('/').some(part => part === '.' || part === '..')) throw fail();
  let url;
  try { url = new URL(service.endpoint); } catch { throw fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || !url.hostname.includes('.') || isIP(url.hostname) ||
      /\.(?:localhost|local|localdomain|internal)$/i.test(url.hostname) ||
      url.hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw fail();
  if (!service.secretHeaders || typeof service.secretHeaders !== 'object' || Array.isArray(service.secretHeaders)) throw fail();
  if ((env.AWF_AUTH_TYPE || '').trim().toLowerCase() === 'github-oidc' &&
      ['aws', 'gcp'].includes((env.AWF_AUTH_PROVIDER || '').trim().toLowerCase())) throw fail();
  const authHeader = (env[`AWF_${provider.toUpperCase()}_AUTH_HEADER`] || '').trim().toLowerCase();
  const headers = {};
  for (const [header, name] of Object.entries(service.secretHeaders)) {
    const lower = header.toLowerCase();
    if (header !== header.trim() || !/^[a-z][a-z0-9-]*$/i.test(header) || Object.hasOwn(headers, lower) || reserved.has(lower) ||
        /^(?:proxy|x-forwarded|x-original|x-rewrite|x-envoy-|x-awf|awf-|sec-|access-control-|openai-|anthropic-|copilot-)/.test(lower) ||
        lower === authHeader || typeof name !== 'string' || name !== name.trim() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        /^(?:AWF_|NODE_|LD_|DYLD_|OPENAI_|ANTHROPIC_|COPILOT_|GEMINI_|GOOGLE_|VERTEX_|GITHUB_|GH_|ACTIONS_|DOCKER_|BASH_|OPENSSL_|SSL|UV_|ENV$|IFS$|SHELLOPTS$|PATH$|HOME$|HTTP|HTTPS|ALL_PROXY$|NO_PROXY$|SHELL$|USER$|PWD$)/i.test(name)) throw fail();
    const value = env[name];
    if (!value || !value.trim()) throw fail();
    try { validateHeaderValue(lower, value); } catch { throw fail(); }
    headers[lower] = value;
    secretValues.add(value);
  }
  return {
    target: url.host,
    basePath: url.pathname.replace(/\/$/, '') || (provider === 'openai' ? '/v1' : ''),
    inject(auth) {
      // Do not turn unavailable OIDC credentials into apparently configured auth.
      if (!auth || Object.keys(auth).length === 0) return auth;
      for (const [name, value] of Object.entries(auth)) {
        if (['authorization', 'x-api-key', 'api-key', authHeader].includes(name.toLowerCase()) &&
            typeof value === 'string' && value) {
          secretValues.add(value);
          const token = value.replace(/^Bearer\s+/i, '');
          if (token) secretValues.add(token);
        }
      }
      return markCredentialHeaders({
        ...auth, ...headers, [TRUSTED_SERVICE]: true,
        [TRUSTED_SERVICE_HEADERS]: new Set([...Object.keys(auth), ...Object.keys(headers)].map(name => name.toLowerCase())),
      }, [...getHeaderCredentials(auth), ...Object.values(headers)]);
    },
  };
}

function redactTrustedServiceSecrets(value) {
  if (typeof value !== 'string') return value;
  for (const secret of [...secretValues].sort((a, b) => b.length - a.length)) {
    value = value.split(secret).join('[REDACTED]');
  }
  return value;
}

module.exports = {
  readTrustedService, TRUSTED_SERVICE, TRUSTED_SERVICE_HEADERS,
  redactTrustedServiceSecrets,
};
