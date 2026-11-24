'use strict';

const { EventEmitter } = require('events');
const { createOpenAIAdapter } = require('./openai');
const { createAnthropicAdapter } = require('./anthropic');
const { createCopilotAdapter } = require('./copilot');
const { createProxyHandler, createWebSocketUpgradeHandler } = require('../server-factory');
const { buildCrossProviderRequest } = require('../cross-provider-fallback');

const env = {
  AWF_AUTH_TYPE: 'github-oidc',
  AWF_AUTH_PROVIDER: 'databricks',
  AWF_AUTH_DATABRICKS_HOST: 'https://workspace.cloud.databricks.com',
  AWF_AUTH_OIDC_AUDIENCE: 'audience',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://actions.example/token',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-actions-token',
};
const host = 'workspace.cloud.databricks.com';

describe.each([
  ['openai', createOpenAIAdapter, 'OPENAI_API_TARGET', 'OPENAI_API_BASE_PATH'],
  ['anthropic', createAnthropicAdapter, 'ANTHROPIC_API_TARGET', 'ANTHROPIC_API_BASE_PATH'],
  ['copilot', createCopilotAdapter, 'COPILOT_API_TARGET', 'COPILOT_API_BASE_PATH'],
])('Databricks %s route guard', (name, create, target, base) => {
  let adapter;
  beforeEach(() => {
    adapter = create({ ...env, [target]: host, [base]: '/serving-endpoints' });
    const provider = adapter.getOidcProvider();
    provider._cachedToken = 'synthetic-oidc-token';
    provider._expiresAt = Date.now() / 1000 + 300;
  });
  afterEach(() => adapter.getOidcProvider().shutdown());

  it.each([
    ['POST', '/v1/chat/completions?stream=true'],
    ['POST', '/v1/embeddings'],
    ['POST', '/v1/responses'],
    ['POST', '/v1/messages'],
    ['POST', '/serving-endpoints/my-model/invocations'],
    ['GET', '/v1/models'],
    ['GET', '/v1/models/my-model'],
  ])('allows %s %s', (method, url) => {
    expect(adapter.isRequestAllowed({ method, url, headers: {} })).toBe(true);
  });

  it.each([
    ['GET', '/api/2.0/secrets/get'],
    ['POST', '/api/2.0/jobs/run-now'],
    ['GET', '/v1/chat/completions'],
    ['POST', '/v1/models'],
    ['DELETE', '/v1/models/my-model'],
    ['GET', '/v1/models/../secrets'],
    ['GET', '/v1/models/%2e%2e/secrets'],
    ['GET', '/v1/models%2fsecret'],
    ['GET', '/v1/models#fragment'],
    ['GET', '//v1/models'],
  ])('blocks %s %s before injection', (method, url) => {
    const proxy = jest.fn();
    const getHeaders = jest.spyOn(adapter, 'getAuthHeaders');
    const res = { writeHead: jest.fn(), end: jest.fn() };
    createProxyHandler(adapter, () => false, proxy)({ method, url, headers: {} }, res);
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(proxy).not.toHaveBeenCalled();
    expect(getHeaders).not.toHaveBeenCalled();
  });

  it('rejects websocket upgrades before injecting credentials', () => {
    const proxy = jest.fn();
    const getHeaders = jest.spyOn(adapter, 'getAuthHeaders');
    const socket = new EventEmitter();
    socket.write = jest.fn();
    socket.destroy = jest.fn();
    createWebSocketUpgradeHandler(adapter, proxy)({ method: 'GET', url: '/v1/models', headers: { upgrade: 'websocket' } }, socket, Buffer.alloc(0));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('403'));
    expect(proxy).not.toHaveBeenCalled();
    expect(getHeaders).not.toHaveBeenCalled();
  });

  it('dispatches allowed inference with the federated token', () => {
    const proxy = jest.fn();
    const req = { method: 'POST', url: '/v1/chat/completions', headers: {} };
    createProxyHandler(adapter, () => false, proxy)(req, {});
    expect(proxy.mock.calls[0][3].Authorization).toBe(['Bearer', 'synthetic-oidc-token'].join(' '));
  });
});

describe('Databricks discovery and Copilot auth', () => {
  it.each(['COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_API_KEY'])('overrides %s for inference and discovery', key => {
    const adapter = createCopilotAdapter({
      ...env, COPILOT_API_TARGET: host, COPILOT_API_BASE_PATH: '/ai-gateway/openai',
      COPILOT_GITHUB_TOKEN: 'synthetic-github', [key]: 'synthetic-static',
    });
    const provider = adapter.getOidcProvider();
    try {
      expect(adapter.isEnabled()).toBe(false);
      expect(adapter.getModelsFetchConfig()).toBeNull();
      expect(adapter.getAuthHeaders({ method: 'GET', url: '/models', headers: {} })).toEqual({});
      provider._cachedToken = 'synthetic-oidc-token';
      provider._expiresAt = Date.now() / 1000 + 300;
      for (const url of ['/models', '/models/model', '/v1/chat/completions']) {
        expect(adapter.getAuthHeaders({ method: url.includes('completions') ? 'POST' : 'GET', url, headers: {} }).Authorization)
          .toBe(['Bearer', 'synthetic-oidc-token'].join(' '));
      }
      expect(adapter.getModelsFetchConfig()).toMatchObject({
        url: `https://${host}/ai-gateway/openai/models`,
        opts: { headers: { Authorization: ['Bearer', 'synthetic-oidc-token'].join(' ') } },
      });
    } finally { provider.shutdown(); }
  });

  it.each(['other.example', 'https://[malformed', 'api.githubcopilot.com'])('fails closed with static credentials on refused target %s', target => {
    const adapter = createCopilotAdapter({ ...env, COPILOT_API_TARGET: target, COPILOT_PROVIDER_API_KEY: 'synthetic-static', COPILOT_GITHUB_TOKEN: 'synthetic-github' });
    expect(adapter.isEnabled()).toBe(false);
    expect(adapter.getAuthHeaders({ method: 'GET', url: '/models', headers: {} })).toEqual({});
    expect(adapter.getModelsFetchConfig()).toBeNull();
    expect(adapter.getUnconfiguredResponse().body.error.message).toContain('Databricks OIDC');
  });

  it('retains unrelated Copilot static auth when no Copilot target is selected', () => {
    const adapter = createCopilotAdapter({ ...env, OPENAI_API_TARGET: host, COPILOT_GITHUB_TOKEN: 'synthetic-github' });
    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.getAuthHeaders({ method: 'GET', url: '/models', headers: {} }).Authorization).toContain('synthetic-github');
  });

  it('does not send discovery credentials to an arbitrary configured base path', () => {
    const adapter = createOpenAIAdapter({ ...env, OPENAI_API_TARGET: host, OPENAI_API_BASE_PATH: '/api/2.0/secrets' });
    const provider = adapter.getOidcProvider();
    try {
      provider._cachedToken = 'synthetic-oidc-token';
      provider._expiresAt = Date.now() / 1000 + 300;
      expect(adapter.getModelsFetchConfig()).toBeNull();
      expect(adapter.isRequestAllowed({ method: 'GET', url: '/v1/models', headers: {} })).toBe(false);
    } finally { provider.shutdown(); }
  });

  it.each(['/ai-gateway/openai', '/ai-gateway/anthropic'])('permits model routes under %s', basePath => {
    const adapter = createOpenAIAdapter({ ...env, OPENAI_API_TARGET: host, OPENAI_API_BASE_PATH: basePath });
    try {
      expect(adapter.isRequestAllowed({ method: 'POST', url: '/v1/messages', headers: {} })).toBe(true);
      expect(adapter.isRequestAllowed({ method: 'GET', url: '/models', headers: {} })).toBe(true);
      expect(adapter.isRequestAllowed({ method: 'GET', url: '/api/2.0/secrets/get', headers: {} })).toBe(false);
    } finally { adapter.getOidcProvider().shutdown(); }
  });

  it('does not restrict unrelated static adapters', () => {
    const adapter = createOpenAIAdapter({ OPENAI_API_TARGET: host, OPENAI_API_KEY: 'synthetic-static' });
    expect(adapter.isRequestAllowed).toBeUndefined();
  });

  it('rejects an unsafe fallback route before obtaining credentials', async () => {
    const adapter = createOpenAIAdapter({ ...env, OPENAI_API_TARGET: host, OPENAI_API_BASE_PATH: '/api/2.0/secrets' });
    try {
      const getHeaders = jest.spyOn(adapter, 'getAuthHeaders');
      await expect(buildCrossProviderRequest({
        sourceBody: Buffer.from('{"model":"test","messages":[]}'),
        protocol: 'chat', originProvider: 'copilot', targetProvider: 'openai',
        model: 'test', adapter, req: { method: 'POST', headers: {} }, requestId: 'test',
      })).rejects.toThrow('route not allowed');
      expect(getHeaders).not.toHaveBeenCalled();
    } finally { adapter.getOidcProvider().shutdown(); }
  });
});
