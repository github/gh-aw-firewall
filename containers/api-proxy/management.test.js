'use strict';

const { buildRoutingModelMetadata, createManagementHandlers } = require('./management');
const { normalizeModel } = require('./routing-catalogue');
const { buildRoutingCandidates } = require('./routing-candidates');

describe('routing metadata in /reflect', () => {
  it('combines discovered IDs with maintained provider metadata and marks incomplete models', () => {
    expect(buildRoutingModelMetadata('openai', ['gpt-5.4', 'o3'], [])).toEqual([
      {
        model_id: 'gpt-5.4',
        source: 'maintained',
        supported_endpoints: ['chat_completions', 'responses'],
        supported_reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        context_window_tokens: 1_050_000,
        candidate_metadata_complete: true,
      },
      {
        model_id: 'o3',
        source: 'incomplete',
        supported_endpoints: ['chat_completions', 'responses'],
        supported_reasoning_efforts: null,
        context_window_tokens: null,
        candidate_metadata_complete: false,
      },
    ]);
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
      source: 'provider+maintained',
      supported_endpoints: ['/v1/messages'],
      supported_reasoning_efforts: ['low', 'medium', 'high', 'max'],
      context_window_tokens: 900_000,
      candidate_metadata_complete: true,
    }]);
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
});
