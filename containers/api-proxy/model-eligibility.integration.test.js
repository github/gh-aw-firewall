'use strict';

const http = require('http');
const https = require('https');
const { PassThrough } = require('node:stream');
const {
  makeReq, makeRes, makeProxyReq, makeProxyRes, flushPromises,
} = require('./test-helpers/server-mock-factories');

const ENV_KEYS = [
  'HTTPS_PROXY', 'AWF_FALLBACK_MODELS', 'AWF_MODEL_FALLBACK', 'AWF_ALLOWED_MODELS',
  'AWF_DISALLOWED_MODELS', 'AWF_MAX_MODEL_MULTIPLIER', 'AWF_MAX_AI_CREDITS',
  'AWF_MODEL_ALIASES', 'AWF_MAX_RUNS',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
let eligibility, proxy, requests, responses;

const scope = (provider = 'copilot') => ({
  provider, channel: provider === 'copilot' ? 'copilot-api' : 'native-api',
});

function evidence(model = 'gpt-6-sol', provider = 'copilot', overrides = {}) {
  const { identity } = require('./model-identity').resolveModelIdentity(model, provider);
  return {
    models: [{
      identity, harnesses: [{
        name: 'copilot', scheme: 'semver', minimum: '1.2.0',
        excludedRanges: ['>=1.3.0 <1.4.0'], scope: scope(provider),
        reason: 'Requires the revised request protocol',
        provenance: {
          authority: 'maintained', source: 'https://internal.example/token/secret',
          revision: 'private-revision',
        },
      }],
    }],
    executionEnvironment: 'actual-agent',
    observations: [{
      name: 'copilot', scheme: 'semver', version: '1.1.0',
      scope: scope(provider), environment: 'actual-agent', verified: true, actual: true,
    }],
    ...overrides,
  };
}

function record(id) {
  return { id, supportedEndpoints: ['/chat/completions'], capabilities: { supports: { streaming: true } } };
}

beforeEach(() => {
  jest.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  requests = [];
  responses = [];
  jest.spyOn(https, 'request').mockImplementation((options, callback) => {
    const outgoing = makeProxyReq();
    requests.push({ options, outgoing });
    responses.push(callback);
    return outgoing;
  });
  eligibility = require('./model-eligibility');
  proxy = require('./proxy-request');
});

afterEach(async () => {
  await require('./otel').shutdown();
  jest.dontMock('./model-information.naming.generated.json');
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function start(model = 'gpt-6-sol', provider = 'copilot', transform = null, eligibilityScope) {
  proxy._setSleepForTests(() => Promise.resolve());
  const req = makeReq('/chat/completions');
  req.awfEligibilityScope = eligibilityScope;
  const res = makeRes();
  proxy.proxyRequest(req, res, 'api.githubcopilot.com', {}, provider, '', transform);
  req.emit('data', Buffer.from(JSON.stringify({ model, messages: [] })));
  req.emit('end');
  await flushPromises();
  return { req, res };
}

function sent(index = 0) {
  return JSON.parse(Buffer.concat(requests[index].outgoing.write.mock.calls.map(([chunk]) => chunk)));
}

async function reject(index, status = 400, code = 'model_not_supported') {
  const response = makeProxyRes(status);
  responses[index](response);
  response.emit('data', Buffer.from(JSON.stringify({ error: { code, message: code } })));
  response.emit('end');
  await flushPromises();
}

test('real HTTP ingress rejects an incompatible harness with scoped actionable details before any upstream call', async () => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  const { createProviderServer } = require('./server-factory');
  const adapter = {
    name: 'copilot', isEnabled: () => true, getTargetHost: () => 'api.githubcopilot.com',
    getAuthHeaders: () => ({}), getBasePath: () => '', getBodyTransform: () => null,
  };
  const server = createProviderServer(adapter, {
    handleManagementEndpoint: () => false, reflectEndpoints: () => [],
    checkRateLimit: () => false, proxyRequest: proxy.proxyRequest, proxyWebSocket: jest.fn(),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise((resolve, rejectRequest) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/chat/completions',
        headers: { 'content-type': 'application/json' },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      req.on('error', rejectRequest);
      req.end(JSON.stringify({ model: 'gpt-6-sol', messages: [] }));
    });
    expect(result).toMatchObject({
      status: 400,
      body: { error: { code: 'model_harness_incompatible', scope: scope() } },
    });
    expect(result.body.error.reasons).toEqual([{
      code: 'harness_incompatible', detected: '1.1.0',
      required: { scheme: 'semver', minimum: '1.2.0', excludedRanges: ['>=1.3.0 <1.4.0'] },
      reason: 'Requires the revised request protocol',
    }]);
    expect(JSON.stringify(result.body)).not.toMatch(/internal\.example|secret|private-revision/);
    expect(requests).toHaveLength(0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.shutdownConnections();
  }
});

test.each([true, false])('real HTTP alias exhaustion cannot become unrelated preflight recovery (harness constrained=%s)', async constrained => {
  process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { coding: ['copilot/gpt-6-sol'] } });
  jest.resetModules();
  eligibility = require('./model-eligibility');
  proxy = require('./proxy-request');
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(constrained ? evidence() : {});
  const catalog = require('./runtime-model-catalog');
  catalog.replaceRuntimeModels('copilot', [record('gpt-6-sol'), record('gpt-5.3-codex')]);
  const { makeModelBodyTransform } = require('./model-config');
  const transform = makeModelBodyTransform('copilot', { copilot: ['gpt-6-sol', 'gpt-5.3-codex'] },
    async () => {}, null, () => catalog.getRuntimeModels('copilot'), true);
  let handledRequest;
  const adapter = {
    name: 'copilot', isEnabled: () => true, getTargetHost: () => 'api.githubcopilot.com',
    getAuthHeaders: () => ({}), getBasePath: () => '',
    getBodyTransform: () => async (body, req) => {
      handledRequest = req;
      return transform(body, req);
    },
  };
  https.request.mockImplementation((options, callback) => {
    const outgoing = makeProxyReq();
    requests.push({ options, outgoing });
    setImmediate(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      response.end('{"choices":[]}');
    });
    return outgoing;
  });
  const { createProviderServer } = require('./server-factory');
  const server = createProviderServer(adapter, {
    handleManagementEndpoint: () => false, reflectEndpoints: () => [],
    checkRateLimit: () => false, proxyRequest: proxy.proxyRequest, proxyWebSocket: jest.fn(),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise((resolve, rejectRequest) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/chat/completions',
        headers: { 'content-type': 'application/json' },
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
      });
      req.on('error', rejectRequest);
      req.end('{"model":"coding","messages":[]}');
    });
    expect(result.status).toBe(constrained ? 400 : 200);
    expect(requests).toHaveLength(constrained ? 0 : 1);
    if (constrained) {
      expect(result.body.error).toMatchObject({
        code: 'model_harness_incompatible', model: 'copilot/gpt-6-sol',
        reasons: [expect.objectContaining({ code: 'harness_incompatible' })],
      });
      expect(handledRequest.awfAliasEligibilityRejection).toMatchObject({
        requestedModel: 'coding', provider: 'copilot', decision: { admitted: false },
      });
      expect(handledRequest.awfModelFallback).toBeUndefined();
    } else {
      expect(sent().model).toBe('gpt-6-sol');
      expect(handledRequest.awfAliasEligibilityRejection).toBeUndefined();
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.shutdownConnections();
  }
});

test('real HTTP requests use only the trusted pinned selected harness', async () => {
  const observedRequests = [];
  const adapter = {
    name: 'copilot', isEnabled: () => true, getTargetHost: () => 'api.githubcopilot.com',
    getAuthHeaders: req => { observedRequests.push(req); return {}; },
    getBasePath: () => '', getBodyTransform: () => null,
  };
  https.request.mockImplementation((options, callback) => {
    const outgoing = makeProxyReq();
    requests.push({ options, outgoing });
    setImmediate(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      callback(response);
      response.end('{"choices":[]}');
    });
    return outgoing;
  });
  const { createProviderServer } = require('./server-factory');
  const server = createProviderServer(adapter, {
    handleManagementEndpoint: () => false, reflectEndpoints: () => [],
    checkRateLimit: () => false, proxyRequest: proxy.proxyRequest, proxyWebSocket: jest.fn(),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const selectedHarness of ['aider', 'copilot']) {
      eligibility.proxyEligibilityStore.replaceTrustedEvidence({ ...evidence(), selectedHarness });
      const result = await new Promise((resolve, rejectRequest) => {
        const req = http.request({
          host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/chat/completions',
          headers: { 'content-type': 'application/json', 'x-awf-selected-harness': 'aider' },
        }, res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
        });
        req.on('error', rejectRequest);
        req.end('{"model":"gpt-6-sol","messages":[]}');
      });
      expect(result.status).toBe(selectedHarness === 'aider' ? 200 : 400);
      if (selectedHarness === 'copilot') {
        expect(result.body.error).toMatchObject({
          code: 'model_harness_incompatible', model: 'copilot/gpt-6-sol',
        });
      }
    }
    expect(requests).toHaveLength(1);
    expect(eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot', observedRequests[0]))
      .toMatchObject({ admitted: true, harness: 'unconstrained', selectedHarness: 'aider' });
    expect(eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot', observedRequests[1]))
      .toMatchObject({ admitted: false, harness: 'incompatible', selectedHarness: 'copilot' });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.shutdownConnections();
  }
});

test.each([
  ['gemini', '/v1beta/models/gemini%2Dpro:generateContent'],
  ['vertex', '/v1/projects/project/locations/us/publishers/google/models/gemini-pro:streamGenerateContent?alt=sse'],
])('explicit %s URL model harness requirements cannot be hidden by a different body model', async (provider, path) => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence('gemini-pro', provider));
  const req = makeReq(path);
  const res = makeRes();
  proxy.proxyRequest(req, res, 'generativelanguage.googleapis.com', {}, provider);
  req.emit('data', Buffer.from(JSON.stringify({ model: 'unconstrained-body-model', contents: [] })));
  req.emit('end');
  await flushPromises();
  expect(requests).toHaveLength(0);
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(JSON.parse(res.end.mock.calls[0][0]).error).toMatchObject({
    code: 'model_harness_incompatible', model: `${provider}/gemini-pro`, scope: scope(provider),
  });
});

test('unconstrained Gemini path models still forward unchanged without introducing pricing admission', async () => {
  const path = '/v1beta/models/opaque-deployment:generateContent';
  const req = makeReq(path);
  const res = makeRes();
  proxy.proxyRequest(req, res, 'generativelanguage.googleapis.com', {}, 'gemini');
  const body = Buffer.from('{"contents":[]}');
  req.emit('data', body);
  req.emit('end');
  await flushPromises();
  expect(requests).toHaveLength(1);
  expect(requests[0].options.path).toBe(path);
  expect(Buffer.concat(requests[0].outgoing.write.mock.calls.map(([chunk]) => chunk))).toEqual(body);
});

test.each([
  ['copilot', 'gpt-6-sol', '/responses?model=gpt-6-sol'],
  ['gemini', 'gemini-pro', '/v1beta/models/gemini%2Dpro:streamGenerateContent'],
])('readable %s WebSocket handshake models enforce the original pin without replaying or opening upstream', (provider, model, path) => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence(model, provider));
  const pin = eligibility.proxyEligibilityStore.pin();
  eligibility.proxyEligibilityStore.replaceTrustedEvidence({});
  const req = makeReq(path, { upgrade: 'websocket' });
  req.method = 'GET';
  req.awfEligibility = pin;
  const socket = { write: jest.fn(), destroy: jest.fn() };
  proxy.proxyWebSocket(req, socket, Buffer.alloc(0), 'api.githubcopilot.com', {}, provider);
  expect(req.awfEligibility).toBe(pin);
  expect(socket.write.mock.calls[0][0]).toContain('HTTP/1.1 400 Bad Request');
  expect(JSON.parse(socket.write.mock.calls[1][0]).error.code).toBe('model_harness_incompatible');
  expect(socket.destroy).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(0);
});

test.each([
  ['missing evidence', { observations: [] }],
  ['host evidence', { observations: [{
    name: 'copilot', version: '9.0.0', scope: scope(), environment: 'host', verified: true, actual: true,
  }] }],
  ['unverified evidence', { observations: [{
    name: 'copilot', version: '9.0.0', scope: scope(), environment: 'actual-agent', verified: false, actual: true,
  }] }],
  ['not actual evidence', { observations: [{
    name: 'copilot', version: '9.0.0', scope: scope(), environment: 'actual-agent', verified: true, actual: false,
  }] }],
])('%s cannot satisfy an applicable harness requirement', async (_label, overrides) => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence('gpt-6-sol', 'copilot', overrides));
  const { res } = await start();
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.reasons[0].code).toBe('harness_unverified');
});

test('caller headers and body cannot inject trusted harness observations', async () => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence('gpt-6-sol', 'copilot', { observations: [] }));
  const req = makeReq('/chat/completions', { 'x-awf-harness-version': '9.0.0' });
  const res = makeRes();
  proxy.proxyRequest(req, res, 'api.githubcopilot.com', {}, 'copilot');
  req.emit('data', Buffer.from(JSON.stringify({
    model: 'gpt-6-sol', observations: evidence().observations.map(item => ({ ...item, version: '9.0.0' })),
    executionEnvironment: 'actual-agent',
  })));
  req.emit('end');
  await flushPromises();
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_harness_incompatible');
});

test('harness rejection responses omit successful requirement diagnostics', () => {
  const facts = evidence();
  facts.models[0].harnesses.unshift({
    ...facts.models[0].harnesses[0], minimum: '1.0.0', excludedRanges: [],
  });
  const decision = eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot', {
    awfEligibility: eligibility.createProxyEligibilityStore(facts).pin(),
  });
  expect(decision.reasons.some(reason => reason.code === 'harness_compatible')).toBe(true);
  const envelope = eligibility.buildEligibilityError(decision);
  expect(envelope.error.reasons).toHaveLength(1);
  expect(envelope.error.reasons[0].code).toBe('harness_incompatible');
});

test.each([['1.3.2', false], ['1.4.0', true]])('actual harness version %s applies excluded ranges at the HTTP boundary', async (version, admitted) => {
  const facts = evidence();
  facts.observations[0].version = version;
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(facts);
  const { res } = await start();
  expect(requests).toHaveLength(admitted ? 1 : 0);
  if (!admitted) expect(JSON.parse(res.end.mock.calls[0][0]).error.reasons[0].detected).toBe(version);
});

test('constraints remain provider/channel/deployment scoped and unknown legacy models remain admitted', () => {
  const store = eligibility.createProxyEligibilityStore(evidence());
  const req = { awfEligibility: store.pin() };
  expect(eligibility.isModelEligible('gpt-6-sol', 'copilot', req)).toBe(false);
  expect(eligibility.isModelEligible('github-copilot/GPT-6-SOL?effort=high', 'copilot', req)).toBe(false);
  expect(eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot', req, { scope: { provider: 'openai' } }))
    .toMatchObject({ admitted: false, identity: { provider: 'copilot' }, scope: scope() });
  expect(eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot', {
    awfEligibility: req.awfEligibility, awfEligibilityScope: scope('openai'),
  })).toMatchObject({ admitted: false, identity: { provider: 'copilot' }, scope: scope() });
  expect(eligibility.isModelEligible('copilot/gpt-6-sol', 'copilot', req, { inputMode: 'native' })).toBe(true);
  expect(eligibility.isModelEligible('gpt-6-sol', 'openai', req)).toBe(true);
  expect(eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot', req,
    { scope: { channel: 'byok' } }).admitted).toBe(true);
  expect(eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot', req,
    { scope: { deployment: 'private' } }).admitted).toBe(true);
  expect(eligibility.evaluateModelEligibility('opaque-deployment', 'copilot', req)).toMatchObject({
    status: 'unknown', admitted: true, harness: 'unconstrained',
  });
});

test('trusted request scopes are captured immutably and cannot bleed into a different provider', () => {
  const facts = evidence();
  facts.models[0].harnesses[0].scope.deployment = 'private';
  const store = eligibility.createProxyEligibilityStore(facts);
  const trustedScope = { ...scope(), deployment: 'private' };
  const req = { awfEligibility: store.pin(), awfEligibilityScope: trustedScope };
  expect(eligibility.isModelEligible('gpt-6-sol', 'copilot', req)).toBe(false);
  trustedScope.deployment = 'public';
  expect(eligibility.isModelEligible('gpt-6-sol', 'copilot', req)).toBe(false);
  expect(Object.isFrozen(req.awfEligibilityScope)).toBe(true);
  expect(eligibility.isModelEligible('gpt-6-sol', 'openai', req)).toBe(true);
  expect(eligibility.isModelEligible('gpt-6-sol', 'copilot', { awfEligibility: store.pin() })).toBe(true);
});

test('adapter evidence cannot override route identity, scope or trusted harness observations', () => {
  const req = { awfEligibility: eligibility.createProxyEligibilityStore(evidence()).pin() };
  const otherIdentity = require('./model-identity').resolveModelIdentity('gpt-5.3-codex', 'openai').identity;
  const decision = eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot', req, {
    scope: { provider: 'openai' },
    evidence: {
      identity: otherIdentity, scope: scope('openai'), harnesses: [],
      observations: [{
        name: 'copilot', scheme: 'semver', version: '9.0.0', scope: scope(),
        environment: 'forged-agent', verified: true, actual: true,
      }],
      executionEnvironment: 'forged-agent',
      selectedHarness: 'aider',
    },
  });
  expect(decision).toMatchObject({
    admitted: false, harness: 'incompatible',
    identity: { key: 'copilot/gpt-6-sol', provider: 'copilot' }, scope: scope(),
  });
});

test('real HTTP selectors, resolver aliases and admission use the same trusted deployment scope', async () => {
  const privateScope = { ...scope(), deployment: 'private' };
  const identity = {
    key: 'copilot/real-model', provider: 'copilot', rawId: 'real-model', lookupId: 'real-model',
    aliases: [{ id: 'friendly-model', match: 'exact', scope: privateScope }],
  };
  jest.resetModules();
  jest.doMock('./model-information.naming.generated.json', () => ({ models: [{ identity }], rules: [] }));
  eligibility = require('./model-eligibility');
  proxy = require('./proxy-request');
  const { makeModelBodyTransform } = require('./model-config');
  const transform = makeModelBodyTransform('copilot', { copilot: ['real-model'] },
    async () => {}, null, () => []);
  await start('friendly-model', 'copilot', transform, privateScope);
  expect(sent().model).toBe('real-model');
  await start('friendly-model', 'copilot', transform);
  expect(sent(1).model).toBe('friendly-model');
  const { resolveModel } = require('./model-resolver');
  expect(resolveModel('friendly-model', {}, { copilot: ['real-model'] }, 'copilot', [],
    { enabled: false }, null, true, { blocked: false }, { awfEligibilityScope: privateScope }))
    .toMatchObject({ resolvedModel: 'real-model', matchKind: 'alias' });
  expect(resolveModel('friendly-model', {}, { copilot: ['real-model'] }, 'copilot', [],
    { enabled: false })).toBeNull();
  eligibility.proxyEligibilityStore.replaceTrustedEvidence({
    models: [{ identity, harnesses: [{
      name: 'copilot', scheme: 'semver', minimum: '1.2.0', scope: privateScope,
      reason: 'Fixture requires the private deployment harness',
      provenance: { authority: 'maintained', source: 'fixture' },
    }] }],
  });
  const { res } = await start('friendly-model', 'copilot', transform, privateScope);
  expect(requests).toHaveLength(2);
  expect(JSON.parse(res.end.mock.calls[0][0]).error).toMatchObject({
    code: 'model_harness_incompatible', model: 'copilot/real-model', scope: privateScope,
  });
});

test('explicit unknown models still forward unchanged without pricing admission changes', async () => {
  await start('opaque-deployment');
  expect(requests).toHaveLength(1);
  expect(sent().model).toBe('opaque-deployment');
});

test.each(['?effort=high', '/opaque'])('opaque explicit model %s does not produce an empty harness incompatibility error', async model => {
  const { res } = await start(model, 'openai');
  expect(requests).toHaveLength(1);
  expect(sent().model).toBe(model);
  expect(res.end).not.toHaveBeenCalled();
});

test('a later trusted refresh cannot change a request already waiting for its body', async () => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  const req = makeReq('/chat/completions');
  const res = makeRes();
  proxy.proxyRequest(req, res, 'api.githubcopilot.com', {}, 'copilot');
  const pin = req.awfEligibility;
  eligibility.proxyEligibilityStore.replaceTrustedEvidence({});
  req.emit('data', Buffer.from(JSON.stringify({ model: 'gpt-6-sol', messages: [] })));
  req.emit('end');
  await flushPromises();
  expect(req.awfEligibility).toBe(pin);
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_harness_incompatible');
  await start();
  expect(requests).toHaveLength(1);
});

test('existing model policy rejection keeps precedence over a harness failure', async () => {
  process.env.AWF_DISALLOWED_MODELS = '["gpt-6-sol"]';
  jest.resetModules();
  eligibility = require('./model-eligibility');
  proxy = require('./proxy-request');
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  const { res } = await start();
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.type).toBe('model_policy_violation');
  expect(eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot').reasons)
    .toContainEqual(expect.objectContaining({ code: 'policy_denied', scope: scope() }));
});

test('a policy-denied display alias retains the existing canonical model-policy error', async () => {
  process.env.AWF_DISALLOWED_MODELS = '["gpt-6-sol"]';
  process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { 'Coding Model': ['copilot/gpt-6-sol'] } });
  jest.resetModules();
  eligibility = require('./model-eligibility');
  proxy = require('./proxy-request');
  const { makeModelBodyTransform } = require('./model-config');
  const transform = makeModelBodyTransform('copilot', { copilot: ['gpt-6-sol'] },
    async () => {}, null, () => []);
  const { res } = await start('Coding Model', 'copilot', transform);
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error).toMatchObject({
    type: 'model_policy_violation', model: 'gpt-6-sol',
  });
});

test('existing lifecycle and positive discovery evidence use the shared admission decision', () => {
  expect(eligibility.evaluateModelEligibility('gpt-5-codex', 'copilot')).toMatchObject({
    admitted: false, status: 'incompatible',
    reasons: expect.arrayContaining([expect.objectContaining({ code: 'lifecycle_retired' })]),
  });
  expect(eligibility.evaluateModelEligibility('copilot/gpt-5-codex', 'copilot', {}, { inputMode: 'native' }))
    .toMatchObject({ admitted: true, status: 'unknown' });
  const req = {
    awfModelCatalogAuthoritative: true, awfRuntimePricing: { copilot: [record('gpt-6-sol')] },
  };
  expect(eligibility.evaluateModelEligibility('gpt-6-sol', 'copilot', req)).toMatchObject({
    admitted: true, status: 'eligible', harness: 'unconstrained',
  });
  expect(eligibility.evaluateModelEligibility('opaque-deployment', 'copilot', req)).toMatchObject({
    admitted: true, status: 'unknown',
  });
});

test.each([undefined, { ...scope(), deployment: 'private' }])(
  'the existing recovery boundary interprets authoritative Copilot absence in scope %j', eligibilityScope => {
    const { getModelUnavailability } = require('./model-recovery');
    const pin = eligibility.proxyEligibilityStore.pin();
    const evaluate = jest.fn(input => pin.evaluate(input));
    const req = {
      url: '/chat/completions', awfModelCatalogAuthoritative: true,
      awfRuntimePricing: { copilot: [record('available')] },
      awfEligibility: { revision: pin.revision, evaluate },
      awfEligibilityScope: eligibilityScope,
    };
    expect(getModelUnavailability('missing', 'copilot', req)).toEqual({ reason: 'model_unavailable' });
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({
      discovery: { status: 'unavailable', authoritative: true, scope: eligibilityScope || scope() },
      policy: expect.objectContaining({ status: 'allow' }),
    }));
    req.awfModelRecoveryDisabled = true;
    expect(getModelUnavailability('missing', 'copilot', req)).toBeNull();
    req.awfModelRecoveryDisabled = false;
    req.awfModelCatalogAuthoritative = false;
    expect(getModelUnavailability('missing', 'copilot', req)).toBeNull();
  },
);

test('selector aliases and resolver automatic candidates skip incompatible models', () => {
  const req = { awfEligibility: eligibility.createProxyEligibilityStore(evidence()).pin() };
  const { resolveModelSelector } = require('./model-selector');
  const { resolveModel } = require('./model-resolver');
  const aliases = { 'Coding Model': ['copilot/gpt-6-sol', 'copilot/gpt-5.3-codex'] };
  const ids = ['gpt-6-sol', 'gpt-5.3-codex'];
  expect(resolveModelSelector('Coding Model', 'copilot', ids, [], aliases, null, req).resolvedModel)
    .toBe('gpt-5.3-codex');
  expect(resolveModel('Coding Model', aliases, { copilot: ids }, 'copilot', [],
    { enabled: false }, null, true, { blocked: false }, req).resolvedModel).toBe('gpt-5.3-codex');
  const recursiveAliases = { 'Coding Model': ['Nested Model'], 'Nested Model': aliases['Coding Model'] };
  const recursive = resolveModelSelector('Coding Model', 'copilot', ids, [], recursiveAliases, null, req);
  expect(recursive.resolvedModel).toBe('gpt-5.3-codex');
  expect(recursive.candidates).toEqual(['gpt-5.3-codex']);
  expect(resolveModel('gpt-6-sol', aliases, { copilot: ids }, 'copilot', [],
    { enabled: true }, null, true, { blocked: false }, req)).toMatchObject({
    resolvedModel: 'gpt-6-sol', candidates: ['gpt-6-sol'], eligibilityDecision: { admitted: false },
  });
});

test('a same-named alias cannot redirect an explicitly available incompatible exact ID', async () => {
  process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { 'gpt-6-sol': ['copilot/gpt-5.3-codex'] } });
  jest.resetModules();
  eligibility = require('./model-eligibility');
  proxy = require('./proxy-request');
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  const { makeModelBodyTransform } = require('./model-config');
  const ids = ['gpt-6-sol', 'gpt-5.3-codex'];
  const transform = makeModelBodyTransform('copilot', { copilot: ids },
    async () => {}, null, () => []);
  const { res } = await start('gpt-6-sol', 'copilot', transform);
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error).toMatchObject({
    code: 'model_harness_incompatible', model: 'copilot/gpt-6-sol',
  });
  const { resolveModel } = require('./model-resolver');
  const direct = resolveModel('gpt-6-sol', { 'gpt-6-sol': ['copilot/gpt-5.3-codex'] },
    { copilot: ids }, 'copilot', [], { enabled: true }, null, true, { blocked: false },
    { awfEligibility: eligibility.proxyEligibilityStore.pin() });
  expect(direct).toMatchObject({
    resolvedModel: 'gpt-6-sol', candidates: ['gpt-6-sol'], aliasKeys: [],
    eligibilityDecision: { admitted: false, harness: 'incompatible' },
  });
});

test.each([
  { coding: ['openai/gpt-6-sol'] },
  { coding: ['blocked-child', 'openai/missing-*'], 'blocked-child': ['openai/gpt-6-sol'] },
])('harness-rejected genuine alias matches cannot activate default middle-power fallback: %j', aliases => {
  const { resolveModel } = require('./model-resolver');
  const req = { awfEligibility: eligibility.createProxyEligibilityStore(evidence('gpt-6-sol', 'openai')).pin() };
  const state = { blocked: false };
  expect(resolveModel('coding', aliases, { openai: ['gpt-6-sol', 'gpt-5.3-codex'] },
    'openai', [], undefined, null, true, state, req)).toBeNull();
  expect(state.blocked).toBe(true);
});

test('admission continues to a genuine compatible sibling but retains fallback for genuinely missing aliases', () => {
  const { resolveModel } = require('./model-resolver');
  const req = { awfEligibility: eligibility.createProxyEligibilityStore(evidence('gpt-6-sol', 'openai')).pin() };
  const inventory = { openai: ['gpt-6-sol', 'gpt-5.3-codex'] };
  expect(resolveModel('coding', { coding: ['openai/gpt-6-sol', 'openai/gpt-5.3-codex'] },
    inventory, 'openai', [], undefined, null, true, { blocked: false }, req))
    .toMatchObject({ resolvedModel: 'gpt-5.3-codex', fallback: { activated: false } });
  expect(resolveModel('coding', { coding: ['openai/missing-*'] },
    inventory, 'openai', [], undefined, null, true, { blocked: false }, req))
    .toMatchObject({ resolvedModel: 'gpt-5.3-codex', fallback: { activated: true } });
});

test('harness rejection of genuine family-version matches cannot synthesize an unrelated replacement', () => {
  const { resolveModel } = require('./model-resolver');
  const req = { awfEligibility: eligibility.createProxyEligibilityStore(evidence('gpt-5.9', 'openai')).pin() };
  const state = { blocked: false };
  expect(resolveModel('gpt-5.8', {}, { openai: ['gpt-5.9', 'unrelated'] },
    'openai', [], undefined, null, true, state, req)).toBeNull();
  expect(state.blocked).toBe(true);
});

test('advertised display-name selection checks shared eligibility and rejects through the ordered HTTP guard', async () => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  const { makeModelBodyTransform } = require('./model-config');
  const transform = makeModelBodyTransform('copilot', { copilot: ['gpt-6-sol'] },
    async () => {}, null, () => [{ id: 'gpt-6-sol', displayName: 'Advertised Model' }]);
  const { req, res } = await start('Advertised Model', 'copilot', transform);
  expect(req.awfSelectedModelEligibility).toMatchObject({
    model: 'gpt-6-sol', decision: { admitted: false, harness: 'incompatible' },
  });
  expect(Object.isFrozen(req.awfSelectedModelEligibility.decision)).toBe(true);
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error).toMatchObject({
    code: 'model_harness_incompatible', model: 'copilot/gpt-6-sol',
  });
});

test('HTTP selector aliases use the ingress pin', async () => {
  process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: {
    'Coding Model': ['copilot/gpt-6-sol', 'copilot/gpt-5.3-codex'],
  } });
  // model-config is loaded by the production body pipeline, so reload with the alias config.
  jest.resetModules();
  eligibility = require('./model-eligibility');
  proxy = require('./proxy-request');
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  const { makeModelBodyTransform } = require('./model-config');
  const transform = makeModelBodyTransform('copilot', {
    copilot: ['gpt-6-sol', 'gpt-5.3-codex'],
  }, async () => {}, null, () => []);
  await start('Coding Model', 'copilot', transform);
  expect(sent().model).toBe('gpt-5.3-codex');
});

test.each([false, true])('automatic Responses picker (provider-scoped=%s) skips a harness-incompatible candidate', async scoped => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence('gpt-5.4-codex'));
  const { makeModelBodyTransform } = require('./model-config');
  const records = ['gpt-5.4-codex', 'gpt-5.3-codex'].map(id => ({
    id, supportedEndpoints: ['/responses'],
  }));
  const transform = makeModelBodyTransform('copilot', {
    copilot: records.map(record => record.id),
  }, async () => {}, null, () => records, true);
  const req = { method: 'POST', url: '/responses' };
  const result = await transform(Buffer.from(JSON.stringify({
    model: 'auto', ...(scoped ? { model_provider: 'openai' } : {}),
    input: 'hello', tools: [{ type: 'custom', name: 'apply_patch' }],
  })), req);
  expect(JSON.parse(result).model).toBe('gpt-5.3-codex');
  expect(req.awfModelCandidates).toEqual(['gpt-5.3-codex']);
});

test('automatic picker refresh does not repin and exhausts through its existing actionable error', async () => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence('gpt-5.4-codex'));
  const { makeModelBodyTransform } = require('./model-config');
  const refresh = jest.fn(async () => eligibility.proxyEligibilityStore.replaceTrustedEvidence({}));
  const transform = makeModelBodyTransform('copilot', {
    copilot: ['gpt-5.4-codex'],
  }, refresh, null, () => [{ id: 'gpt-5.4-codex', supportedEndpoints: ['/responses'] }], true);
  await expect(transform(Buffer.from('{"model":"auto","input":"hello"}'), {
    method: 'POST', url: '/responses',
  })).rejects.toMatchObject({ statusCode: 503, code: 'copilot_auto_responses_model_unavailable' });
  expect(refresh).toHaveBeenCalledTimes(1);
});

test.each([false, true])('missing discovery preserves automatic picker unavailable errors (provider-scoped=%s)', async scoped => {
  const { makeModelBodyTransform } = require('./model-config');
  const refresh = jest.fn();
  const transform = makeModelBodyTransform('copilot', { copilot: null },
    refresh, null, () => null, true);
  await expect(transform(Buffer.from(JSON.stringify({
    model: 'auto', ...(scoped ? { model_provider: 'openai' } : {}), input: 'hello',
  })), { method: 'POST', url: '/responses' })).rejects.toMatchObject({
    statusCode: 503,
    code: scoped ? 'scoped_auto_model_unavailable' : 'copilot_auto_responses_model_unavailable',
  });
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('an explicit constrained model cannot escape through family fallback or preflight recovery', async () => {
  process.env.AWF_MODEL_ALIASES = JSON.stringify({ models: { coding: ['copilot/gpt-*'] } });
  jest.resetModules();
  eligibility = require('./model-eligibility');
  proxy = require('./proxy-request');
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  require('./runtime-model-catalog').replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  const { makeModelBodyTransform } = require('./model-config');
  const transform = makeModelBodyTransform('copilot', {
    copilot: ['gpt-5.3-codex'],
  }, async () => {}, null, () => []);
  const { res } = await start('gpt-6-sol', 'copilot', transform);
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_harness_incompatible');
});

test('routing candidates exclude incompatible models and exhaust through the existing no_route error', () => {
  const { buildRoutingCandidates } = require('./routing-candidates');
  const req = { awfEligibility: eligibility.createProxyEligibilityStore(evidence()).pin() };
  const catalogue = {
    provider: 'copilot', configured: true, discovery: 'complete',
    models: ['gpt-6-sol', 'gpt-5.3-codex'].map(id => ({
      id, efforts: ['low'], protocols: ['responses'], contextWindow: 128_000,
    })),
  };
  expect(buildRoutingCandidates({ catalogue, eligibilityRequest: req }).choices.map(item => item.model))
    .toEqual(['github-copilot/gpt-5.3-codex']);
  catalogue.models.pop();
  expect(() => buildRoutingCandidates({ catalogue, eligibilityRequest: req })).toThrow(
    'No available model and effort is supported',
  );
});

test('the production classifier executor uses the controller pin rather than refreshed evidence', async () => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  const pin = eligibility.proxyEligibilityStore.pin();
  eligibility.proxyEligibilityStore.replaceTrustedEvidence({});
  const { createRoutingProviderExecutor } = require('./routing-provider-executor');
  const executor = createRoutingProviderExecutor({
    getAdapter: () => ({
      name: 'copilot', isEnabled: () => true, getRoutingProviderIdentity: () => 'github-copilot',
      getTargetHost: () => 'api.githubcopilot.com', getAuthHeaders: () => ({}), getBasePath: () => '',
    }),
    proxyRequest: proxy.proxyRequest, checkRateLimit: () => false,
  });
  const result = await executor.execute({
    provider: 'copilot', purpose: 'routing_classification', path: '/chat/completions',
    body: { model: 'gpt-6-sol', messages: [] }, awfEligibility: pin,
  });
  expect(result).toMatchObject({
    statusCode: 400, terminal: { code: 'model_harness_incompatible' },
  });
  expect(requests).toHaveLength(0);
});

test('automatic HTTP recovery skips unmet harness candidates while preserving protocol compatibility', async () => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  require('./runtime-model-catalog').replaceRuntimeModels('copilot', [
    record('gpt-6-sol'), record('gpt-5.3-codex'),
  ]);
  await start('missing-model');
  expect(sent().model).toBe('gpt-5.3-codex');
});

test('upstream recovery candidates retain the pin while later requests see refreshed evidence', async () => {
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence());
  const catalog = require('./runtime-model-catalog');
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('gpt-6-sol'), record('gpt-5.3-codex')]);
  const { req } = await start('primary');
  const pin = req.awfEligibility;
  eligibility.proxyEligibilityStore.replaceTrustedEvidence({});
  await reject(0);
  expect(sent(1).model).toBe('gpt-5.3-codex');
  expect(req.awfEligibility).toBe(pin);
  await start('gpt-6-sol');
  expect(sent(2).model).toBe('gpt-6-sol');
});

test('ordered cross-provider fallback skips incompatible targets and retains the original pin through transforms', async () => {
  process.env.AWF_FALLBACK_MODELS = 'openai/gpt-6-sol,openai/next';
  eligibility.proxyEligibilityStore.replaceTrustedEvidence(evidence('gpt-6-sol', 'openai'));
  const transform = jest.fn(async (_body, req) => {
    expect(req.awfEligibility).toBe(origin.req.awfEligibility);
    expect(req.awfEligibilityScope).toBe(origin.req.awfEligibilityScope);
    expect(Object.isFrozen(req.awfEligibilityScope)).toBe(true);
    expect(req.awfCatalogue).toBe(origin.req.awfCatalogue);
    return null;
  });
  proxy.configureFallbackProviders({ getAdapter: provider => provider === 'openai' ? {
    name: 'openai', isEnabled: () => true, getTargetHost: () => 'api.openai.com',
    getBasePath: () => '', getAuthHeaders: () => ({}), getBodyTransform: () => transform,
  } : null });
  const origin = await start('primary', 'copilot', null, scope('openai'));
  eligibility.proxyEligibilityStore.replaceTrustedEvidence({});
  await reject(0, 503, 'overloaded');
  expect(requests).toHaveLength(2);
  expect(requests[1].options.hostname).toBe('api.openai.com');
  expect(sent(1).model).toBe('next');
  expect(transform).toHaveBeenCalledTimes(1);
});
