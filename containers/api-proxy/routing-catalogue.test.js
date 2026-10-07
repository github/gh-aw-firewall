'use strict';

const { createRoutingCatalogue, normalizeModel } = require('./routing-catalogue');
const { buildRoutingCandidates } = require('./routing-candidates');
const { createCopilotAdapter } = require('./providers/copilot');

function dependencies(overrides = {}) {
  return {
    getCopilotAdapter: jest.fn(() => createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'test-token' })),
    getDiscoveredModels: jest.fn(() => ['gpt-test', 'missing', 'empty', 'no-reasoning']),
    getRuntimeModels: jest.fn(() => [
      {
        id: 'GPT-test',
        supportedReasoningEfforts: ['high', 'low'],
        supportedEndpoints: ['/responses', '/chat/completions', '/responses', '/messages'],
        capabilities: { limits: { max_context_window_tokens: 128_000 } },
      },
      { id: 'empty', supportedReasoningEfforts: [], supportedEndpoints: [] },
      {
        id: 'no-reasoning',
        capabilities: { supports: { reasoningEffort: false }, limits: { max_context_window_tokens: -1 } },
        supportedEndpoints: ['/chat/completions'],
      },
      { id: 'not-discovered', supportedReasoningEfforts: ['low'], supportedEndpoints: ['/responses'] },
    ]),
    ...overrides,
  };
}

describe('routing catalogue', () => {
  it('takes one frozen snapshot from authoritative discovery and private metadata', async () => {
    const deps = dependencies();
    const catalogue = createRoutingCatalogue(deps);
    const snapshot = await catalogue.getSnapshot();
    expect(snapshot).toEqual({
      provider: 'copilot', configured: true, discovery: 'complete',
      models: [
        { id: 'gpt-test', efforts: ['high', 'low'], protocols: ['responses', 'chat-completions', 'messages'], contextWindow: 128_000 },
        { id: 'missing' },
        { id: 'empty', efforts: [], protocols: [] },
        { id: 'no-reasoning', efforts: [], protocols: ['chat-completions'] },
      ],
    });

    expect(Object.isFrozen(catalogue)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.models)).toBe(true);
    for (const model of snapshot.models) {
      expect(Object.isFrozen(model)).toBe(true);
      if (model.efforts) expect(Object.isFrozen(model.efforts)).toBe(true);
      if (model.protocols) expect(Object.isFrozen(model.protocols)).toBe(true);
    }
    const source = deps.getRuntimeModels.mock.results[0].value;
    source[0].supportedReasoningEfforts.push('max');
    source[0].supportedEndpoints.length = 0;
    expect(snapshot.models[0].efforts).toEqual(['high', 'low']);
    expect(snapshot.models[0].protocols).toEqual(['responses', 'chat-completions', 'messages']);
    expect(deps.getDiscoveredModels).toHaveBeenCalledWith('copilot');
    expect(deps.getRuntimeModels).toHaveBeenCalledTimes(1);
    expect(deps.getRuntimeModels).toHaveBeenCalledWith('copilot');
  });

  it.each([
    ['openai', 'gpt-5.4', 'api.openai.com', ['none', 'low', 'medium', 'high', 'xhigh'], ['chat-completions', 'responses']],
    ['anthropic', 'claude-opus-5-5', 'api.anthropic.com', ['low', 'medium', 'high', 'max'], ['messages']],
  ])('uses maintained endpoint, effort, and context metadata for %s', async (provider, model, host, efforts, protocols) => {
    const catalogue = createRoutingCatalogue({
      getAdapter: name => ({
        name,
        isEnabled: () => true,
        getTargetHost: () => host,
      }),
      getDiscoveredModels: name => name === provider ? [model] : null,
      getRuntimeModels: () => [],
    });

    await expect(catalogue.getSnapshot({ provider })).resolves.toEqual({
      provider,
      configured: true,
      discovery: 'complete',
      models: [{
        id: model,
        efforts,
        contextWindow: provider === 'openai' ? 1_050_000 : 1_000_000,
        protocols,
      }],
    });
  });

  it('fails closed for custom OpenAI-compatible hosts', async () => {
    const catalogue = createRoutingCatalogue({
      getAdapter: name => ({
        name,
        isEnabled: () => true,
        getTargetHost: () => 'router.example.com',
      }),
      getDiscoveredModels: () => ['gpt-5.4'],
      getRuntimeModels: () => [],
    });
    await expect(catalogue.getSnapshot({ provider: 'openai' })).resolves.toMatchObject({
      provider: 'openai',
      configured: false,
      discovery: 'failed',
    });
  });

  it.each([null, createCopilotAdapter({})])('fails closed when Copilot is not configured: %s', adapter => {
    return expect(createRoutingCatalogue(dependencies({
      getCopilotAdapter: () => adapter,
    })).getSnapshot()).resolves.toEqual({
      provider: 'copilot', configured: false, discovery: 'failed',
    });
  });

  it.each([null, []])('fails closed when discovery has no authoritative models: %s', models => {
    return expect(createRoutingCatalogue(dependencies({
      getDiscoveredModels: () => models,
    })).getSnapshot()).resolves.toEqual({
      provider: 'copilot', configured: true, discovery: 'failed',
    });
  });

  it.each([
    { COPILOT_GITHUB_TOKEN: 'test-token', COPILOT_API_TARGET: 'gateway.example.com' },
    { COPILOT_GITHUB_TOKEN: 'test-token', COPILOT_PROVIDER_API_KEY: 'test-key' },
    { COPILOT_PROVIDER_API_KEY: 'test-key' },
    {},
  ])('does not admit a custom target or non-native credential occupying the Copilot slot: %j', env => {
    const adapter = createCopilotAdapter(env);
    expect(adapter.getRoutingProviderIdentity()).toBeNull();
    return expect(createRoutingCatalogue(dependencies({
      getCopilotAdapter: () => adapter,
    })).getSnapshot()).resolves.toMatchObject({ configured: false, discovery: 'failed' });
  });

  it('does not admit an OIDC provider even after its token becomes ready', async () => {
    const adapter = createCopilotAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-token',
      AWF_AUTH_AZURE_TENANT_ID: 'test-tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'test-client',
    });
    const provider = adapter.getOidcProvider();
    expect(provider).not.toBeNull();
    provider._cachedToken = 'test-oidc-token';
    provider._expiresAt = Math.floor(Date.now() / 1000) + 600;
    expect(adapter.isEnabled()).toBe(true);
    expect(adapter.getRoutingProviderIdentity()).toBeNull();
    await expect(createRoutingCatalogue(dependencies({
      getCopilotAdapter: () => adapter,
    })).getSnapshot()).resolves.toMatchObject({ configured: false, discovery: 'failed' });
    provider.shutdown();
  });

  it('honors cancellation before reading mutable startup state', async () => {
    const deps = dependencies();
    const controller = new AbortController();
    controller.abort();
    await expect(createRoutingCatalogue(deps).getSnapshot({ signal: controller.signal }))
      .rejects.toMatchObject({ code: 'routing_cancelled', retryable: false });
    for (const dependency of Object.values(deps)) expect(dependency).not.toHaveBeenCalled();
  });

  it('reads efforts from the live Copilot /models capability shape', async () => {
    const snapshot = await createRoutingCatalogue(dependencies({
      getDiscoveredModels: () => ['gpt-5-mini', 'claude-haiku-4.5', 'gpt-4.1', 'malformed'],
      getRuntimeModels: () => [
        {
          id: 'gpt-5-mini',
          capabilities: {
            limits: { max_context_window_tokens: 264_000 },
            supports: { streaming: true, reasoning_effort: ['low', 'medium', 'high'] },
          },
          supportedEndpoints: ['/chat/completions', '/responses', 'ws:/responses'],
        },
        {
          id: 'claude-haiku-4.5',
          capabilities: {
            limits: { max_context_window_tokens: 200_000 },
            supports: { streaming: true, max_thinking_budget: 32_000 },
          },
          supportedEndpoints: ['/chat/completions', '/v1/messages'],
        },
        { id: 'gpt-4.1', capabilities: { supports: { streaming: true } } },
        { id: 'malformed', capabilities: { supports: { reasoning_effort: 'high' } }, supportedEndpoints: ['/responses'] },
      ],
    })).getSnapshot();
    expect(snapshot.models).toEqual([
      { id: 'gpt-5-mini', efforts: ['low', 'medium', 'high'], protocols: ['chat-completions', 'responses'], contextWindow: 264_000 },
      { id: 'claude-haiku-4.5', efforts: [], protocols: ['chat-completions', 'messages'], contextWindow: 200_000 },
      { id: 'gpt-4.1', efforts: [] },
      { id: 'malformed', protocols: ['responses'] },
    ]);
    const { choices } = buildRoutingCandidates({
      catalogue: snapshot,
      policy: { allowedModels: ['github-copilot/claude-haiku-4.5'] },
    });
    expect(choices).toEqual([{ id: 'choice-0001', model: 'github-copilot/claude-haiku-4.5' }]);
  });

  it('keeps Copilot Messages endpoints while excluding them for OpenAI', () => {
    const metadata = {
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      supportedEndpoints: ['/v1/messages', '/chat/completions'],
    };
    expect(normalizeModel('claude-sonnet-5', metadata, 'copilot').protocols)
      .toEqual(['messages', 'chat-completions']);
    expect(normalizeModel('gpt-test', metadata, 'openai').protocols)
      .toEqual(['chat-completions']);
  });

  it('requires every catalogue dependency', () => {
    for (const name of Object.keys(dependencies())) {
      expect(() => createRoutingCatalogue(dependencies({ [name]: null })))
        .toThrow(expect.objectContaining({ code: 'routing_configuration_error' }));
    }
  });
});
