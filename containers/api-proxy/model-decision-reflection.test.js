'use strict';

const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { makeReq, makeProxyReq, makeProxyRes, flushPromises } = require('./test-helpers/server-mock-factories');
const { collectLogOutput } = require('./test-helpers/log-test-helpers');

let originalEnv, serverModule, requestSpy, logs;
const servers = [];

beforeEach(() => {
  originalEnv = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (/^(?:AWF_|COPILOT_|OPENAI_|ANTHROPIC_|HTTPS_PROXY)/.test(name)) delete process.env[name];
  }
  process.env.COPILOT_PROVIDER_API_KEY = 'fixture';
  process.env.AWF_VERSION = 'fixture';
  jest.resetModules();
  logs = collectLogOutput();
  requestSpy = jest.spyOn(https, 'request').mockImplementation(() => makeProxyReq());
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.shutdownConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
  if (serverModule) await require('./otel').shutdown();
  serverModule = null;
  jest.restoreAllMocks();
  process.env = originalEnv;
});

function load() {
  serverModule = require('./server');
  serverModule.cachedModels.copilot = ['gpt-5.4', 'effort-model'];
  const { replaceRuntimeModels } = require('./runtime-model-catalog');
  replaceRuntimeModels('copilot', [{
    id: 'effort-model', supportedEndpoints: ['/responses'],
    supportedReasoningEfforts: ['low', 'high'],
    capabilities: { supports: { reasoning_effort: ['low', 'high'] } },
  }]);
  return serverModule;
}

function productionServer() {
  const module = serverModule || load();
  const server = module.createProviderServer({
    name: 'copilot', isEnabled: () => true, isManagementPort: true,
    getTargetHost: () => 'api.githubcopilot.com', getAuthHeaders: () => ({}),
    getBasePath: () => '', getBodyTransform: () => module.makeModelBodyTransform('copilot'),
  }, Promise.resolve());
  servers.push(server);
  return server;
}

function makeResponse() {
  const res = new EventEmitter();
  const headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = jest.fn((key, value) => { headers[key] = value; });
  res.getHeader = key => headers[key];
  res.writeHead = jest.fn(status => { res.statusCode = status; res.headersSent = true; });
  res.end = jest.fn(body => { res.body = body; res.writableFinished = true; res.emit('finish'); });
  return res;
}

async function post(server, model = 'effort-model', effort = 'max', extra = {}) {
  const req = makeReq('/responses');
  Object.assign(req, extra);
  const res = makeResponse();
  server.emit('request', req, res);
  await flushPromises();
  req.emit('data', Buffer.from(JSON.stringify({ model, reasoning: { effort }, input: 'private-prompt' })));
  req.emit('end');
  await flushPromises();
  return { req, res };
}

function getReflection(server) {
  const res = makeResponse();
  server.emit('request', { method: 'GET', url: '/reflect' }, res);
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

test('production server injection captures real effort rejection without upstream inference', async () => {
  const server = productionServer();
  const { req, res } = await post(server);
  expect(res.statusCode).toBe(400);
  expect(JSON.parse(res.body).error.code).toBe('unsupported_reasoning_effort');
  expect(requestSpy).not.toHaveBeenCalled();
  expect(req.awfSelectedModelEligibility).toBeDefined();
  const before = getReflection(server);
  const rejected = before.model_decision_diagnostics.recent.decisions[0];
  expect(rejected).toMatchObject({
    kind: 'request_outcome', reason: 'unsupported_reasoning_effort', status: 'rejected',
    identity: { provider: 'copilot', model_id: null },
    scope: { context: 'primary-agent', endpoint: '/responses', channel: 'copilot-api' },
    action: { kind: 'change_request', retry: 'do_not_repeat' },
    evidence: { eligibility_revision: req.awfEligibility.revision },
    effort: { support: 'known_unsupported', supported_values: null, omission_supported: null },
  });
  const { proxyEligibilityStore } = require('./model-eligibility');
  proxyEligibilityStore.replaceTrustedEvidence({});
  await post(server);
  const after = getReflection(server);
  expect(after.model_decision_diagnostics.recent.decisions[0]).toEqual(rejected);
  expect(after.model_decision_diagnostics.recent.decisions[1].evidence.eligibility_revision)
    .toBeGreaterThan(rejected.evidence.eligibility_revision);
  expect(getReflection(server)).toEqual(after);
  expect(requestSpy).not.toHaveBeenCalled();
  expect(JSON.stringify(after.model_decision_diagnostics)).not.toContain('private-prompt');
});

test('production policy guard records denial without publishing hidden inventory or policy patterns', async () => {
  process.env.AWF_DISALLOWED_MODELS = JSON.stringify(['effort-*']);
  const server = productionServer();
  const { res } = await post(server);
  expect(res.statusCode).toBe(403);
  const reflection = getReflection(server);
  expect(reflection.endpoints.find(item => item.provider === 'copilot').models).toEqual(['gpt-5.4']);
  expect(reflection.model_decision_diagnostics.recent.decisions[0]).toMatchObject({
    reason: 'policy_denied', status: 'rejected', identity: { provider: 'copilot', model_id: null },
    action: { retry: 'do_not_repeat' },
  });
  expect(JSON.stringify(reflection.model_decision_diagnostics)).not.toContain('effort-model');
  expect(JSON.stringify(reflection.model_decision_diagnostics)).not.toContain('effort-*');
  expect(requestSpy).not.toHaveBeenCalled();
});

test('real fallback effort skip and exhaustion cannot reject the initial model or dispatch the candidate', async () => {
  process.env.AWF_FALLBACK_MODELS = JSON.stringify(['initial-model', 'fallback-model']);
  load();
  serverModule.cachedModels.copilot = ['initial-model', 'fallback-model'];
  require('./runtime-model-catalog').replaceRuntimeModels('copilot', [
    { id: 'initial-model', supportedEndpoints: ['/responses'], supportedReasoningEfforts: ['high'],
      capabilities: { supports: { reasoning_effort: ['high'] } } },
    { id: 'fallback-model', supportedEndpoints: ['/responses'], supportedReasoningEfforts: ['low'],
      capabilities: { supports: { reasoning_effort: ['low'] } } },
  ]);
  require('./proxy-request')._setSleepForTests(() => Promise.resolve());
  let respond;
  requestSpy.mockImplementation((_options, callback) => { respond = callback; return makeProxyReq(); });
  const server = productionServer();
  const { req, res } = await post(server, 'initial-model', 'high');
  expect(req.awfSelectedModelEligibility.model).toBe('initial-model');
  expect(requestSpy).toHaveBeenCalledTimes(1);
  const failure = makeProxyRes(400);
  respond(failure);
  failure.emit('data', Buffer.from(JSON.stringify({ error: { code: 'model_not_supported' } })));
  failure.emit('end');
  await flushPromises();
  expect(res.statusCode).toBe(502);
  expect(JSON.parse(res.body).error).toMatchObject({ code: 'model_fallback_exhausted' });
  const diagnostics = getReflection(server).model_decision_diagnostics;
  expect(diagnostics.recent.decisions[0]).toMatchObject({
    reason: 'fallback_incompatible', identity: { provider: 'copilot', model_id: 'fallback-model' },
    origin: { provider: 'copilot', model_id: 'initial-model' },
    compatibility: { outcome: 'skipped', reasons: [
      { feature: 'reasoning_fields', code: 'reasoning_effort_unsupported' },
    ] },
    action: { retry: 'do_not_repeat' },
  });
  expect(diagnostics.recent.decisions[1]).toMatchObject({
    reason: 'fallback_exhausted', identity: { provider: null, model_id: null },
  });
  expect(diagnostics.recent.decisions.some(item => item.reason === 'unsupported_reasoning_effort')).toBe(false);
  expect(requestSpy).toHaveBeenCalledTimes(1);
});

test('latched real accounting failure remains operator-required without changing legacy reflection status', () => {
  const server = productionServer();
  const { applyAiCreditsUsage } = require('./guards/ai-credits-guard');
  expect(() => applyAiCreditsUsage({ input_tokens: Number.MAX_SAFE_INTEGER + 1 }, 'gpt-5.4', 'copilot')).toThrow();
  const reflection = getReflection(server);
  expect(reflection.ai_credits.pricing_error).toBe('pricing_resolution_error');
  expect(reflection.model_decision_diagnostics.accounting.decisions[0]).toMatchObject({
    reason: 'pricing_resolution_error', action: { kind: 'operator_required' },
  });
  expect(requestSpy).not.toHaveBeenCalled();
});

test.each([
  ['1.0.0', 'actual-agent', true, 'harness_incompatible'],
  ['3.0.0', 'other-environment', true, 'harness_unverified'],
  ['3.0.0', 'actual-agent', false, 'harness_unverified'],
])('production harness guard reflects actual version/scope/evidence: %s %s %s',
  async (version, environment, verified, reason) => {
    load();
    const { identity } = require('./model-identity').resolveModelIdentity('effort-model', 'copilot');
    const scope = { provider: 'copilot', channel: 'copilot-api' };
    require('./model-eligibility').proxyEligibilityStore.replaceTrustedEvidence({
      models: [{ identity, harnesses: [{
        name: 'copilot', minimum: '2.0.0', scheme: 'semver', scope,
        reason: 'private-reason', provenance: { source: 'https://private.invalid/credential' },
      }] }],
      executionEnvironment: 'actual-agent',
      observations: [{ name: 'copilot', version, environment, verified, actual: true, scope }],
    });
    const server = productionServer();
    const { res } = await post(server);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('model_harness_incompatible');
    const diagnostics = getReflection(server).model_decision_diagnostics;
    expect(diagnostics.recent.decisions[0]).toMatchObject({
      reason, status: 'rejected', action: { kind: 'operator_required' },
    });
    expect(JSON.stringify(diagnostics)).not.toContain('private-');
    expect(JSON.stringify(diagnostics)).not.toContain('private.invalid');
    expect(requestSpy).not.toHaveBeenCalled();
  });

test('real accounted direct and backend-estimated usage is projected without another pricing evaluation', () => {
  const server = productionServer();
  const { applyAiCreditsUsage, getAiCreditsReflectState } = require('./guards/ai-credits-guard');
  const direct = applyAiCreditsUsage({ input_tokens: 1000 }, 'gpt-5.4', 'copilot');
  const estimated = applyAiCreditsUsage({ input_tokens: 1000 }, 'copilot/unknown-new-model', 'copilot');
  expect(direct).toBeDefined();
  expect(estimated.pricingEstimate.basis).toBe('backend');
  const usage = getAiCreditsReflectState();
  const reflection = getReflection(server);
  expect(reflection.ai_credits).toEqual(usage);
  expect(reflection.model_decision_diagnostics.accounting.decisions).toEqual([
    expect.objectContaining({ reason: 'direct_pricing', status: 'observed',
      pricing: { basis: 'direct', donor_count: null, budget_accounted: true } }),
    expect.objectContaining({ reason: 'estimated_pricing', status: 'estimated',
      pricing: { basis: 'backend', donor_count: expect.any(Number), budget_accounted: true } }),
  ]);
  expect(getReflection(server).ai_credits).toEqual(usage);
  expect(requestSpy).not.toHaveBeenCalled();
});

test('real no-donor accounting keeps its warning policy and does not become permission or a fake priced bucket', () => {
  const server = productionServer();
  const { applyAiCreditsUsage, getAiCreditsReflectState } = require('./guards/ai-credits-guard');
  expect(applyAiCreditsUsage({ input_tokens: 1000 }, 'opaque', 'unpriced-private-backend')).toBeNull();
  expect(getAiCreditsReflectState().by_model).toEqual({});
  const reflection = getReflection(server);
  expect(reflection.model_decision_diagnostics.accounting.decisions).toEqual([]);
  expect(logs.lines.some(line => line.event === 'unknown_model_ai_credits_pricing')).toBe(true);
  expect(requestSpy).not.toHaveBeenCalled();
});

test('real accounting failure preserves HTTP 500 and the exact legacy error body', () => {
  const server = productionServer();
  // Exceeds the exact decimal contract's exponent bound, rather than a large
  // valid cap (which the legacy policy clamps to the hard ceiling).
  process.env.AWF_MAX_AI_CREDITS = '1e100001';
  require('./guards/ai-credits-guard').resetAiCreditsGuardForTests();
  const failed = makeResponse();
  server.emit('request', { method: 'GET', url: '/reflect' }, failed);
  expect(failed.statusCode).toBe(500);
  expect(JSON.parse(failed.body)).toEqual({ error: {
    type: 'pricing_resolution_error',
    message: 'AI-credit pricing resolution failed; accounting could not be completed.',
  } });
  expect(requestSpy).not.toHaveBeenCalled();
});

test('production dedicated proxy never reflects primary or cross-invocation outcome evidence', async () => {
  process.env.AWF_ENCLAVE_AGENT_PROXY = '1';
  const server = productionServer();
  const reflection = getReflection(server);
  expect(reflection.model_decision_diagnostics).toMatchObject({
    context: 'dedicated-enclave', recent: { status: 'unavailable', decisions: [] },
    accounting: { decisions: [] },
  });
  expect(reflection.model_decision_diagnostics.current.decisions.some(item => item.effort)).toBe(false);
  expect(requestSpy).not.toHaveBeenCalled();
});

test('real loopback management reads dispatch no inference and preserve management methods', async () => {
  const server = productionServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const get = path => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
  const first = await get('/reflect');
  const second = await get('/reflect');
  expect(first.status).toBe(200);
  expect(second.body).toEqual(first.body);
  expect(first.body.model_decision_diagnostics.schema).toBe('awf-model-decision-diagnostics/v1');
  expect(requestSpy).not.toHaveBeenCalled();
});
