const { resolveCatalogModel } = require('./models-dev-catalog');

describe('models-dev-catalog', () => {
  it('resolves bundled pricing for catalog models outside the curated pricing table', () => {
    expect(resolveCatalogModel('openai/gpt-5.5-pro')).toEqual({
      exists: true,
      pricing: {
        input: 30,
        cachedInput: 3,
        cacheWrite: null,
        output: 180,
      },
      zeroCost: false,
    });
  });

  it('treats catalog entries with negative sentinel pricing as unpriced', () => {
    // "openrouter/pareto-code" has prompt/completion "-1" sentinel values in the bundled catalog
    expect(resolveCatalogModel('openrouter/pareto-code')).toEqual({
      exists: true,
      pricing: null,
      zeroCost: false,
    });
  });

  it('recognizes zero-cost catalog models', () => {
    expect(resolveCatalogModel('google/gemma-4-31b-it:free')).toEqual({
      exists: true,
      pricing: {
        input: 0,
        cachedInput: 0,
        cacheWrite: null,
        output: 0,
      },
      zeroCost: true,
    });
  });

  it('includes bundled pricing for claude-fable-5 and claude-mythos-5', () => {
    expect(resolveCatalogModel('claude-fable-5')).toEqual({
      exists: true,
      pricing: {
        input: 10,
        cachedInput: 1,
        cacheWrite: 12.5,
        output: 50,
      },
      zeroCost: false,
    });
    expect(resolveCatalogModel('claude-mythos-5')).toEqual({
      exists: true,
      pricing: {
        input: 10,
        cachedInput: 1,
        cacheWrite: 12.5,
        output: 50,
      },
      zeroCost: false,
    });
  });
});
