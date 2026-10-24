'use strict';

const { stripTargetScheme, normalizeApiTarget } = require('./proxy-utils');
const { stripBearerPrefix, classifyGithubServerHost } = require('./providers/copilot-auth');
const { COPILOT_PLACEHOLDER_TOKEN } = require('./providers/copilot-byok');

const PLACEHOLDERS = new Set([
  COPILOT_PLACEHOLDER_TOKEN, 'dummy-byok-key-for-offline-mode',
  'placeholder-token-for-credential-isolation',
]);
const expectedHeaders = new WeakMap();

function credentialKind(token) {
  if (!token) return 'none';
  if (PLACEHOLDERS.has(token)) return 'placeholder';
  for (const [prefix, kind] of [
    ['github_pat_', 'fine_grained_pat'], ['ghp_', 'classic_pat'],
    ['gho_', 'oauth'], ['ghu_', 'user_token'], ['ghs_', 'installation_token'],
  ]) {
    if (token.startsWith(prefix)) return kind;
  }
  return 'other';
}

function headerValues(headers, name) {
  return Object.entries(headers || {})
    .filter(([key]) => key.toLowerCase() === name)
    .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}

function headerMatch(actual, expected, name) {
  const a = headerValues(actual, name);
  const e = headerValues(expected, name);
  if (e.length !== 1 || typeof e[0] !== 'string' || !e[0]) return 'unknown';
  return a.length === 1 && a[0] === e[0] ? 'yes' : 'no';
}

function authorizationKind(headers) {
  const values = headerValues(headers, 'authorization');
  if (!values.length) return 'missing';
  if (values.length > 1) return 'multiple';
  if (typeof values[0] !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]* [^\s,]+$/.test(values[0])) {
    return 'malformed';
  }
  const scheme = values[0].split(' ', 1)[0].toLowerCase();
  return scheme === 'bearer' || scheme === 'token' ? scheme : 'other';
}

function integrationKind(headers) {
  const values = headerValues(headers, 'copilot-integration-id');
  if (!values.length || (values.length === 1 && !values[0])) return 'missing';
  if (values.length > 1) return 'multiple';
  if (values[0] === 'agentic-workflows') return 'workflows';
  if (values[0] === 'copilot-developer-cli') return 'cli';
  return 'custom';
}

function targetKind(host) {
  if (host === 'api.githubcopilot.com') return 'standard';
  if (host === 'api.enterprise.githubcopilot.com') return 'enterprise';
  if (host === 'api.business.githubcopilot.com') return 'business';
  if (typeof host === 'string' && /^copilot-api\.[^.]+\.ghe\.com$/.test(host)) return 'ghec';
  return typeof host === 'string' && host ? 'custom' : 'unknown';
}

function endpointKind(upstreamPath) {
  if (typeof upstreamPath !== 'string') return 'unknown';
  const pathname = upstreamPath.split(/[?#]/, 1)[0];
  if (pathname === '/models') return 'models';
  if (pathname === '/models/session' || pathname === '/models/session/intent') return 'models_session';
  if (pathname === '/auto') return 'auto';
  if (/^(?:\/v1)?\/chat\/completions$/.test(pathname)) return 'chat_completions';
  if (/^(?:\/v1)?\/responses$/.test(pathname)) return 'responses';
  return 'other';
}

function attachCopilotAuthDiagnostic(req, { env, source, token, rawTarget, basePath, integrationIdSource }) {
  if (!req || env.AWF_ENCLAVE_PROXY_DIAGNOSTICS !== '1') return;
  const raw = source === 'provider_api_key' ? env.COPILOT_PROVIDER_API_KEY
    : source === 'github_token' ? env.COPILOT_GITHUB_TOKEN : undefined;
  const normalized = stripBearerPrefix(raw);
  const server = classifyGithubServerHost(env).kind;
  req.awfCopilotAuthDiagnostic = {
    credential_source: source,
    credential_kind: credentialKind(token),
    credential_shape: !normalized ? 'missing' : PLACEHOLDERS.has(normalized) ? 'placeholder'
      : /\s/.test(normalized) ? 'embedded_whitespace'
      : /^\s*(?:Bearer|token)\s+/i.test(raw) ? 'prefixed'
      : raw !== raw.trim() ? 'whitespace' : 'clean',
    target_source: normalizeApiTarget(env.COPILOT_API_TARGET) ? 'explicit'
      : server === 'ghec' || server === 'ghes' ? 'server' : 'default',
    server_kind: server,
    base_path: basePath && basePath !== '/' ? 'configured' : 'none',
    integration_source: integrationIdSource,
    // Internal comparison only; never included in the public projection.
    targetHost: stripTargetScheme(rawTarget),
  };
}

function recordCopilotInjectedHeaders(req, injected) {
  if (!req.awfCopilotAuthDiagnostic) return;
  expectedHeaders.set(req, {
    authorization: headerValues(injected, 'authorization'),
    'copilot-integration-id': headerValues(injected, 'copilot-integration-id'),
  });
}

function buildCopilotWireAuthDiagnostic(req, headers, targetHost, upstreamPath) {
  const source = req.awfCopilotAuthDiagnostic;
  if (!source) return undefined;
  const expected = expectedHeaders.get(req);
  return {
    credential_source: source.credential_source,
    credential_kind: source.credential_kind,
    credential_shape: source.credential_shape,
    target_source: source.target_source,
    server_kind: source.server_kind,
    base_path: source.base_path,
    integration_source: source.integration_source,
    authorization_match: expected ? headerMatch(headers, expected, 'authorization') : 'unknown',
    integration_match: expected ? headerMatch(headers, expected, 'copilot-integration-id') : 'unknown',
    target: targetKind(targetHost),
    target_match: typeof source.targetHost === 'string'
      ? source.targetHost === targetHost ? 'yes' : 'no' : 'unknown',
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method)
      ? req.method.toLowerCase() : typeof req.method === 'string' ? 'other' : 'unknown',
    endpoint: endpointKind(upstreamPath),
    authorization: authorizationKind(headers),
    integration: integrationKind(headers),
  };
}

const ERROR_CLASSES = new Map([
  ...['expired_token', 'token_expired', 'token expired', 'token has expired'].map(value => [value, 'expired']),
  ...['bad credentials', 'invalid_token', 'invalid_api_key', 'invalid credentials'].map(value => [value, 'invalid_credential']),
  ...['insufficient_scope', 'insufficient_permissions'].map(value => [value, 'insufficient_scope']),
  ...['copilot_subscription_required', 'subscription_required', 'copilot_not_enabled'].map(value => [value, 'entitlement']),
  ...['invalid_integration_id', 'integration_not_authorized', 'integration_unauthorized'].map(value => [value, 'integration']),
  ...['invalid_authorization_header', 'authorization header is badly formatted'].map(value => [value, 'malformed_auth']),
]);

function classifyCopilotAuthError(capture, responseHeaders) {
  const challengeValues = headerValues(responseHeaders, 'www-authenticate');
  const challenge = challengeValues.length === 0 ? 'missing'
    : challengeValues.length !== 1 || typeof challengeValues[0] !== 'string' ? 'other'
    : /\berror="invalid_token"/i.test(challengeValues[0]) ? 'invalid_token'
    : /\berror="insufficient_scope"/i.test(challengeValues[0]) ? 'insufficient_scope' : 'other';
  const bodyCapture = capture.bodyOmitted ? 'omitted' : capture.truncated ? 'truncated' : 'complete';
  if (bodyCapture !== 'complete' || capture.bodyValue.length > 64 * 1024) {
    return { error_class: 'uninspectable', body_capture: bodyCapture, challenge };
  }
  let value;
  try {
    value = JSON.parse(capture.bodyValue);
  } catch {
    value = capture.bodyValue;
  }
  // Classify exact known identifiers/messages; never publish provider text.
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const error = object.error && typeof object.error === 'object' && !Array.isArray(object.error)
    ? object.error : object;
  const candidates = [error.code, error.type, error.message, object.error, value];
  let errorClass = 'unclassified';
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length > 256) continue;
    const text = candidate.trim().toLowerCase();
    const known = /^(?:401\s+){0,2}(?:unauthorized:\s*)?personal access token does not have copilot requests permission$/.test(text)
      ? 'insufficient_scope' : ERROR_CLASSES.get(text);
    if (known) { errorClass = known; break; }
  }
  return { error_class: errorClass, body_capture: bodyCapture, challenge };
}

module.exports = {
  attachCopilotAuthDiagnostic,
  recordCopilotInjectedHeaders,
  buildCopilotWireAuthDiagnostic,
  classifyCopilotAuthError,
};
