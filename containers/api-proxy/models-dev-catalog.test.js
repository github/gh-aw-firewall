const { buildCatalogIndex, resolveCatalogModel } = require('./models-dev-catalog');

const entry = (id, prompt, completion, canonical_slug = undefined) => ({
  id, canonical_slug, pricing: { prompt, completion },
});

describe('models-dev-catalog', () => {
  it('resolves exact IDs and canonical aliases into normalized fallback pricing', () => {
    const index = buildCatalogIndex([
      entry('google/gemma-4-31b-it:free', '0', '0', 'google/gemma-4-31b-it'),
      entry('openai/fixture-model', '0.000001', '0.000002', 'shared/fixture-alias'),
    ]);

    expect(resolveCatalogModel('google/gemma-4-31b-it', index)).toEqual({
      exists: true,
      pricing: { input: 0, cachedInput: 0, cacheWrite: null, output: 0 },
      zeroCost: true,
    });
    expect(resolveCatalogModel('google/gemma-4-31b-it:free', index))
      .toEqual(resolveCatalogModel('google/gemma-4-31b-it', index));
    expect(resolveCatalogModel('shared/fixture-alias', index)).toEqual({
      exists: true,
      pricing: { input: 1, cachedInput: 0.1, cacheWrite: null, output: 2 },
      zeroCost: false,
    });
  });

  it('prioritizes exact IDs over canonical aliases when lookup keys collide', () => {
    const free = entry('google/gemma-4-31b-it', '0', '0', 'gemma-4-31b-it');
    const priced = entry('openai/alias-competitor', '0.00000012', '0.00000037', 'gemma-4-31b-it');
    const firstFree = buildCatalogIndex([free, priced]);
    const firstPriced = buildCatalogIndex([priced, free]);

    expect(resolveCatalogModel('gemma-4-31b-it', firstFree).pricing?.input).toBe(0);
    expect(resolveCatalogModel('gemma-4-31b-it', firstPriced).pricing?.input).toBe(0);
  });

  it('does not fall back to an alias price when the exact model is unpriced', () => {
    const index = buildCatalogIndex([
      entry('openai/fixture-model', '-1', '-1'),
      entry('openai/alias-competitor', '0.00000012', '0.00000037', 'openai/fixture-model'),
    ]);

    expect(resolveCatalogModel('openai/fixture-model', index)).toEqual({
      exists: true, pricing: null, zeroCost: false,
    });
  });

  it('recognizes known entries while excluding negative sentinel pricing', () => {
    const index = buildCatalogIndex([
      entry('openrouter/pareto-code', '-1', '-1'),
      entry('openai/fixture-unpriced', '0.000001', '-1'),
    ]);

    expect(resolveCatalogModel('openrouter/pareto-code', index)).toEqual({
      exists: true, pricing: null, zeroCost: false,
    });
    expect(resolveCatalogModel('openai/fixture-unpriced', index)).toEqual({
      exists: true, pricing: null, zeroCost: false,
    });
  });

  it.each([false, true])('uses the exact DeepSeek price over a versioned alias (alias first: %s)', aliasFirst => {
    const exact = {
      id: 'deepseek/deepseek-v4-flash',
      canonical_slug: 'deepseek/deepseek-v4-flash-20260423',
      pricing: { prompt: '0.000000091', input_cache_read: '0.0000000182', completion: '0.000000182' },
    };
    const versioned = {
      id: 'deepseek/deepseek-v4-flash-0731',
      canonical_slug: 'deepseek/deepseek-v4-flash-20260731',
      pricing: { prompt: '0.0000000434', input_cache_read: '0.000000035', completion: '0.0000003' },
    };
    const index = buildCatalogIndex(aliasFirst ? [versioned, exact] : [exact, versioned]);

    expect(resolveCatalogModel('deepseek/deepseek-v4-flash', index)).toEqual({
      exists: true, zeroCost: false,
      pricing: { input: 0.091, cachedInput: 0.0182, cacheWrite: null, output: 0.182 },
    });
  });
});
