'use strict';

const { EventEmitter } = require('node:events');
const { createModelDecisionObservation } = require('./model-decision-observation');
const { projectModelDecisionDiagnostics, validateDiagnostics } = require('./model-decision-diagnostics');
const { CONTRACTS, FEATURES, REVISION } = require('./protocol-compatibility');
const { REASON_CODES, ASSESSMENT_REVISION } = require('./protocol-compatibility/assessment');
const schema = require('./model-decision-diagnostics.schema.json');

const catalogueRevision = 'a'.repeat(64);
const inventory = { copilot: ['original-model'], openai: ['candidate-model'] };
const options = { context: 'primary-agent', getModels: () => inventory };

function assessment(status = 'compatible') {
  return {
    status, source: 'chat_completions', target: 'responses',
    revision: REVISION, assessmentRevision: 'awf-fallback-assessment-v1',
    features: ['message_text', 'reasoning_fields'],
    reasons: status === 'compatible' ? []
      : [{ feature: 'message_text', code: status === 'incompatible' ? 'content_loss' : 'condition_unverified' }],
    contracts: [CONTRACTS[0]],
    candidate: { provider: 'openai', model: 'candidate-model' },
    pins: { eligibilityRevision: 3, catalogueRevision },
    reasoning: { support: 'supported', mode: 'optional', code: 'reasoning_effort_accepted' },
  };
}

function record(overrides = {}) {
  return {
    provider: 'openai', model: 'candidate-model', endpoint: '/chat/completions',
    originProvider: 'copilot', originModel: 'original-model',
    outcome: 'accepted', reason: 'fallback_compatible', compatibility: assessment(),
    eligibilityRevision: 3, catalogueRevision, ...overrides,
  };
}

function request(observer, { req: extra = {}, host = 'api.githubcopilot.com',
  provider = 'copilot' } = {}) {
  const req = { method: 'POST', url: '/chat/completions', ...extra };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.end = jest.fn(() => res);
  const originalEnd = res.end;
  const dispatch = jest.fn(() => 'original-result');
  expect(observer.wrapProxyRequest(dispatch)(req, res, host, {}, provider)).toBe('original-result');
  return { req, res, dispatch, originalEnd };
}

function project(observer, models = inventory) {
  return projectModelDecisionDiagnostics({
    endpoints: Object.entries(models).map(([provider, models]) => ({ provider, models, configured: true })),
    models_fetch_complete: true,
  }, { context: 'primary-agent', recent: observer.getRecent() });
}

test('explicit production decisions publish on upstream finish, never by reading provider responses', () => {
  const observer = createModelDecisionObservation(options);
  const { req, res, originalEnd } = request(observer);
  req.awfObserveModelDecision(record({
    outcome: 'skipped', reason: 'fallback_incompatible', compatibility: assessment('incompatible'),
  }));
  req.awfObserveModelDecision(record());
  expect(observer.getRecent()).toEqual([]);
  const bytes = Buffer.from('upstream provider prompt/tool/credential data');
  const callback = jest.fn();
  res.awfUpstreamResponse = true;
  expect(res.end(bytes, 'utf8', callback)).toBe(res);
  expect(originalEnd).toHaveBeenCalledWith(bytes, 'utf8', callback);
  res.emit('finish');
  const diagnostics = project(observer);
  expect(diagnostics.recent.decisions).toHaveLength(2);
  expect(diagnostics.recent.decisions[0]).toMatchObject({
    reason: 'fallback_incompatible', status: 'rejected',
    identity: { provider: 'openai', model_id: 'candidate-model' },
    origin: { provider: 'copilot', model_id: 'original-model' },
    scope: { context: 'primary-agent', endpoint: '/chat/completions' },
    action: { kind: 'change_request', retry: 'do_not_repeat' },
    compatibility: { outcome: 'skipped', status: 'incompatible' },
  });
  expect(diagnostics.recent.decisions[1]).toMatchObject({
    reason: 'fallback_compatible', status: 'observed', action: { kind: 'none', retry: 'not_applicable' },
    compatibility: {
      outcome: 'accepted', status: 'compatible', return_conditions: 'provider_response_unobserved',
      contract_revision: REVISION, assessment_revision: 'awf-fallback-assessment-v1',
      pins: { eligibility_revision: 3, catalogue_revision: catalogueRevision },
      contracts: [{ id: CONTRACTS[0].id, implementation: CONTRACTS[0].implementation }],
    },
    reasoning: {
      support: 'supported', mode: 'optional', reason: 'reasoning_effort_accepted',
      pins: { eligibility_revision: 3, catalogue_revision: catalogueRevision },
    },
  });
  expect(diagnostics.recent.decisions[1].reasoning).not.toHaveProperty('selected_evidence');
  expect(JSON.stringify(diagnostics)).not.toContain('prompt/tool/credential');
  expect(validateDiagnostics(diagnostics)).toBe(true);
});

test('unverified and exhausted outcomes give no replacement, invented rejected candidate, or retry guarantee', () => {
  const observer = createModelDecisionObservation(options);
  const { req, res } = request(observer);
  req.awfObserveModelDecision(record({
    outcome: 'skipped', reason: 'fallback_unverified', compatibility: assessment('unverified'),
  }));
  req.awfObserveModelDecision(record({
    outcome: 'exhausted', reason: 'fallback_exhausted', model: 'original-model', compatibility: null,
  }));
  res.awfUpstreamResponse = true;
  res.emit('finish');
  const [unknown, exhausted] = project(observer).recent.decisions;
  expect(unknown).toMatchObject({
    status: 'unknown', action: { kind: 'operator_required', retry: 'after_operator_change' },
  });
  expect(exhausted).toMatchObject({
    identity: { provider: null, model_id: null },
    origin: { provider: 'copilot', model_id: 'original-model' },
    action: { kind: 'change_request', retry: 'do_not_repeat' },
  });
  expect(exhausted).not.toHaveProperty('compatibility');
  expect(exhausted).not.toHaveProperty('reasoning');
});

test('sanitization precedes pending retention and neither later public inventory nor policy can reveal hidden identities', () => {
  let models = { copilot: ['original-model'], openai: ['hidden-model', 'candidate-model'] };
  const policy = { disallowedModels: ['hidden-*'] };
  const observer = createModelDecisionObservation({
    ...options, getModels: () => models, modelPolicy: policy,
  });
  const { req, res } = request(observer);
  const supplied = record({ model: 'hidden-model', originModel: 'undiscovered-original' });
  supplied.compatibility.candidate = { provider: 'openai', model: 'hidden-model' };
  supplied.compatibility.features.push('https://private.invalid/tool');
  supplied.compatibility.reasons.push(
    { feature: 'function_tools', code: 'private_prompt_tool_name' },
    { feature: 'private_feature', code: 'content_loss' },
  );
  supplied.compatibility.contracts.push({
    id: 'private-contract', revision: 'private-revision',
    implementation: { file: '/private/path', sha256: 'b'.repeat(64) },
  });
  supplied.reasoning = {
    support: 'supported', mode: 'optional', code: 'reasoning_effort_accepted',
    identity: { key: 'openai/hidden-model', provider: 'openai', rawId: 'hidden-model' },
    scope: { provider: 'openai', channel: 'native-api' },
    observations: [
      { selected: true, authority: 'provider', rawEfforts: ['private-effort'],
        provenance: { source: 'provider-model-list', field: 'supportedReasoningEfforts',
          revision: 'private-id', at: 'private-date', apiVersion: 'private-api',
          credential: 'private-credential', url: 'https://private.invalid' } },
      { selected: false, authority: 'provider', provenance: { source: 'provider-model-list' } },
      { selected: true, authority: 'maintained', provenance: { source: 'https://private.invalid' } },
    ],
  };
  supplied.headers = { authorization: 'private-credential' };
  req.awfObserveModelDecision(supplied);
  supplied.compatibility.source = 'private-protocol';
  supplied.reasoning.support = 'unsupported';
  models = { copilot: ['undiscovered-original'], openai: ['hidden-model'] };
  policy.disallowedModels = [];
  res.emit('finish');
  const projected = project(observer, models);
  expect(projected.recent.decisions[0]).toMatchObject({
    identity: { model_id: null }, origin: { model_id: null },
    compatibility: { source: 'chat_completions', features: ['message_text', 'reasoning_fields'] },
    reasoning: { support: 'supported', selected_evidence: [{
      authority: 'provider', source: 'provider-model-list', field: 'supportedReasoningEfforts',
    }] },
  });
  for (const value of ['private-', 'private.invalid', 'hidden-model', 'undiscovered-original']) {
    expect(JSON.stringify(observer.getRecent())).not.toContain(value);
    expect(JSON.stringify(projected.recent)).not.toContain(value);
  }
});

test('only explicitly captured candidate identities may be named, not an alias or initial request selection', () => {
  const observer = createModelDecisionObservation(options);
  const { req, res } = request(observer, { req: {
    awfSelectedModelEligibility: { provider: 'copilot', decision: { identity: { rawId: 'original-model' } } },
    awfModelFallback: { model: 'candidate-model', requested_model: 'automatic-alias', provider: 'openai' },
  } });
  req.awfObserveModelDecision(record({ model: undefined }));
  res.emit('finish');
  expect(project(observer).recent.decisions[0]).toMatchObject({
    identity: { provider: 'openai', model_id: null },
    origin: { provider: 'copilot', model_id: 'original-model' },
  });
});

test.each(['provider/candidate-model', '/private/path', 'https://private.invalid/model',
  'candidate-model?credential=private', 'candidate-model@private'])(
  'qualified or opaque candidate identity %s is never retained', model => {
    const observer = createModelDecisionObservation({ ...options, getModels: () => ({
      ...inventory, openai: [model],
    }) });
    const { req, res } = request(observer);
    req.awfObserveModelDecision(record({ model }));
    res.emit('finish');
    expect(observer.getRecent()[0].model).toBeNull();
    expect(JSON.stringify(project(observer).recent)).not.toContain(model);
  },
);

test('current refresh can hide but cannot rewrite captured compatibility, reasoning, or pin histories', () => {
  const observer = createModelDecisionObservation(options);
  const { req, res } = request(observer);
  req.awfObserveModelDecision(record());
  res.emit('finish');
  const initial = observer.getRecent();
  const exported = observer.getRecent();
  exported[0].compatibility.contracts[0].implementation.sha256 = 'b'.repeat(64);
  exported[0].reasoning.pins.eligibility_revision = 900;
  const changed = project(observer, {});
  expect(changed.recent.decisions[0]).toMatchObject({ identity: { model_id: null } });
  expect(changed.recent.decisions[0].compatibility).toEqual(initial[0].compatibility);
  expect(changed.recent.decisions[0].reasoning).toEqual(initial[0].reasoning);
  expect(observer.getRecent()).toEqual(initial);
});

test('unfinished, closed and excluded request contexts cannot contribute production observations', () => {
  const observer = createModelDecisionObservation(options);
  for (const cfg of [
    { req: { awfCaller: { purpose: 'subagent', agent_name: 'private-session' } } },
    { req: { awfRequestContext: { purpose: 'routing_classification' } } },
    { req: { awfEligibilityScope: { deployment: 'https://private.invalid' } } },
    { req: { awfReasoning: { scope: { deployment: 'https://private.invalid' } } } },
    { host: 'private.azure.invalid' },
    { req: { method: 'GET' } },
    { req: { url: '/private/endpoint?credential=private' } },
  ]) {
    const { req, res } = request(observer, cfg);
    expect(req.awfObserveModelDecision).toBeUndefined();
    res.emit('finish');
  }
  const { req, res } = request(observer);
  req.awfObserveModelDecision(record());
  expect(observer.getRecent()).toEqual([]);
  res.emit('close');
  req.awfObserveModelDecision(record());
  res.emit('finish');
  expect(observer.getRecent()).toEqual([]);
  const dedicated = createModelDecisionObservation({ ...options, context: 'dedicated-enclave' });
  const excluded = request(dedicated);
  expect(excluded.req.awfObserveModelDecision).toBeUndefined();
  expect(dedicated.getRecent()).toBeNull();
});

test('independent observers never share request decisions or refreshed session histories', () => {
  const first = createModelDecisionObservation(options);
  const second = createModelDecisionObservation(options);
  const { req, res } = request(first);
  req.awfObserveModelDecision(record());
  res.emit('finish');
  expect(first.getRecent()).toHaveLength(1);
  expect(second.getRecent()).toEqual([]);
  expect(createModelDecisionObservation(options).getRecent()).toEqual([]);
});

test('candidate-specific deployment scopes and contexts changed before finish cannot enter primary history', () => {
  const observer = createModelDecisionObservation(options);
  for (const scope of [
    { provider: 'openai', channel: 'native-api', deployment: 'https://private.invalid' },
    { provider: 'copilot', channel: 'copilot-api' },
    { provider: 'openai', channel: 'copilot-api' },
  ]) {
    const { req, res } = request(observer);
    req.awfObserveModelDecision(record({
      reasoning: { support: 'supported', mode: 'optional', code: 'reasoning_effort_accepted', scope },
    }));
    res.emit('finish');
  }
  const { req, res } = request(observer);
  req.awfObserveModelDecision(record());
  req.awfCaller = { purpose: 'subagent', agent_name: 'private-session' };
  res.emit('finish');
  expect(observer.getRecent()).toEqual([]);
});

test('contradictory outcome, reason, endpoint and candidate claims never identify a rejected original', () => {
  const observer = createModelDecisionObservation({
    ...options, getModels: () => ({ ...inventory, openai: ['original-model', 'candidate-model'] }),
  });
  const { req, res } = request(observer);
  req.awfObserveModelDecision(record({ outcome: 'skipped' }));
  req.awfObserveModelDecision(record({ reason: 'fallback_exhausted' }));
  req.awfObserveModelDecision(record({ endpoint: '/responses' }));
  req.awfObserveModelDecision(record({ compatibility: assessment('incompatible') }));
  req.awfObserveModelDecision(record({ model: 'original-model' }));
  res.emit('finish');
  expect(observer.getRecent()).toHaveLength(1);
  expect(observer.getRecent()[0].model).toBeNull();
  expect(project(observer).recent.decisions[0].origin.model_id).toBe('original-model');
});

test.each([
  { provider: 'copilot', rawId: 'candidate-model', key: 'openai/candidate-model' },
  { provider: 'openai', rawId: 'original-model', key: 'openai/original-model' },
  { provider: 'openai', rawId: 'candidate-model', key: 'openai/original-model' },
])('pinned reasoning identity %p must exactly identify the candidate', identity => {
  const observer = createModelDecisionObservation(options);
  const { req, res } = request(observer);
  req.awfObserveModelDecision(record({ reasoning: {
    support: 'supported', mode: 'optional', code: 'reasoning_effort_accepted', identity,
    scope: { provider: 'openai', channel: 'native-api' },
  } }));
  res.emit('finish');
  expect(observer.getRecent()).toEqual([]);
});

test('arbitrary and stale known implementation hash pins cannot claim verified compatibility', () => {
  const observer = createModelDecisionObservation(options);
  for (const implementation of [
    { ...CONTRACTS[0].implementation, sha256: 'b'.repeat(64) },
    CONTRACTS.find(contract => contract.implementation.file === 'anthropic-chat-compat.js').implementation,
  ]) {
    const { req, res } = request(observer);
    req.awfObserveModelDecision(record({
      compatibility: { ...assessment(), contracts: [{ ...CONTRACTS[0], implementation }] },
    }));
    res.emit('finish');
  }
  expect(observer.getRecent()).toEqual([]);
});

test('scalar reasoning summaries cannot expose unpinned selected evidence or contradictory action reasons', () => {
  const observer = createModelDecisionObservation(options);
  const { req, res } = request(observer);
  req.awfObserveModelDecision(record({ reasoning: {
    support: 'supported', mode: 'optional', code: 'reasoning_effort_accepted',
    observations: [{ selected: true, authority: 'provider', provenance: { source: 'provider-model-list' } }],
  } }));
  req.awfObserveModelDecision(record({ eligibilityRevision: 4, reasoning: {
    support: 'unsupported', mode: 'forbidden', code: 'reasoning_effort_forbidden',
  } }));
  res.emit('finish');
  const [summary, contradictory] = project(observer).recent.decisions;
  expect(summary.reasoning).toMatchObject({ support: 'supported', mode: 'optional', reason: 'reasoning_effort_accepted' });
  expect(summary.reasoning).not.toHaveProperty('selected_evidence');
  expect(contradictory).not.toHaveProperty('reasoning');
});

test('production pending and retained decisions remain bounded, deduplicated, and expire', () => {
  let time = Date.parse('2026-11-08T12:00:00Z');
  const observer = createModelDecisionObservation({ ...options, now: () => time });
  const { req, res } = request(observer);
  for (let i = 0; i < 80; i++) req.awfObserveModelDecision(record({ eligibilityRevision: i }));
  res.emit('finish');
  expect(observer.getRecent()).toHaveLength(32);
  expect(observer.getRecent()[0].eligibilityRevision).toBe(48);
  for (let i = 0; i < 1100; i++) {
    const next = request(observer);
    next.req.awfObserveModelDecision(record({ eligibilityRevision: 79 }));
    next.res.emit('finish');
  }
  expect(observer.getRecent().at(-1).occurrences).toBe(1000);
  time += 901_000;
  expect(observer.getRecent()).toEqual([]);
});

test('optional compatibility and reasoning fields remain absent for older captured records', () => {
  const diagnostics = projectModelDecisionDiagnostics({ endpoints: [], models_fetch_complete: true }, {
    context: 'primary-agent', recent: [{ provider: 'copilot', reason: 'unsupported_reasoning_effort' }],
  });
  expect(diagnostics.recent.decisions[0]).not.toHaveProperty('compatibility');
  expect(diagnostics.recent.decisions[0]).not.toHaveProperty('reasoning');
  expect(diagnostics.recent.decisions[0]).not.toHaveProperty('origin');
});

test('new optional objects are strict and arbitrary feature, code, provenance, and contract paths are rejected', () => {
  const observer = createModelDecisionObservation(options);
  const { req, res } = request(observer);
  req.awfObserveModelDecision(record());
  res.emit('finish');
  const original = project(observer);
  for (const modify of [
    item => { item.compatibility.reasons.push({ feature: 'private-feature', code: 'content_loss' }); },
    item => { item.compatibility.reasons.push({ feature: 'message_text', code: 'private-code' }); },
    item => { item.compatibility.contracts[0].implementation.file = '/private/path'; },
    item => { item.reasoning.provenance = 'https://private.invalid'; },
    item => { item.origin.request_id = 'private-id'; },
  ]) {
    const diagnostics = structuredClone(original);
    modify(diagnostics.recent.decisions[0]);
    expect(validateDiagnostics(diagnostics)).toBe(false);
  }
});

test('every compatibility reason code is the evaluator allowlist, not arbitrary snake-case text', () => {
  expect([...schema.definitions.compatibility.properties.reasons.items.properties.code.enum].sort())
    .toEqual([...REASON_CODES].sort());
  const observer = createModelDecisionObservation(options);
  for (const code of REASON_CODES) {
    const { req, res } = request(observer);
    req.awfObserveModelDecision(record({
      outcome: 'skipped', reason: 'fallback_unverified',
      compatibility: { ...assessment('unverified'), reasons: [{ feature: 'unknown_fields', code }] },
    }));
    res.emit('finish');
    expect(observer.getRecent().at(-1).compatibility.reasons).toEqual([{ feature: 'unknown_fields', code }]);
  }
});

test('strict optional schema enums stay aligned with exported feature, contract and assessment pins', () => {
  expect(schema.definitions.feature.enum).toEqual(FEATURES);
  expect(schema.definitions.compatibility.properties.contracts.items.properties.id.enum)
    .toEqual(CONTRACTS.map(contract => contract.id));
  expect(schema.definitions.compatibility.properties.contract_revision.enum).toContain(REVISION);
  expect(schema.definitions.compatibility.properties.assessment_revision.enum).toContain(ASSESSMENT_REVISION);
});

describe('production upstream fallback observations', () => {
  const { createSendUpstreamRequest } = require('./upstream-http');
  const { replaceRuntimeModels, clearRuntimeModels } = require('./runtime-model-catalog');
  const { createProxyEligibilityStore } = require('./model-eligibility');

  afterEach(() => clearRuntimeModels());

  function production(chain, extra = {}, source = {
    model: 'original-model', input: 'PRIVATE_PROMPT',
    tools: [{ type: 'custom', name: 'PRIVATE_TOOL_NAME' }],
  }) {
    const models = { copilot: ['original-model', 'chat-only', 'native-responses', 'low-only', 'unknown-model', 'high-model'] };
    const observer = createModelDecisionObservation({ ...options, getModels: () => models });
    const { req, res } = request(observer, { req: { url: '/responses',
      awfEligibility: createProxyEligibilityStore().pin(), awfCatalogue: { revision: catalogueRevision },
      awfRequestedModelSelector: 'automatic-alias', ...extra } });
    const attempts = [];
    const responses = [];
    const send = createSendUpstreamRequest({
      https: { request: (_options, callback) => {
        const attempt = { callback };
        attempts.push(attempt);
        return { on: jest.fn(), end: jest.fn(), write: body => { attempt.body = JSON.parse(body); } };
      } },
      http: { request: jest.fn() }, proxyAgent: {},
      handleUpstreamResponse: (_response, _headers, context) => {
        res.awfUpstreamResponse = true;
        responses.push(context);
      },
      sleep: () => Promise.resolve(), otel: { endSpan: jest.fn(), endSpanError: jest.fn() },
      metrics: { gaugeDec: jest.fn(), gaugeInc: jest.fn(), increment: jest.fn(), observe: jest.fn() },
      handleRequestError: jest.fn(), getFallbackModels: () => chain,
      getProviderAdapter: () => null,
    });
    const body = Buffer.from(JSON.stringify(source));
    send({}, {
      req, res, provider: 'copilot', targetHost: 'api.githubcopilot.com',
      upstreamPath: '/responses', body, wireApiSourceBody: body,
      requestId: 'PRIVATE_IDENTIFIER', startTime: Date.now(), span: {}, requestBytes: body.length,
    });
    attempts[0].callback({ statusCode: 503, headers: {} });
    return { req, res, observer, models, attempts, responses };
  }

  test('actual dispatch skips a lossy wire candidate and captures the accepted native candidate on finish', () => {
    replaceRuntimeModels('copilot', [{ id: 'chat-only', supportedEndpoints: ['/chat/completions'] }]);
    const h = production(['chat-only', 'native-responses']);
    expect(h.responses[0].onModelFallback({ reason: 'upstream_5xx' })).toBe(true);
    expect(h.attempts.map(attempt => attempt.body.model)).toEqual(['original-model', 'native-responses']);
    expect(h.observer.getRecent()).toEqual([]);
    h.attempts[1].callback({ statusCode: 200, headers: {} });
    h.res.emit('finish');
    const decisions = project(h.observer, h.models).recent.decisions;
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      reason: 'fallback_incompatible', identity: { provider: 'copilot', model_id: 'chat-only' },
      origin: { provider: 'copilot', model_id: 'original-model' },
      compatibility: { source: 'responses', target: 'chat_completions', outcome: 'skipped',
        reasons: expect.arrayContaining([{ feature: 'hosted_tools', code: 'translator_rejected' }]) },
    });
    expect(decisions[1]).toMatchObject({
      reason: 'fallback_compatible', identity: { provider: 'copilot', model_id: 'native-responses' },
      scope: { endpoint: '/responses' }, compatibility: {
        outcome: 'accepted', status: 'compatible', return_conditions: 'not_applicable',
      },
      origin: { provider: 'copilot', model_id: 'original-model' },
    });
    for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_TOOL_NAME', 'PRIVATE_IDENTIFIER', 'automatic-alias']) {
      expect(JSON.stringify(h.observer.getRecent())).not.toContain(secret);
    }
  });

  test('actual exhausted dispatch names no rejected origin or last-attempt candidate as a replacement', () => {
    replaceRuntimeModels('copilot', [{ id: 'chat-only', supportedEndpoints: ['/chat/completions'] }]);
    const h = production(['chat-only']);
    const abandon = jest.fn();
    expect(h.responses[0].onModelFallback({ reason: 'upstream_5xx', abandon })).toBe(false);
    expect(h.attempts).toHaveLength(1);
    h.res.emit('finish');
    const decisions = project(h.observer, h.models).recent.decisions;
    expect(decisions.map(item => item.reason)).toEqual(['fallback_incompatible', 'fallback_exhausted']);
    expect(decisions[1]).toMatchObject({
      identity: { provider: null, model_id: null },
      origin: { provider: 'copilot', model_id: 'original-model' },
      action: { kind: 'change_request', retry: 'do_not_repeat' },
    });
  });

  describe('actual proxyRequest observation boundary', () => {
    const https = require('node:https');
    const { makeReq, makeProxyReq, makeProxyRes, flushPromises } = require('./test-helpers/server-mock-factories');
    const { replaceRuntimeModels, clearRuntimeModels } = require('./runtime-model-catalog');
    let proxy;
    let previousChain;

    beforeAll(() => {
      proxy = require('./proxy-request');
      proxy._setSleepForTests(() => Promise.resolve());
    });
    beforeEach(() => {
      previousChain = process.env.AWF_FALLBACK_MODELS;
      replaceRuntimeModels('copilot', [
        { id: 'original-model', supportedEndpoints: ['/responses'] },
        { id: 'chat-only', supportedEndpoints: ['/chat/completions'] },
        { id: 'native-responses', supportedEndpoints: ['/responses'] },
      ]);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      clearRuntimeModels();
      if (previousChain === undefined) delete process.env.AWF_FALLBACK_MODELS;
      else process.env.AWF_FALLBACK_MODELS = previousChain;
    });
    afterAll(() => proxy._resetSleepForTests());

    test.each([
      ['chat-only,native-responses', ['fallback_incompatible', 'fallback_compatible'], 200],
      ['chat-only', ['fallback_incompatible', 'fallback_exhausted'], 503],
    ])('native proxy request with chain %s retains finished production decisions', async (chain, reasons, status) => {
      process.env.AWF_FALLBACK_MODELS = chain;
      const models = { copilot: ['original-model', 'chat-only', 'native-responses'] };
      const observer = createModelDecisionObservation({ ...options, getModels: () => models });
      const attempts = [];
      jest.spyOn(https, 'request').mockImplementation((_options, callback) => {
        const upstream = makeProxyReq();
        attempts.push({ callback, upstream });
        return upstream;
      });
      const req = makeReq('/responses');
      const res = new EventEmitter();
      res.headersSent = false;
      res.statusCode = 200;
      res.setHeader = jest.fn();
      res.write = jest.fn();
      res.destroy = jest.fn();
      res.writeHead = jest.fn(code => { res.statusCode = code; res.headersSent = true; });
      res.end = jest.fn(() => res);
      observer.wrapProxyRequest(proxy.proxyRequest)(req, res, 'api.githubcopilot.com', {}, 'copilot');
      req.emit('data', Buffer.from(JSON.stringify({
        model: 'original-model', input: 'PRIVATE_PROMPT',
        tools: [{ type: 'web_search', name: 'PRIVATE_TOOL_NAME' }],
      })));
      req.emit('end');
      await flushPromises();
      expect(attempts).toHaveLength(1);
      function respond(index, code, body) {
        const upstream = makeProxyRes(code);
        attempts[index].callback(upstream);
        upstream.emit('data', Buffer.from(body));
        upstream.emit('end');
      }
      respond(0, 503, '{"error":"overloaded"}');
      await flushPromises();
      if (status === 200) {
        expect(attempts).toHaveLength(2);
        const written = attempts[1].upstream.write.mock.calls.map(([chunk]) => chunk);
        expect(JSON.parse(Buffer.concat(written)).model).toBe('native-responses');
        respond(1, 200, '{"ok":true}');
        await flushPromises();
      } else expect(attempts).toHaveLength(1);
      expect(res.statusCode).toBe(status);
      expect(observer.getRecent()).toEqual([]);
      res.emit('finish');
      const decisions = project(observer, models).recent.decisions;
      expect(decisions.map(item => item.reason)).toEqual(reasons);
      expect(decisions[0]).toMatchObject({
        identity: { provider: 'copilot', model_id: 'chat-only' },
        origin: { provider: 'copilot', model_id: 'original-model' },
        scope: { endpoint: '/responses', context: 'primary-agent' },
      });
      if (status === 503) expect(decisions[1]).toMatchObject({
        identity: { provider: null, model_id: null },
        action: { kind: 'change_request', retry: 'do_not_repeat' },
      });
      expect(JSON.stringify(observer.getRecent())).not.toContain('PRIVATE_PROMPT');
      expect(JSON.stringify(decisions)).not.toContain('PRIVATE_TOOL_NAME');
    });
  });

  test('actual automatic effort admission exposes the captured shared decision and exact pins, not replayed advertisements', () => {
    const h = production(['low-only', 'unknown-model', 'high-model'], {
      awfRuntimePricing: { copilot: [
        { id: 'original-model', supportedReasoningEfforts: ['high'] },
        { id: 'low-only', supportedReasoningEfforts: ['low'] },
        { id: 'high-model', supportedReasoningEfforts: ['high'] },
      ] },
    }, { model: 'original-model', input: 'PRIVATE_PROMPT', reasoning: { effort: 'high' } });
    h.responses[0].onModelFallback({ reason: 'upstream_5xx' });
    expect(h.attempts.map(attempt => attempt.body.model)).toEqual(['original-model', 'high-model']);
    h.attempts[1].callback({ statusCode: 200, headers: {} });
    h.res.emit('finish');
    const decisions = project(h.observer, h.models).recent.decisions;
    expect(decisions.map(item => item.reason)).toEqual([
      'fallback_incompatible', 'fallback_unverified', 'fallback_compatible',
    ]);
    expect(decisions[0].reasoning).toMatchObject({
      support: 'supported', mode: 'unknown', reason: 'reasoning_effort_unsupported',
      action: { kind: 'change_request', retry: 'do_not_repeat' },
      pins: { eligibility_revision: 0, catalogue_revision: catalogueRevision },
      selected_evidence: [{ authority: 'provider', source: 'provider-model-list', field: 'supportedReasoningEfforts' }],
    });
    expect(decisions[1].reasoning).toMatchObject({
      support: 'absent', mode: 'unknown', reason: 'reasoning_automatic_requires_known_support',
      action: { kind: 'operator_required', retry: 'after_operator_change' },
    });
    expect(decisions[1].reasoning).not.toHaveProperty('selected_evidence');
    expect(decisions[2].reasoning).toMatchObject({
      support: 'supported', mode: 'unknown', reason: 'reasoning_effort_accepted',
      action: { kind: 'none', retry: 'not_applicable' },
    });
    expect(decisions.every(item => item.reasoning.supported_values === undefined)).toBe(true);
  });
});
