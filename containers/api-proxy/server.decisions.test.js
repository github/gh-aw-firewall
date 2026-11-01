'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupServerTestEnv, getStructuredLogs } = require('./test-helpers/server-mock-factories');

let OpenAI;
if (Number(process.versions.node.split('.')[0]) >= 22) {
  try {
    ({ OpenAI } = require('openai'));
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
  }
}
const hasDecisionsSdk = typeof OpenAI === 'function' &&
  typeof new OpenAI({ apiKey: 'awf-placeholder' }).decisions?.create === 'function';
const sdkTest = hasDecisionsSdk ? test : test.skip;

const questions = [
  { type: 'predicate', name: 'correct', instructions: 'Is the answer correct?' },
  { type: 'choice', name: 'route', instructions: 'Choose a route.', choices: [{ value: false }, { value: 'false' }] },
  { type: 'score', name: 'quality', instructions: 'Rate quality.', levels: [{ label: 'poor' }, { label: 'good' }] },
];
const decision = {
  model: 'gpt-6-luna',
  answers: [
    { type: 'predicate', name: 'correct', probability: 0.95 },
    { type: 'choice', name: 'route', choice: false, confidence: 0.9,
      probabilities: [{ value: false, probability: 0.9 }, { value: 'false', probability: 0.1 }] },
    { type: 'score', name: 'quality', score: 0.8, confidence: 0.8,
      probabilities: [{ label: 'poor', value: 0, probability: 0.2 }, { label: 'good', value: 1, probability: 0.8 }] },
  ],
  usage: {
    input_tokens: 1000, output_tokens: 50, total_tokens: 1050,
    input_tokens_details: { cached_tokens: 400, cache_write_tokens: 300 },
    output_tokens_details: { reasoning_tokens: 20 },
  },
};

describe('OpenAI Decisions HTTP conformance', () => {
  const envKeys = ['AWF_ALLOWED_MODELS', 'AWF_DISALLOWED_MODELS', 'AWF_TOKEN_LOG_DIR', 'AWF_MAX_AI_CREDITS', 'AWF_MAX_RUNS'];
  const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  let proxy;
  let upstream;
  let baseURL;
  let requests;
  let respond;
  let proxyCore;
  let closeLogStream;
  let tokenLogDir;

  setupServerTestEnv(() => {
    process.env.AWF_ALLOWED_MODELS = JSON.stringify(['openai/gpt-6-luna', 'openai/gpt-6-sol']);
    process.env.AWF_DISALLOWED_MODELS = JSON.stringify(['openai/gpt-6-sol']);
    tokenLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-decisions-'));
    process.env.AWF_TOKEN_LOG_DIR = tokenLogDir;
    proxyCore = require('./proxy-request');
    ({ closeLogStream } = require('./token-tracker'));
  });

  function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }

  beforeEach(async () => {
    delete process.env.AWF_MAX_AI_CREDITS;
    delete process.env.AWF_MAX_RUNS;
    proxyCore.resetAiCreditsGuardForTests();
    proxyCore.resetMaxRunsGuardForTests();
    requests = [];
    respond = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(decision));
    };
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ url: req.url, headers: req.headers, body });
        respond(req, res);
      });
    });
    await listen(upstream);
    await startProxy();
  });

  async function startProxy(env = {}) {
    const { createOpenAIAdapter } = require('./providers/openai');
    const { createProviderServer } = require('./server-factory');
    const { rewriteModelInBody } = require('./model-body-rewriter');
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'trusted-sidecar-placeholder',
      OPENAI_API_TARGET: `http://127.0.0.1:${upstream.address().port}`,
      OPENAI_API_BASE_PATH: '/v1',
      ...env,
    }, {
      bodyTransform: body => rewriteModelInBody(body, 'openai',
        { grader: ['openai/gpt-6-luna'] }, { openai: ['gpt-6-luna'] }, { enabled: false })?.body || null,
    });
    proxy = createProviderServer(adapter, {
      handleManagementEndpoint: () => false,
      checkRateLimit: proxyCore.checkRateLimit,
      proxyRequest: proxyCore.proxyRequest,
      proxyWebSocket: proxyCore.proxyWebSocket,
    });
    await listen(proxy);
    baseURL = `http://127.0.0.1:${proxy.address().port}/v1`;
  }

  async function post(endpoint, body, { headers = {}, query, signal } = {}) {
    const url = new URL(baseURL + endpoint);
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      method: 'POST', body: JSON.stringify(body), signal,
      headers: { 'content-type': 'application/json', authorization: ['Bearer', 'agent-placeholder'].join(' '), ...headers },
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error('Proxy rejected request'), { status: response.status, error: result.error });
    return result;
  }

  afterEach(async () => {
    for (const server of [proxy, upstream]) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    await closeLogStream();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(tokenLogDir, { recursive: true, force: true });
  });

  sdkTest('client.decisions.create preserves typed questions and the native response', async () => {
    const client = new OpenAI({ baseURL, apiKey: 'agent-placeholder', maxRetries: 0 });
    expect(await client.decisions.create({ model: 'gpt-6-luna', input: 'Evidence', questions })).toEqual(decision);
    expect(requests[0].url).toBe('/v1/decisions');
    expect(JSON.parse(requests[0].body).questions).toEqual(questions);
    expect(requests[0].headers.authorization).toBe(['Bearer', 'trusted-sidecar-placeholder'].join(' '));
  });

  test('preserves a single predicate and injects only sidecar credentials', async () => {
    const result = { ...decision, answers: [decision.answers[0]] };
    respond = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    };
    const body = { model: 'gpt-6-luna', input: 'Evidence', questions: [questions[0]] };
    expect(await post('/decisions', body, {
      headers: { 'api-key': 'untrusted-placeholder', 'x-api-key': 'untrusted-placeholder' },
    })).toEqual(result);
    expect(requests[0].url).toBe('/v1/decisions');
    expect(JSON.parse(requests[0].body)).toEqual(body);
    expect(requests[0].headers.authorization).toBe(['Bearer', 'trusted-sidecar-placeholder'].join(' '));
    expect(requests[0].headers['api-key']).toBeUndefined();
    expect(requests[0].headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('trusted-sidecar-placeholder');
  });

  test('preserves typed questions, conversation history, JSON, images, and cache metadata', async () => {
    const body = {
      model: 'gpt-6-luna',
      input: [
        { role: 'system', content: 'Evaluate the evidence.' },
        { role: 'assistant', content: 'Previous answer.' },
        { role: 'user', content: [
          { type: 'input_text', text: 'Private evaluation evidence', prompt_cache_breakpoint: { mode: 'explicit' } },
          { type: 'input_json', json: { correct: true, nested: [1, false] } },
          { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=', detail: 'low' },
        ] },
        { type: 'function_call', name: 'lookup', arguments: '{}', call_id: 'call-1' },
        { type: 'function_call_output', call_id: 'call-1', output: 'Evidence from lookup' },
      ],
      questions,
      prompt_cache_key: 'private-cache-partition',
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    };
    const logs = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await post('/decisions', body)).toEqual(decision);
    expect(JSON.parse(requests[0].body)).toEqual(body);
    expect(logs.mock.calls.map(([line]) => line).join('')).not.toMatch(/Private evaluation evidence|private-cache-partition|trusted-sidecar-placeholder/);
    await closeLogStream();
    const records = fs.readFileSync(path.join(tokenLogDir, 'token-usage.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    expect(records.at(-1)).toEqual(expect.objectContaining({
      provider: 'openai', model: 'gpt-6-luna', input_tokens: 1000,
      output_tokens: 50, cache_read_tokens: 400, cache_write_tokens: 300,
    }));
  });

  test('honors an Azure-compatible base path, query string, and configured api-key injection', async () => {
    await new Promise(resolve => proxy.close(resolve));
    await startProxy({ OPENAI_API_BASE_PATH: '/openai/v1', AWF_OPENAI_AUTH_HEADER: 'api-key' });
    baseURL = baseURL.replace(/\/v1$/, '');
    await post('/decisions', { model: 'gpt-6-luna', input: 'Evidence', questions }, {
      query: { 'api-version': 'test' },
      headers: { 'api-key': 'untrusted-placeholder' },
    });
    expect(requests[0].url).toBe('/openai/v1/decisions?api-version=test');
    expect(requests[0].headers['api-key']).toBe('trusted-sidecar-placeholder');
    expect(requests[0].headers.authorization).toBeUndefined();
  });

  test('forwards the maximum 400-question batch without splitting or dropping answers', async () => {
    const batch = Array.from({ length: 400 }, (_, index) => ({ ...questions[0], name: `q-${index}` }));
    const answers = batch.map(question => ({ ...decision.answers[0], name: question.name }));
    respond = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...decision, answers }));
    };
    expect((await post('/decisions', { model: 'gpt-6-luna', input: 'Evidence', questions: batch })).answers).toEqual(answers);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0].body).questions).toEqual(batch);
  });

  test.each(['gpt-5.4', 'gpt-6-sol', 'anthropic/gpt-6-luna'])('rejects policy-disallowed model %s before forwarding', async model => {
    await expect(post('/decisions', { model, input: 'Evidence', questions }))
      .rejects.toMatchObject({ status: 403, error: { type: 'model_policy_violation' } });
    expect(requests).toHaveLength(0);
  });

  test.each(['grader', 'openai/gpt-6-luna'])('uses existing alias/prefix resolution for %s', async model => {
    await post('/decisions', { model, input: 'Evidence', questions });
    expect(JSON.parse(requests[0].body).model).toBe('gpt-6-luna');
  });

  test('accounts for all token classes once and enforces the shared AI-credit budget', async () => {
    process.env.AWF_MAX_AI_CREDITS = '0.009';
    const logs = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await post('/decisions', { model: 'gpt-6-luna', input: 'Evidence', questions });
    expect(getStructuredLogs(logs, 'token_budget_usage')).toEqual([
      expect.objectContaining({ ai_credits_this_response: 0.00965, ai_credits_total: 0.00965 }),
    ]);
    await expect(post('/decisions', { model: 'gpt-6-luna', input: 'Evidence', questions }))
      .rejects.toMatchObject({ status: 403, error: { type: 'ai_credits_limit_exceeded' } });
    expect(requests).toHaveLength(1);
  });

  test.each([
    '/v1/decisions',
    '/v1\\decisions',
    '/v1/./decisions',
    '/v1/decisions///?api-version=test',
  ])('Decisions at %s and existing endpoints share invocation limits', async requestPath => {
    process.env.AWF_MAX_RUNS = '1';
    const body = { model: 'gpt-6-luna', input: 'Evidence', questions };
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: proxy.address().port,
        path: requestPath, method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
    expect(status).toBe(200);
    const forwarded = new URL(requestPath, baseURL);
    expect(requests[0].url).toBe(forwarded.pathname + forwarded.search);
    await expect(post('/decisions', body))
      .rejects.toMatchObject({ status: 429, error: { type: 'max_runs_exceeded' } });
    await expect(post('/responses', { model: 'gpt-6-luna', input: 'Evidence' }))
      .rejects.toMatchObject({ status: 429, error: { type: 'max_runs_exceeded' } });
    expect(requests).toHaveLength(1);
  });

  test('applies shared request rate limits to Decisions', async () => {
    const limiter = proxyCore.limiter;
    const { enabled, rpm } = limiter;
    limiter.enabled = true;
    limiter.rpm = 1;
    limiter.providers.clear();
    try {
      await post('/decisions', { model: 'gpt-6-luna', input: 'Evidence', questions });
      await expect(post('/decisions', { model: 'gpt-6-luna', input: 'Evidence', questions }))
        .rejects.toMatchObject({ status: 429 });
      expect(requests).toHaveLength(1);
    } finally {
      limiter.enabled = enabled;
      limiter.rpm = rpm;
      limiter.providers.clear();
    }
  });

  test('rejects Decisions requests exceeding the shared 10 MB body limit', async () => {
    const response = await fetch(`${baseURL}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'gpt-6-luna', input: 'x'.repeat(10 * 1024 * 1024), questions }),
    });
    expect(response.status).toBe(413);
    expect(requests).toHaveLength(0);
  });

  test.each([400, 401, 403, 429, 500, 503])('passes through upstream status %s and native errors', async status => {
    const error = { error: { type: 'invalid_request_error', code: 'upstream_error', message: 'Provider rejected request' } };
    respond = (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'retry-after': '2' });
      res.end(JSON.stringify(error));
    };
    await expect(post('/decisions', { model: 'gpt-6-luna', input: 'Evidence', questions }))
      .rejects.toMatchObject({ status, error: error.error });
    expect(requests).toHaveLength(1);
  });

  const liveTest = process.env.AWF_TEST_LIVE_DECISIONS === '1' ? test : test.skip;
  liveTest('live Decisions conformance through the configured AWF sidecar', async () => {
    if (!hasDecisionsSdk) throw new Error('Live SDK conformance requires Node.js 22+ and an OpenAI SDK with client.decisions.create');
    const origin = process.env.AWF_API_PROXY_OPENAI_URL;
    if (!origin) throw new Error('Run inside AWF with AWF_API_PROXY_OPENAI_URL configured');
    const client = new OpenAI({ baseURL: `${origin.replace(/\/+$/, '')}/v1`, apiKey: 'awf-placeholder', maxRetries: 0 });
    const result = await client.decisions.create({ model: 'gpt-6-luna', input: 'The answer is 42.', questions });
    expect(result.model).toMatch(/^gpt-6-luna/);
    expect(result.answers).toHaveLength(questions.length);
    expect(result.usage.input_tokens).toEqual(expect.any(Number));
  }, 30000);

  test.each(['not-json', '{"model":"gpt-6-luna","questions":[]}'])('preserves malformed requests for upstream validation', async body => {
    respond = (_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":{"type":"invalid_request_error","message":"Malformed request"}}');
    };
    const result = await fetch(`${baseURL}/decisions`, { method: 'POST', body });
    expect(result.status).toBe(400);
    expect(requests[0].body).toBe(body);
  });

  test('returns the shared gateway error on an upstream connection failure', async () => {
    respond = req => req.socket.destroy();
    await expect(post('/decisions', { model: 'gpt-6-luna', input: 'Evidence', questions }))
      .rejects.toMatchObject({ status: 502 });
    expect(requests).toHaveLength(1);
  });

  test('supports client timeouts without retrying Decisions requests', async () => {
    respond = () => {};
    await expect(post('/decisions', { model: 'gpt-6-luna', input: 'Evidence', questions }, { signal: AbortSignal.timeout(100) }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    expect(requests).toHaveLength(1);
  });

  test.each(['responses', 'chat/completions'])('keeps existing /v1/%s forwarding unchanged', async endpoint => {
    const body = endpoint === 'responses'
      ? { model: 'gpt-6-luna', input: 'Evidence' }
      : { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'Evidence' }] };
    const native = endpoint === 'responses'
      ? { model: 'gpt-6-luna', output: [], usage: decision.usage }
      : { model: 'gpt-6-luna', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } };
    respond = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(native));
    };
    expect(await post(`/${endpoint}`, body)).toEqual(native);
    expect(requests[0].url).toBe(`/v1/${endpoint}`);
    expect(JSON.parse(requests[0].body)).toEqual(body);
  });
});
