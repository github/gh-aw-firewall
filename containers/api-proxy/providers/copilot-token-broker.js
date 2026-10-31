'use strict';

const { createTokenBrokerProvider } = require('./token-broker');
const { createAdapterMethods, buildProviderAdapter } = require('../adapter-factory');
const { composeBodyTransforms } = require('../proxy-utils');
const { sanitizeNullToolCallTypes } = require('../body-transform');
const { bearerAuthHeaders, withCopilotIntegration } = require('./auth-headers');
const { logRequest } = require('../logging');

const MODELS_API_VERSION = '2026-07-01';
const BROKER_ERROR_CODES = new Set([
  'ERR_TOKEN_BROKER_CONFIGURATION', 'ERR_TOKEN_BROKER_OIDC',
  'ERR_TOKEN_BROKER_UNAUTHORIZED', 'ERR_TOKEN_BROKER_UNSUPPORTED',
  'ERR_TOKEN_BROKER_UNAVAILABLE', 'ERR_TOKEN_BROKER_MALFORMED_RESPONSE',
]);
const BROKER_TARGETS = new Set([
  'api.githubcopilot.com', 'api.individual.githubcopilot.com',
  'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com',
]);

function brokerUnavailable(brokerErrorCode = 'ERR_TOKEN_BROKER_UNAVAILABLE') {
  const error = new Error('Copilot token broker authentication unavailable');
  error.code = 'token_broker_unavailable';
  error.type = 'authentication_error';
  error.statusCode = 503;
  Object.defineProperty(error, 'brokerErrorCode', {
    value: BROKER_ERROR_CODES.has(brokerErrorCode) ? brokerErrorCode : 'ERR_TOKEN_BROKER_UNAVAILABLE',
  });
  return error;
}

function validateBrokerTarget(env) {
  // Validate the original input: legacy target normalization silently discards
  // userinfo and paths, and falls back to GitHub on malformed URLs.
  const rawTarget = env.COPILOT_API_TARGET || 'api.githubcopilot.com';
  let target;
  try {
    target = new URL(rawTarget.includes('://') ? rawTarget : `https://${rawTarget}`);
  } catch {
    throw new Error('Invalid Copilot token broker API target');
  }
  if (/[\s\\?#@]/.test(rawTarget) || target.protocol !== 'https:' || target.username || target.password
    || target.hostname.length > 253
    || target.hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || (target.port && target.port !== '443') || target.pathname !== '/'
    || target.search || target.hash || !BROKER_TARGETS.has(target.hostname)
    || (env.COPILOT_API_BASE_PATH || '').trim()) {
    throw new Error('Copilot token broker requires a trusted HTTPS GitHub Copilot target');
  }
  return target.hostname;
}

function createCopilotTokenBrokerAdapter(env, deps = {}) {
  const conflicts = [
    'COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_BASE_URL', 'COPILOT_API_KEY', 'AWF_AUTH_TYPE', 'AWF_AUTH_PROVIDER',
    'AWF_BYOK_EXTRA_HEADERS', 'AWF_BYOK_EXTRA_BODY_FIELDS', 'AWF_AUTH_HEADER',
  ];
  if (conflicts.some(key => (env[key] || '').trim())) {
    throw new Error('Copilot token broker cannot be combined with static, BYOK, or cloud authentication');
  }
  const rawTarget = validateBrokerTarget(env);
  const integrationId = (env.COPILOT_INTEGRATION_ID || '').trim()
    || (env.GITHUB_COPILOT_INTEGRATION_ID || '').trim() || 'agentic-workflows';
  let client;
  try {
    client = (deps.createTokenBrokerProvider || createTokenBrokerProvider)(env);
  } catch {
    throw brokerUnavailable();
  }
  let stopped = false;
  let ready = false;
  let validated = false;

  async function getAuthHeaders(req = {}) {
    try {
      if (stopped) throw brokerUnavailable();
      // Keep credentials in this invocation's closure, never on the request or
      // in diagnostics. Concurrent renewals cannot change already-built headers.
      const token = await client.getToken();
      if (stopped || typeof token !== 'string' || !token || /[\r\n]/.test(token)) {
        throw brokerUnavailable();
      }
      const headers = withCopilotIntegration(bearerAuthHeaders(token), integrationId);
      Object.defineProperty(headers, Symbol.for('awf.renewableAuth'), { value: true });
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      const hasVersion = Object.keys(req.headers || {}).some(key => key.toLowerCase() === 'x-github-api-version');
      if (req.method === 'GET' && (pathname === '/models' || pathname.startsWith('/models/'))) {
        headers['X-GitHub-Api-Version'] = MODELS_API_VERSION;
      } else if (!hasVersion && req.method === 'POST') {
        if (pathname === '/auto') headers['X-GitHub-Api-Version'] = '2026-08-01';
        if (pathname === '/models/session' || pathname === '/models/session/intent') {
          headers['X-GitHub-Api-Version'] = '2025-07-16';
        }
      }
      ready = true;
      return headers;
    } catch (error) {
      ready = false;
      const code = BROKER_ERROR_CODES.has(error?.code) ? error.code : 'ERR_TOKEN_BROKER_UNAVAILABLE';
      logRequest('error', 'token_broker_auth_failed', {
        code,
      });
      throw brokerUnavailable(code);
    }
  }

  async function modelsRequest(extra = {}) {
    return {
      url: `https://${rawTarget}/models`,
      opts: { method: 'GET', headers: await getAuthHeaders({ method: 'GET', url: '/models' }) },
      modelMetadataFormat: 'copilot',
      apiVersion: MODELS_API_VERSION,
      ...extra,
    };
  }

  return buildProviderAdapter({
    name: 'copilot',
    port: 10002,
    isEnabled: () => !stopped,
    getAuthHeaders,
    bodyTransform: composeBodyTransforms(
      composeBodyTransforms(
        deps.bodyTransform || null,
        body => { const result = sanitizeNullToolCallTypes(body); return result ? result.body : null; },
      ),
      (body, req) => {
        const pathname = new URL(req.url, 'http://localhost').pathname;
        if (pathname !== '/chat/completions' && pathname !== '/v1/chat/completions') return null;
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
        if (!parsed || parsed.model !== 'auto') return null;
        delete parsed.model;
        return Buffer.from(JSON.stringify(parsed));
      },
    ),
    adapterMethods: createAdapterMethods({
      rawTarget, provider: 'copilot', port: 10002, modelsPath: '/models',
      credentialConfigured: true, reflectionConfigured: true,
      getValidationProbe: () => modelsRequest(),
      getModelsFetchConfig: () => modelsRequest({ cacheKey: 'copilot' }),
      reflectionExtra: {
        credential_kind: 'token_broker', selected_scheme: 'Bearer',
        inference_credential_source: 'token_broker', inference_selected_scheme: 'Bearer',
      },
    }),
    missingCredentialResponse: { kind: 'plain_error', statusCode: 503, message: 'Copilot token broker authentication unavailable' },
    extra: {
      renewableAuth: true,
      isReady: () => !stopped && ready && validated,
      recordAuthReadiness(success) { validated = success === true; },
      getRoutingProviderIdentity: () => 'github-copilot',
      shutdown() {
        stopped = true;
        ready = false;
        client.shutdown();
      },
    },
  });
}

module.exports = { createCopilotTokenBrokerAdapter, brokerUnavailable };
