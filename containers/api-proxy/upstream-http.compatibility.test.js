'use strict';

const { createSendUpstreamRequest } = require('./upstream-http');
const { replaceRuntimeModels, clearRuntimeModels, captureRuntimePricing } = require('./runtime-model-catalog');
const { createProxyEligibilityStore } = require('./model-eligibility');

function harness({ source, path = '/responses', provider = 'copilot', chain = [], req: extraReq = {}, translated = null,
  adapters = {}, targetHost = 'api.githubcopilot.com', isPermitted = null,
  sendFactory = createSendUpstreamRequest }) {
  const attempts = [];
  const responses = [];
  const observe = jest.fn();
  const req = {
    method: 'POST', url: path, headers: {}, awfObserveModelDecision: observe,
    awfEligibility: { ...createProxyEligibilityStore().pin(), revision: 'eligibility-pinned' },
    awfCatalogue: { revision: 'catalogue-pinned' },
    ...extraReq,
  };
  const res = { headersSent: false, writeHead: jest.fn(), end: jest.fn() };
  const request = jest.fn((options, callback) => {
    const attempt = { options, callback, body: null };
    attempts.push(attempt);
    return { on: jest.fn(), end: jest.fn(), write: body => { attempt.body = JSON.parse(body); } };
  });
  const send = sendFactory({
    https: { request }, http: { request }, proxyAgent: {},
    handleUpstreamResponse: (_res, _headers, ctx) => responses.push(ctx),
    sleep: () => Promise.resolve(), otel: { endSpan: jest.fn(), endSpanError: jest.fn() },
    metrics: { gaugeDec: jest.fn(), gaugeInc: jest.fn(), increment: jest.fn(), observe: jest.fn() },
    handleRequestError: jest.fn(), getFallbackModels: () => chain,
    getProviderAdapter: route => adapters[route] || null,
    isFallbackModelPermitted: isPermitted,
  });
  const sourceBody = Buffer.from(JSON.stringify(source));
  send({}, {
    req, res, provider, targetHost, upstreamPath: translated?.compatibility.upstreamEndpoint || path,
    body: translated?.body || sourceBody, wireApiSourceBody: provider === 'copilot' ? sourceBody : null,
    wireApiCompatibility: translated?.compatibility || null,
    requestId: 'compatibility-test', startTime: Date.now(), span: {}, requestBytes: sourceBody.length,
  });
  const fail = index => {
    attempts[index].callback({ statusCode: 503, headers: {} });
    return responses[index];
  };
  return { attempts, responses, observe, req, res, fail };
}

function adapter(provider, overrides = {}) {
  return {
    isEnabled: () => true, getTargetHost: () => `api.${provider === 'copilot' ? 'githubcopilot' : provider}.com`,
    getBasePath: () => '', getAuthHeaders: jest.fn(() => ({})), getBodyTransform: () => null,
    ...overrides,
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

afterEach(() => clearRuntimeModels());

test.each([
  ['gemini', '/v1beta/models/origin:generateContent'],
  ['gemini', '/v1beta/models/origin:streamGenerateContent?alt=sse'],
  ['vertex', '/v1/projects/private-project/locations/us-central1/publishers/google/models/origin:generateContent'],
  ['vertex', '/v1/projects/private-project/locations/us-central1/publishers/google/models/origin:streamGenerateContent?alt=sse'],
])('%s native %s fallback preserves the body and endpoint without inventing a contract', (provider, path) => {
  const source = {
    contents: [{ role: 'user', parts: [{ text: 'PRIVATE_PROMPT' }] }],
    generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 1024 } },
    tools: [{ functionDeclarations: [{ name: 'lookup', parameters: { type: 'object' } }] }],
  };
  const h = harness({ source, path, provider, chain: ['next'], targetHost: 'generativelanguage.googleapis.com' });
  expect(h.fail(0).onModelFallback({ reason: 'upstream_5xx' })).toBe(true);
  expect(h.attempts.map(a => a.options.path)).toEqual([path, path.replace('/models/origin:', '/models/next:')]);
  expect(h.attempts.map(a => a.body)).toEqual([source, source]);
  expect(h.observe.mock.calls[0][0]).toMatchObject({
    provider, model: 'next', originModel: 'origin', outcome: 'accepted',
    compatibility: {
      status: 'compatible', source: null, target: null, contracts: [], returnConditions: 'not_applicable',
      pins: { eligibilityRevision: 'eligibility-pinned', catalogueRevision: 'catalogue-pinned' },
    },
  });
  const evidence = JSON.stringify(h.observe.mock.calls);
  expect(evidence).not.toContain('PRIVATE_PROMPT');
  expect(evidence).not.toContain('private-project');
});

test.each(['gemini', 'vertex'])('%s native fallback still enforces candidate policy', provider => {
  const h = harness({
    source: { contents: [{ parts: [{ text: 'hello' }] }] },
    path: '/v1beta/models/origin:generateContent', provider, chain: ['hidden-target', 'next'],
    isPermitted: model => model !== 'hidden-target',
  });
  expect(h.fail(0).onModelFallback({ reason: 'upstream_5xx' })).toBe(true);
  expect(h.attempts.map(a => a.options.path)).toEqual([
    '/v1beta/models/origin:generateContent', '/v1beta/models/next:generateContent',
  ]);
  expect(h.observe.mock.calls.map(([r]) => [r.model, r.outcome])).toEqual([
    [null, 'skipped'], ['next', 'accepted'],
  ]);
  expect(JSON.stringify(h.observe.mock.calls)).not.toContain('hidden-target');
});

test.each([
  ['gemini', '/v1beta/models/origin:unknownMethod'],
  ['openai', '/models/origin:generateContent'],
])('%s unrecognized %s cannot claim native passthrough', (provider, path) => {
  const h = harness({ source: { contents: [] }, provider, path, chain: ['next'] });
  expect(h.fail(0).onModelFallback({ reason: 'upstream_5xx' })).toBe(false);
  expect(h.attempts).toHaveLength(1);
  expect(h.observe.mock.calls.map(([r]) => [r.outcome, r.compatibility.status])).toEqual([
    ['skipped', 'unverified'], ['exhausted', 'unverified'],
  ]);
});

test('skips an incompatible same-provider wire endpoint and dispatches the next native candidate', () => {
  replaceRuntimeModels('copilot', [{ id: 'chat-only', supportedEndpoints: ['/chat/completions'] }]);
  const h = harness({
    source: { model: 'origin', input: 'PRIVATE_PROMPT', tools: [{ type: 'custom', name: 'apply_patch' }] },
    chain: ['chat-only', 'native-responses'],
  });
  expect(h.fail(0).onModelFallback({ reason: 'upstream_5xx' })).toBe(true);
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'native-responses']);
  expect(h.observe.mock.calls.map(([r]) => [r.model, r.outcome, r.compatibility.status])).toEqual([
    ['chat-only', 'skipped', 'incompatible'], ['native-responses', 'accepted', 'compatible'],
  ]);
  const skipped = h.observe.mock.calls[0][0];
  expect(skipped).toMatchObject({
    endpoint: '/responses', originModel: 'origin', eligibilityRevision: 'eligibility-pinned',
    catalogueRevision: 'catalogue-pinned', compatibility: { source: 'responses', target: 'chat_completions' },
  });
  expect(JSON.stringify(skipped)).not.toContain('PRIVATE_PROMPT');
});

test('cross-provider rejection happens before body transforms and target authentication', async () => {
  const anthropic = adapter('anthropic', { getBodyTransform: jest.fn(() => jest.fn()) });
  const h = harness({
    source: { model: 'origin', input: 'hi', tools: [{ type: 'web_search' }] },
    chain: ['anthropic/claude-sonnet-4.6', 'openai/gpt-5.4'],
    adapters: { anthropic, openai: adapter('openai') },
  });
  expect(h.fail(0).onModelFallback({ reason: 'upstream_5xx' })).toBe(true);
  await flush();
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'gpt-5.4']);
  expect(anthropic.getBodyTransform).not.toHaveBeenCalled();
  expect(anthropic.getAuthHeaders).not.toHaveBeenCalled();
  expect(h.observe.mock.calls.map(([r]) => r.outcome)).toEqual(['skipped', 'accepted']);
});

test('assesses original protocol on the same cross-provider route and when returning to origin', async () => {
  replaceRuntimeModels('copilot', [{ id: 'chat-only', supportedEndpoints: ['/chat/completions'] }]);
  const h = harness({
    source: { model: 'origin', input: 'hi', tools: [{ type: 'custom', name: 'apply_patch' }] },
    chain: ['openai/gpt-5.4', 'openai/gpt-5.5', 'chat-only', 'native-responses'],
    adapters: { openai: adapter('openai') },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  h.fail(1).onModelFallback({ reason: 'upstream_5xx' });
  h.fail(2).onModelFallback({ reason: 'upstream_5xx' });
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'gpt-5.4', 'gpt-5.5', 'native-responses']);
  expect(h.observe.mock.calls.map(([r]) => [r.originProvider, r.originModel, r.compatibility.source])).toEqual([
    ['copilot', 'origin', 'responses'], ['copilot', 'origin', 'responses'],
    ['copilot', 'origin', 'responses'], ['copilot', 'origin', 'responses'],
  ]);
  expect(h.observe.mock.calls[2][0]).toMatchObject({ model: 'chat-only', outcome: 'skipped' });
});

test('same-provider cross-protocol attempts retain Responses as the assessed source', async () => {
  const h = harness({
    source: { model: 'origin', input: 'hi' },
    chain: ['anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.6'],
    adapters: { anthropic: adapter('anthropic') },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  h.fail(1).onModelFallback({ reason: 'upstream_5xx' });
  expect(h.attempts).toHaveLength(3);
  expect(h.observe.mock.calls.map(([r]) => r.compatibility)).toEqual([
    expect.objectContaining({ source: 'responses', target: 'anthropic_messages', status: 'compatible' }),
    expect.objectContaining({ source: 'responses', target: 'anthropic_messages', status: 'compatible' }),
  ]);
});

test('same-provider fallback after a provider switch assesses reasoning against the current target', async () => {
  const h = harness({
    source: { model: 'origin', input: 'hi', reasoning: { effort: 'xhigh' } },
    chain: ['openai/gpt-5.4-mini', 'openai/gpt-5.4-mini-2026-03-17'],
    adapters: { openai: adapter('openai') },
    req: { awfRuntimePricing: {} },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  h.fail(1).onModelFallback({ reason: 'upstream_5xx' });
  expect(h.attempts.map(a => a.body.model)).toEqual([
    'origin', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17',
  ]);
  expect(h.observe.mock.calls.map(([r]) => [r.provider, r.model, r.outcome, r.compatibility.reasoning?.code])).toEqual([
    ['openai', 'gpt-5.4-mini', 'accepted', 'reasoning_effort_accepted'],
    ['openai', 'gpt-5.4-mini-2026-03-17', 'accepted', 'reasoning_effort_accepted'],
  ]);
});

test('explicit effort skips unsupported and unverified models without changing the primary direct path', () => {
  const records = [
    { id: 'origin', supportedReasoningEfforts: ['high'] },
    { id: 'low-only', supportedReasoningEfforts: ['low'] },
    { id: 'high-model', supportedReasoningEfforts: ['high'] },
  ];
  const h = harness({
    path: '/chat/completions', source: { model: 'origin', messages: [], reasoning_effort: 'high' },
    chain: ['low-only', 'unknown-model', 'high-model'], req: { awfRuntimePricing: { copilot: records } },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'high-model']);
  expect(h.observe.mock.calls.map(([r]) => r.compatibility.status)).toEqual(['incompatible', 'unverified', 'compatible']);
});

test.each(['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17'])('native fallback dispatch consumes reviewed %s efforts', model => {
  const source = { model: 'origin', input: 'hello', reasoning: { effort: 'xhigh' } };
  const h = harness({
    provider: 'openai', targetHost: 'api.openai.com', source,
    chain: ['gpt-5.4-mini-preview', model], req: { awfRuntimePricing: {} },
  });
  expect(h.fail(0).onModelFallback({ reason: 'upstream_5xx' })).toBe(true);
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', model]);
  expect(h.attempts[1].body).toEqual({ ...source, model });
  expect(h.observe.mock.calls.map(([r]) => [r.model, r.outcome, r.compatibility.status])).toEqual([
    ['gpt-5.4-mini-preview', 'skipped', 'unverified'], [model, 'accepted', 'compatible'],
  ]);
  expect(h.observe.mock.calls[1][0]).toMatchObject({
    compatibility: {
      reasoning: { support: 'supported', mode: 'optional', code: 'reasoning_effort_accepted' },
      pins: { eligibilityRevision: 'eligibility-pinned', catalogueRevision: 'catalogue-pinned' },
    },
  });
});

test('native fallback does not strip or substitute an unsupported mini effort', () => {
  const source = { model: 'origin', input: 'hello', reasoning: { effort: 'max' } };
  const h = harness({
    provider: 'openai', targetHost: 'api.openai.com', source,
    chain: ['gpt-5.4-mini'], req: { awfRuntimePricing: {} },
  });
  expect(h.fail(0).onModelFallback({ reason: 'upstream_5xx' })).toBe(false);
  expect(h.attempts).toHaveLength(1);
  expect(h.attempts[0].body).toEqual(source);
  expect(h.observe.mock.calls[0][0]).toMatchObject({
    model: 'gpt-5.4-mini', outcome: 'skipped', compatibility: {
      status: 'incompatible', reasoning: { code: 'reasoning_effort_unsupported' },
    },
  });
});

test('alternate-endpoint and ranked alias retries skip incompatible endpoints and keep candidate order', () => {
  replaceRuntimeModels('copilot', [{ id: 'chat-only', supportedEndpoints: ['/chat/completions'] }]);
  const source = { model: 'origin', input: 'hi', tools: [{ type: 'custom', name: 'apply_patch' }] };
  const h = harness({
    source, translated: { body: Buffer.from(JSON.stringify(source)),
      compatibility: { upstreamEndpoint: '/responses', requestedEndpoint: '/responses', passthrough: true } },
    req: { awfModelCandidates: ['origin', 'chat-only', 'native-responses'] },
  });
  const ctx = h.fail(0);
  expect(() => ctx.onWireApiEndpointRetry()).toThrow('Fallback request compatibility was not established');
  expect(ctx.onModelEndpointBlockedRetry()).toBe(true);
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'native-responses']);
  expect(h.observe.mock.calls.map(([r]) => [r.model, r.outcome])).toEqual([
    ['origin', 'skipped'], ['chat-only', 'skipped'], ['native-responses', 'accepted'],
  ]);
});

test('all incompatible candidates emit one bounded exhaustion and retain the original failure', async () => {
  const h = harness({
    source: { model: 'origin', input: 'PRIVATE_PROMPT', tools: [{ type: 'web_search' }] },
    chain: ['anthropic/claude-sonnet-4.6'], adapters: { anthropic: adapter('anthropic') },
    req: { awfRequestedModelSelector: 'alias' },
  });
  const abandon = jest.fn();
  const ctx = h.fail(0);
  expect(ctx.onModelFallback({ reason: 'upstream_5xx', abandon })).toBe(true);
  await flush();
  expect(h.attempts).toHaveLength(1);
  expect(abandon).toHaveBeenCalledTimes(1);
  expect(h.observe.mock.calls.map(([r]) => r.outcome)).toEqual(['skipped', 'exhausted']);
  expect(h.observe.mock.calls[1][0]).toMatchObject({
    originProvider: 'copilot', originModel: 'origin', model: null, reason: 'fallback_exhausted',
  });
  expect(JSON.stringify(h.observe.mock.calls)).not.toContain('PRIVATE_PROMPT');
  expect(ctx.onModelFallback({ reason: 'upstream_5xx', abandon })).toBe(false);
  expect(h.observe).toHaveBeenCalledTimes(2);
});

test('automatic recovery also rejects future efforts before inference dispatch', () => {
  const records = [
    { id: 'origin', supportedReasoningEfforts: ['future-effort'], supportedEndpoints: ['/chat/completions'] },
    { id: 'replacement', supportedReasoningEfforts: ['future-effort'], supportedEndpoints: ['/chat/completions'] },
  ];
  const h = harness({
    path: '/chat/completions', source: { model: 'origin', messages: [], reasoning_effort: 'future-effort' },
    req: { awfRuntimePricing: { copilot: records } },
  });
  const ctx = h.fail(0);
  expect(ctx.onModelFallback({ reason: 'model_not_supported', statusCode: 400 })).toBe(true);
  expect(h.attempts).toHaveLength(1);
  expect(h.observe.mock.calls.map(([r]) => r.outcome)).toEqual(['skipped', 'exhausted']);
  expect(h.res.writeHead).toHaveBeenCalledWith(502, expect.any(Object));
});

test('cross-provider Copilot dispatch is assessed against its concrete selected endpoint', async () => {
  replaceRuntimeModels('copilot', [{ id: 'chat-only', supportedEndpoints: ['/chat/completions'] }]);
  const copilot = adapter('copilot');
  const h = harness({
    provider: 'openai', targetHost: 'api.openai.com',
    source: { model: 'origin', input: 'hi', tools: [{ type: 'custom', name: 'apply_patch' }] },
    chain: ['copilot/chat-only', 'copilot/native-responses'], adapters: { copilot },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'native-responses']);
  expect(h.observe.mock.calls[0][0]).toMatchObject({
    provider: 'copilot', model: 'chat-only', outcome: 'skipped',
    compatibility: { source: 'responses', target: 'chat_completions', status: 'incompatible' },
  });
  expect(copilot.getAuthHeaders).toHaveBeenCalledTimes(1);
});

test('async build failure observes safe skip and exhaustion before retaining the original failure', async () => {
  const h = harness({
    source: { model: 'origin', input: 'hi' }, chain: ['openai/gpt-5.4'],
    adapters: { openai: adapter('openai', {
      getBodyTransform: () => async () => { throw new Error('PRIVATE_BUILD_ERROR'); },
    }) },
  });
  const abandon = jest.fn();
  h.fail(0).onModelFallback({ reason: 'upstream_5xx', abandon });
  await flush();
  expect(h.attempts).toHaveLength(1);
  expect(abandon).toHaveBeenCalledTimes(1);
  expect(h.observe.mock.calls.map(([r]) => r.outcome)).toEqual(['skipped', 'exhausted']);
  expect(h.observe.mock.calls[0][0]).toMatchObject({
    outcome: 'skipped', reason: 'fallback_unverified',
    compatibility: { status: 'unverified', reasons: [{ feature: 'unknown_fields', code: 'request_build_failed' }] },
  });
  expect(JSON.stringify(h.observe.mock.calls)).not.toContain('PRIVATE_BUILD_ERROR');
});

test('an absent or throwing observation hook does not change admission', () => {
  const h = harness({
    path: '/chat/completions', source: { model: 'origin', messages: [] }, chain: ['next'],
    req: { awfObserveModelDecision: () => { throw new Error('diagnostics failed'); } },
  });
  expect(h.fail(0).onModelFallback({ reason: 'upstream_5xx' })).toBe(true);
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'next']);
});

test('assesses captured agent-facing semantics while retaining the actual original model identity', async () => {
  const raw = {
    model: 'alias', messages: [{ role: 'user', content: [
      { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
    ] }],
  };
  const h = harness({
    path: '/chat/completions', source: { model: 'actual-origin', messages: [{ role: 'user', content: 'hi' }] },
    chain: ['anthropic/claude-sonnet-4.6', 'next'],
    req: { awfFallbackSourceBody: Buffer.from(JSON.stringify(raw)), awfRequestedModelSelector: 'alias' },
    adapters: { anthropic: adapter('anthropic') },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  expect(h.attempts.map(a => a.body.model)).toEqual(['actual-origin', 'next']);
  expect(h.observe.mock.calls[0][0]).toMatchObject({
    originModel: 'actual-origin', outcome: 'skipped', reason: 'fallback_unverified',
  });
});

test.each(['ordered', 'alias'])('%s guard skips redact rejected identities before the observation callback', route => {
  const h = harness({
    path: '/chat/completions', source: { model: 'origin', messages: [] },
    chain: route === 'ordered' ? ['hidden-target', 'next'] : [],
    req: route === 'alias' ? { awfModelCandidates: ['origin', 'hidden-target', 'next'] } : {},
    isPermitted: model => model !== 'hidden-target',
  });
  const ctx = h.fail(0);
  expect(route === 'ordered'
    ? ctx.onModelFallback({ reason: 'upstream_5xx' }) : ctx.onModelEndpointBlockedRetry()).toBe(true);
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'next']);
  expect(h.observe.mock.calls[0][0]).toMatchObject({
    model: null, outcome: 'skipped', reason: 'fallback_unverified', reasoning: null,
    compatibility: { candidate: { provider: 'copilot', model: null } },
  });
  expect(JSON.stringify(h.observe.mock.calls)).not.toContain('hidden-target');
});

test.each([
  ['invalid supplied token limit', { max_tokens: 0 }],
  ['temperature clamp', { temperature: 1.5 }],
  ['filtered stop strings', { stop: ['END', 7] }],
  ['developer priority', { messages: [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hi' }] }],
  ['multiple system turns', { messages: [
    { role: 'system', content: 'one' }, { role: 'system', content: 'two' }, { role: 'user', content: 'hi' },
  ] }],
  ['non-leading system turn', { messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'rules' }] }],
  ['same-role merge', { messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }] }],
  ['empty-turn removal', { messages: [{ role: 'user', content: '' }, { role: 'assistant', content: 'reply' }] }],
])('production Messages fallback skips %s without dispatch or normalization', async (_name, fields) => {
  const anthropic = adapter('anthropic');
  const source = { model: 'origin', messages: [{ role: 'user', content: 'hi' }], ...fields };
  const h = harness({
    path: '/chat/completions', source, chain: ['anthropic/claude-sonnet-4.6', 'next'],
    adapters: { anthropic },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'next']);
  expect(anthropic.getAuthHeaders).not.toHaveBeenCalled();
  expect(h.attempts[1].body).toEqual({ ...source, model: 'next' });
  expect(h.observe.mock.calls[0][0]).toMatchObject({
    model: 'claude-sonnet-4.6', outcome: 'skipped', reason: 'fallback_incompatible',
  });
});

test('single leading system turn and omitted maximum permit the documented Messages default', async () => {
  const h = harness({
    path: '/chat/completions', source: { model: 'origin', messages: [
      { role: 'system', content: 'rules' }, { role: 'user', content: 'hi' },
    ] }, chain: ['anthropic/claude-sonnet-4.6'], adapters: { anthropic: adapter('anthropic') },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  expect(h.attempts).toHaveLength(2);
  expect(h.attempts[1].body).toMatchObject({ model: 'claude-sonnet-4.6', system: 'rules', max_tokens: 8192 });
  expect(h.observe.mock.calls[0][0]).toMatchObject({ outcome: 'accepted', reason: 'fallback_compatible' });
});

test.each(['system', 'developer'])('Chat-to-Responses fallback rejects %s priority collapse before dispatch', role => {
  replaceRuntimeModels('copilot', [{ id: 'responses-only', supportedEndpoints: ['/responses'] }]);
  const source = { model: 'origin', messages: [{ role, content: 'rules' }, { role: 'user', content: 'hi' }] };
  const h = harness({ path: '/chat/completions', source, chain: ['responses-only', 'next'] });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'next']);
  expect(h.attempts[1].body.messages).toEqual(source.messages);
  expect(h.observe.mock.calls[0][0]).toMatchObject({
    outcome: 'skipped', compatibility: { reasons: [{ feature: 'message_roles', code: 'role_priority_loss' }] },
  });
});

test.each([
  ['/chat/completions', { model: 'origin', stream: true, stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'hi' }] }, ['usage']],
  ['/responses', { model: 'origin', stream: true, input: 'hi' }, ['usage']],
  ['/chat/completions', { model: 'origin', messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'check', parameters: { type: 'object' } } }] }, ['function_tools']],
  ['/responses', { model: 'origin', input: [
    { type: 'function_call', call_id: 'call_1', name: 'check', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'done' },
  ] }, ['function_tools']],
  ['/responses', { model: 'origin', stream: true, input: 'hi',
    tools: [{ type: 'function', name: 'check', parameters: { type: 'object' } }] }, ['usage', 'function_tools']],
])('dispatch supplies captured return requirements for %s', async (path, source, required) => {
  let assessed;
  let sendFactory;
  jest.isolateModules(() => {
    const assessment = require('./protocol-compatibility/assessment');
    assessed = jest.spyOn(assessment, 'assessRequestCompatibility');
    sendFactory = require('./upstream-http').createSendUpstreamRequest;
  });
  const h = harness({
    path, source, chain: ['anthropic/claude-sonnet-4.6', 'next'],
    adapters: { anthropic: adapter('anthropic') }, sendFactory,
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  expect(assessed).toHaveBeenCalledWith(expect.objectContaining({
    body: expect.any(Buffer), candidate: { provider: 'anthropic', model: 'claude-sonnet-4.6' },
    requiredResponseFeatures: required,
  }));
  assessed.mockRestore();
});

test('return-origin pre/post assessments both use the actual origin target reasoning scope', async () => {
  const h = harness({
    provider: 'openai', targetHost: 'api.openai.com',
    source: { model: 'gpt-5.4', input: 'hi', reasoning: { effort: 'high' } },
    chain: ['copilot/high-model', 'openai/gpt-5.5'],
    adapters: { copilot: adapter('copilot') },
    req: { awfRuntimePricing: {
      openai: [{ id: 'gpt-5.4', supportedReasoningEfforts: ['high'] },
        { id: 'gpt-5.5', supportedReasoningEfforts: ['high'] }],
      copilot: [{ id: 'high-model', supportedReasoningEfforts: ['high'] }],
    } },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  h.fail(1).onModelFallback({ reason: 'upstream_5xx' });
  expect(h.attempts.map(a => a.body.model)).toEqual(['gpt-5.4', 'high-model', 'gpt-5.5']);
  const returned = h.observe.mock.calls[1][0];
  expect(returned).toMatchObject({
    provider: 'openai', model: 'gpt-5.5', outcome: 'accepted',
    reasoning: { support: 'supported', scope: { provider: 'openai', channel: 'native-api' } },
  });
  expect(returned.reasoning.scope).not.toHaveProperty('deployment');
});

test.each([
  ['ordered', '/responses', '/chat/completions'],
  ['ordered', '/chat/completions', '/responses'],
  ['alias', '/responses', '/chat/completions'],
  ['alias', '/chat/completions', '/responses'],
])('%s fallback honors captured %s while the next request sees refreshed %s', (route, captured, refreshed) => {
  replaceRuntimeModels('copilot', [{ id: 'candidate', supportedEndpoints: [captured] }]);
  const source = { model: 'origin', input: 'hi' };
  const options = {
    source, chain: route === 'ordered' ? ['candidate'] : [],
    req: {
      awfRuntimePricing: captureRuntimePricing(),
      ...(route === 'alias' ? { awfModelCandidates: ['origin', 'candidate'] } : {}),
    },
  };
  const h = harness(options);
  replaceRuntimeModels('copilot', [{ id: 'candidate', supportedEndpoints: [refreshed] }]);
  const ctx = h.fail(0);
  expect(route === 'ordered'
    ? ctx.onModelFallback({ reason: 'upstream_5xx' }) : ctx.onModelEndpointBlockedRetry()).toBe(true);
  expect(h.attempts[1].options.path).toBe(captured);
  expect(h.attempts[1].body).toEqual(captured === '/responses'
    ? { model: 'candidate', input: 'hi' }
    : { model: 'candidate', messages: [{ role: 'user', content: 'hi' }] });
  expect(h.req.awfRuntimePricing.copilot[0].supportedEndpoints).toEqual([captured]);
  const next = harness({ ...options, req: { ...options.req, awfRuntimePricing: captureRuntimePricing() } });
  const nextCtx = next.fail(0);
  expect(route === 'ordered'
    ? nextCtx.onModelFallback({ reason: 'upstream_5xx' }) : nextCtx.onModelEndpointBlockedRetry()).toBe(true);
  expect(next.attempts[1].options.path).toBe(refreshed);
});

test.each(['/responses', '/chat/completions'])('async cross-provider build cannot drift from captured Copilot %s', async captured => {
  replaceRuntimeModels('copilot', [{ id: 'candidate', supportedEndpoints: [captured] }]);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({
    provider: 'openai', targetHost: 'api.openai.com', source: { model: 'origin', input: 'hi' },
    chain: ['copilot/candidate'], req: { awfRuntimePricing: captureRuntimePricing() },
    adapters: { copilot: adapter('copilot', { getBodyTransform: () => () => pending }) },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  replaceRuntimeModels('copilot', [{ id: 'candidate', supportedEndpoints: [
    captured === '/responses' ? '/chat/completions' : '/responses',
  ] }]);
  release(Buffer.from(JSON.stringify({ model: 'candidate', input: 'hi' })));
  await flush();
  expect(h.attempts).toHaveLength(2);
  expect(h.attempts[1].options.path).toBe(captured);
  expect(h.observe.mock.calls[0][0]).toMatchObject({
    outcome: 'accepted', compatibility: {
      target: captured === '/responses' ? 'responses' : 'chat_completions',
    },
  });
});

test.each(['/responses', '/chat/completions'])('return-origin build retains pinned Copilot %s after refresh', async captured => {
  replaceRuntimeModels('copilot', [{ id: 'candidate', supportedEndpoints: [captured] }]);
  const h = harness({
    source: { model: 'origin', input: 'hi' }, chain: ['openai/gpt-5.4', 'candidate'],
    req: { awfRuntimePricing: captureRuntimePricing() }, adapters: { openai: adapter('openai') },
  });
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  await flush();
  replaceRuntimeModels('copilot', [{ id: 'candidate', supportedEndpoints: [
    captured === '/responses' ? '/chat/completions' : '/responses',
  ] }]);
  expect(h.fail(1).onModelFallback({ reason: 'upstream_5xx' })).toBe(true);
  expect(h.attempts).toHaveLength(3);
  expect(h.attempts[2].options.path).toBe(captured);
});

test('pinned incompatible endpoint remains skipped even when a refreshed catalogue would permit native dispatch', () => {
  replaceRuntimeModels('copilot', [
    { id: 'candidate', supportedEndpoints: ['/chat/completions'] },
    { id: 'next', supportedEndpoints: ['/responses'] },
  ]);
  const source = { model: 'origin', input: 'hi', tools: [{ type: 'custom', name: 'apply_patch' }] };
  const pinned = captureRuntimePricing();
  const h = harness({ source, chain: ['candidate', 'next'], req: { awfRuntimePricing: pinned } });
  replaceRuntimeModels('copilot', [{ id: 'candidate', supportedEndpoints: ['/responses'] }]);
  h.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  expect(h.attempts.map(a => a.body.model)).toEqual(['origin', 'next']);
  expect(h.observe.mock.calls[0][0]).toMatchObject({ model: 'candidate', outcome: 'skipped' });
  const next = harness({ source, chain: ['candidate', 'next'], req: { awfRuntimePricing: captureRuntimePricing() } });
  next.fail(0).onModelFallback({ reason: 'upstream_5xx' });
  expect(next.attempts.map(a => a.body.model)).toEqual(['origin', 'candidate']);
});
