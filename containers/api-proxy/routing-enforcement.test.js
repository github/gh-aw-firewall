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

function createHarness(selection = SELECTION, failure = null) {
  const failures = [];
  const decisions = [];
  let currentFailure = failure;
  const enforcement = createRoutingEnforcement({
    getSelection: () => selection,
    getFailure: () => currentFailure,
    recordFailure: code => failures.push(code),
    observer: { record: record => decisions.push(record) },
  });
  return {
    enforcement,
    failures,
    decisions,
    setFailure(value) { currentFailure = value; },
  };
}

function screen(harness, req, adapter = { name: 'copilot' }) {
  const res = new FakeResponse();
  const screened = harness.enforcement.screenRequest(req, res, adapter);
  return { screened, res, req };
}

describe('routing enforcement', () => {
  it('exempts only model discovery from screening', () => {
    const harness = createHarness();
    for (const url of ['/models', '/v1/models', '/models/gpt-test']) {
      expect(screen(harness, request({ method: 'GET', url })).screened).toBe(false);
    }
    expect(screen(harness, request({ method: 'POST', url: '/models' })).screened).toBe(true);
    expect(screen(harness, request({ method: 'GET', url: '/responses' })).screened).toBe(true);
    expect(harness.failures).toContain('model_routing_mismatch');
  });

  it('admits the endpoint that follows the selected reasoning effort', () => {
    const withEffort = createHarness(SELECTION);
    expect(screen(withEffort, request({ url: '/responses' })).screened).toBe(false);
    expect(screen(withEffort, request({ url: '/v1/responses' })).screened).toBe(false);
    expect(screen(withEffort, request({ url: '/chat/completions' })).screened).toBe(true);

    const withoutEffort = createHarness(CHAT_SELECTION);
    expect(screen(withoutEffort, request({ url: '/chat/completions' })).screened).toBe(false);
    expect(screen(withoutEffort, request({ url: '/responses' })).screened).toBe(true);
  });

  it('rejects a foreign adapter, an override header, a recorded failure, and a missing selection', () => {
    const harness = createHarness();
    expect(screen(harness, request(), { name: 'anthropic' }).screened).toBe(true);
    expect(screen(harness, request({ headers: { 'x-model-override': 'other' } })).screened).toBe(true);
    expect(screen(harness, request({ headers: { 'copilot-reasoning-effort': 'high' } })).screened).toBe(true);

    const failed = createHarness(SELECTION, 'provider_unavailable');
    expect(screen(failed, request()).screened).toBe(true);

    const unrouted = createHarness(null);
    expect(screen(unrouted, request()).screened).toBe(true);
  });

  it('writes a sanitized 403 rejection body', () => {
    const harness = createHarness(null);
    const { res } = screen(harness, request());
    expect(res.statusCode).toBe(403);
    expect(res.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(res.body())).toEqual({
      error: {
        type: 'model_routing_failed',
        code: 'model_routing_mismatch',
        message: 'The request does not match the task model selection',
        retryable: false,
      },
    });
  });

  it('passes a matching body through unchanged and rejects a mismatch instead of rewriting it', () => {
    const harness = createHarness();
    const { req } = screen(harness, request());
    const body = Buffer.from(JSON.stringify({ model: 'gpt-test', reasoning: { effort: 'low' } }), 'utf8');
    expect(req.awfRouting.bodyTransform(body)).toBe(body);

    for (const payload of [
      { model: 'other-model', reasoning: { effort: 'low' } },
      { model: 'gpt-test', reasoning: { effort: 'high' } },
      { model: 'gpt-test' },
      { model: 'gpt-test', reasoning: { effort: 'low' }, reasoning_effort: 'low' },
      [],
    ]) {
      expect(() => req.awfRouting.bodyTransform(Buffer.from(JSON.stringify(payload), 'utf8')))
        .toThrow('The request does not match the task model selection');
    }
    expect(() => req.awfRouting.bodyTransform(Buffer.from('not json', 'utf8'))).toThrow();
    expect(harness.failures.every(code => code === 'model_routing_mismatch')).toBe(true);
  });

  it('rejects reasoning fields on the chat-completions endpoint', () => {
    const harness = createHarness(CHAT_SELECTION);
    const { req } = screen(harness, request({ url: '/chat/completions' }));
    const body = Buffer.from(JSON.stringify({ model: 'chat-test' }), 'utf8');
    expect(req.awfRouting.bodyTransform(body)).toBe(body);
    for (const payload of [
      { model: 'chat-test', reasoning_effort: 'low' },
      { model: 'chat-test', reasoning: { effort: 'low' } },
    ]) {
      expect(() => req.awfRouting.bodyTransform(Buffer.from(JSON.stringify(payload), 'utf8'))).toThrow();
    }
  });

  it('observes native failures in buffered and streamed responses without changing the bytes', () => {
    const harness = createHarness();
    const { req, res } = screen(harness, request());
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

  it('records a prematurely closed response and drains admitted responses', async () => {
    const harness = createHarness();
    const { res } = screen(harness, request());
    let drained = false;
    const draining = harness.enforcement.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    res.emit('close');
    await draining;
    expect(drained).toBe(true);
    expect(harness.failures).toContain('provider_unavailable');

    expect(screen(harness, request()).screened).toBe(true);
    await expect(harness.enforcement.drain()).resolves.toBeUndefined();
  });

  it('rejects an opaque upgrade while routing is active', () => {
    const harness = createHarness();
    const written = [];
    harness.enforcement.rejectUpgrade({
      write: chunk => written.push(chunk),
      destroy: () => written.push('<destroyed>'),
    });
    expect(written[0]).toContain('HTTP/1.1 403 Forbidden');
    expect(written[0]).toContain('model_routing_mismatch');
    expect(written[1]).toBe('<destroyed>');
  });

  it('records a structured decision for every admit and reject outcome', () => {
    const harness = createHarness();
    screen(harness, request({ method: 'GET', url: '/v1/models' }));
    const { req } = screen(harness, request());
    req.awfRouting.bodyTransform(Buffer.from(JSON.stringify({ model: 'gpt-test', reasoning: { effort: 'low' } }), 'utf8'));
    screen(harness, request({ method: 'GET', url: '/responses' }));
    screen(harness, request(), { name: 'anthropic' });
    screen(harness, request({ headers: { 'x-model-override': 'other' } }));

    expect(harness.decisions).toEqual([
      { stage: 'decision', decision: 'admit', reason: 'model_discovery_exempt', method: 'GET', pathname: '/v1/models' },
      {
        stage: 'decision', decision: 'admit', reason: 'selected_model_pinned', method: 'POST', pathname: '/responses',
        selected_model: SELECTION.choice.model, selected_effort: SELECTION.choice.effort,
      },
      { stage: 'decision', decision: 'reject', reason: 'method_not_allowed', method: 'GET', pathname: '/responses' },
      { stage: 'decision', decision: 'reject', reason: 'foreign_adapter', method: 'POST', pathname: '/responses' },
      { stage: 'decision', decision: 'reject', reason: 'header_override', method: 'POST', pathname: '/responses' },
    ]);
  });

  it('records a body-mismatch rejection instead of an admit decision', () => {
    const harness = createHarness();
    const { req } = screen(harness, request());
    expect(() => req.awfRouting.bodyTransform(Buffer.from(JSON.stringify({ model: 'wrong-model' }), 'utf8'))).toThrow();
    expect(harness.decisions).toEqual([
      { stage: 'decision', decision: 'reject', reason: 'body_model_mismatch', method: 'POST', pathname: '/responses' },
    ]);
  });

  it('records an invalid-json rejection instead of an admit decision', () => {
    const harness = createHarness();
    const { req } = screen(harness, request());
    expect(() => req.awfRouting.bodyTransform(Buffer.from('not json', 'utf8'))).toThrow();
    expect(harness.decisions).toEqual([
      { stage: 'decision', decision: 'reject', reason: 'body_invalid_json', method: 'POST', pathname: '/responses' },
    ]);
  });

  it('records a distinct reject reason for draining, no selection, and a terminal failure', () => {
    const draining = createHarness();
    draining.enforcement.drain();
    screen(draining, request());
    expect(draining.decisions.at(-1)).toMatchObject({ decision: 'reject', reason: 'draining' });

    const unrouted = createHarness(null);
    screen(unrouted, request());
    expect(unrouted.decisions.at(-1)).toMatchObject({ decision: 'reject', reason: 'no_selection' });

    const failed = createHarness(SELECTION, 'provider_unavailable');
    screen(failed, request());
    expect(failed.decisions.at(-1)).toMatchObject({ decision: 'reject', reason: 'terminal_failure' });
  });

  it('records a reject decision for an opaque upgrade', () => {
    const harness = createHarness();
    harness.enforcement.rejectUpgrade({ write: () => {}, destroy: () => {} });
    expect(harness.decisions).toContainEqual({ stage: 'decision', decision: 'reject', reason: 'upgrade_rejected' });
  });

  it('never throws when the observer itself throws', () => {
    const enforcement = createRoutingEnforcement({
      getSelection: () => SELECTION,
      getFailure: () => null,
      recordFailure: () => {},
      observer: { record: () => { throw new Error('boom'); } },
    });
    const res = new FakeResponse();
    expect(() => enforcement.screenRequest(request(), res, { name: 'copilot' })).not.toThrow();
  });
});
