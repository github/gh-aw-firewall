'use strict';

const { EventEmitter } = require('node:events');
const { createManagementHandlers, buildRoutingModelMetadata } = require('./management');
const { reflectScopedAuto } = require('./scoped-auto-model');
const { getModelApiMappingReflect } = require('./model-api-mapping');
const { getCatalogueLoader } = require('./catalogue-loader');
const { evaluateEligibility, createEligibilityStore } = require('./catalogue-contract/eligibility');
const { identity } = require('./catalogue-contract/identity');
const { buildEligibilityError } = require('./model-eligibility');
const { buildModelPolicyError } = require('./guards/model-policy-guard');
const { buildRoutingCandidates } = require('./routing-candidates');
const { medianPricingFact } = require('./catalogue-contract/pricing-resolution');
const exact = require('./catalogue-contract/exact-pricing');
const { validateReasoningEffort } = require('./reasoning-effort-validation');
const { createModelDecisionObservation } = require('./model-decision-observation');
const { projectModelDecisionDiagnostics, validateDiagnostics, projectCapturedEligibility } = require('./model-decision-diagnostics');

const scope = { provider: 'copilot', channel: 'copilot-api' };
const runtime = [{
  id: 'effort-model', supportedEndpoints: ['/responses'],
  supportedReasoningEfforts: ['low', 'high'], observedAt: '2026-11-08T12:00:00Z',
}];
const endpoint = { provider: 'copilot', configured: true, models: ['effort-model'] };
const reflect = (extra = {}, options = {}) => projectModelDecisionDiagnostics({
  endpoints: [endpoint], models_fetch_complete: true, ...extra,
}, { context: 'primary-agent', runtimeMetadata: { copilot: runtime }, ...options });

function response() {
  const res = new EventEmitter();
  res.statusCode = 400;
  res.end = jest.fn();
  return res;
}

function observe(observer, error, extra = {}, finish = true) {
  const req = { method: 'POST', url: '/responses', ...extra };
  const res = response();
  const nativeEnd = res.end;
  const dispatch = jest.fn((_req, target) => target.end(JSON.stringify({ error })));
  observer.wrapProxyRequest(dispatch)(req, res, 'target.invalid', {}, 'copilot');
  if (finish) res.emit('finish');
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(nativeEnd).toHaveBeenCalledWith(JSON.stringify({ error }), undefined, undefined);
  return res;
}

test('real management handler preserves every legacy field and calls state getters once', () => {
  const adapter = {
    name: 'openai',
    getReflectionInfo: () => ({ provider: 'openai', port: 10000, configured: true,
      base_url: 'http://api-proxy:10000', models_cache_key: 'openai', models_url: '/v1/models' }),
  };
  const aiCredits = { total: 12, by_model: {}, effective_max_ai_credits: 100 };
  const metadata = [{ id: 'gpt-5.4' }];
  const deps = {
    getAdapters: jest.fn(() => [adapter]),
    getCachedModels: jest.fn(() => ({ openai: ['gpt-5.4'] })),
    getRuntimeModelMetadata: jest.fn(() => ({ openai: metadata })),
    getRoutingModelMetadata: jest.fn(() => ({ openai: metadata })),
    isModelFetchComplete: jest.fn(() => true),
    getModelAliases: jest.fn(() => ({ models: { custom: ['openai/gpt-5.4'] } })),
    getModelFallback: jest.fn(() => ({ enabled: false })),
    getEffectiveModelFallback: jest.fn(() => ({})),
    getAiCreditsUsage: jest.fn(() => aiCredits),
    getTimeoutSteeringUsage: jest.fn(() => ({ enabled: false })),
    getMaxRunsUsage: jest.fn(() => ({ total: 2 })),
    getMaxCacheMissesUsage: jest.fn(() => ({ total: 3 })),
    getPermissionDeniedUsage: jest.fn(() => ({ total: 4 })),
    getRoutingState: jest.fn(() => null),
  };
  const handlers = createManagementHandlers(deps);
  const res = { writeHead: jest.fn(), end: jest.fn() };
  expect(handlers.handleManagementEndpoint({ method: 'GET', url: '/reflect' }, res)).toBe(true);
  expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
  const { model_decision_diagnostics: diagnostics, ...legacy } = JSON.parse(res.end.mock.calls[0][0]);
  expect(legacy).toEqual({
    endpoints: [{
      provider: 'openai', port: 10000, base_url: 'http://api-proxy:10000',
      configured: true, models: ['gpt-5.4'], model_metadata: metadata,
      automatic_model_selection: reflectScopedAuto('openai', ['gpt-5.4'], metadata, null),
      routing_models: buildRoutingModelMetadata('openai', ['gpt-5.4'], metadata),
      models_url: '/v1/models',
    }],
    models_fetch_complete: true, model_aliases: { custom: ['openai/gpt-5.4'] },
    model_fallback: { enabled: false }, model_fallback_effective: {}, ai_credits: aiCredits,
    time_steering: { enabled: false }, runs: { total: 2 }, cache_misses: { total: 3 },
    permission_denied: { total: 4 }, model_api_mapping: getModelApiMappingReflect(),
    routing: null, model_catalogue: getCatalogueLoader().reflect(),
  });

  for (const getter of Object.values(deps)) expect(getter).toHaveBeenCalledTimes(1);
  expect(validateDiagnostics(diagnostics)).toBe(true);
  expect(diagnostics.recent.status).toBe('unavailable');
  expect(handlers.handleManagementEndpoint({ method: 'POST', url: '/reflect' }, res)).toBe(false);
  expect(handlers.handleManagementEndpoint({ method: 'GET', url: '/reflect/v2' }, res)).toBe(false);
});

test.each([null, []])('missing listing %p remains unknown, not confirmed unavailability', models => {
  const state = reflect({ endpoints: [{ ...endpoint, models }] }).current.decisions;
  expect(state).toEqual([expect.objectContaining({
    reason: 'provider_state_unknown', status: 'unknown',
    action: { kind: 'unknown', retry: 'unknown' },
  })]);
});

test('unconfigured provider and unfinished discovery have distinct evidence-backed actions', () => {
  expect(reflect({ endpoints: [{ ...endpoint, configured: false }] }).current.decisions[0])
    .toMatchObject({ reason: 'provider_not_configured', action: { kind: 'operator_required' } });
  expect(reflect({ models_fetch_complete: false }).current.decisions[0])
    .toMatchObject({ reason: 'discovery_pending', action: { kind: 're_evaluate', retry: 'after_models_fetch' } });
});

test('only exact runtime advertisements supply current efforts; family and routing metadata cannot', () => {
  const projected = reflect();
  expect(projected.current.decisions[1]).toMatchObject({
    kind: 'current_state', status: 'unknown', identity: { provider: 'copilot', model_id: 'effort-model' },
    scope: { context: 'primary-agent', endpoint: '/responses', channel: 'copilot-api' },
    effort: { support: 'reported_supported', supported_values: ['low', 'high'], omission_supported: null },
    evidence: { observed_at: '2026-11-08T12:00:00Z', eligibility_revision: null },
  });
  expect(reflect({}, { runtimeMetadata: { copilot: [{
    id: 'effort-model', family: 'gpt', supportedEndpoints: ['/responses'],
    capabilities: { supports: { streaming: true } },
  }] } }).current.decisions).toHaveLength(1);
  expect(reflect({}, { runtimeMetadata: { copilot: [{
    ...runtime[0], supportedReasoningEfforts: ['future'],
  }] } }).current.decisions[1].effort).toMatchObject({ support: 'unknown', supported_values: null });
});

test('real policy rejection avoids an unchanged retry and hides disallowed models and rules', () => {
  const observer = createModelDecisionObservation({
    context: 'primary-agent', getModels: () => ({ copilot: ['private-model'] }),
    modelPolicy: { disallowedModels: ['private-*'] },
  });

  observe(observer, buildModelPolicyError({ model: 'private-model', reason: 'disallowed' }).error, {
    awfEligibility: { revision: 3 }, awfCatalogue: { revision: 'a'.repeat(64) },
  });
  const diagnostics = reflect({}, { recent: observer.getRecent() });
  expect(diagnostics.recent.decisions[0]).toMatchObject({
    kind: 'request_outcome', reason: 'policy_denied', status: 'rejected',
    identity: { provider: 'copilot', model_id: null },
    action: { kind: 'change_request', retry: 'do_not_repeat' },
    evidence: { eligibility_revision: 3, catalogue_revision: 'a'.repeat(64) },
  });
  expect(JSON.stringify(diagnostics)).not.toContain('private-');
});

test('real effort validation and reflection give a provider-free correction example', () => {
  const body = value => Buffer.from(JSON.stringify({ model: 'effort-model', reasoning: { effort: value } }));
  let rejection;
  try { validateReasoningEffort(body('max'), 'copilot', '/responses', { copilot: runtime }); }
  catch (error) { rejection = error; }
  expect(rejection.code).toBe('unsupported_reasoning_effort');
  const observer = createModelDecisionObservation({ context: 'primary-agent' });
  observe(observer, { code: rejection.code, message: rejection.message });
  const diagnostics = reflect({}, { recent: observer.getRecent() });
  const outcome = diagnostics.recent.decisions[0];
  expect(outcome.effort).toMatchObject({ support: 'known_unsupported', supported_values: null, omission_supported: null });
  expect(outcome.action.retry).toBe('do_not_repeat');
  // The agent uses an explicit current advertisement for this exact endpoint,
  // not accounting family, a guessed omission, or a replacement model.
  const advertised = diagnostics.current.decisions.find(item => item.effort?.support === 'reported_supported');
  const corrected = advertised.effort.supported_values[0];
  expect(corrected).toBe('low');
  expect(() => validateReasoningEffort(body(corrected), 'copilot', '/responses', { copilot: runtime })).not.toThrow();
  expect(() => validateReasoningEffort(body('max'), 'copilot', '/responses', { copilot: [] })).not.toThrow();
  expect(reflect({}, { runtimeMetadata: {} }).current.decisions.some(item => item.effort)).toBe(false);
});

test.each([
  ['1.0.0', true, 'harness_incompatible'],
  ['3.0.0', false, 'harness_unverified'],
])('real harness decisions distinguish version %s, verified %s', (version, verified, reason) => {
  const result = evaluateEligibility({
    identity: identity('copilot', 'effort-model'), scope,
    discovery: { status: 'available', authoritative: true, scope },
    executionEnvironment: 'actual-agent',
    harnesses: [{ name: 'copilot', minimum: '2.0.0', scheme: 'semver', scope,
      reason: '******', provenance: { source: 'https://private.invalid/secret', revision: '/private/path' } }],
    observations: [{ name: 'copilot', version, verified, actual: true, scope, environment: 'actual-agent' }],
  });
  const observer = createModelDecisionObservation({ context: 'primary-agent' });
  observe(observer, buildEligibilityError(result).error, {
    awfSelectedModelEligibility: { provider: 'copilot', decision: result }, awfEligibility: { revision: 7 },
  });
  const diagnostics = reflect({}, { recent: observer.getRecent() });
  expect(diagnostics.recent.decisions[0]).toMatchObject({
    kind: 'request_outcome', status: 'rejected', reason,
    action: { kind: 'operator_required', retry: 'after_operator_change' },
    evidence: { eligibility_revision: 7 },
  });
  const text = JSON.stringify(diagnostics);
  for (const secret of ['Bearer', 'private-text', 'private.invalid', '/private/path', 'actual-agent'])
    expect(text).not.toContain(secret);
});

test('current refresh cannot rewrite captured decisions or request pins', () => {
  const store = createEligibilityStore();
  const pinned = store.pin();
  const observer = createModelDecisionObservation({ context: 'primary-agent' });
  observe(observer, { type: 'model_policy_violation' }, { awfEligibility: pinned });
  store.replace({ observations: [] });
  const before = observer.getRecent();
  reflect({}, { recent: before });
  reflect({ models_fetch_complete: false }, { recent: before });
  expect(observer.getRecent()).toEqual(before);
  expect(reflect({}, { recent: before }).recent.decisions[0].evidence.eligibility_revision).toBe(0);
  expect(store.pin().revision).toBe(1);
});

test('real eligibility treats absence, authoritative absence, and incorrectly scoped evidence differently', () => {
  for (const [discovery, expected] of [
    [{ status: 'unknown', scope }, 'discovery_unknown'],
    [{ status: 'unavailable', authoritative: true, scope }, 'discovery_unavailable'],
    [{ status: 'unavailable', authoritative: true, scope: { ...scope, deployment: 'other' } }, 'discovery_unknown'],
  ]) {
    const result = evaluateEligibility({ identity: identity('copilot', 'effort-model'), scope, discovery });
    expect(projectCapturedEligibility({ decision: result, provider: 'copilot', endpoint: '/responses' }, 'primary-agent')[0].reason)
      .toBe(expected);
  }
});

test('existing routing pool failures distinguish policy denial from provider/catalogue unavailability', () => {
  const catalogue = { provider: 'copilot', configured: false, discovery: 'unavailable', models: [] };
  let code;
  try { buildRoutingCandidates({ catalogue }); } catch (error) { code = error.code; }
  expect(code).toBe('provider_unavailable');
  expect(reflect({ routing: { status: 'failed', failure_code: code } }).current.decisions.at(-1))
    .toMatchObject({ reason: 'provider_unavailable', status: 'unavailable', action: { retry: 'unknown' } });
  try {
    buildRoutingCandidates({ catalogue: { ...catalogue, configured: true, discovery: 'complete',
      models: [{ id: 'effort-model' }] }, policy: { disallowedModels: ['*'] } });
  } catch (error) { code = error.code; }
  expect(code).toBe('model_policy_violation');
  expect(reflect({ routing: { status: 'failed', failure_code: code } }).current.decisions.at(-1))
    .toMatchObject({ reason: 'policy_denied', action: { retry: 'do_not_repeat' } });
});

test('a supplied real family estimate stays accounting-only and contributes no effort or replacement evidence', () => {
  const estimate = medianPricingFact([{
    family: 'declared-family',
    result: { source: 'curated', pricing: exact.rates({ input: 2, output: 4, cachedInput: 0, cacheWrite: null }) },
  }], 'declared-family').metadata.estimate;
  expect(estimate.basis).toBe('family');
  const diagnostics = reflect({ ai_credits: { by_model: {
    'copilot/effort-model': { total: 3, pricing_source: 'median_estimate', pricing_estimate: estimate },
  } } }, { runtimeMetadata: {} });
  expect(diagnostics.accounting.decisions[0]).toMatchObject({
    reason: 'estimated_pricing', status: 'estimated',
    pricing: { basis: 'family', donor_count: 1, budget_accounted: true },
  });
  expect(diagnostics.current.decisions.some(item => item.effort)).toBe(false);
  expect(JSON.stringify(diagnostics)).not.toContain('declared-family');
});

test('retention is bounded, deduplicated, expires, and returned copies cannot mutate history', () => {
  let time = Date.parse('2026-11-08T12:00:00Z');
  const observer = createModelDecisionObservation({ context: 'primary-agent', now: () => time });
  for (let i = 0; i < 1200; i++) observe(observer, { type: 'model_policy_violation' });
  expect(observer.getRecent()).toHaveLength(1);
  expect(observer.getRecent()[0].occurrences).toBe(1000);
  for (let i = 0; i < 60; i++)
    observe(observer, { type: 'model_policy_violation' }, { awfEligibility: { revision: i } });
  expect(observer.getRecent()).toHaveLength(32);
  observer.getRecent()[0].reason = 'forged';
  expect(observer.getRecent()[0].reason).toBe('policy_denied');
  time += 901_000;
  expect(observer.getRecent()).toEqual([]);
});

test('provider payloads, aborted responses, other purposes, subagents and enclave scopes are excluded', () => {
  const observer = createModelDecisionObservation({ context: 'primary-agent' });
  const error = { type: 'model_policy_violation', model: '/private/secret',
    message: '******', headers: { authorization: 'credential' } };
  for (const extra of [
    { awfRequestContext: { purpose: 'routing_classification' } },
    { awfCaller: { purpose: 'subagent', agent_name: 'other-session' } },
    { awfEligibilityScope: { provider: 'copilot', deployment: 'private-deployment' } },
  ]) observe(observer, error, extra);
  const upstream = response();
  upstream.awfUpstreamResponse = true;
  observer.wrapProxyRequest((_req, res) => res.end(JSON.stringify({ error })))(
    { method: 'POST', url: '/responses' }, upstream, 'target', {}, 'copilot');
  upstream.emit('finish');
  const aborted = observe(observer, error, {}, false);
  aborted.emit('close');
  aborted.emit('finish');
  expect(observer.getRecent()).toEqual([]);
  expect(createModelDecisionObservation({ context: 'dedicated-enclave' }).getRecent()).toBeNull();
  const dedicated = reflect({}, { context: 'dedicated-enclave', recent: [{
    provider: 'copilot', reason: 'harness_incompatible',
  }] });
  expect(dedicated.recent).toMatchObject({ status: 'unavailable', decisions: [] });
  expect(dedicated.current.decisions.some(item => item.effort)).toBe(false);
  expect(dedicated.accounting.decisions).toEqual([]);
});

test('projection is JSON-safe, strictly schema validated and bounded without mutating inputs', () => {
  const records = Array.from({ length: 100 }, (_, i) => ({ ...runtime[0], id: `model-${i}` }));
  const input = {
    endpoints: [{ ...endpoint, models: records.map(record => record.id) }],
    models_fetch_complete: true,
  };
  const before = structuredClone(input);
  const diagnostics = projectModelDecisionDiagnostics(input, {
    context: 'primary-agent', runtimeMetadata: { copilot: records },
  });
  expect(diagnostics.current.decisions).toHaveLength(64);
  expect(diagnostics.current.truncated).toBe(true);
  expect(input).toEqual(before);
  expect(validateDiagnostics(JSON.parse(JSON.stringify(diagnostics)))).toBe(true);
  expect(validateDiagnostics({ ...diagnostics, prompt: 'forbidden' })).toBe(false);
  expect(validateDiagnostics({ ...diagnostics, context: 'forged-session' })).toBe(false);
});

test('older-response absence remains unavailable, never zero-cost, support or permission', () => {
  const older = { endpoints: [], ai_credits: {} };
  expect(older.model_decision_diagnostics?.recent?.status ?? 'unavailable').toBe('unavailable');
  expect(older.model_decision_diagnostics?.current?.decisions).toBeUndefined();
  expect(older.ai_credits.total).toBeUndefined();
});

test.each(['__proto__', 'constructor', 'toString', 'new_private_provider_code'])(
  'unrecognized routing code %s gives unknown actionability rather than crashing or echoing it', failure_code => {
    const diagnostics = reflect({ routing: { status: 'failed', failure_code } });
    expect(diagnostics.current.decisions.at(-1)).toMatchObject({
      reason: 'decision_unknown', action: { kind: 'unknown', retry: 'unknown' },
    });
    expect(JSON.stringify(diagnostics.current.decisions.at(-1))).not.toContain(failure_code);
  });

test.each([new Error('private exception path'), null])(
  'diagnostics failure %p is unavailable, not a new management failure or leaked exception', error => {
    const handlers = createManagementHandlers({
      getAdapters: () => [], getCachedModels: () => ({}), isModelFetchComplete: () => true,
      getModelAliases: () => null, getModelFallback: () => null, getEffectiveModelFallback: () => ({}),
      getAiCreditsUsage: () => ({ total: 7 }), getMaxRunsUsage: () => ({}),
      getMaxCacheMissesUsage: () => ({}), getPermissionDeniedUsage: () => ({}),
      getRecentModelDecisions: () => { throw error; },
    });
    const res = { writeHead: jest.fn(), end: jest.fn() };
    handlers.handleManagementEndpoint({ method: 'GET', url: '/reflect' }, res);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    const reflection = JSON.parse(res.end.mock.calls[0][0]);
    expect(reflection).not.toHaveProperty('model_decision_diagnostics');
    expect(reflection.ai_credits.total).toBe(7);
    expect(JSON.stringify(reflection)).not.toContain('private exception');
  });

test('real wire pricing error type is captured as operator-required without a success-shaped repair', () => {
  const { checkModelPricing, applyAiCreditsUsage, resetAiCreditsGuardForTests } = require('./guards/ai-credits-guard');
  resetAiCreditsGuardForTests();
  try {
    expect(() => applyAiCreditsUsage({ input_tokens: Number.MAX_SAFE_INTEGER + 1 }, 'gpt-5.4', 'copilot')).toThrow();
    const error = checkModelPricing('gpt-5.4', 'copilot').error;
    expect(error.type).toBe('pricing_resolution_error');
    expect(error).not.toHaveProperty('code');
    const observer = createModelDecisionObservation({ context: 'primary-agent' });
    observe(observer, error);
    expect(reflect({}, { recent: observer.getRecent() }).recent.decisions[0]).toMatchObject({
      reason: 'pricing_resolution_error', status: 'unavailable', action: { kind: 'operator_required' },
    });
  } finally { resetAiCreditsGuardForTests(); }
});
