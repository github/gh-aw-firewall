'use strict';

const https = require('https');
const { EventEmitter } = require('events');
const { composeBodyTransforms } = require('./proxy-utils');
const { createRoutingObservation } = require('./routing-observation');
const {
  makeReq, makeRes, flushPromises, createMockUpstreamCycle, getStructuredLogs,
} = require('./test-helpers/server-mock-factories');

describe('model selectors before inference guards', () => {
  const originalEnv = { ...process.env };
  let proxyRequest;
  let makeModelBodyTransform;
  let refresh;
  let records;
  let cache;

  function load(overrides = {}) {
    Object.assign(process.env, overrides);
    jest.isolateModules(() => {
      ({ proxyRequest } = require('./proxy-request'));
      ({ makeModelBodyTransform } = require('./model-config'));
    });
  }

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('AWF_')) delete process.env[key];
    }
    delete process.env.HTTPS_PROXY;
    process.env.AWF_MAX_AI_CREDITS = '100';
    cache = { copilot: ['gpt-5.6-terra', 'claude-sonnet-5'] };
    records = [
      { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
    ];
    refresh = jest.fn();
    load();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  function transform() {
    return makeModelBodyTransform('copilot', cache, refresh, () => new Set(['copilot']), () => records);
  }

  async function send(model) {
    const upstream = createMockUpstreamCycle(https);
    const req = makeReq('/chat/completions');
    const res = makeRes();
    proxyRequest(req, res, 'api.githubcopilot.com', {}, 'copilot', '', transform());
    req.emit('data', Buffer.from(JSON.stringify({ model, messages: [] })));
    req.emit('end');
    await flushPromises();
    return { upstream, req, res };
  }

  it.each(['GPT-5.6 Terra', 'GPT-5.6 Terra (copilot)', 'gpt-5.6-terra', 'copilot/GPT-5.6 Terra'])(
    'prices and forwards the canonical ID for %s', async selector => {
      const logs = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const { upstream, req, res } = await send(selector);
      expect(upstream.spy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(upstream.upstreamRequest.write.mock.calls[0][0].toString()).model)
        .toBe('gpt-5.6-terra');
      expect(req.awfModelCandidates).toEqual(['gpt-5.6-terra']);
      expect(res.end).not.toHaveBeenCalled();
      expect(getStructuredLogs(logs, 'model_selector_resolution')).toEqual([
        expect.objectContaining({
          requested_selector: selector,
          selected_provider: 'copilot',
          resolved_model: 'gpt-5.6-terra',
        }),
      ]);
    },
  );

  it.each([
    ['AWF_ALLOWED_MODELS', ['claude-sonnet-5']],
    ['AWF_DISALLOWED_MODELS', ['copilot/gpt-5.6-terra']],
  ])('enforces %s on the resolved ID without substituting an allowed model', async (key, models) => {
    load({ [key]: JSON.stringify(models) });
    const { upstream, res } = await send('GPT-5.6 Terra (copilot)');
    expect(upstream.spy).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0]).error).toMatchObject({
      type: 'model_policy_violation', model: 'gpt-5.6-terra',
    });
  });

  it('refreshes missing display metadata before resolving', async () => {
    records = [];
    refresh.mockImplementation(async () => {
      records = [{ id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' }];
    });
    const { upstream } = await send('GPT-5.6 Terra');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(upstream.spy).toHaveBeenCalledTimes(1);
  });

  it('compares advisory routing with the canonical ID rather than the UI selector', async () => {
    const upstream = createMockUpstreamCycle(https);
    const req = makeReq('/chat/completions');
    const res = Object.assign(new EventEmitter(), makeRes(), { statusCode: 200 });
    const observations = [];
    const failures = [];
    const routing = createRoutingObservation({
      getSelection: () => ({
        provider: 'copilot', choice: { model: 'copilot/gpt-5.6-terra' },
        wire_model: 'gpt-5.6-terra', endpoint: '/chat/completions',
      }),
      recordFailure: failure => failures.push(failure),
      observer: { record: record => observations.push(record) },
    });
    routing.observeRequest(req, res, { name: 'copilot' });
    proxyRequest(req, res, 'api.githubcopilot.com', {}, 'copilot', '',
      composeBodyTransforms(req.awfRouting.bodyTransform, transform()));
    req.emit('data', Buffer.from('{"model":"GPT-5.6 Terra (copilot)","messages":[]}'));
    req.emit('end');
    await flushPromises();
    expect(upstream.spy).toHaveBeenCalledTimes(1);
    res.writableFinished = true;
    res.emit('finish');
    expect(observations).toEqual([
      expect.objectContaining({ requested_model: 'gpt-5.6-terra', routed: 'as_selected' }),
    ]);
    expect(failures).toEqual([]);
    await routing.drain();
  });

  it.each(['Missing Model', 'GPT-5.6 Terra (openai)', ['Missing Model', 'GPT-5.6 Terra']])(
    'rejects unsupported selector %j before pricing or upstream', async selector => {
      load({ AWF_MODEL_ALIASES: JSON.stringify({ models: { sonnet: ['copilot/*sonnet*'] } }) });
      const { upstream, res } = await send(selector);
      expect(upstream.spy).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(JSON.parse(res.end.mock.calls[0][0]).error).toMatchObject({
        code: 'unsupported_model_selector',
        message: expect.stringContaining('canonical provider model ID'),
      });
    },
  );

  it('keeps exact BYOK deployment names intact with aliases enabled', async () => {
    delete process.env.AWF_MAX_AI_CREDITS;
    load({ AWF_MODEL_ALIASES: JSON.stringify({ models: { 'Team Deployment (private)': ['copilot/*sonnet*'] } }) });
    cache.copilot.push('Team Deployment (private)');
    const { upstream } = await send('Team Deployment (private)');
    expect(JSON.parse(upstream.upstreamRequest.write.mock.calls[0][0].toString()).model)
      .toBe('Team Deployment (private)');
  });

  it('uses operator aliases for display selectors before canonical policy and pricing', async () => {
    load({
      AWF_MODEL_ALIASES: JSON.stringify({ models: { 'Team Model': ['copilot/gpt-5.6-terra'] } }),
      AWF_ALLOWED_MODELS: JSON.stringify(['gpt-5.6-terra']),
    });
    const { upstream } = await send('Team Model (copilot)');
    expect(JSON.parse(upstream.upstreamRequest.write.mock.calls[0][0].toString()).model)
      .toBe('gpt-5.6-terra');
  });
});
