'use strict';

const https = require('https');
const {
  makeReq, makeRes, makeProxyReq, makeProxyRes, getStructuredLogs, flushPromises,
} = require('./test-helpers/server-mock-factories');

const envKeys = [
  'HTTPS_PROXY', 'AWF_FALLBACK_MODELS', 'AWF_MODEL_FALLBACK', 'AWF_ALLOWED_MODELS',
  'AWF_DISALLOWED_MODELS', 'AWF_MAX_MODEL_MULTIPLIER', 'AWF_MAX_AI_CREDITS',
  'AWF_MODEL_ALIASES', 'AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET', 'AWF_ENCLAVE_AGENT_PROXY', 'AWF_MAX_RUNS',
];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let proxyRequest, catalog, logs, requests, responses;

function record(id, overrides = {}) {
  return {
    id, supportedEndpoints: ['/chat/completions', '/responses'],
    supportedReasoningEfforts: ['low', 'high'],
    capabilities: { supports: { tool_calls: true, streaming: true } },
    ...overrides,
  };
}

function load(env = {}) {
  jest.resetModules();
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, env);
  ({ proxyRequest } = require('./proxy-request'));
  catalog = require('./runtime-model-catalog');
}

beforeEach(() => {
  logs = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  requests = [];
  responses = [];
  jest.spyOn(https, 'request').mockImplementation((options, cb) => {
    const outgoing = makeProxyReq();
    requests.push({ options, outgoing });
    responses.push(cb);
    return outgoing;
  });
  load();
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function start(body = { model: 'gpt-5-codex', messages: [] }, provider = 'copilot', path = '/v1/chat/completions', options = {}) {
  const req = makeReq(path, options.headers);
  Object.assign(req, options.req || {});
  const res = makeRes();
  proxyRequest(req, res, options.host || 'api.githubcopilot.com', {}, provider, '', options.transform || null);
  const bytes = Buffer.from(JSON.stringify(body));
  req.emit('data', bytes);
  req.emit('end');
  await flushPromises();
  return { req, res, bytes };
}

function sent(index = 0) {
  return Buffer.concat(requests[index].outgoing.write.mock.calls.map(([chunk]) => chunk));
}

async function reject(index, status = 400, code = 'model_not_supported') {
  const response = makeProxyRes(status);
  responses[index](response);
  response.emit('data', Buffer.from(JSON.stringify({ error: { code, message: code } })));
  response.emit('end');
  await flushPromises();
}

test('prefers the available retirement suggestion and warns without request contents', async () => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-6-sol'), record('gpt-5.3-codex')]);
  const body = {
    model: 'copilot/gpt-5-codex', messages: [{ role: 'user', content: 'private prompt' }],
    tools: [{ type: 'function', function: { name: 'check' } }], reasoning_effort: 'high',
  };
  const { req } = await start(body);
  expect(JSON.parse(sent())).toEqual({ ...body, model: 'gpt-5.3-codex' });
  expect(requests[0].options.path).toBe('/v1/chat/completions');
  expect(requests[0].options.headers['content-length']).toBe(String(sent().length));
  expect(req.awfModelFallback).toMatchObject({ requested_model: body.model, model: 'gpt-5.3-codex', reason: 'retired_model' });
  const warnings = getStructuredLogs(logs, 'model_fallback');
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatchObject({
    level: 'warn', provider: 'copilot', requested_model: body.model,
    from_model: 'gpt-5-codex', to_model: 'gpt-5.3-codex', reason: 'retired_model',
  });
  expect(JSON.stringify(warnings)).not.toContain('private prompt');
});

test('translates Codex tool-call history before testing recovery compatibility', async () => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  await start({
    model: 'copilot/gpt-5-codex',
    input: [
      { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch\n' },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Done' },
    ],
  }, 'copilot', '/v1/responses');
  expect(JSON.parse(sent())).toMatchObject({
    model: 'gpt-5.3-codex',
    input: [
      { type: 'function_call', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch\n' }) },
      { type: 'function_call_output', output: 'Done' },
    ],
  });
});

test('uses deterministic compatible catalog alternatives when the suggestion is absent', async () => {
  catalog.replaceRuntimeModels('copilot', [record('model-2'), record('model-3'), record('model-1')]);
  await start();
  expect(JSON.parse(sent()).model).toBe('model-3');
});

test('skips an incompatible suggestion rather than stripping the requested effort', async () => {
  catalog.replaceRuntimeModels('copilot', [
    record('gpt-5.3-codex', { supportedReasoningEfforts: ['low'] }), record('compatible'),
  ]);
  await start({ model: 'gpt-5-codex', messages: [], reasoning_effort: 'high' });
  expect(JSON.parse(sent())).toMatchObject({ model: 'compatible', reasoning_effort: 'high' });
});

test('recovers a concrete unavailable model but leaves valid requests byte-for-byte unchanged', async () => {
  catalog.replaceRuntimeModels('copilot', [record('available')]);
  const { bytes } = await start({ model: 'available', messages: [] });
  expect(sent()).toEqual(bytes);
  expect(getStructuredLogs(logs, 'model_fallback')).toHaveLength(0);
  await start({ model: 'missing', messages: [] });
  expect(JSON.parse(sent(1)).model).toBe('available');
  expect(getStructuredLogs(logs, 'model_fallback')[0].reason).toBe('model_unavailable');
});

test.each([
  ['wrong endpoint', { supportedEndpoints: ['/messages'] }, {}],
  ['effort', { supportedReasoningEfforts: ['low'] }, { reasoning_effort: 'high' }],
  ['tools', { capabilities: { supports: { tool_calls: false } } }, { tools: [{ type: 'function', function: { name: 'check' } }] }],
  ['native custom tools', {}, { tools: [{ type: 'custom', custom: { name: 'check' } }] }],
  ['streaming', { capabilities: { supports: {} } }, { stream: true }],
  ['hosted tools', {}, { tools: [{ type: 'web_search' }] }],
  ['structured output', {}, { response_format: { type: 'json_schema' } }],
  ['parallel tools', {}, { parallel_tool_calls: true }],
  ['images', {}, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'private' } }] }] }],
  ['unknown feature', {}, { unsupported_feature: true }],
  ['picker disabled', { modelPickerEnabled: false }, {}],
  ['query parameters', {}, { model: 'gpt-5-codex?effort=high' }],
  ['output limit', { capabilities: { limits: { max_output_tokens: 10 } } }, { max_tokens: 100 }],
  ['unknown output limit', {}, { max_tokens: 100 }],
])('does not drop %s to recover a request', async (_name, metadata, extra) => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex', metadata)]);
  const { res } = await start({ model: 'gpt-5-codex', messages: [], ...extra });
  expect(requests).toHaveLength(0);
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_recovery_exhausted');
});

test.each([
  { AWF_ALLOWED_MODELS: '["allowed"]' },
  { AWF_DISALLOWED_MODELS: '["gpt-5.3-codex"]' },
])('filters replacement candidates through model policy %j', async env => {
  load(env);
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex'), record('allowed')]);
  await start();
  expect(JSON.parse(sent()).model).toBe('allowed');
});

test('does not bypass multiplier restrictions', async () => {
  load({ AWF_MAX_MODEL_MULTIPLIER: '0.5' });
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  const { res } = await start();
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_recovery_exhausted');
});

test('does not bypass missing credit pricing', async () => {
  load({ AWF_MAX_AI_CREDITS: '1' });
  catalog.replaceRuntimeModels('copilot', [record('unknown-unpriceable')]);
  const { res } = await start();
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_recovery_exhausted');
});

test('allows recovery to a priceable model with a credit budget', async () => {
  load({ AWF_MAX_AI_CREDITS: '1' });
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  await start();
  expect(requests).toHaveLength(1);
  expect(JSON.parse(sent()).model).toBe('gpt-5.3-codex');
});

test('skips pricing-error candidates while recovering to a priceable model', async () => {
  load({ AWF_MAX_AI_CREDITS: '1' });
  catalog.replaceRuntimeModels('copilot', [
    record('invalid-pricing', { pricingError: true }),
    record('gpt-5.3-codex'),
  ]);
  await start();
  expect(requests).toHaveLength(1);
  expect(JSON.parse(sent()).model).toBe('gpt-5.3-codex');
});

test.each([
  { AWF_MODEL_FALLBACK: '{"enabled":false}' },
  { AWF_MODEL_FALLBACK: '{"excludeEngines":["copilot"]}' },
])('respects disabled recovery %j', async env => {
  load(env);
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  await start();
  expect(requests).toHaveLength(0);
  expect(getStructuredLogs(logs, 'model_fallback')).toHaveLength(0);
});

test.each([[400, 'model_not_supported'], [404, 'model_not_found']])(
  'recovers from upstream %s %s without an explicit chain', async (status, code) => {
    catalog.replaceRuntimeModels('copilot', [record('primary'), record('next')]);
    const { req } = await start({ model: 'primary', messages: [] });
    await reject(0, status, code);
    expect(requests).toHaveLength(2);
    expect(JSON.parse(sent(1)).model).toBe('next');
    expect(req.awfModelFallback).toMatchObject({ requested_model: 'primary', model: 'next', reason: 'model_not_supported' });
    expect(getStructuredLogs(logs, 'model_fallback')).toHaveLength(1);
  },
);

test('retains explicit configured ordering before automatic alternatives', async () => {
  process.env.AWF_FALLBACK_MODELS = 'chosen-1,chosen-2';
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next')]);
  await start({ model: 'primary', messages: [] });
  await reject(0);
  expect(JSON.parse(sent(1)).model).toBe('chosen-1');
  await reject(1);
  expect(JSON.parse(sent(2)).model).toBe('chosen-2');
  await reject(2);
  expect(JSON.parse(sent(3)).model).toBe('next');
});

test.each([401, 403, 429, 500])('does not automatically switch on upstream %s', async status => {
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next')]);
  await start({ model: 'primary', messages: [] });
  await reject(0, status);
  expect(requests).toHaveLength(1);
});

test('bounds automatic attempts and reports exhaustion without repeating models', async () => {
  catalog.replaceRuntimeModels('copilot', ['primary', 'next-1', 'next-2', 'next-3', 'next-4'].map(id => record(id)));
  const { res } = await start({ model: 'primary', messages: [] });
  for (let index = 0; index < 4; index++) await reject(index);
  expect(requests).toHaveLength(4);
  expect(new Set(requests.map((_, index) => JSON.parse(sent(index)).model)).size).toBe(4);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_fallback_exhausted');
});

test('fails clearly when an upstream rejection has no compatible replacement', async () => {
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next', { supportedReasoningEfforts: ['low'] })]);
  const { res } = await start({ model: 'primary', messages: [], reasoning_effort: 'high' });
  await reject(0);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_fallback_exhausted');
});

test('does not reduce the known context window when replacing an unavailable model', async () => {
  catalog.replaceRuntimeModels('copilot', [
    record('primary', { capabilities: { limits: { max_context_window_tokens: 100_000 } } }),
    record('next', { capabilities: { limits: { max_context_window_tokens: 50_000 } } }),
  ]);
  const { res } = await start({ model: 'primary', messages: [] });
  await reject(0);
  expect(requests).toHaveLength(1);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_fallback_exhausted');
});

test.each([8192, undefined])(
  'does not reduce a known output ceiling when the request omits a cap (candidate limit: %s)',
  async outputLimit => {
    catalog.replaceRuntimeModels('copilot', [
      record('primary', { capabilities: { supports: { tool_calls: true }, limits: { max_output_tokens: 32_000 } } }),
      record('next', { capabilities: { supports: { tool_calls: true }, ...(outputLimit ? { limits: { max_output_tokens: outputLimit } } : {}) } }),
    ]);
    const { res } = await start({ model: 'primary', messages: [] });
    await reject(0);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_fallback_exhausted');
  },
);

test('ignores opaque tool arguments and image source metadata but checks nested tool-result images', () => {
  const { isRecoveryCompatible } = require('./model-recovery');
  const candidate = record('messages-model', {
    supportedEndpoints: ['/messages'],
    capabilities: { supports: { tool_calls: true, vision: true } },
  });
  const request = {
    model: 'original',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'issue', input: { type: 'issue', title: 'Bug' } }] },
      { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'opaque' } }] }] },
    ],
  };
  expect(isRecoveryCompatible(candidate, 'anthropic', request, '/v1/messages')).toBe(true);
  expect(isRecoveryCompatible({
    ...candidate,
    capabilities: { supports: { tool_calls: true, vision: false } },
  }, 'anthropic', request, '/v1/messages')).toBe(false);
});

test('returns to the original endpoint when replacing a model rejected on both wire APIs', async () => {
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next')]);
  await start({ model: 'primary', messages: [] });
  for (const index of [0, 1]) {
    const response = makeProxyRes(400);
    responses[index](response);
    response.emit('data', Buffer.from(JSON.stringify({
      message: `model "primary" is not accessible via the ${index === 0 ? '/chat/completions' : '/responses'} endpoint`,
    })));
    response.emit('end');
    await flushPromises();
  }
  expect(JSON.parse(sent(2))).toMatchObject({ model: 'next', messages: [] });
  expect(requests.map(attempt => attempt.options.path))
    .toEqual(['/v1/chat/completions', '/v1/responses', '/v1/chat/completions']);
});

test('keeps the captured catalog and pricing stable across retries', async () => {
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next')]);
  const { req } = await start({ model: 'primary', messages: [] });
  const snapshot = structuredClone(req.awfRuntimePricing);
  catalog.replaceRuntimeModels('copilot', [record('newer')]);
  await reject(0);
  expect(JSON.parse(sent(1)).model).toBe('next');
  expect(req.awfRuntimePricing).toEqual(snapshot);
});

test('does not re-route a compatible replacement using metadata refreshed during the request', async () => {
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next')]);
  await start({ model: 'primary', input: 'check' }, 'copilot', '/v1/responses');
  catalog.replaceRuntimeModels('copilot', [record('next', { supportedEndpoints: ['/chat/completions'] })]);
  await reject(0);
  expect(JSON.parse(sent(1))).toMatchObject({ model: 'next', input: 'check' });
  expect(requests[1].options.path).toBe('/v1/responses');
});

test('keeps the original endpoint when metadata refreshes during body transformation', async () => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  await start(
    { model: 'gpt-5-codex', input: 'check' },
    'copilot',
    '/v1/responses',
    { transform: async body => {
      catalog.replaceRuntimeModels('copilot', [
        record('gpt-5.3-codex', { supportedEndpoints: ['/chat/completions'] }),
      ]);
      return body;
    } },
  );
  expect(JSON.parse(sent())).toMatchObject({ model: 'gpt-5.3-codex', input: 'check' });
  expect(requests[0].options.path).toBe('/v1/responses');
});

test('uses the post-resolution catalogue generation for automatic retries', async () => {
  load({
    AWF_MODEL_ALIASES: JSON.stringify({
      models: { 'new-selector': { patterns: ['copilot/new-model'], fallback: true } },
    }),
  });
  catalog.replaceRuntimeModels('copilot', [record('old-model')]);
  const cachedModels = { copilot: ['old-model'] };
  const transform = require('./model-config').makeModelBodyTransform(
    'copilot',
    cachedModels,
    async () => {
      catalog.replaceRuntimeModels('copilot', [record('new-model'), record('next')]);
      cachedModels.copilot = ['new-model', 'next'];
    },
    undefined,
    () => catalog.getRuntimeModels('copilot'),
  );
  const { req } = await start(
    { model: 'new-selector', messages: [] },
    'copilot',
    '/v1/chat/completions',
    { transform },
  );
  expect(JSON.parse(sent()).model).toBe('new-model');
  expect(req.awfRuntimePricing.copilot.map(model => model.id)).toEqual(['new-model', 'next']);
  await reject(0);
  expect(JSON.parse(sent(1)).model).toBe('next');
});

test('does not infer Copilot BYOK deployment availability from catalogue absence', async () => {
  catalog.replaceRuntimeModels('copilot', [record('available')]);
  const { bytes } = await start({ model: 'deployment', messages: [] }, 'copilot', '/chat/completions', { host: 'custom.example.com' });
  expect(sent()).toEqual(bytes);
});

test.each([
  [
    'qualified alias selector',
    { strict: { patterns: ['copilot/primary'], fallback: false } },
    { model: 'strict (copilot)', messages: [] },
    'primary',
  ],
  [
    'family alias',
    { 'gpt-5': { patterns: ['copilot/gpt-5.3-codex'], fallback: false } },
    { model: 'gpt-5.4', messages: [] },
    'gpt-5.3-codex',
  ],
  [
    'default alias',
    { '': { patterns: ['copilot/primary'], fallback: false } },
    { messages: [] },
    'primary',
  ],
])('preserves strict alias fallback opt-out for %s', async (_name, aliases, body, model) => {
  load({ AWF_MODEL_ALIASES: JSON.stringify({ models: aliases }) });
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next'), record('gpt-5.3-codex')]);
  const transform = require('./model-config').makeModelBodyTransform(
    'copilot', { copilot: ['primary', 'next', 'gpt-5.3-codex'] }, async () => {},
  );
  const { req } = await start(body, 'copilot', '/chat/completions', { transform });
  expect(JSON.parse(sent()).model).toBe(model);
  expect(req.awfModelRecoveryDisabled).toBe(true);
  await reject(0, 404, 'model_not_found');
  expect(requests).toHaveLength(1);
});

test('does not dispatch uncharacterized replacement protocols even with explicit chains', async () => {
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next')]);
  const { res } = await start({ model: 'primary', input: 'query' }, 'copilot', '/v1/embeddings');
  await reject(0, 400, 'model_not_supported');
  expect(requests).toHaveLength(1);
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));

  load({ AWF_FALLBACK_MODELS: 'next' });
  requests = [];
  responses = [];
  catalog.replaceRuntimeModels('openai', [record('primary'), record('next')]);
  expect(require('./model-fallback-chain').getFallbackModels()).toEqual(['next']);
  const { req, res: explicitRes } = await start(
    { model: 'primary', input: 'query' },
    'openai',
    '/v1/embeddings',
    { host: 'api.openai.com' },
  );
  await reject(0, 400, 'model_not_supported');
  expect(requests).toHaveLength(1);
  expect(req.awfModelFallback).toBeUndefined();
  expect(explicitRes.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
});

test('validates retry effort against the captured runtime catalogue', async () => {
  catalog.replaceRuntimeModels('copilot', [
    record('primary', { supportedReasoningEfforts: ['high'] }),
    record('next', { supportedReasoningEfforts: ['high'] }),
  ]);
  const { req } = await start({ model: 'primary', messages: [], reasoning_effort: 'high' });
  catalog.replaceRuntimeModels('copilot', [
    record('next', { supportedReasoningEfforts: ['low'] }),
  ]);
  await reject(0);
  expect(requests).toHaveLength(2);
  expect(JSON.parse(sent(1))).toMatchObject({ model: 'next', reasoning_effort: 'high' });
  expect(req.awfRuntimePricing.copilot.map(model => model.id)).toEqual(['primary', 'next']);
});

test('cannot bypass enclave capabilities during pre-dispatch replacement', async () => {
  load({ AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET: 'a'.repeat(64) });
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  const { res } = await start();
  expect(requests).toHaveLength(0);
  expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('awf_enclave_model_budget_invalid_capability');
});

test('charges automatic retries to the same enclave invocation request budget', async () => {
  const secret = 'a'.repeat(64);
  load({ AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET: secret });
  const payload = Buffer.from(JSON.stringify({
    v: 1, invocationId: 'invocation-model-recovery01', maxRequests: 1, maxTokens: null,
  })).toString('base64url');
  const signature = require('crypto').createHmac('sha256', Buffer.from(secret, 'hex')).update(payload).digest('base64url');
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next')]);
  const { res } = await start({ model: 'primary', messages: [] }, 'copilot', '/chat/completions', {
    headers: { authorization: `Bearer ${payload}.${signature}` },
  });
  await reject(0);
  expect(requests).toHaveLength(1);
  expect(res.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('awf_enclave_model_budget_request_limit');
});

test('preserves invocation cap responses rather than hiding them as recovery failures', async () => {
  load({ AWF_MAX_RUNS: '1' });
  require('./guards/max-runs-guard').applyMaxRunsInvocation();
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  const { res } = await start();
  expect(requests).toHaveLength(0);
  expect(res.writeHead).toHaveBeenCalledWith(429, expect.any(Object));
});

test('does not infer deployment unavailability from a custom provider catalog', async () => {
  catalog.replaceRuntimeModels('openai', [record('available')]);
  const { bytes } = await start({ model: 'custom-deployment', messages: [] }, 'openai');
  expect(sent()).toEqual(bytes);
  await reject(0, 404, 'model_not_found');
  expect(JSON.parse(sent(1)).model).toBe('available');
});

test.each(['unverified', 'incompatible'])('pre-dispatch recovery skips a shared %s reasoning decision and follows approved order', async status => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex'), record('compatible')]);
  const { resolveModelReasoning } = require('./model-reasoning');
  const awfReasoning = resolveModelReasoning('gpt-5.3-codex', 'copilot', {
    records: status === 'unverified' ? [] : [record('gpt-5.3-codex', { supportedReasoningEfforts: [] })],
    maintained: false,
  });
  const observe = jest.fn();
  const body = { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], reasoning_effort: 'high' };
  const { req } = await start(body, 'copilot', '/chat/completions', {
    req: { awfReasoning, awfObserveModelDecision: observe },
  });
  expect(requests).toHaveLength(1);
  expect(JSON.parse(sent())).toEqual({ ...body, model: 'compatible' });
  expect(observe.mock.calls.map(([r]) => [r.model, r.outcome, r.compatibility.status])).toEqual([
    ['gpt-5.3-codex', 'skipped', status], ['compatible', 'accepted', 'compatible'],
  ]);
  expect(observe.mock.calls[0][0]).toMatchObject({
    originProvider: 'copilot', originModel: 'gpt-5-codex', endpoint: '/chat/completions',
    eligibilityRevision: req.awfEligibility.revision, catalogueRevision: req.awfCatalogue?.revision,
  });
  expect(req.awfRecoveryAttempts).toEqual([
    { provider: 'copilot', model: 'gpt-5-codex' }, { provider: 'copilot', model: 'compatible' },
  ]);
  expect(JSON.stringify(observe.mock.calls)).not.toContain('PRIVATE_PROMPT');
});

test('pre-dispatch recovery exhausts future efforts without sending inference or changing its public error', async () => {
  catalog.replaceRuntimeModels('copilot', [
    record('gpt-5.3-codex', { supportedReasoningEfforts: ['future-effort'] }),
    record('compatible', { supportedReasoningEfforts: ['future-effort'] }),
  ]);
  const observe = jest.fn();
  const { req, res } = await start({
    model: 'gpt-5-codex', messages: [], reasoning_effort: 'future-effort',
  }, 'copilot', '/chat/completions', { req: { awfObserveModelDecision: observe } });
  expect(requests).toHaveLength(0);
  expect(observe.mock.calls.map(([r]) => [r.model, r.outcome])).toEqual([
    ['gpt-5.3-codex', 'skipped'], ['compatible', 'skipped'], [null, 'exhausted'],
  ]);
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_recovery_exhausted');
  expect(req.awfRecoveryAttempts).toBeUndefined();
  expect(req.awfModelFallback).toBeUndefined();
});

test('pre-dispatch recovery accepts unknown native reasoning omission but never emits for a valid direct request', async () => {
  const records = [record('gpt-5.3-codex', { supportedReasoningEfforts: undefined })];
  catalog.replaceRuntimeModels('copilot', records);
  const observe = jest.fn();
  await start({ model: 'gpt-5-codex', messages: [] }, 'copilot', '/chat/completions', {
    req: { awfObserveModelDecision: observe },
  });
  expect(JSON.parse(sent()).model).toBe('gpt-5.3-codex');
  expect(observe.mock.calls[0][0]).toMatchObject({
    outcome: 'accepted', reason: 'fallback_compatible', reasoning: { support: 'unknown' },
  });
  const directObserve = jest.fn();
  const { bytes } = await start({ model: 'gpt-5.3-codex', messages: [] }, 'copilot', '/chat/completions', {
    req: { awfObserveModelDecision: directObserve },
  });
  expect(sent(1)).toEqual(bytes);
  expect(directObserve).not.toHaveBeenCalled();
});

test('bounded assessment blocks deeply nested automatic replacement but leaves the same direct request untouched', async () => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  let schema = { type: 'string' };
  for (let i = 0; i < 40; i++) schema = { type: 'object', properties: { next: schema } };
  const fields = { messages: [], tools: [{ type: 'function', function: { name: 'check', parameters: schema } }] };
  const observe = jest.fn();
  const { res } = await start({ model: 'gpt-5-codex', ...fields }, 'copilot', '/chat/completions', {
    req: { awfObserveModelDecision: observe },
  });
  expect(requests).toHaveLength(0);
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(observe.mock.calls.map(([r]) => r.outcome)).toEqual(['skipped', 'exhausted']);
  expect(observe.mock.calls[0][0].compatibility.reasons).toContainEqual({
    feature: 'unknown_fields', code: 'assessment_limit',
  });
  const { bytes } = await start({ model: 'gpt-5.3-codex', ...fields });
  expect(sent()).toEqual(bytes);
});

test('pre-dispatch recovery and later fallback retain the same original native model identity', async () => {
  load({ AWF_FALLBACK_MODELS: 'other' });
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex'), record('other')]);
  const observe = jest.fn();
  await start({ model: 'copilot/gpt-5-codex', messages: [] }, 'copilot', '/chat/completions', {
    req: { awfObserveModelDecision: observe },
  });
  await reject(0, 503, 'overloaded');
  expect(requests).toHaveLength(2);
  expect(observe.mock.calls.map(([r]) => [r.model, r.originModel])).toEqual([
    ['gpt-5.3-codex', 'gpt-5-codex'], ['other', 'gpt-5-codex'],
  ]);
});

test('pre-dispatch recovery skips a known required omission using the shared pinned decision', async () => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex'), record('compatible')]);
  const { resolveReasoning } = require('./catalogue-contract/reasoning');
  const { identity } = require('./catalogue-contract/identity');
  const modelIdentity = identity('copilot', 'gpt-5.3-codex');
  const scope = { provider: 'copilot', channel: 'copilot-api' };
  const awfReasoning = resolveReasoning({
    identity: modelIdentity, scope, facts: [{
      identity: modelIdentity, scope, active: true, authority: 'provider',
      support: 'supported', mode: 'required', rawEfforts: ['high'],
    }],
  });
  const observe = jest.fn();
  await start({ model: 'gpt-5-codex', messages: [] }, 'copilot', '/chat/completions', {
    req: { awfReasoning, awfObserveModelDecision: observe },
  });
  expect(JSON.parse(sent()).model).toBe('compatible');
  expect(observe.mock.calls[0][0]).toMatchObject({
    outcome: 'skipped', reason: 'fallback_incompatible',
    compatibility: { reasoning: { support: 'supported', mode: 'required', code: 'reasoning_effort_required' } },
  });
});

test('pre-dispatch reasoning checks use the trusted concrete target scope instead of native defaults', async () => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  const observe = jest.fn();
  const host = 'deployment.example.test';
  const { res } = await start({
    model: 'gpt-5-codex', messages: [], reasoning_effort: 'high',
  }, 'copilot', '/chat/completions', {
    host, req: { awfFallbackTarget: { targetHost: host, targetScheme: 'https' }, awfObserveModelDecision: observe },
  });
  expect(requests).toHaveLength(0);
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(observe.mock.calls[0][0]).toMatchObject({
    outcome: 'skipped', reason: 'fallback_unverified',
    reasoning: { scope: { deployment: `https://${host}` } },
  });
});

test('pre-dispatch recovery remains successful when optional observation throws', async () => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex')]);
  await start(undefined, 'copilot', '/chat/completions', {
    req: { awfObserveModelDecision: () => { throw new Error('diagnostics failed'); } },
  });
  expect(requests).toHaveLength(1);
  expect(JSON.parse(sent()).model).toBe('gpt-5.3-codex');
});

test('pre-dispatch native recovery honors Chat completion-limit precedence without weakening candidate limits', async () => {
  const boundedRecord = (id, maxOutput) => record(id, {
    capabilities: { supports: { tool_calls: true }, limits: { max_output_tokens: maxOutput } },
  });
  catalog.replaceRuntimeModels('copilot', [
    boundedRecord('gpt-5.3-codex', 50), boundedRecord('compatible', 150),
  ]);
  const body = { model: 'gpt-5-codex', messages: [], max_tokens: 10, max_completion_tokens: 100 };
  await start(body);
  expect(JSON.parse(sent())).toEqual({ ...body, model: 'compatible' });
});

test('pre-dispatch assessment retains runtime pins across an asynchronous transform and catalogue refresh', async () => {
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex', { supportedReasoningEfforts: ['high'] })]);
  const observe = jest.fn();
  const { req } = await start({
    model: 'gpt-5-codex', messages: [], reasoning_effort: 'high',
  }, 'copilot', '/chat/completions', {
    req: { awfObserveModelDecision: observe },
    transform: async body => {
      catalog.replaceRuntimeModels('copilot', [record('gpt-5.3-codex', { supportedReasoningEfforts: ['low'] })]);
      return body;
    },
  });
  expect(JSON.parse(sent())).toMatchObject({ model: 'gpt-5.3-codex', reasoning_effort: 'high' });
  expect(req.awfRuntimePricing.copilot[0].supportedReasoningEfforts).toEqual(['high']);
  expect(observe.mock.calls[0][0]).toMatchObject({
    outcome: 'accepted', reasoning: { supportedEfforts: ['high'] },
    compatibility: { pins: {
      eligibilityRevision: req.awfEligibility.revision, catalogueRevision: req.awfCatalogue?.revision ?? null,
    } },
  });
});

test('real nested initial family fallback skips incompatible wire routing and sends the next already-ranked model', async () => {
  load({ AWF_MODEL_ALIASES: JSON.stringify({ models: { outer: ['gpt-5.9', 'copilot/gpt-4.1'] } }) });
  catalog.replaceRuntimeModels('copilot', [
    record('gpt-5.4', { supportedEndpoints: ['/responses'] }),
    record('gpt-4.1', { supportedEndpoints: ['/chat/completions'] }),
  ]);
  const { makeModelBodyTransform } = require('./model-config');
  const refresh = jest.fn(async () => {});
  const transform = makeModelBodyTransform('copilot', { copilot: ['gpt-5.4', 'gpt-4.1'] },
    refresh, null, catalog.getRuntimeModels, true);
  const observe = jest.fn();
  const body = { model: 'outer', messages: [{ role: 'developer', content: 'PRIVATE_RULES' }, { role: 'user', content: 'hi' }] };
  const { req } = await start(body, 'copilot', '/chat/completions', {
    transform, req: { awfObserveModelDecision: observe },
  });
  expect(requests).toHaveLength(1);
  expect(JSON.parse(sent())).toEqual({ ...body, model: 'gpt-4.1' });
  expect(requests[0].options.path).toBe('/chat/completions');
  expect(req.awfResolverFallback).toMatchObject({
    provider: 'copilot', originalModel: 'outer', fromModel: 'outer', model: 'gpt-5.4',
    candidates: ['gpt-5.4', 'gpt-4.1'],
  });
  expect(Object.isFrozen(req.awfResolverFallback.candidates)).toBe(true);
  expect(observe.mock.calls.map(([r]) => [r.model, r.outcome])).toEqual([
    ['gpt-5.4', 'skipped'], ['gpt-4.1', 'accepted'],
  ]);
  expect(refresh).not.toHaveBeenCalled();
  expect(JSON.stringify(observe.mock.calls)).not.toContain('PRIVATE_RULES');
});

test('initial automatic fallback exhaustion sends the existing 400 without inference', async () => {
  load({ AWF_MODEL_ALIASES: JSON.stringify({ models: { outer: ['gpt-5.9'] } }) });
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.4', { supportedEndpoints: ['/responses'] })]);
  const transform = require('./model-config').makeModelBodyTransform('copilot', { copilot: ['gpt-5.4'] },
    async () => {}, null, catalog.getRuntimeModels, true);
  const observe = jest.fn();
  const { res } = await start({ model: 'outer', messages: [
    { role: 'developer', content: 'rule' }, { role: 'user', content: 'hello' },
  ] }, 'copilot', '/chat/completions', { transform, req: { awfObserveModelDecision: observe } });
  expect(requests).toHaveLength(0);
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_recovery_exhausted');
  expect(observe.mock.calls.map(([r]) => [r.model, r.outcome])).toEqual([
    ['gpt-5.4', 'skipped'], [null, 'exhausted'],
  ]);
});

test('an explicitly authorized initial alias remains a direct primary request', async () => {
  load({ AWF_MODEL_ALIASES: JSON.stringify({ models: { outer: ['copilot/gpt-5.4'] } }) });
  catalog.replaceRuntimeModels('copilot', [record('gpt-5.4', { supportedEndpoints: ['/responses'] })]);
  const transform = require('./model-config').makeModelBodyTransform('copilot', { copilot: ['gpt-5.4'] },
    async () => {}, null, catalog.getRuntimeModels, true);
  const observe = jest.fn();
  const { req } = await start({ model: 'outer', messages: [
    { role: 'developer', content: 'rule' }, { role: 'user', content: 'hello' },
  ] }, 'copilot', '/chat/completions', { transform, req: { awfObserveModelDecision: observe } });
  expect(requests).toHaveLength(1);
  expect(requests[0].options.path).toBe('/responses');
  expect(JSON.parse(sent()).instructions).toBe('rule');
  expect(req.awfResolverFallback).toBeUndefined();
  expect(observe).not.toHaveBeenCalled();
});

test('real synthesized middle-power fallback is marked and rejects unverified effort before inference', async () => {
  load({ AWF_MODEL_ALIASES: JSON.stringify({ models: { direct: ['copilot/gpt-5.4'] } }) });
  const ids = ['gpt-5.4', 'gpt-4.1', 'gpt-3.5-turbo'];
  catalog.replaceRuntimeModels('copilot', ids.map(id => record(id, {
    supportedEndpoints: ['/chat/completions'], supportedReasoningEfforts: ['future-effort'],
  })));
  const refresh = jest.fn(async () => {});
  const transform = require('./model-config').makeModelBodyTransform('copilot', { copilot: ids },
    refresh, null, catalog.getRuntimeModels, true);
  const observe = jest.fn();
  const { req, res } = await start({ model: 'missing', messages: [], reasoning_effort: 'future-effort' },
    'copilot', '/chat/completions', { transform, req: { awfObserveModelDecision: observe } });
  expect(requests).toHaveLength(0);
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_recovery_exhausted');
  expect(req.awfResolverFallback).toMatchObject({ originalModel: 'missing', model: 'gpt-4.1' });
  expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
  expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('model_recovery_exhausted');
  expect(observe.mock.calls.map(([r]) => [r.model, r.outcome])).toEqual([
    ['gpt-4.1', 'skipped'], [null, 'exhausted'],
  ]);
  expect(refresh).toHaveBeenCalledTimes(1);
});
