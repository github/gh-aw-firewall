'use strict';

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createCopilotAdapter } = require('./copilot');
const { createTokenBrokerProvider } = require('./token-broker');
const { createProviderServer, createWebSocketUpgradeHandler, createHealthCheckHandler } = require('../server-factory');
const { createManagementHandlers } = require('../management');
const { createSendUpstreamRequest } = require('../upstream-http');
const { buildCrossProviderRequest } = require('../cross-provider-fallback');
const { createRoutingProviderExecutor } = require('../routing-provider-executor');
const { buildRequestHeaders } = require('../request-headers');

jest.mock('../model-discovery', () => ({
  ...jest.requireActual('../model-discovery'),
  fetchJson: jest.fn(),
  httpProbe: jest.fn(),
}));
const discovery = require('../model-discovery');
const validation = require('../key-validation');
const auth = token => ['Bearer', token].join(' ');

function healthChecks(adapter, expected) {
  const providerResponse = { writeHead: jest.fn(), end: jest.fn() };
  createHealthCheckHandler(adapter)({}, providerResponse);
  expect(providerResponse.writeHead).toHaveBeenCalledWith(expected, expect.any(Object));
  const management = createManagementHandlers({
    getAdapters: () => [adapter], isModelFetchComplete: () => validation.isModelFetchComplete(),
    getKeyValidationState: () => ({
      complete: validation.isKeyValidationComplete(), results: validation.keyValidationResults,
    }),
    getLimiter: () => ({ getAllStatus: () => ({}) }),
  });
  const aggregateResponse = { writeHead: jest.fn(), end: jest.fn() };
  management.handleManagementEndpoint({ method: 'GET', url: '/health' }, aggregateResponse);
  expect(aggregateResponse.writeHead).toHaveBeenCalledWith(expected, expect.any(Object));
  expect(JSON.parse(aggregateResponse.end.mock.calls[0][0]).status)
    .toBe(expected === 200 ? 'healthy' : 'unavailable');
}

function brokerFixture(extraEnv = {}) {
  let now = Date.now();
  let generation = 0;
  const env = {
    AWF_COPILOT_TOKEN_BROKER: 'true',
    GH_AW_TOKEN_BROKER_URL: 'https://broker.example.test/token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://identity.example.test/token?api-version=1',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'bootstrap-test-credential',
    GITHUB_REPOSITORY_ID: '1', GITHUB_REPOSITORY_OWNER_ID: '2',
    GITHUB_RUN_ID: '3', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'test',
    ...extraEnv,
  };
  const request = jest.fn(async ({ url }) => {
    if (new URL(url).hostname === 'identity.example.test') {
      const payload = Buffer.from(JSON.stringify({
        aud: env.GH_AW_TOKEN_BROKER_URL, exp: Math.floor(now / 1000) + 600,
      })).toString('base64url');
      return { statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify({ value: `header.${payload}.signature` })) };
    }
    generation++;
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: Buffer.from(JSON.stringify({
        token: `renewed-test-${generation}`, expires_at: new Date(now + 120_000).toISOString(),
      })),
    };
  });
  const client = createTokenBrokerProvider(env, { now: () => now, request });
  const adapter = createCopilotAdapter(env, { createTokenBrokerProvider: () => client });
  return { adapter, client, request, env, advance: ms => { now += ms; } };
}

function requestLocal(server, body = { model: 'gpt-4.1', messages: [] }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: '/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('renewable Copilot broker adapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    validation.resetModelCacheState();
    validation.resetKeyValidationState();
    discovery.fetchJson.mockReset();
    discovery.httpProbe.mockReset();
  });

  test.each(['TRUE', '1', 'false', undefined])('requires exact marker %s and preserves static synchronous auth', marker => {
    const adapter = createCopilotAdapter({ AWF_COPILOT_TOKEN_BROKER: marker, COPILOT_GITHUB_TOKEN: 'static-test' });
    expect(adapter.getAuthHeaders({ method: 'POST', url: '/chat/completions', headers: {} }))
      .toMatchObject({ Authorization: auth('static-test') });
    expect(adapter.renewableAuth).toBeUndefined();
  });

  test.each([
    { COPILOT_GITHUB_TOKEN: 'static-test' }, { COPILOT_PROVIDER_API_KEY: 'byok-test' },
    { COPILOT_PROVIDER_API_KEY: 'awf-placeholder-token' }, { COPILOT_PROVIDER_TYPE: 'openai' },
    { COPILOT_PROVIDER_BASE_URL: 'https://api.githubcopilot.com' }, { AWF_AUTH_TYPE: 'github-oidc' },
    { AWF_AUTH_PROVIDER: 'azure' }, { AWF_BYOK_EXTRA_HEADERS: '{"Authorization":"secret"}' },
  ])('rejects conflicting authentication %j before constructing a client', conflict => {
    const factory = jest.fn();
    expect(() => createCopilotAdapter({ AWF_COPILOT_TOKEN_BROKER: 'true', ...conflict },
      { createTokenBrokerProvider: factory })).toThrow(/cannot be combined/);
    expect(factory).not.toHaveBeenCalled();
  });

  test.each([
    'http://api.githubcopilot.com', 'https://third-party.example.test', 'https://api.githubcopilot.com.evil.test',
    'https://unlisted.githubcopilot.com', 'https://copilot-api.tenant.ghe.com',
    ['https://', 'user', '@api.githubcopilot.com'].join(''), 'https://api.githubcopilot.com:8443',
    'https://api.githubcopilot.com/prefix', 'https://api.githubcopilot.com?query=secret',
    'https://api.githubcopilot.com#secret', 'https://api.githubcopilot.com?', 'https://api.githubcopilot.com#',
    ['https://', '@api.githubcopilot.com'].join(''), 'https://', 'api.githubcopilot.com\\evil.test',
  ])('rejects unsafe target %s without legacy target fallback', target => {
    const factory = jest.fn();
    expect(() => createCopilotAdapter({ AWF_COPILOT_TOKEN_BROKER: 'true', COPILOT_API_TARGET: target },
      { createTokenBrokerProvider: factory })).toThrow(/target/);
    expect(factory).not.toHaveBeenCalled();
  });

  test.each(['/', '/custom'])('rejects any configured base path %s', basePath => {
    expect(() => createCopilotAdapter({ AWF_COPILOT_TOKEN_BROKER: 'true', COPILOT_API_BASE_PATH: basePath }))
      .toThrow(/target/);
  });

  test.each(['api.githubcopilot.com', 'api.individual.githubcopilot.com',
    'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com'])(
    'uses renewable bearer headers on trusted %s without token-prefix diagnostics', async target => {
      const fixture = brokerFixture({ COPILOT_API_TARGET: target });
      const req = { method: 'POST', url: '/chat/completions', headers: {} };
      expect(fixture.adapter.isEnabled()).toBe(true);
      expect(fixture.client.hasToken()).toBe(false);
      const original = await fixture.adapter.getAuthHeaders(req);
      expect(original.Authorization).toBe(auth('renewed-test-1'));
      fixture.advance(100_000);
      const renewed = await fixture.adapter.getAuthHeaders(req);
      expect(renewed.Authorization).toBe(auth('renewed-test-2'));
      expect(original.Authorization).toBe(auth('renewed-test-1'));
      expect(JSON.stringify(req)).not.toMatch(/renewed-test|bootstrap-test|signature/);
      expect(fixture.adapter.getOidcProvider).toBeUndefined();
      expect(fixture.adapter.getReflectionInfo()).toMatchObject({ configured: true, credential_kind: 'token_broker' });
      fixture.adapter.shutdown();
      expect(fixture.client.hasToken()).toBe(false);
      await expect(fixture.adapter.getAuthHeaders(req)).rejects.toMatchObject({ code: 'token_broker_unavailable' });
    });

  test('broker default target cannot be redirected by enterprise GitHub server metadata', () => {
    const fixture = brokerFixture({ GITHUB_SERVER_URL: 'https://tenant.ghe.com' });
    expect(fixture.adapter.getTargetHost()).toBe('api.githubcopilot.com');
    fixture.adapter.shutdown();
  });

  test('concurrent request closures retain their own returned token', async () => {
    let release;
    const first = new Promise(resolve => { release = resolve; });
    const client = { getToken: jest.fn().mockReturnValueOnce(first).mockResolvedValueOnce('concurrent-test-2'), shutdown: jest.fn() };
    const adapter = createCopilotAdapter({ AWF_COPILOT_TOKEN_BROKER: 'true' }, { createTokenBrokerProvider: () => client });
    const one = adapter.getAuthHeaders({ url: '/', headers: {} });
    const two = await adapter.getAuthHeaders({ url: '/', headers: {} });
    release('concurrent-test-1');
    expect((await one).Authorization).toBe(auth('concurrent-test-1'));
    expect(two.Authorization).toBe(auth('concurrent-test-2'));
  });

  test('broker header preparation never logs token previews or captures credentials on the request', async () => {
    const fixture = brokerFixture();
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const req = { url: '/chat/completions', method: 'POST', headers: {} };
    const headers = buildRequestHeaders(Buffer.from('{}'), 2, req, {
      injectHeaders: await fixture.adapter.getAuthHeaders(req), provider: 'copilot',
      targetHost: fixture.adapter.getTargetHost(), requestId: 'broker-diagnostics-test',
    });
    expect(headers.Authorization).toBe(auth('renewed-test-1'));
    expect(Reflect.ownKeys(headers).every(key => typeof key === 'string')).toBe(true);
    expect(JSON.stringify(req)).not.toMatch(/renewed-test|bootstrap-test/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/auth_inject|renewed-test|key_preview/);
    fixture.adapter.shutdown();
  });

  test.each([
    ...['CONFIGURATION', 'OIDC', 'UNAUTHORIZED', 'UNSUPPORTED', 'UNAVAILABLE', 'MALFORMED_RESPONSE']
      .map(kind => [`ERR_TOKEN_BROKER_${kind}`, `ERR_TOKEN_BROKER_${kind}`]),
    ['ERR_TOKEN_BROKER_private-secret', 'ERR_TOKEN_BROKER_UNAVAILABLE'],
    ['arbitrary-private-secret', 'ERR_TOKEN_BROKER_UNAVAILABLE'],
    [undefined, 'ERR_TOKEN_BROKER_UNAVAILABLE'],
  ])('auth failures log only allowlisted classification for %s', async (code, expected) => {
    const log = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const client = {
      getToken: jest.fn().mockRejectedValue(Object.assign(new Error('private credential and broker response'), { code })),
      shutdown: jest.fn(),
    };
    const adapter = createCopilotAdapter({ AWF_COPILOT_TOKEN_BROKER: 'true' },
      { createTokenBrokerProvider: () => client });
    await expect(adapter.getAuthHeaders({ method: 'POST', url: '/responses' }))
      .rejects.toMatchObject({
        code: 'token_broker_unavailable', message: 'Copilot token broker authentication unavailable',
        brokerErrorCode: expected,
      });
    const failure = await adapter.getValidationProbe().catch(error => error);
    expect(failure.brokerErrorCode).toBe(expected);
    expect(Object.keys(failure)).not.toContain('brokerErrorCode');
    expect(JSON.stringify(failure)).not.toMatch(/ERR_TOKEN_BROKER|private|credential|response/);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({
      timestamp: expect.any(String), level: 'error', event: 'token_broker_auth_failed', code: expected,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|credential|response/);
    adapter.shutdown();
  });

  test('validation, discovery and resolution refresh await renewable models headers', async () => {
    const fixture = brokerFixture();
    discovery.httpProbe.mockResolvedValue(200);
    discovery.fetchJson.mockResolvedValue({ data: [{ id: 'gpt-4.1' }] });
    await validation.validateApiKeys([fixture.adapter]);
    expect(discovery.httpProbe).toHaveBeenCalledWith('https://api.githubcopilot.com/models',
      expect.objectContaining({ headers: expect.objectContaining({
        Authorization: auth('renewed-test-1'), 'X-GitHub-Api-Version': '2026-07-01',
      }) }), 10_000);
    fixture.advance(100_000);
    await validation.fetchStartupModels([fixture.adapter]);
    expect(discovery.fetchJson).toHaveBeenLastCalledWith('https://api.githubcopilot.com/models',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: auth('renewed-test-2') }) }), 10_000);
    expect(validation.cachedModels.copilot).toContain('gpt-4.1');
    validation.configureKeyValidation({ getRegisteredAdapters: () => [fixture.adapter] });
    fixture.advance(100_000);
    await validation.refreshProviderModelsForResolution('copilot');
    expect(discovery.fetchJson.mock.calls.at(-1)[1].headers.Authorization).toBe(auth('renewed-test-3'));
    fixture.adapter.shutdown();
  });

  test('health is passive and fail-closed until acquisition and startup validation, then recovers after renewal', async () => {
    const fixture = brokerFixture();
    healthChecks(fixture.adapter, 503);
    expect(fixture.request).not.toHaveBeenCalled();
    await fixture.adapter.getAuthHeaders();
    healthChecks(fixture.adapter, 503);
    discovery.fetchJson.mockResolvedValue({ data: [{ id: 'gpt-4.1' }] });
    await validation.fetchStartupModels([fixture.adapter]);
    healthChecks(fixture.adapter, 200);
    const requestCount = fixture.request.mock.calls.length;
    fixture.advance(100_000);
    expect(fixture.client.hasToken()).toBe(false);
    healthChecks(fixture.adapter, 200);
    healthChecks(fixture.adapter, 200);
    expect(fixture.request).toHaveBeenCalledTimes(requestCount);
    const originalRequest = fixture.request.getMockImplementation();
    fixture.request.mockRejectedValue(new Error('private outage body'));
    await expect(fixture.adapter.getAuthHeaders()).rejects.toMatchObject({ code: 'token_broker_unavailable' });
    healthChecks(fixture.adapter, 503);
    expect(fixture.adapter.isEnabled()).toBe(true);
    fixture.request.mockImplementation(originalRequest);
    await fixture.adapter.getAuthHeaders();
    healthChecks(fixture.adapter, 200);
    fixture.adapter.shutdown();
    healthChecks(fixture.adapter, 503);
  });

  test.each(['denial', 'outage'])('broker startup %s cannot make provider or management health healthy', async failure => {
    const fixture = brokerFixture();
    const original = fixture.request.getMockImplementation();
    fixture.request.mockImplementation(async options => {
      if (new URL(options.url).hostname !== 'broker.example.test') return original(options);
      if (failure === 'outage') throw new Error('private outage body');
      return { statusCode: 403, headers: {}, body: Buffer.from('private denial body') };
    });
    await validation.validateApiKeys([fixture.adapter]);
    await validation.fetchStartupModels([fixture.adapter]);
    healthChecks(fixture.adapter, 503);
    expect(fixture.adapter.isEnabled()).toBe(true);
    expect(discovery.fetchJson).not.toHaveBeenCalled();
    fixture.adapter.shutdown();
  });

  test('a minted token rejected by startup Copilot validation does not satisfy readiness', async () => {
    const fixture = brokerFixture();
    discovery.httpProbe.mockResolvedValue(401);
    await validation.validateApiKeys([fixture.adapter]);
    expect(fixture.client.hasToken()).toBe(true);
    healthChecks(fixture.adapter, 503);
    discovery.fetchJson.mockResolvedValue(null);
    await validation.fetchStartupModels([fixture.adapter]);
    healthChecks(fixture.adapter, 503);
    discovery.fetchJson.mockResolvedValue({ data: [{ id: 'gpt-4.1' }] });
    await validation.fetchStartupModels([fixture.adapter]);
    healthChecks(fixture.adapter, 200);
    fixture.adapter.shutdown();
  });

  test('static management and provider health retain synchronous behavior', () => {
    const adapter = createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'static-test' });
    healthChecks(adapter, 200);
  });

  test('startup authentication acquisition failure is recorded safely and discovery completes without a fallback', async () => {
    const fixture = brokerFixture();
    fixture.request.mockRejectedValue(new Error('bootstrap-test-credential broker response body'));
    await validation.validateApiKeys([fixture.adapter]);
    await validation.fetchStartupModels([fixture.adapter]);
    expect(validation.keyValidationResults.copilot).toMatchObject({
      status: 'inconclusive', code: 'ERR_TOKEN_BROKER_OIDC',
    });
    expect(validation.isModelFetchComplete()).toBe(true);
    expect(discovery.fetchJson).not.toHaveBeenCalled();
    expect(discovery.httpProbe).not.toHaveBeenCalled();
    expect(JSON.stringify(validation.keyValidationResults)).not.toContain('bootstrap-test');
    fixture.adapter.shutdown();
  });

  test('HTTP inference handler awaits auth and returns sanitized 503 with no upstream fallback', async () => {
    const fixture = brokerFixture();
    const upstream = jest.fn((_req, res, _target, headers) => {
      expect(headers.Authorization).toBe(auth('renewed-test-1'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"choices":[]}');
    });
    const server = createProviderServer(fixture.adapter, {
      checkRateLimit: () => false, proxyRequest: upstream,
      proxyWebSocket: jest.fn(), reflectEndpoints: () => [],
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const successful = await requestLocal(server);
      expect(successful.status).toBe(200);
      expect(successful.body).not.toContain('renewed-test');
      fixture.advance(100_000);
      fixture.request.mockRejectedValue(new Error('renewed-test-1 response body bootstrap-test-credential'));
      const failed = await requestLocal(server);
      expect(failed.status).toBe(503);
      expect(JSON.parse(failed.body).error.code).toBe('token_broker_unavailable');
      expect(failed.body).not.toMatch(/renewed-test|bootstrap-test|response body/);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {
      fixture.adapter.shutdown();
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('broker WebSockets fail closed explicitly without requesting auth or opening upstream', () => {
    const fixture = brokerFixture();
    const socket = { write: jest.fn(), destroy: jest.fn() };
    const proxy = jest.fn();
    createWebSocketUpgradeHandler(fixture.adapter, proxy)({ url: '/responses', headers: {} }, socket, Buffer.alloc(0));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('503 Service Unavailable'));
    expect(socket.destroy).toHaveBeenCalled();
    expect(proxy).not.toHaveBeenCalled();
    expect(fixture.request).not.toHaveBeenCalled();
    fixture.adapter.shutdown();
  });

  test('cross-provider preparation renews broker auth and never retains incoming auth', async () => {
    const fixture = brokerFixture();
    await fixture.adapter.getAuthHeaders();
    fixture.advance(100_000);
    const built = await buildCrossProviderRequest({
      sourceBody: Buffer.from(JSON.stringify({ model: 'gpt-4.1', messages: [] })),
      protocol: 'chat', originProvider: 'openai', targetProvider: 'copilot', model: 'gpt-4.1',
      adapter: fixture.adapter, req: { method: 'POST', url: '/chat/completions', headers: { authorization: 'incoming-test' } },
      requestId: 'test-fallback',
    });
    expect(built.headers.Authorization).toBe(auth('renewed-test-2'));
    expect(built.headers.authorization).toBeUndefined();
    fixture.advance(100_000);
    fixture.request.mockRejectedValue(new Error('private broker body'));
    await expect(buildCrossProviderRequest({
      sourceBody: Buffer.from('{"messages":[]}'), protocol: 'chat',
      originProvider: 'openai', targetProvider: 'copilot', model: 'gpt-4.1', adapter: fixture.adapter,
      req: { method: 'POST', url: '/chat/completions', headers: {} },
    })).rejects.toMatchObject({ code: 'token_broker_unavailable', message: 'Copilot token broker authentication unavailable' });
    fixture.adapter.shutdown();
  });

  test('routing classifier resolves renewable credentials before dispatch', async () => {
    const fixture = brokerFixture();
    const proxy = jest.fn((_req, res, _target, headers) => {
      expect(headers.Authorization).toBe(auth('renewed-test-1'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices":[]}');
    });
    const executor = createRoutingProviderExecutor({
      getAdapter: () => fixture.adapter, proxyRequest: proxy, checkRateLimit: () => false,
    });
    await executor.execute({ purpose: 'routing_classification', provider: 'copilot',
      path: '/chat/completions', body: { model: 'gpt-4.1', messages: [] } });
    expect(proxy).toHaveBeenCalledTimes(1);
    fixture.adapter.shutdown();
  });

  test.each(['copilot-integration-id', 'Copilot-Integration-Id', 'cOpIlOt-InTeGrAtIoN-iD'])(
    'upstream dispatch preserves caller %s while renewing auth without duplicates',
    async integrationHeader => {
    const fixture = brokerFixture();
    const transport = jest.fn(() => ({ on: jest.fn(), write: jest.fn(), end: jest.fn() }));
    const send = createSendUpstreamRequest({
      https: { request: transport }, proxyAgent: {}, handleUpstreamResponse: jest.fn(), sleep: jest.fn(),
      getProviderAdapter: () => fixture.adapter,
      otel: { endSpan: jest.fn() }, metrics: { gaugeDec: jest.fn() }, handleRequestError: jest.fn(),
    });
    const response = { writeHead: jest.fn(), end: jest.fn() };
    const context = { body: Buffer.from('{"messages":[]}'), targetHost: 'api.githubcopilot.com',
      upstreamPath: '/chat/completions', provider: 'copilot',
      req: { method: 'POST', headers: { [integrationHeader]: 'caller-integration', authorization: 'incoming-test' } },
      res: response, span: {}, requestId: 'renewal-test', startTime: Date.now(), requestBytes: 15 };
    const preparedHeaders = buildRequestHeaders(context.body, context.body.length, context.req, {
      injectHeaders: { Authorization: auth('stale-test'), 'Copilot-Integration-Id': 'agentic-workflows' },
      targetHost: context.targetHost, provider: context.provider, requestId: context.requestId,
    });
    expect(Object.entries(preparedHeaders).filter(([key]) => key.toLowerCase() === 'copilot-integration-id'))
      .toEqual([[integrationHeader, 'caller-integration']]);
    const staleHeaders = {
      ...preparedHeaders,
      authorization: auth('stale-test'), AUTHORIZATION: auth('stale-duplicate-test'),
      'content-type': 'application/json',
      'COPILOT-INTEGRATION-ID': 'duplicate-integration',
    };
    await send(staleHeaders, context);
    expect(transport.mock.calls[0][0].headers.Authorization).toBe(auth('renewed-test-1'));
    fixture.advance(100_000);
    await send(staleHeaders, { ...context, hasRetried: true });
    expect(transport.mock.calls[1][0].headers.Authorization).toBe(auth('renewed-test-2'));
    expect(transport.mock.calls[0][0].headers.Authorization).toBe(auth('renewed-test-1'));
    for (const [options] of transport.mock.calls) {
      expect(Object.entries(options.headers).filter(([key]) => key.toLowerCase() === 'authorization'))
        .toEqual([['Authorization', options.headers.Authorization]]);
      expect(Object.entries(options.headers).filter(([key]) => key.toLowerCase() === 'copilot-integration-id'))
        .toEqual([[integrationHeader, 'caller-integration']]);
    }
    expect(staleHeaders.authorization).toBe(auth('stale-test'));
    expect(staleHeaders['COPILOT-INTEGRATION-ID']).toBe('duplicate-integration');
    fixture.advance(100_000);
    fixture.request.mockRejectedValue(new Error('private body renewed-test-2'));
    await send(staleHeaders, context);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(response.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(response.end.mock.calls[0][0]).not.toMatch(/private body|renewed-test/);
    fixture.adapter.shutdown();
  });

  test('a failed cross-provider broker renewal stops the fallback chain before alternate providers', async () => {
    const fixture = brokerFixture();
    fixture.request.mockRejectedValue(new Error('broker private response body'));
    const alternate = {
      isEnabled: () => true, getTargetHost: () => 'api.anthropic.com', getBasePath: () => '',
      getBodyTransform: () => null, getAuthHeaders: jest.fn(() => ({ 'x-api-key': 'alternate-test' })),
    };
    const transport = jest.fn((_options, callback) => {
      callback({ statusCode: 503, headers: {} });
      return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    });
    const handleResponse = jest.fn();
    const send = createSendUpstreamRequest({
      https: { request: transport }, proxyAgent: {}, handleUpstreamResponse: handleResponse, sleep: jest.fn(),
      getProviderAdapter: provider => provider === 'copilot' ? fixture.adapter : provider === 'anthropic' ? alternate : null,
      getFallbackModels: () => ['copilot/gpt-4.1', 'anthropic/claude-sonnet-4.6'],
      otel: { endSpan: jest.fn() }, metrics: { gaugeDec: jest.fn(), increment: jest.fn() },
      handleRequestError: jest.fn(),
    });
    const res = { headersSent: false, writeHead: jest.fn(), end: jest.fn() };
    send({ authorization: auth('origin-test') }, {
      body: Buffer.from('{"model":"origin-model","messages":[]}'), targetHost: 'api.openai.com',
      upstreamPath: '/chat/completions', provider: 'openai', req: { method: 'POST', url: '/chat/completions', headers: {} },
      res, span: {}, requestId: 'fallback-broker-test', startTime: Date.now(),
    });
    const onFallback = handleResponse.mock.calls[0][2].onModelFallback;
    expect(onFallback({ reason: 'upstream_5xx', abandon: jest.fn() })).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(alternate.getAuthHeaders).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.any(Object));
    expect(res.end.mock.calls[0][0]).not.toContain('private response');
    fixture.adapter.shutdown();
  });

  test('active HTTP streams continue through a subsequent request renewal without replay', async () => {
    const fixture = brokerFixture();
    const core = require('../proxy-request');
    core.configureFallbackProviders({ getAdapter: () => fixture.adapter });
    const streams = [];
    const transport = jest.spyOn(https, 'request').mockImplementation((options, callback) => {
      const request = new EventEmitter();
      request.write = jest.fn();
      request.destroy = jest.fn();
      request.end = () => {
        const stream = new PassThrough();
        stream.statusCode = 200;
        stream.headers = { 'content-type': streams.length ? 'application/json' : 'text/event-stream' };
        streams.push({ stream, headers: options.headers });
        setImmediate(() => {
          callback(stream);
          if (streams.length === 1) stream.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
          else stream.end('{"choices":[]}');
        });
      };
      return request;
    });
    const server = createProviderServer(fixture.adapter, {
      checkRateLimit: () => false, proxyRequest: core.proxyRequest, proxyWebSocket: jest.fn(),
      reflectEndpoints: () => [],
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let firstResponse;
    let firstEnded = false;
    try {
      const firstChunk = new Promise((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
          path: '/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
          firstResponse = res;
          res.once('data', chunk => resolve(chunk.toString()));
          res.once('end', () => { firstEnded = true; });
          res.once('error', reject);
        });
        request.on('error', reject);
        request.end('{"model":"gpt-4.1","messages":[],"stream":true}');
      });
      expect(await firstChunk).toContain('first');
      fixture.advance(100_000);
      expect((await requestLocal(server)).status).toBe(200);
      expect(firstEnded).toBe(false);
      expect(streams[0].headers.Authorization).toBe(auth('renewed-test-1'));
      expect(streams[1].headers.Authorization).toBe(auth('renewed-test-2'));
      fixture.advance(100_000);
      fixture.request.mockRejectedValue(new Error('broker-private-failure'));
      expect((await requestLocal(server)).status).toBe(503);
      expect(firstEnded).toBe(false);
      const ended = new Promise(resolve => firstResponse.once('end', resolve));
      streams[0].stream.end('data: [DONE]\n\n');
      await ended;
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      firstResponse?.destroy();
      streams.forEach(({ stream }) => stream.destroy());
      fixture.adapter.shutdown();
      core.configureFallbackProviders();
      await new Promise(resolve => server.close(resolve));
    }
  }, 10_000);
});
