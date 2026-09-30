'use strict';

const { EventEmitter } = require('events');
const { createRoutingEnforcement } = require('./routing-enforcement');

const SELECTION = Object.freeze({
  schema: 'awf-routing-selection/v1',
  engine: 'copilot',
  provider: 'copilot',
  choice: Object.freeze({ id: 'choice-0001', model: 'github-copilot/gpt-test', effort: 'low' }),
  wire_model: 'gpt-test',
});

const CHAT_SELECTION = Object.freeze({
  ...SELECTION,
  choice: Object.freeze({ id: 'choice-0002', model: 'github-copilot/chat-test' }),
  wire_model: 'chat-test',
});

const ANTHROPIC_SELECTION = Object.freeze({
  schema: 'awf-routing-selection/v1',
  engine: 'copilot',
  provider: 'anthropic',
  choice: Object.freeze({ id: 'choice-0003', model: 'anthropic/claude-opus-5-5', effort: 'medium' }),
  wire_model: 'claude-opus-5-5',
});

const OPENAI_SELECTION = Object.freeze({
  schema: 'awf-routing-selection/v1',
  engine: 'copilot',
  provider: 'openai',
  choice: Object.freeze({ id: 'choice-0004', model: 'openai/gpt-5.4', effort: 'high' }),
  wire_model: 'gpt-5.4',
});

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = null;
    this.chunks = [];
    this.writableFinished = false;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    this.writableFinished = true;
    this.emit('finish');
    return this;
  }

  body() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function request(overrides = {}) {
  return { method: 'POST', url: '/responses', headers: {}, ...overrides };
}

function createHarness(selection = SELECTION) {
  const failures = [];
  const records = [];
  const enforcement = createRoutingEnforcement({
    getSelection: () => selection,
    recordFailure: code => failures.push(code),
    observer: { record: record => records.push(record) },
  });
  return { enforcement, failures, records };
}

function observe(harness, req, adapter = { name: 'copilot' }) {
  const res = new FakeResponse();
  const result = harness.enforcement.observeRequest(req, res, adapter);
  return { result, res, req };
}

function send(req, payload) {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  return req.awfRouting.bodyTransform(body);
}

describe('advisory routing observation', () => {
  it('never rejects or writes a response, whatever the request', () => {
    const harness = createHarness();
    for (const [req, adapter] of [
      [request(), { name: 'copilot' }],
      [request({ url: '/chat/completions' }), { name: 'copilot' }],
      [request({ method: 'GET', url: '/responses' }), { name: 'copilot' }],
      [request(), { name: 'anthropic' }],
      [request({ headers: { 'x-model-override': 'other', 'copilot-reasoning-effort': 'high' } }), { name: 'copilot' }],
      [request({ url: 'http://[bad' }), { name: 'copilot' }],
    ]) {
      const { result, res } = observe(harness, req, adapter);
      expect(result).toBeUndefined();
      expect(res.headers).toBeNull();
      expect(res.body()).toBe('');
    }
    expect(harness.failures).toEqual([]);
    expect(createRoutingEnforcement({ getSelection: () => SELECTION, recordFailure: () => {} }).rejectUpgrade)
      .toBeUndefined();
  });

  it('passes every body through unchanged, including a deviating model and effort', () => {
    const harness = createHarness();
    const { req } = observe(harness, request());
    for (const payload of [
      { model: 'gpt-test', reasoning: { effort: 'low' } },
      { model: 'other-model', reasoning: { effort: 'high' } },
      { model: 'gpt-test' },
      [],
      'not json',
    ]) {
      expect(send(req, payload)).toBeNull();
    }
    expect(harness.failures).toEqual([]);
  });

  it('records a request routed as selected', () => {
    const harness = createHarness();
    const { req } = observe(harness, request({ url: '/v1/responses' }));
    send(req, { model: 'gpt-test', reasoning: { effort: 'low' } });
    expect(harness.records).toEqual([{
      stage: 'request',
      routed: 'as_selected',
      deviations: [],
      method: 'POST',
      pathname: '/v1/responses',
      provider: 'copilot',
      requested_model: 'gpt-test',
      requested_effort: 'low',
      selected_provider: 'copilot',
      selected_model: 'gpt-test',
      selected_effort: 'low',
      selected_endpoint: '/responses',
    }]);
  });

  it('records a deviating model, effort, and endpoint without rejecting', () => {
    const harness = createHarness();
    const { req } = observe(harness, request({ url: '/chat/completions' }));
    send(req, { model: 'copilot/small-model', reasoning_effort: 'high' });
    expect(harness.records).toEqual([expect.objectContaining({
      stage: 'request',
      routed: 'deviated',
      deviations: ['model', 'effort', 'endpoint'],
      requested_model: 'small-model',
      requested_effort: 'high',
      selected_model: 'gpt-test',
      selected_effort: 'low',
      selected_endpoint: '/responses',
    })]);
  });

  it('matches effort and endpoint by the shape of the selected provider', () => {
    const chat = createHarness(CHAT_SELECTION);
    send(observe(chat, request({ url: '/chat/completions' })).req, { model: 'chat-test' });
    expect(chat.records.at(-1)).toMatchObject({ routed: 'as_selected', selected_endpoint: '/chat/completions' });

    const anthropic = createHarness(ANTHROPIC_SELECTION);
    send(observe(anthropic, request({ url: '/v1/messages' }), { name: 'anthropic' }).req,
      { model: 'claude-opus-5-5', output_config: { effort: 'medium' } });
    expect(anthropic.records.at(-1)).toMatchObject({ routed: 'as_selected', selected_endpoint: '/v1/messages' });

    const openai = createHarness(OPENAI_SELECTION);
    send(observe(openai, request(), { name: 'copilot' }).req, { model: 'gpt-5.4', reasoning: { effort: 'high' } });
    expect(openai.records.at(-1)).toMatchObject({ routed: 'deviated', deviations: ['provider'] });
  });

  it('records a non-JSON body as a deviation without a requested model', () => {
    const harness = createHarness();
    send(observe(harness, request()).req, 'not json');
    expect(harness.records).toEqual([expect.objectContaining({
      routed: 'deviated', requested_model: null, requested_effort: null, deviations: ['model', 'effort'],
    })]);
  });

  it('bounds recorded model and effort values', () => {
    const harness = createHarness();
    send(observe(harness, request()).req, { model: 'm'.repeat(500), reasoning: { effort: 42 } });
    expect(harness.records[0].requested_model).toHaveLength(200);
    expect(harness.records[0].requested_effort).toBeNull();
  });

  it('observes only inference POSTs while a selection exists', () => {
    const harness = createHarness();
    for (const req of [
      request({ method: 'GET', url: '/v1/models' }),
      request({ method: 'GET', url: '/responses' }),
      request({ url: '/models' }),
    ]) {
      expect(observe(harness, req).req.awfRouting).toBeUndefined();
    }
    const unrouted = createHarness(null);
    expect(observe(unrouted, request()).req.awfRouting).toBeUndefined();
  });

  it('observes native failures on the selected provider without changing the bytes', () => {
    const harness = createHarness();
    const { req, res } = observe(harness, request());
    const payload = JSON.stringify({ error: { code: 'model_not_supported' } });
    res.statusCode = 400;
    res.end(payload);
    expect(res.body()).toBe(payload);
    expect(harness.failures).toContain('model_not_supported');

    req.awfRouting.onSseData(JSON.stringify({ type: 'response.failed', response: { error: { code: 'rate_limited' } } }));
    expect(harness.failures).toContain('rate_limited');
    expect(() => req.awfRouting.onSseData('not json')).not.toThrow();
    req.awfRouting.onSseData(JSON.stringify({ error: { code: 'bad code with spaces' } }));
    expect(harness.failures).toContain('provider_unavailable');
  });

  it('does not observe failures on a provider other than the selected one', () => {
    const harness = createHarness();
    const { req, res } = observe(harness, request(), { name: 'anthropic' });
    res.statusCode = 400;
    res.end(JSON.stringify({ error: { code: 'invalid_request_error' } }));
    expect(harness.failures).toEqual([]);
    expect(req.awfRouting.onSseData).toBeUndefined();
    send(req, { model: 'claude-x' });
    expect(harness.records.at(-1)).toMatchObject({ routed: 'deviated', provider: 'anthropic' });
  });

  it('records a prematurely closed response and drains observed responses', async () => {
    const harness = createHarness();
    const { res } = observe(harness, request());
    let drained = false;
    const draining = harness.enforcement.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    res.emit('close');
    await draining;
    expect(drained).toBe(true);
    expect(harness.failures).toContain('provider_unavailable');

    // A request that arrives while draining is proxied but no longer observed.
    expect(observe(harness, request()).req.awfRouting).toBeUndefined();
    await expect(harness.enforcement.drain()).resolves.toBeUndefined();
  });

  it('never throws when the observer itself throws', () => {
    const enforcement = createRoutingEnforcement({
      getSelection: () => SELECTION,
      recordFailure: () => {},
      observer: { record: () => { throw new Error('boom'); } },
    });
    const req = request();
    expect(() => enforcement.observeRequest(req, new FakeResponse(), { name: 'copilot' })).not.toThrow();
    expect(send(req, { model: 'other' })).toBeNull();
  });
});
