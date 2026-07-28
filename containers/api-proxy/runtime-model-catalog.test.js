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
      cacheWrite: null,
      output: 15,
    });
  });

  it('applies an advertised promotion and exposes sanitized provenance', () => {
    const records = parseProviderModelMetadata('copilot', {
      data: [{
        id: 'gpt-test',
        billing: {
          token_prices: {
            batch_size: 500_000,
            default: { input_price: 100, output_price: 400 },
          },
          promo: { discount_percent: 25, message: 'not retained' },
        },
      }],
    }, { format: 'copilot', observedAt: '2026-07-28T00:00:00Z' });
    replaceRuntimeModels('copilot', records);

    expect(resolveRuntimePricing('copilot', 'gpt-test').pricing).toEqual({
      input: 1.5,
      cachedInput: 0.15,
      cacheWrite: null,
      output: 6,
    });
    expect(getRuntimeCatalogSnapshot().copilot[0]).not.toHaveProperty('billing');
    expect(JSON.stringify(getRuntimeCatalogSnapshot())).not.toContain('not retained');
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
