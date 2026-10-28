'use strict';

const https = require('https');
const {
  makeReq, makeRes, makeProxyReq, makeProxyRes, getStructuredLogs, flushPromises,
} = require('./test-helpers/server-mock-factories');

const envKeys = [
  'HTTPS_PROXY', 'AWF_FALLBACK_MODELS', 'AWF_MODEL_FALLBACK', 'AWF_ALLOWED_MODELS',
  'AWF_DISALLOWED_MODELS', 'AWF_MAX_MODEL_MULTIPLIER', 'AWF_MAX_AI_CREDITS',
  'AWF_MODEL_ALIASES', 'AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET', 'AWF_MAX_RUNS',
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

test('does not infer Copilot BYOK deployment availability from catalogue absence', async () => {
  catalog.replaceRuntimeModels('copilot', [record('available')]);
  const { bytes } = await start({ model: 'deployment', messages: [] }, 'copilot', '/chat/completions', { host: 'custom.example.com' });
  expect(sent()).toEqual(bytes);
});

test('preserves strict alias fallback opt-out after alias resolution', async () => {
  load({ AWF_MODEL_ALIASES: '{"models":{"strict":{"patterns":["copilot/primary"],"fallback":false}}}' });
  catalog.replaceRuntimeModels('copilot', [record('primary'), record('next')]);
  const transform = require('./model-config').makeModelBodyTransform(
    'copilot', { copilot: ['primary', 'next'] }, async () => {},
  );
  const { req } = await start({ model: 'strict', messages: [] }, 'copilot', '/chat/completions', { transform });
  expect(JSON.parse(sent()).model).toBe('primary');
  expect(req.awfModelRecoveryDisabled).toBe(true);
  await reject(0, 404, 'model_not_found');
  expect(requests).toHaveLength(1);
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
