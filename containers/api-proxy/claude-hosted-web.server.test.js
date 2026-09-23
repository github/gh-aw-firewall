'use strict';

/**
 * End-to-end coverage for the Claude hosted-web policy inside the Anthropic
 * adapter and the proxy request pipeline.
 *
 * These tests assert the exact JSON body a mock Anthropic endpoint observes —
 * not just helper return values — and that fail-closed policy violations are
 * surfaced as structured API-proxy errors before any upstream dispatch.
 */

const https = require('https');
const {
  makeReq,
  makeRes,
  makeProxyReq,
  setupServerTestEnv,
  flushPromises,
} = require('./test-helpers/server-mock-factories');

const { createAnthropicAdapter } = require('./providers/anthropic');

let proxyRequest;

setupServerTestEnv(() => {
  ({ proxyRequest } = require('./server'));
  return { proxyRequest };
});

const ALLOW_POLICY_ENV = JSON.stringify({
  enabled: true,
  mode: 'allow',
  domains: ['docs.github.com'],
  maxUses: 5,
});

function messagesBody(tools) {
  return {
    model: 'claude-sonnet-4',
    messages: [{ role: 'user', content: 'find something' }],
    ...(tools ? { tools } : {}),
  };
}

/**
 * Drive one request through proxyRequest with the adapter's composed body
 * transform and return the upstream body (or the client-facing rejection).
 */
async function dispatch(bodyTransform, body) {
  const upstreamRequest = makeProxyReq();
  jest.spyOn(https, 'request').mockImplementation(() => upstreamRequest);

  const req = makeReq('/v1/messages');
  const res = makeRes();
  proxyRequest(req, res, 'api.anthropic.com', { 'x-api-key': 'sk-ant-test' }, 'anthropic', '', bodyTransform);
  req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'));
  req.emit('end');
  await flushPromises();

  const written = upstreamRequest.write.mock.calls[0];
  return {
    res,
    upstreamBody: written ? JSON.parse(written[0].toString('utf8')) : null,
  };
}

describe('Claude hosted-web policy through the Anthropic adapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fails sidecar startup when the serialized internal policy is invalid', () => {
    expect(() => createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_CLAUDE_HOSTED_WEB_POLICY: '{"enabled":true,"mode":"allow"}',
    })).toThrow(/AWF_CLAUDE_HOSTED_WEB_POLICY/);
  });

  it('installs no transform when no policy is configured', () => {
    const adapter = createAnthropicAdapter({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(adapter.getReflectionInfo).toBeDefined();
    expect(adapter.getBodyTransform()).toBeNull();
  });

  it('injects the configured allowlist into the upstream request body', async () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_CLAUDE_HOSTED_WEB_POLICY: ALLOW_POLICY_ENV,
    });

    const { upstreamBody } = await dispatch(
      adapter.getBodyTransform(),
      messagesBody([{ type: 'web_search_20250305', name: 'web_search' }]),
    );

    expect(upstreamBody.tools).toEqual([
      {
        type: 'web_search_20250305',
        name: 'web_search',
        allowed_domains: ['docs.github.com'],
        max_uses: 5,
      },
    ]);
  });

  it('leaves an ordinary Messages request untouched', async () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_CLAUDE_HOSTED_WEB_POLICY: ALLOW_POLICY_ENV,
    });

    const body = messagesBody();
    const { upstreamBody } = await dispatch(adapter.getBodyTransform(), body);

    expect(upstreamBody).toEqual(body);
  });

  it('survives the Anthropic prompt-cache transform (policy cannot be undone)', async () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_ANTHROPIC_AUTO_CACHE: '1',
      AWF_CLAUDE_HOSTED_WEB_POLICY: ALLOW_POLICY_ENV,
    });

    const { upstreamBody } = await dispatch(
      adapter.getBodyTransform(),
      messagesBody([{ type: 'web_fetch_20250910', allowed_domains: ['docs.github.com', 'evil.example'] }]),
    );

    const hostedTool = upstreamBody.tools.find(tool => tool.type === 'web_fetch_20250910');
    expect(hostedTool.allowed_domains).toEqual(['docs.github.com']);
    // The cache transform still ran (it adds a cache breakpoint to the tools tail).
    expect(hostedTool.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('rejects a disabled hosted tool with a structured error before upstream dispatch', async () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_CLAUDE_HOSTED_WEB_POLICY: '{"enabled":false}',
    });

    const { res, upstreamBody } = await dispatch(
      adapter.getBodyTransform(),
      messagesBody([{ type: 'web_search_20250305', name: 'web_search' }]),
    );

    expect(upstreamBody).toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    const payload = JSON.parse(res.end.mock.calls[0][0]);
    expect(payload.error.code).toBe('claude_hosted_web_disabled');
    expect(payload.error.message).not.toContain('find something');
  });

  it('rejects an empty allowlist intersection before upstream dispatch', async () => {
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: 'sk-ant-test',
      AWF_CLAUDE_HOSTED_WEB_POLICY: ALLOW_POLICY_ENV,
    });

    const { res, upstreamBody } = await dispatch(
      adapter.getBodyTransform(),
      messagesBody([{ type: 'web_search_20250305', allowed_domains: ['evil.example'] }]),
    );

    expect(upstreamBody).toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.objectContaining({
      'Content-Type': 'application/json',
    }));
    expect(JSON.parse(res.end.mock.calls[0][0]).error.code).toBe('claude_hosted_web_empty_intersection');
  });
});
