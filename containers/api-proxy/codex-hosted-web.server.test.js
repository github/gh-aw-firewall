'use strict';

const https = require('https');
const {
  makeReq,
  makeRes,
  makeProxyReq,
  setupServerTestEnv,
  flushPromises,
} = require('./test-helpers/server-mock-factories');
const { createOpenAIAdapter } = require('./providers/openai');

let proxyRequest;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  return { proxyRequest };
});

const POLICY = JSON.stringify({
  enabled: true,
  mode: 'allow',
  domains: ['docs.github.com'],
});

async function dispatch(adapter, path, body) {
  const upstreamRequest = makeProxyReq();
  jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);
  const req = makeReq(path);
  const res = makeRes();
  proxyRequest(
    req,
    res,
    'api.openai.com',
    { Authorization: '******' },
    'openai',
    '',
    adapter.getBodyTransform(),
  );
  req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await flushPromises();
  const written = upstreamRequest.write.mock.calls[0];
  return {
    res,
    upstreamBody: written ? JSON.parse(written[0].toString('utf8')) : null,
  };
}

describe('Codex hosted-web policy through the OpenAI adapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fails sidecar startup for invalid serialized policy', () => {
    expect(() => createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-test',
      AWF_CODEX_HOSTED_WEB_POLICY: '{"enabled":true}',
    })).toThrow(/AWF_CODEX_HOSTED_WEB_POLICY/);
  });

  it('does not install an extra transform when policy is omitted', () => {
    const marker = body => body;
    expect(createOpenAIAdapter(
      { OPENAI_API_KEY: 'sk-test' },
      { bodyTransform: marker },
    ).getBodyTransform()).toBe(marker);
  });

  it('sends an exactly enforced Responses body upstream after model transforms', async () => {
    const modelTransform = body => {
      const parsed = JSON.parse(body);
      parsed.model = 'resolved-model';
      return Buffer.from(JSON.stringify(parsed));
    };
    const adapter = createOpenAIAdapter(
      { OPENAI_API_KEY: 'sk-test', AWF_CODEX_HOSTED_WEB_POLICY: POLICY },
      { bodyTransform: modelTransform },
    );
    const { upstreamBody } = await dispatch(adapter, '/v1/responses', {
      model: 'alias',
      input: 'search privately',
      tools: [{
        type: 'web_search',
        filters: { allowed_domains: ['github.com'] },
      }],
    });
    expect(upstreamBody).toEqual({
      model: 'resolved-model',
      input: 'search privately',
      tools: [{
        type: 'web_search',
        filters: { allowed_domains: ['docs.github.com'] },
      }],
    });
  });

  it('sends an exactly enforced standalone search body upstream', async () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-test',
      AWF_CODEX_HOSTED_WEB_POLICY: POLICY,
    });
    const { upstreamBody } = await dispatch(adapter, '/v1/alpha/search', {
      id: 'session',
      model: 'gpt-5',
      commands: {
        search_query: [{ q: 'documentation', domains: ['github.com'] }],
        open: [{ ref_id: 'turn0search0' }],
      },
      settings: { external_web_access: true },
    });
    expect(upstreamBody).toEqual({
      id: 'session',
      model: 'gpt-5',
      commands: {
        search_query: [{ q: 'documentation', domains: ['docs.github.com'] }],
        open: [{ ref_id: 'turn0search0' }],
      },
      settings: {
        external_web_access: true,
        filters: { allowed_domains: ['docs.github.com'] },
      },
    });
  });

  it('rejects disabled standalone search without upstream dispatch', async () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-test',
      AWF_CODEX_HOSTED_WEB_POLICY: '{"enabled":false}',
    });
    const { res, upstreamBody } = await dispatch(adapter, '/v1/alpha/search', {
      input: 'sensitive query text',
      settings: { external_web_access: true },
    });
    expect(upstreamBody).toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res.end.mock.calls[0][0]);
    expect(payload.error.code).toBe('codex_hosted_web_disabled');
    expect(payload.error.message).not.toContain('sensitive query text');
  });

  it('leaves ordinary OpenAI requests exactly unchanged', async () => {
    const adapter = createOpenAIAdapter({
      OPENAI_API_KEY: 'sk-test',
      AWF_CODEX_HOSTED_WEB_POLICY: POLICY,
    });
    const body = { model: 'gpt-5', input: 'ordinary request' };
    expect((await dispatch(adapter, '/v1/responses', body)).upstreamBody).toEqual(body);
  });
});
