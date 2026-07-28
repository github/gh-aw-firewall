'use strict';

const {
  parseProviderModelMetadata,
  replaceRuntimeModels,
  clearRuntimeModels,
  resolveRuntimePricing,
  getRuntimeCatalogSnapshot,
} = require('./runtime-model-catalog');

describe('runtime model catalog', () => {
  afterEach(() => clearRuntimeModels());

  it('normalizes current Copilot tiered pricing into dollars per million tokens', () => {
    const records = parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-5.6-terra',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: {
              input_price: 250,
              output_price: 1500,
              cache_read_price: 25,
              cache_write_price: 0,
              max_prompt_tokens: 272_000,
            },
            long_context: {
              input_price: 500,
              output_price: 2250,
              cache_read_price: 50,
              cache_write_price: 0,
              max_prompt_tokens: 1_000_000,
            },
          },
        },
      }],
    }, { format: 'copilot', apiVersion: '2026-07-01', observedAt: '2026-07-28T00:00:00Z' });

    replaceRuntimeModels('copilot', records);
    expect(resolveRuntimePricing('copilot', 'gpt-5.6-terra', 1000)).toMatchObject({
      pricing: { input: 2.5, cachedInput: 0.25, cacheWrite: 0, output: 15 },
      source: 'provider',
      tier: 'default',
      apiVersion: '2026-07-01',
    });
    expect(resolveRuntimePricing('copilot', 'gpt-5.6-terra', 300_000)).toMatchObject({
      pricing: { input: 5, cachedInput: 0.5, cacheWrite: 0, output: 22.5 },
      tier: 'long_context',
    });
  });

  it('normalizes legacy Copilot nano-AIU pricing', () => {
    const records = parseProviderModelMetadata('copilot', {
      data: [{
        id: 'claude-sonnet-4.6',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            input_price: 300_000_000_000,
            output_price: 1_500_000_000_000,
            cache_price: 30_000_000_000,
          },
        },
      }],
    }, { format: 'copilot' });
    replaceRuntimeModels('copilot', records);

    expect(resolveRuntimePricing('copilot', 'claude-sonnet-4-6', 1000).pricing).toEqual({
      input: 3,
      cachedInput: 0.3,
      output: 15,
    });
  });

  it('exposes an advertised promotion without applying it to pricing', () => {
    const records = parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-test',
        billing: {
          token_prices: {
            batch_size: 500_000,
            default: {
              input_price: 100,
              output_price: 400,
              cache_read_price: 10,
              cache_write_price: 0,
            },
          },
          promo: { discount_percent: 25, message: 'not retained' },
        },
      }],
    }, { format: 'copilot', observedAt: '2026-07-28T00:00:00Z' });
    replaceRuntimeModels('copilot', records);

    expect(resolveRuntimePricing('copilot', 'gpt-test').pricing).toEqual({
      input: 2,
      cachedInput: 0.2,
      cacheWrite: 0,
      output: 8,
    });
    expect(getRuntimeCatalogSnapshot().copilot[0].promotion).toEqual({
      discount_percent: 25,
    });
    expect(getRuntimeCatalogSnapshot().copilot[0]).not.toHaveProperty('billing');
    expect(JSON.stringify(getRuntimeCatalogSnapshot())).not.toContain('not retained');
  });

  it('retains complete pricing when a later refresh omits billing fields', () => {
    const initial = parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-test',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: {
              input_price: 100,
              output_price: 400,
              cache_read_price: 10,
              cache_write_price: 20,
            },
          },
        },
      }],
    }, { format: 'copilot', observedAt: '2026-07-28T00:00:00Z' });
    replaceRuntimeModels('copilot', initial);

    const incomplete = parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-test',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: { input_price: 200, output_price: 800 },
          },
        },
      }],
    }, { format: 'copilot', observedAt: '2026-07-28T01:00:00Z' });
    replaceRuntimeModels('copilot', incomplete);

    expect(resolveRuntimePricing('copilot', 'gpt-test').pricing).toEqual({
      input: 1,
      cachedInput: 0.1,
      cacheWrite: 0.2,
      output: 4,
    });
    expect(resolveRuntimePricing('copilot', 'gpt-test').observedAt)
      .toBe('2026-07-28T00:00:00Z');
  });

  it('tracks provenance separately when only one refreshed tier is complete', () => {
    const initial = parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-test',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: {
              input_price: 100,
              output_price: 400,
              cache_read_price: 10,
              cache_write_price: 20,
              max_prompt_tokens: 1000,
            },
            long_context: {
              input_price: 200,
              output_price: 800,
              cache_read_price: 20,
              cache_write_price: 40,
            },
          },
        },
      }],
    }, {
      format: 'copilot',
      apiVersion: 'old',
      observedAt: '2026-07-28T00:00:00Z',
    });
    replaceRuntimeModels('copilot', initial);

    const mixed = parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-test',
        billing: {
          token_prices: {
            batch_size: 1_000_000,
            default: {
              input_price: 300,
              output_price: 1200,
              cache_read_price: 30,
              cache_write_price: 60,
              max_prompt_tokens: 1000,
            },
            long_context: { input_price: 400, output_price: 1600 },
          },
        },
      }],
    }, {
      format: 'copilot',
      apiVersion: 'new',
      observedAt: '2026-07-28T01:00:00Z',
    });
    replaceRuntimeModels('copilot', mixed);

    expect(resolveRuntimePricing('copilot', 'gpt-test', 500)).toMatchObject({
      observedAt: '2026-07-28T01:00:00Z',
      apiVersion: 'new',
      pricing: { input: 3, cachedInput: 0.3, cacheWrite: 0.6, output: 12 },
    });
    expect(resolveRuntimePricing('copilot', 'gpt-test', 1500)).toMatchObject({
      observedAt: '2026-07-28T00:00:00Z',
      apiVersion: 'old',
      pricing: { input: 2, cachedInput: 0.2, cacheWrite: 0.4, output: 8 },
    });
  });

  it('preserves generic provider availability without inventing pricing', () => {
    const records = parseProviderModelMetadata('anthropic', {
      data: [{ id: 'claude-new', capabilities: { batch: { supported: true } } }],
    });
    replaceRuntimeModels('anthropic', records);

    expect(records[0]).toMatchObject({
      provider: 'anthropic',
      id: 'claude-new',
      source: 'provider',
    });
    expect(resolveRuntimePricing('anthropic', 'claude-new')).toBeNull();
  });
});
