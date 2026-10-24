'use strict';

const { createCopilotAdapter } = require('./providers/copilot');
const { buildRequestHeaders } = require('./request-headers');
const {
  buildCopilotWireAuthDiagnostic, classifyCopilotAuthError,
} = require('./copilot-auth-diagnostics');
const { createLogUpstreamErrorResponse, createLogRequestCompletion } = require('./upstream-log');
const { COPILOT_PLACEHOLDER_TOKEN } = require('./providers/copilot-byok');

const secret = 'TEST_CREDENTIAL_DO_NOT_LOG';
function request(env = {}, { url = '/v1/chat/completions', method = 'POST', headers = {} } = {}) {
  const req = { url, method, headers };
  const adapter = createCopilotAdapter({
    AWF_ENCLAVE_PROXY_DIAGNOSTICS: '1',
    COPILOT_GITHUB_TOKEN: `github_pat_${secret}`,
    ...env,
  });
  const injected = adapter.getAuthHeaders(req);
  const outbound = buildRequestHeaders(Buffer.from('{}'), 2, req, {
    injectHeaders: injected, provider: 'copilot',
    targetHost: adapter.getTargetHost(req), requestId: 'synthetic-auth-test',
  });
  return {
    req, injected, outbound,
    describe: (host = adapter.getTargetHost(req), upstreamPath = url) =>
      buildCopilotWireAuthDiagnostic(req, outbound, host, upstreamPath),
  };
}
const capture = value => ({
  bodyValue: typeof value === 'string' ? value : JSON.stringify(value),
  bodyOmitted: false, truncated: false,
});

describe('closed Copilot authentication diagnostics', () => {
  test('H1 distinguishes chosen BYOK credentials from the models-only GitHub credential', () => {
    const env = { COPILOT_PROVIDER_API_KEY: secret };
    expect(request(env).describe()).toMatchObject({
      credential_source: 'provider_api_key', credential_kind: 'other', authorization_match: 'yes',
    });
    expect(request(env, { url: '/models', method: 'GET' }).describe()).toMatchObject({
      credential_source: 'github_token', credential_kind: 'fine_grained_pat', method: 'get', endpoint: 'models',
    });
    expect(request({ COPILOT_PROVIDER_API_KEY: COPILOT_PLACEHOLDER_TOKEN }).describe().credential_source)
      .toBe('github_token');
    expect(request({ COPILOT_GITHUB_TOKEN: '' }).describe()).toMatchObject({
      credential_source: 'none', credential_kind: 'none', credential_shape: 'missing',
    });
  });

  test.each([
    ['ghp_', 'classic_pat'], ['github_pat_', 'fine_grained_pat'], ['gho_', 'oauth'],
    ['ghu_', 'user_token'], ['ghs_', 'installation_token'], ['', 'other'],
  ])('H2 identifies credential family %s without retaining its value', (prefix, kind) => {
    const diagnostic = request({ COPILOT_GITHUB_TOKEN: `${prefix}${secret}` }).describe();
    expect(diagnostic.credential_kind).toBe(kind);
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });

  test.each([
    [{}, 'standard', 'default', 'missing'],
    [{ COPILOT_API_TARGET: 'api.business.githubcopilot.com' }, 'business', 'explicit', 'missing'],
    [{ GITHUB_SERVER_URL: 'https://example.ghe.com' }, 'ghec', 'server', 'ghec'],
    [{ GITHUB_SERVER_URL: 'https://private.example' }, 'enterprise', 'server', 'ghes'],
  ])('H3 records effective route and derivation without publishing hosts', (env, target, source, server) => {
    const req = request(env);
    expect(req.describe()).toMatchObject({
      target, target_source: source, server_kind: server, target_match: 'yes',
    });
    expect(req.describe('unexpected.invalid', '/rewritten/private?token=PRIVATE')).toMatchObject({
      target: 'custom', target_match: 'no', endpoint: 'other',
    });
    expect(JSON.stringify(req.describe())).not.toMatch(/example|private|githubcopilot\.com/);
  });

  test('H4 records the actual scheme, normalization and overwritten/duplicate credentials', () => {
    const req = request({
      COPILOT_GITHUB_TOKEN: ` Bearer github_pat_${secret} `,
      COPILOT_API_TARGET: 'api.business.githubcopilot.com',
    });
    expect(req.describe()).toMatchObject({
      credential_shape: 'prefixed', authorization: 'bearer', authorization_match: 'yes',
    });
    req.outbound.Authorization = 'Bearer OTHER_TEST_VALUE';
    expect(req.describe()).toMatchObject({ authorization: 'bearer', authorization_match: 'no' });
    req.outbound.Authorization = `token ${secret}`;
    expect(req.describe()).toMatchObject({ authorization: 'token', authorization_match: 'no' });
    req.outbound.authorization = 'Bearer OTHER_TEST_VALUE';
    expect(req.describe()).toMatchObject({ authorization: 'multiple', authorization_match: 'no' });
    delete req.outbound.authorization;
    delete req.outbound.Authorization;
    expect(req.describe()).toMatchObject({ authorization: 'missing', authorization_match: 'no' });
    expect(request({ COPILOT_GITHUB_TOKEN: `github_pat_${secret}\nEXTRA` }).describe())
      .toMatchObject({ credential_shape: 'embedded_whitespace', authorization: 'malformed' });
  });

  test('identifies configured base paths without copying custom paths or query strings', () => {
    const diagnostic = request({ COPILOT_API_BASE_PATH: '/PRIVATE_BASE' })
      .describe('api.githubcopilot.com', '/PRIVATE_BASE/models?token=PRIVATE_QUERY');
    expect(diagnostic).toMatchObject({ base_path: 'configured', endpoint: 'other' });
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE/);
  });

  test('H5 detects client integration overrides and does not disclose a custom integration', () => {
    const req = request({ COPILOT_INTEGRATION_ID: `PRIVATE_${secret}` }, {
      headers: { 'copilot-integration-id': 'copilot-developer-cli' },
    });
    expect(req.describe()).toMatchObject({
      integration_source: 'copilot_integration_id', integration: 'cli', integration_match: 'no',
    });
    expect(request({ COPILOT_INTEGRATION_ID: secret }).describe()).toMatchObject({
      integration: 'custom', integration_match: 'yes',
    });
    expect(JSON.stringify(req.describe())).not.toContain(secret);
  });

  test.each([
    ['expired_token', 'expired'], ['Bad credentials', 'invalid_credential'],
    ['insufficient_scope', 'insufficient_scope'], ['copilot_subscription_required', 'entitlement'],
    ['401 unauthorized: Personal Access Token does not have Copilot Requests permission', 'insufficient_scope'],
    ['invalid_integration_id', 'integration'],
    ['Authorization header is badly formatted', 'malformed_auth'],
    [`unknown_${secret}`, 'unclassified'],
  ])('classifies an exact upstream error without echoing %s', (code, expected) => {
    const value = classifyCopilotAuthError(capture({ error: { code, message: secret } }), {
      'www-authenticate': `Bearer error="invalid_token", error_description="${secret}"`,
    });
    expect(value).toEqual({ error_class: expected, body_capture: 'complete', challenge: 'invalid_token' });
    expect(JSON.stringify(value)).not.toContain(secret);
  });

  test.each(['truncated', 'bodyOmitted'])('does not infer a reason from an incomplete %s body', property => {
    expect(classifyCopilotAuthError({ ...capture({ error: { code: 'expired_token' } }), [property]: true }, {}))
      .toMatchObject({ error_class: 'uninspectable' });
  });

  test('does not confuse an arbitrary echoed message with a known upstream rejection', () => {
    expect(classifyCopilotAuthError(capture({ error: { message: `expired_token ${secret}` } }), {}))
      .toMatchObject({ error_class: 'unclassified' });
  });

  test('no diagnostic is attached on a non-enclave proxy', () => {
    const req = request({ AWF_ENCLAVE_PROXY_DIAGNOSTICS: '' });
    expect(req.describe()).toBeUndefined();
  });

  test('logs only bounded auth metadata and classifies compressed original provider errors', () => {
    const logRequest = jest.fn();
    const req = request();
    const log = createLogUpstreamErrorResponse({ logRequest, sanitizeForLog: value => value });
    log(401, {
      requestId: secret, provider: 'copilot', req: req.req, targetHost: 'api.githubcopilot.com',
      copilotAuthDiagnostic: req.describe(),
      responseHeaders: { 'www-authenticate': `Bearer error="invalid_token", token="${secret}"` },
      responseBody: Buffer.from(secret),
      providerErrorBody: {
        responseBody: require('zlib').gzipSync(Buffer.from('{"error":{"code":"expired_token"}}')),
        contentEncoding: 'gzip',
      },
    });
    const event = logRequest.mock.calls.find(([, name]) => name === 'copilot_auth_diagnostic')[2];
    expect(event).toMatchObject({ status: 401, error_class: 'expired', challenge: 'invalid_token' });
    expect(JSON.stringify(event)).not.toMatch(new RegExp(`${secret}|githubcopilot\\.com|Authorization`));
    log(401, {
      provider: 'copilot', req: req.req, copilotAuthDiagnostic: req.describe(),
      responseHeaders: {}, responseBody: Buffer.from('{"error":{"code":"expired_token"}}'),
      providerErrorBody: null,
    });
    expect(logRequest.mock.calls.filter(([, name]) => name === 'copilot_auth_diagnostic')[1][2])
      .toMatchObject({ error_class: 'uninspectable', body_capture: 'omitted' });
  });

  test('records successful controls without inspecting response bodies or adding an inference request', () => {
    const logRequest = jest.fn();
    const metrics = { statusClass: () => '2xx', gaugeDec: jest.fn(), increment: jest.fn(), observe: jest.fn() };
    const complete = createLogRequestCompletion({
      metrics, logRequest, sanitizeForLog: value => value, applyMaxRunsInvocation: jest.fn(),
    });
    complete(200, 0, null, null, {
      startTime: Date.now(), provider: 'copilot', req: { method: 'GET', url: '/models' },
      requestBytes: 0, copilotAuthDiagnostic: request({}, { url: '/models', method: 'GET' }).describe(),
    });
    expect(logRequest).toHaveBeenCalledWith('info', 'copilot_auth_diagnostic', expect.objectContaining({
      status: 200, endpoint: 'models', error_class: 'none', body_capture: 'not_required',
    }));
  });
});
