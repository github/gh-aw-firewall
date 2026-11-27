'use strict';

const { buildRoutingModelMetadata, createManagementHandlers } = require('./management');
const { normalizeModel } = require('./routing-catalogue');
const { buildRoutingCandidates } = require('./routing-candidates');
const { createCopilotAdapter } = require('./providers/copilot');

describe('Copilot native Auto launch capability', () => {
  it.each([
    {},
    { COPILOT_GITHUB_TOKEN: 'test-token' },
    { COPILOT_GITHUB_TOKEN: 'test-token', COPILOT_API_TARGET: 'copilot.enterprise.example' },
    { COPILOT_PROVIDER_API_KEY: 'test-key', COPILOT_API_TARGET: 'router.example.com' },
  ])('does not advertise native CLI Auto support with %p', env => {
    const copilot = createCopilotAdapter(env);
    const openai = {
      name: 'openai',
      getReflectionInfo: () => ({
        provider: 'openai', port: 10000, configured: false, models_cache_key: 'openai',
      }),
    };
    const result = createManagementHandlers({
      getAdapters: () => [copilot, openai],
      getCachedModels: () => ({ copilot: ['auto', 'gpt-5.4'] }),
      isModelFetchComplete: () => true,
      getModelAliases: () => ({ models: { auto: ['copilot/gpt-5.4'] } }),
      getModelFallback: () => null,
      getEffectiveModelFallback: () => ({}),
      getAiCreditsUsage: () => ({}),
      getMaxRunsUsage: () => ({}),
      getMaxCacheMissesUsage: () => ({}),
      getPermissionDeniedUsage: () => ({}),
    }).reflectEndpoints();

    expect(result.endpoints[0].copilot_native_auto).toEqual({
      supported: false,
      reason: 'native_launch_contract_unavailable',
      message: expect.stringContaining('offline/BYOK'),
    });
    expect(result.endpoints[0].copilot_native_auto.message).toContain('engine.model-routing');
    expect(result.endpoints[0].copilot_native_auto.message).toContain('without --auto-tier');
    expect(result.endpoints[0].copilot_native_auto.message).toContain('github/gh-aw/issues/74970');
    expect(result.endpoints[0].models).toEqual(['auto', 'gpt-5.4']);
    expect(result.model_aliases).toEqual({ auto: ['copilot/gpt-5.4'] });
    expect(result.endpoints[0].automatic_model_selection).toMatchObject({ model: 'auto' });
    expect(result.endpoints[1]).not.toHaveProperty('copilot_native_auto');
    expect(JSON.stringify(result)).not.toContain('test-token');
    expect(JSON.stringify(result)).not.toContain('test-key');
  });
});

describe('model-budget health capability', () => {
  it('advertises enforcement only when the dedicated proxy is configured to enforce budgets', () => {
    const getHealth = modelBudgetEnabled => createManagementHandlers({
      getAdapters: () => [],
      isModelFetchComplete: () => true,
      getKeyValidationState: () => ({ complete: true, results: {} }),
      getLimiter: () => ({ getAllStatus: () => ({}) }),
      httpsProxy: undefined,
      modelBudgetEnabled,
    }).healthResponse();

    expect(getHealth(true).model_budget_enforcement).toBe(true);
    expect(getHealth(false)).not.toHaveProperty('model_budget_enforcement');
  });
});

describe('pricing errors in /reflect', () => {
  it('returns a sanitized error response instead of leaving the response unfinished', () => {
    const handlers = createManagementHandlers({
      getAdapters: () => [],
      getCachedModels: () => ({}),
      isModelFetchComplete: () => true,
      getModelAliases: () => null,
      getModelFallback: () => null,
      getEffectiveModelFallback: () => ({}),
      getAiCreditsUsage: () => {
        throw Object.assign(new Error('private configuration details'), {
          code: 'pricing_resolution_error',
        });
      },
    });
    const req = { method: 'GET', url: '/reflect' };
    const res = { writeHead: jest.fn(), end: jest.fn() };

    expect(handlers.handleManagementEndpoint(req, res)).toBe(true);

    expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: {
      type: 'pricing_resolution_error',
      message: 'AI-credit pricing resolution failed; accounting could not be completed.',
    } });
  });
});

describe('routing metadata in /reflect', () => {
  it('combines discovered IDs with maintained provider metadata and marks incomplete models', () => {
    expect(buildRoutingModelMetadata('openai', ['gpt-5.4', 'o3'], [])).toEqual([
      {
        model_id: 'gpt-5.4',
        automatic_selection_eligible: true,
        source: 'maintained',
        supported_endpoints: ['chat_completions', 'responses'],
        maintained_protocols: expect.arrayContaining([
          expect.objectContaining({ protocol: 'chat_completions', support: expect.objectContaining({ state: 'supported' }) }),
          expect.objectContaining({ protocol: 'responses', support: expect.objectContaining({ state: 'supported' }) }),
        ]),
        supported_reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        context_window_tokens: 1_050_000,
        candidate_metadata_complete: true,
      },
      {
        model_id: 'o3',
        automatic_selection_eligible: true,
        source: 'incomplete',
        supported_endpoints: [],
        supported_reasoning_efforts: null,
        context_window_tokens: null,
        candidate_metadata_complete: false,
      },
    ]);
  });

  it('does not expose maintained reasoning, context, or native endpoint metadata for a custom target', () => {
    const adapter = {
      name: 'openai',
      getTargetHost: () => 'router.example.com',
      getTargetScheme: () => 'https',
      getReflectionInfo: () => ({
        provider: 'openai', port: 10000, configured: true, models_cache_key: 'openai',
      }),
    };
    const result = createManagementHandlers({
      getAdapters: () => [adapter],
      getCachedModels: () => ({ openai: ['gpt-5.4-mini'] }),
      getRuntimeModelMetadata: () => ({ openai: [] }),
      getRoutingModelMetadata: () => ({ openai: [] }),
      isModelFetchComplete: () => true,
      getModelAliases: () => null,
      getModelFallback: () => null,
      getEffectiveModelFallback: () => ({}),
      getAiCreditsUsage: () => ({}),
      getMaxRunsUsage: () => ({}),
      getMaxCacheMissesUsage: () => ({}),
      getPermissionDeniedUsage: () => ({}),
    }).reflectEndpoints();

    expect(result.endpoints[0].routing_models[0]).toMatchObject({
      model_id: 'gpt-5.4-mini',
      source: 'incomplete',
      supported_endpoints: [],
      supported_reasoning_efforts: null,
      context_window_tokens: null,
      candidate_metadata_complete: false,
    });
    expect(result.endpoints[0].routing_models[0]).not.toHaveProperty('maintained_protocols');
  });
});

describe('model policy filtering in /reflect', () => {
  function reflect(modelPolicy) {
    const adapters = ['openai', 'copilot'].map((provider, index) => ({
      name: provider,
      getReflectionInfo: () => ({
        provider,
        port: 10000 + index,
        base_url: `http://api-proxy:${10000 + index}`,
        configured: true,
        models_cache_key: provider,
        models_url: `http://api-proxy:${10000 + index}/v1/models`,
      }),
    }));
    return createManagementHandlers({
      getAdapters: () => adapters,
      getCachedModels: () => ({
        openai: ['gpt-5.4', 'gpt-4o-mini'],
        copilot: ['gpt-5.4', 'claude-sonnet-5'],
      }),
      getRuntimeModelMetadata: () => ({
        openai: [{ id: 'gpt-5.4' }, { id: 'gpt-4o-mini' }],
        copilot: [{ id: 'gpt-5.4' }, { id: 'claude-sonnet-5' }],
      }),
      isModelFetchComplete: () => true,
      getKeyValidationState: () => ({ complete: true, results: {} }),
      getLimiter: () => ({ getAllStatus: () => ({}) }),
      getModelAliases: () => ({ models: { custom: ['openai/gpt-5.4'] } }),
      getModelFallback: () => ({ enabled: true }),
      getEffectiveModelFallback: () => ({}),
      getAiCreditsUsage: () => ({}),
      getMaxRunsUsage: () => ({}),
      getMaxCacheMissesUsage: () => ({}),
      getPermissionDeniedUsage: () => ({}),
      modelPolicy,
    }).reflectEndpoints();
  }

  function modelsByProvider(reflection, field) {
    return Object.fromEntries(reflection.endpoints.map(endpoint => [
      endpoint.provider,
      endpoint[field],
    ]));
  }

  it('applies an allowlist to model IDs and associated metadata', () => {
    const result = reflect({ allowedModels: ['*5.4'] });

    expect(modelsByProvider(result, 'models')).toEqual({
      openai: ['gpt-5.4'],
      copilot: ['gpt-5.4'],
    });
    expect(modelsByProvider(result, 'model_metadata')).toEqual({
      openai: [{ id: 'gpt-5.4' }],
      copilot: [{ id: 'gpt-5.4' }],
    });
    expect(modelsByProvider(result, 'routing_models').openai.map(model => model.model_id)).toEqual(['gpt-5.4']);
    expect(modelsByProvider(result, 'routing_models').copilot.map(model => model.model_id)).toEqual(['gpt-5.4']);
  });

  it('applies a denylist to model IDs and associated metadata', () => {
    const result = reflect({ disallowedModels: ['*mini*'] });

    expect(modelsByProvider(result, 'models').openai).toEqual(['gpt-5.4']);
    expect(modelsByProvider(result, 'model_metadata').openai).toEqual([{ id: 'gpt-5.4' }]);
    expect(modelsByProvider(result, 'routing_models').openai.map(model => model.model_id)).toEqual(['gpt-5.4']);
  });

  it('gives the denylist precedence over the allowlist', () => {
    const result = reflect({
      allowedModels: ['*gpt*', '*sonnet*', '*4o*'],
      disallowedModels: ['*4o*'],
    });

    expect(modelsByProvider(result, 'models')).toEqual({
      openai: ['gpt-5.4'],
      copilot: ['gpt-5.4', 'claude-sonnet-5'],
    });
  });

  it('matches provider-qualified patterns against the endpoint provider', () => {
    const result = reflect({
      allowedModels: ['openai/gpt-*', 'github-copilot/gpt-*'],
      disallowedModels: ['github-copilot/gpt-5.4'],
    });

    expect(modelsByProvider(result, 'models')).toEqual({
      openai: ['gpt-5.4', 'gpt-4o-mini'],
      copilot: [],
    });
  });

  it('preserves model catalogue and unrelated reflection metadata without policy', () => {
    const result = reflect(null);

    expect(modelsByProvider(result, 'models')).toEqual({
      openai: ['gpt-5.4', 'gpt-4o-mini'],
      copilot: ['gpt-5.4', 'claude-sonnet-5'],
    });
    expect(modelsByProvider(result, 'model_metadata').openai).toEqual([
      { id: 'gpt-5.4' },
      { id: 'gpt-4o-mini' },
    ]);
    expect(result.model_aliases).toEqual({ custom: ['openai/gpt-5.4'] });
    expect(result.model_fallback).toEqual({ enabled: true });
    expect(result.endpoints[1].automatic_model_selection).toMatchObject({
      model: 'auto',
      constraint_field: 'model_provider',
      preserves_backend: true,
      candidates: { anthropic: { messages: [] } },
    });
    expect(result.endpoints[1].models).not.toContain('auto');
  });
});

describe('routing metadata in /reflect', () => {
  it('prefers runtime metadata while retaining maintained values where runtime fields are absent', () => {
    expect(buildRoutingModelMetadata('anthropic', ['claude-opus-5-5'], [{
      id: 'claude-opus-5-5',
      supportedEndpoints: ['/v1/messages'],
      capabilities: { limits: { max_context_window_tokens: 900_000 } },
    }])).toEqual([{
      model_id: 'claude-opus-5-5',
      automatic_selection_eligible: true,
      source: 'provider+maintained',
      supported_endpoints: ['/v1/messages'],
      maintained_protocols: [
        expect.objectContaining({ protocol: 'messages', support: expect.objectContaining({ state: 'supported' }) }),
      ],
      supported_reasoning_efforts: ['low', 'medium', 'high', 'max'],
      context_window_tokens: 900_000,
      candidate_metadata_complete: true,
    }]);
  });

  it('publishes whether each model can be selected automatically', () => {
    const routingModels = buildRoutingModelMetadata('copilot',
      ['gpt-5.3-codex', 'gpt-5.6-luna-utility', 'gpt-6-luna-decisions', 'no-endpoints', 'undiscovered-model'], [
        { id: 'gpt-5.3-codex', supportedEndpoints: ['/responses', 'ws:/responses'] },
        { id: 'gpt-5.6-luna-utility', supportedEndpoints: ['/responses'], modelPickerEnabled: false },
        { id: 'gpt-6-luna-decisions', supportedEndpoints: ['/v1/decisions'] },
        { id: 'no-endpoints', supportedEndpoints: [] },
      ]);
    expect(routingModels.map(({ model_id, automatic_selection_eligible, automatic_selection_reason }) =>
      ({ model_id, automatic_selection_eligible, automatic_selection_reason }))).toEqual([
      { model_id: 'gpt-5.3-codex', automatic_selection_eligible: true, automatic_selection_reason: undefined },
      { model_id: 'gpt-5.6-luna-utility', automatic_selection_eligible: false, automatic_selection_reason: 'model_picker_disabled' },
      { model_id: 'gpt-6-luna-decisions', automatic_selection_eligible: false, automatic_selection_reason: 'no_agent_endpoint' },
      { model_id: 'no-endpoints', automatic_selection_eligible: false, automatic_selection_reason: 'no_agent_endpoint' },
      { model_id: 'undiscovered-model', automatic_selection_eligible: true, automatic_selection_reason: undefined },
    ]);
  });

  it('returns null until model discovery provides IDs', () => {
    expect(buildRoutingModelMetadata('openai', null, [])).toBeNull();
  });

  it('uses Copilot routing capabilities and marks models complete only when they produce choices', () => {
    const records = [
      {
        id: 'effort-model',
        capabilities: { supports: { reasoning_effort: ['low', 'high'] } },
        supportedEndpoints: ['/responses'],
      },
      {
        id: 'no-effort-model',
        capabilities: { supports: { streaming: true } },
        supportedEndpoints: ['/chat/completions'],
      },
      {
        id: 'unusable-endpoint',
        capabilities: { supports: { reasoning_effort: ['low'] } },
        supportedEndpoints: ['/unknown'],
      },
      {
        id: 'unknown-effort',
        capabilities: { supports: { reasoning_effort: ['future'] } },
        supportedEndpoints: ['/responses'],
      },
      {
        id: 'non-picker',
        capabilities: { supports: { reasoning_effort: ['low'] } },
        supportedEndpoints: ['/responses'],
        modelPickerEnabled: false,
      },
    ];
    const modelIds = records.map(record => record.id);
    const routingModels = buildRoutingModelMetadata('copilot', modelIds, records);
    const catalogue = {
      provider: 'copilot',
      configured: true,
      discovery: 'complete',
      models: records.map(record => normalizeModel(record.id, record, 'copilot')),
    };
    const choices = buildRoutingCandidates({ catalogue }).choices;

    expect(routingModels).toEqual(expect.arrayContaining([
      expect.objectContaining({
        model_id: 'effort-model',
        source: 'provider',
        supported_reasoning_efforts: ['low', 'high'],
        candidate_metadata_complete: true,
      }),
      expect.objectContaining({
        model_id: 'no-effort-model',
        supported_reasoning_efforts: [],
        candidate_metadata_complete: true,
      }),
      expect.objectContaining({
        model_id: 'non-picker',
        candidate_metadata_complete: false,
        candidate_metadata_reason: 'Model is not enabled in the Copilot model picker',
      }),
    ]));
    expect(new Set(routingModels
      .filter(model => model.candidate_metadata_complete)
      .map(model => model.model_id))).toEqual(new Set(
      choices.map(choice => choice.model.replace('github-copilot/', '')),
    ));
  });

  it('marks newly admitted single-endpoint effortless models complete and normalizes raw endpoint aliases when scoped endpoints are active', () => {
    const copilotRecords = [
      { id: 'effortless-v1-responses', supportedReasoningEfforts: [], supportedEndpoints: ['/v1/responses'] },
      { id: 'effortless-bare-responses', supportedReasoningEfforts: [], supportedEndpoints: ['responses'] },
      { id: 'effortless-messages-only', supportedReasoningEfforts: [], supportedEndpoints: ['/v1/messages'] },
      { id: 'effortless-chat-only', supportedReasoningEfforts: [], supportedEndpoints: ['/chat/completions'] },
      { id: 'ws-plus-alias', supportedReasoningEfforts: ['medium'], supportedEndpoints: ['/v1/responses', 'ws:/responses'] },
    ];
    const ids = copilotRecords.map(record => record.id);

    // Without scoped endpoints, legacy metadata completeness and raw spellings remain unchanged.
    const unscoped = buildRoutingModelMetadata('copilot', ids, copilotRecords);
    expect(unscoped.find(m => m.model_id === 'effortless-v1-responses')).toMatchObject({
      candidate_metadata_complete: false,
      supported_endpoints: ['/v1/responses'],
    });
    expect(unscoped.find(m => m.model_id === 'effortless-bare-responses')).toMatchObject({
      candidate_metadata_complete: false,
      supported_endpoints: ['responses'],
    });

    // With Copilot Responses endpoint active, newly admitted effortless Responses models report
    // complete metadata and canonical /responses matching selection.endpoint, while unrelated
    // Chat-only models remain complete.
    const scopedResponses = buildRoutingModelMetadata('copilot', ids, copilotRecords, undefined, ['/responses']);
    expect(scopedResponses.find(m => m.model_id === 'effortless-v1-responses')).toMatchObject({
      candidate_metadata_complete: true,
      supported_endpoints: ['/responses'],
    });
    expect(scopedResponses.find(m => m.model_id === 'effortless-bare-responses')).toMatchObject({
      candidate_metadata_complete: true,
      supported_endpoints: ['/responses'],
    });
    expect(scopedResponses.find(m => m.model_id === 'effortless-chat-only')).toMatchObject({
      candidate_metadata_complete: true,
      supported_endpoints: ['/chat/completions'],
    });
    expect(scopedResponses.find(m => m.model_id === 'ws-plus-alias')).toMatchObject({
      candidate_metadata_complete: true,
      supported_endpoints: ['/responses', 'ws:/responses'],
    });

    // With Messages endpoint active on Copilot, effortless Messages-only becomes complete.
    const scopedMessages = buildRoutingModelMetadata('copilot', ids, copilotRecords, undefined, ['/v1/messages']);
    expect(scopedMessages.find(m => m.model_id === 'effortless-messages-only')).toMatchObject({
      candidate_metadata_complete: true,
      supported_endpoints: ['/v1/messages'],
    });

    // Native OpenAI single-endpoint effortless Responses model reports complete under ['/responses'].
    const openaiRecords = [
      { id: 'effortless-openai-responses', supportedReasoningEfforts: [], supportedEndpoints: ['/responses'] },
    ];
    expect(buildRoutingModelMetadata('openai', ['effortless-openai-responses'], openaiRecords)[0].candidate_metadata_complete)
      .toBe(false);
    expect(buildRoutingModelMetadata('openai', ['effortless-openai-responses'], openaiRecords, undefined, ['/responses'])[0])
      .toMatchObject({
        candidate_metadata_complete: true,
        supported_endpoints: ['/responses'],
      });

    // Maintained-only OpenAI metadata (without runtime supportedEndpoints) also canonicalizes under scoped endpoints,
    // while unscoped reflection keeps the legacy maintained spellings.
    expect(buildRoutingModelMetadata('openai', ['gpt-5.4'], [])[0].supported_endpoints)
      .toEqual(['chat_completions', 'responses']);
    expect(buildRoutingModelMetadata('openai', ['gpt-5.4'], [], undefined, ['/responses'])[0])
      .toMatchObject({
        candidate_metadata_complete: true,
        supported_endpoints: ['/chat/completions', '/responses'],
      });
  });
});
