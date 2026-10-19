'use strict';

const fs = require('fs');
const path = require('path');
const { stripRedundantProviderPrefix } = require('./model-utils');
const { resolveModel } = require('./model-resolver');
const { lookupModelEndpoints, lookupModelRoutingMetadata } = require('./model-api-mapping');
const { resolveCatalogModel } = require('./models-dev-catalog');
const { resolveProviderPricingOverlay, resetProviderPricingOverlaysForTests } = require('./provider-pricing-overlays');
const { resolveModelPricingCatalog, resetModelPricingCatalogForTests } = require('./model-pricing-catalog');
const { getRetiredModelBlockState } = require('./guards/retired-model-guard');
const {
  canonicalizeModel: runtimeCanonicalize,
  parseProviderModelMetadata,
  replaceRuntimeModels,
  clearRuntimeModels,
  findRuntimeModel,
  getRuntimeCatalogSnapshot,
} = require('./runtime-model-catalog');
const {
  canonicalizeModel: creditsCanonicalize,
  applyAiCreditsUsage,
  getAiCreditsReflectState,
  resetAiCreditsGuardForTests,
} = require('./guards/ai-credits-guard');
const { createManagementHandlers } = require('./management');
const { buildModelsJson, writeModelsJson } = require('./model-discovery');

const originalEnv = {};
const envKeys = [
  'AWF_API_PROXY_PROVIDERS',
  'AWF_MODEL_PRICING_CATALOG',
  'AWF_DEFAULT_AI_CREDITS_PRICING',
  'AWF_MAX_AI_CREDITS',
];

beforeEach(() => {
  for (const key of envKeys) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  clearRuntimeModels();
  resetAiCreditsGuardForTests();
  resetProviderPricingOverlaysForTests();
  resetModelPricingCatalogForTests();
});

afterEach(() => {
  clearRuntimeModels();
  resetAiCreditsGuardForTests();
  resetProviderPricingOverlaysForTests();
  resetModelPricingCatalogForTests();
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  jest.restoreAllMocks();
});

describe('model identity is intentionally different between consumers', () => {
  it.each([
    ['copilot/Claude.Sonnet_4.6', 'Claude-Sonnet-4-6', 'claude-sonnet-4-6', 'Claude.Sonnet_4.6'],
    ['claude-sonnet-4-6-alpha-2026-10-15', 'claude-sonnet-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-6-alpha-2026-10-15'],
    ['claude-sonnet-4-6-20261015', 'claude-sonnet-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-6-20261015'],
    ['claude-sonnet-4-6?effort=high', 'claude-sonnet-4-6', 'claude-sonnet-4-6?effort=high', 'claude-sonnet-4-6?effort=high'],
  ])('%s: credits / runtime / provider-prefix normalization', (model, credits, runtime, stripped) => {
    expect(creditsCanonicalize(model)).toBe(credits);
    expect(runtimeCanonicalize(model)).toBe(runtime);
    expect(stripRedundantProviderPrefix(model, 'copilot')).toBe(stripped);
  });

  it('runtime discovery canonicalizes dated and dotted IDs but resolver direct matching does not', () => {
    replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
      data: [{ id: 'claude-sonnet-4.6-20261015' }],
    }));
    expect(findRuntimeModel('copilot', 'copilot/CLAUDE_SONNET_4_6')).toMatchObject({
      id: 'claude-sonnet-4.6-20261015',
    });
    expect(resolveModel('claude-sonnet-4-6', {}, {
      copilot: ['claude-sonnet-4.6-20261015'],
    }, 'copilot', [], { enabled: false })).toBeNull();
  });

  it('endpoint mapping is an exact/prefix glob, not a canonicalized pricing match', () => {
    expect(lookupModelEndpoints('gpt-5.5-pro', 'openai')).toMatchObject({
      family: 'gpt-5.5-pro',
      endpoints: ['responses'],
    });
    expect(lookupModelEndpoints('GPT_5_5_PRO', 'openai')).toBeNull();
    expect(lookupModelRoutingMetadata('gpt-5.5-pro', 'openai')).toBeNull();
  });

  it.each([
    ['GPT-5-CODEX', { model: 'GPT-5-CODEX', suggestion: 'gpt-5.3-codex' }],
    ['GPT_5_CODEX', null],
  ])('proxy retirement lookup for %s', (model, expected) => {
    expect(getRetiredModelBlockState(model)).toEqual(expected);
  });

  it.each([
    ['openai/gpt-5.5-pro', true],
    ['openai/gpt-5.5-pro-20261015', true],
    ['gpt_5_5_pro', true],
    ['OPENAI/GPT-5.5-PRO', false],
    ['openai/gpt-5.5-pro?effort=high', false],
  ])('models.dev lookup for %s exists=%s (case and query are not normalized)', (model, exists) => {
    expect(resolveCatalogModel(model).exists).toBe(exists);
  });

  it.each([
    ['copilot/CLAUDE.SONNET_4.6', 2],
    ['claude-sonnet-4-6-20261015', 2],
    ['claude-sonnet-4-6?effort=high', null],
    ['claude-sonnet-4-6-other', 2],
  ])('operator overlay for %s: separator, date, suffix and query differences', (model, input) => {
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      copilot: { models: { 'claude-sonnet-4-6': { cost: {
        input: 0.000002, output: 0.000004,
      } } } },
    });
    expect(resolveProviderPricingOverlay('copilot', model)?.pricing.input ?? null).toBe(input);
  });

  it('operator overlays preserve exact dated tariffs and fall back to the base tariff for other dates', () => {
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      copilot: { models: {
        'claude-sonnet-4-6': { cost: { input: 0.000002, output: 0.000004 } },
        'claude-sonnet-4-6-20261015': { cost: { input: 0.000007, output: 0.000009 } },
      } },
    });
    expect(resolveProviderPricingOverlay('copilot', 'claude-sonnet-4-6-20261015')?.pricing.input).toBe(7);
    expect(resolveProviderPricingOverlay('copilot', 'claude-sonnet-4-6-20261016')?.pricing.input).toBe(2);
  });

  it.each([
    ['claude-opus-5-5', true],
    ['claude-sonnet-5-5', true],
    ['gemini-3.8-flash', true],
    ['grok-4.5', true],
    ['grok-4.6', true],
    ['grok-4.7', true],
    ['gpt-6.1-sol', false],
  ])('#10029: %s currently lacks a curated tariff', (model, absent) => {
    const curated = require('./ai-credits-pricing');
    expect(Object.hasOwn(curated, model)).toBe(!absent);
  });

  it.each([
    ['gpt-5.4-mini', 'openai'],
    ['gpt-5.5', 'openai'],
    ['gpt-5.6', 'openai'],
    ['gpt-5.6-sol', 'openai'],
    ['gpt-5.6-terra', 'openai'],
    ['gpt-5.6-luna', 'openai'],
    ['gpt-6-sol', 'openai'],
    ['gpt-6-astra', 'openai'],
    ['gpt-6-luna', 'openai'],
    ['claude-haiku-5-5', 'anthropic'],
  ])('#10030: %s currently has no maintained routing choices', (model, provider) => {
    expect(lookupModelRoutingMetadata(model, provider)).toBeNull();
  });

  it.each([
    ['claude-opus-5', 'anthropic'],
    ['claude-opus-5-5', 'anthropic'],
    ['claude-sonnet-5', 'anthropic'],
    ['claude-sonnet-5-5', 'anthropic'],
    ['claude-opus-4-7', 'anthropic'],
    ['claude-opus-4-8', 'anthropic'],
  ])('#10030: %s routing metadata currently omits xhigh', (model, provider) => {
    const routing = lookupModelRoutingMetadata(model, provider);
    expect(routing).not.toBeNull();
    expect(routing.reasoningEfforts).not.toContain('xhigh');
  });
});

describe('effective AI-credit tariff precedence and provenance', () => {
  const model = 'claude-sonnet-4-6';
  const observedAt = '2026-10-15T12:00:00Z';
  const usage = { input_tokens: 1000, output_tokens: 0 };

  function setRuntime(id = model, prices = {
    input_price: 100, output_price: 400, cache_read_price: 10, cache_write_price: 20,
  }) {
    replaceRuntimeModels('copilot', parseProviderModelMetadata('copilot', {
      data: [{ id, billing: { token_prices: { batch_size: 1_000_000, default: prices } } }],
    }, { apiVersion: 'v-test', observedAt }));
  }

  it.each([
    ['provider', () => setRuntime(), 'provider', 0.1],
    ['incomplete provider merged with curated', () => setRuntime(model, {
      input_price: 100, output_price: 400,
    }), 'provider', 0.1],
    ['curated when runtime is absent', () => {}, 'curated', 0.3],
  ])('%s', (_case, setup, source, inputCredits) => {
    setup();
    const result = applyAiCreditsUsage(usage, model, 'copilot');
    expect(result).toMatchObject({
      pricingSource: source,
      pricingTier: 'default',
      inputCreditsThisResponse: inputCredits,
    });
    if (source === 'provider') {
      expect(result).toMatchObject({ pricingObservedAt: observedAt, pricingApiVersion: 'v-test' });
    }
  });

  it('incomplete runtime merges cached and cache-write rates from curated pricing, retaining runtime provenance', () => {
    setRuntime(model, { input_price: 100, output_price: 400 });
    const result = applyAiCreditsUsage({
      input_tokens: 1000, cache_read_tokens: 100, cache_write_tokens: 100,
    }, model, 'copilot');
    expect(result).toMatchObject({
      inputCreditsThisResponse: 0.1,
      cachedInputCreditsThisResponse: 0.003,
      cacheWriteCreditsThisResponse: 0.0375,
      pricingSource: 'provider',
      pricingTier: 'default',
      pricingObservedAt: observedAt,
    });
  });

  it.each([
    [272_000, 2, 'default'],
    [272_001, 4, 'long_context'],
  ])('curated long-context tier starts strictly above %i input tokens', (inputTokens, rate, tier) => {
    const result = applyAiCreditsUsage({ input_tokens: inputTokens }, 'gpt-6.1-sol', 'copilot');
    expect(result.pricingSource).toBe('curated');
    expect(result.pricingTier).toBe(tier);
    expect(result.inputCreditsThisResponse).toBeCloseTo(inputTokens * rate / 10_000, 6);
    expect(getAiCreditsReflectState().by_model['gpt-6.1-sol']).toMatchObject({
      pricing_source: 'curated', pricing_tier: tier,
    });
  });

  it('operator overlay outranks the shared catalog and a complete provider tariff', () => {
    setRuntime();
    process.env.AWF_API_PROXY_PROVIDERS = JSON.stringify({
      copilot: { models: { [model]: { cost: { input: 0.000002, output: 0.000005 } } } },
    });
    process.env.AWF_MODEL_PRICING_CATALOG = JSON.stringify({
      schemaVersion: 1, unit: 'USD_PER_1M_TOKENS',
      catalogId: 'fixture', version: 'v1',
      providers: { copilot: { models: { [model]: {
        input: 9, cachedInput: 0.9, cacheWrite: null, output: 10, reasoning: 10,
      } } } },
    });
    const operator = applyAiCreditsUsage(usage, model, 'copilot');
    expect(operator).toMatchObject({ pricingSource: 'operator', inputCreditsThisResponse: 0.2 });
    expect(resolveProviderPricingOverlay('copilot', `copilot/${model}-20261015`))
      .toMatchObject({ source: 'operator', pricing: { input: 2 } });
    expect(resolveModelPricingCatalog('copilot', `copilot/${model}-20261015`))
      .toMatchObject({ source: 'shared_catalog', pricingCatalogId: 'fixture' });
    delete process.env.AWF_API_PROXY_PROVIDERS;
    expect(applyAiCreditsUsage(usage, model, 'copilot')).toMatchObject({
      pricingSource: 'shared_catalog', pricingCatalogVersion: 'v1', inputCreditsThisResponse: 0.9,
    });
  });

  it.each([
    ['openai/gpt-5.5-pro', 'models.dev'],
    ['copilot/auto', 'dynamic_selector_fallback'],
    ['unlisted-model', 'configured_default'],
    ['unknown', 'configured_default'],
  ])('%s falls through to %s when no higher tariff exists', (qualified, source) => {
    process.env.AWF_DEFAULT_AI_CREDITS_PRICING = JSON.stringify({ input: 7, output: 8 });
    const [provider, modelId] = qualified.includes('/')
      ? qualified.split('/')
      : ['copilot', qualified];
    expect(applyAiCreditsUsage(usage, modelId, provider)).toMatchObject({ pricingSource: source });
  });

  it('unknown sentinel uses the built-in fallback without a configured default', () => {
    expect(applyAiCreditsUsage(usage, 'unknown', 'copilot')).toMatchObject({
      pricingSource: 'builtin_fallback', inputCreditsThisResponse: 0.3,
    });
    expect(resolveCatalogModel('openai/gpt-5.5-pro')).toMatchObject({
      exists: true, pricing: { input: 30 },
    });
  });
});

describe('public and persisted metadata projections', () => {
  it('keeps mapping copies byte-identical until they have a single generator', () => {
    const proxy = fs.readFileSync(path.join(__dirname, 'model-api-mapping.json'));
    const docs = fs.readFileSync(path.join(__dirname, '../../docs/model-api-mapping.json'));
    expect(proxy.equals(docs)).toBe(true);
  });

  it('exposes sanitized runtime pricing, routing, and credit provenance in /reflect and models.json', () => {
    const records = parseProviderModelMetadata('copilot', {
      data: [{ id: 'gpt-5.4', supported_endpoints: ['/responses'], billing: {
        token_prices: { batch_size: 1_000_000, default: {
          input_price: 100, output_price: 400, cache_read_price: 10, cache_write_price: 20,
        } },
      } }],
    }, { observedAt: '2026-10-15T12:00:00Z', apiVersion: 'v-test' });
    replaceRuntimeModels('copilot', records);
    applyAiCreditsUsage({ input_tokens: 1000 }, 'gpt-5.4', 'copilot');
    const metadata = getRuntimeCatalogSnapshot();
    const adapter = {
      name: 'copilot',
      getReflectionInfo: () => ({
        provider: 'copilot', port: 10002, base_url: 'http://proxy:10002',
        configured: true, models_cache_key: 'copilot',
      }),
      isEnabled: () => true,
      getTargetHost: () => 'api.githubcopilot.com',
    };
    const handlers = createManagementHandlers({
      getAdapters: () => [adapter],
      getCachedModels: () => ({ copilot: ['gpt-5.4'] }),
      getRuntimeModelMetadata: () => metadata,
      getRoutingModelMetadata: () => ({ copilot: records }),
      isModelFetchComplete: () => true,
      getModelAliases: () => ({ models: { primary: ['copilot/gpt-5.4'] } }),
      getModelFallback: () => ({ enabled: false }),
      getEffectiveModelFallback: () => ({}),
      getAiCreditsUsage: getAiCreditsReflectState,
      getMaxRunsUsage: () => ({}),
      getMaxCacheMissesUsage: () => ({}),
      getPermissionDeniedUsage: () => ({}),
    });
    const res = { writeHead: jest.fn(), end: jest.fn() };
    expect(handlers.handleManagementEndpoint({ method: 'GET', url: '/reflect' }, res)).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    const reflection = JSON.parse(res.end.mock.calls[0][0]);
    expect(reflection.endpoints[0]).toMatchObject({
      models: ['gpt-5.4'],
      model_metadata: [{ id: 'gpt-5.4', source: 'provider', wire_api: 'responses',
        observed_at: '2026-10-15T12:00:00Z', api_version: 'v-test',
        pricing: { default: { input: 1, output: 4, cachedInput: 0.1, cacheWrite: 0.2 } } }],
      routing_models: [{ model_id: 'gpt-5.4', source: 'provider' }],
    });
    expect(reflection.endpoints[0].model_metadata[0]).not.toHaveProperty('billing');
    expect(reflection.ai_credits.by_model['gpt-5.4']).toMatchObject({
      pricing_source: 'provider', pricing_tier: 'default',
    });
    expect(reflection.ai_credits.by_model['gpt-5.4']).not.toHaveProperty('pricing_observed_at');

    const payload = buildModelsJson([adapter], { copilot: ['gpt-5.4'] },
      { models: { primary: ['copilot/gpt-5.4'] } }, metadata);
    const mkdir = jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    const write = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    writeModelsJson([adapter], {}, null, path.join(__dirname, 'fixture-log'), payload);
    expect(mkdir).toHaveBeenCalled();
    const persisted = JSON.parse(write.mock.calls[0][1]);
    expect(persisted).toMatchObject({
      providers: { copilot: { configured: true, target: 'api.githubcopilot.com',
        models: ['gpt-5.4'], model_metadata: [{
          id: 'gpt-5.4', observed_at: '2026-10-15T12:00:00Z', api_version: 'v-test',
        }] } },
      model_aliases: { primary: ['copilot/gpt-5.4'] },
    });
    expect(persisted.timestamp).toEqual(expect.any(String));
    expect(persisted).not.toHaveProperty('ai_credits');
  });
});
