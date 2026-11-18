const {
  filterResolvableAliases,
  filterAvailableModelsToConfiguredProviders,
} = require('./model-provider-filter');

describe('provider filtering module', () => {
  it('uses the injected resolver with fallback and direct-request preference disabled', () => {
    const aliases = { team: ['openai/gpt-*'], missing: ['openai/absent'] };
    const models = { openai: ['gpt-5'] };
    const resolve = jest.fn(alias => alias === 'team' ? { resolvedModel: 'gpt-5' } : null);
    expect(filterResolvableAliases(aliases, models, ['openai'], resolve)).toEqual({ team: aliases.team });
    expect(resolve).toHaveBeenCalledWith('team', aliases, models, 'openai', [], { enabled: false }, null, false);
  });

  it('follows nested aliases and rejects loops before catalogues load', () => {
    const aliases = { team: ['BASE'], base: ['OpenAI/gpt-*'], loop: ['LOOP'], other: ['copilot/*'] };
    const resolve = jest.fn();
    expect(filterResolvableAliases(aliases, { openai: null }, ['openai'], resolve)).toEqual({
      team: aliases.team, base: aliases.base,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('preserves pending configured providers alongside providers with data', () => {
    const aliases = { pending: ['anthropic/*'], missing: ['openai/absent'] };
    expect(filterResolvableAliases(
      aliases, { openai: ['gpt-5'], anthropic: null }, ['openai', 'anthropic'], () => null,
    )).toEqual({ pending: aliases.pending });
  });

  it('does not mutate catalogues when blanking unconfigured providers', () => {
    const models = Object.freeze({ openai: ['gpt-5'], copilot: ['gpt-5'] });
    expect(filterAvailableModelsToConfiguredProviders(models, ['openai'])).toEqual({
      openai: models.openai, copilot: null,
    });
    expect(filterAvailableModelsToConfiguredProviders(models, null)).toBe(models);
    expect(filterAvailableModelsToConfiguredProviders(models, [])).toEqual({ openai: null, copilot: null });
  });

  it.each(['./model-provider-filter', './model-resolver'])('keeps the legacy API usable when %s loads first', first => {
    jest.isolateModules(() => {
      require(first);
      const resolver = require('./model-resolver');
      expect(Object.keys(resolver).sort()).toEqual([
        'compareByVersion', 'extractVersionNumbers', 'filterAvailableModelsToConfiguredProviders',
        'filterResolvableAliases', 'globMatch', 'parseModelAliases', 'resolveModel', 'selectMiddlePowerFallback',
      ]);
      expect(resolver.parseModelAliases).toBe(require('./model-alias-config').parseModelAliases);
      expect(require('./model-fallback').resolveAliasDefinition).toBe(require('./model-alias-config').resolveAliasDefinition);
      const aliases = { team: ['openai/gpt-5'], missing: ['openai/absent'] };
      expect(resolver.filterResolvableAliases(aliases, { openai: ['gpt-5'] }, ['openai'])).toEqual({
        team: aliases.team,
      });
    });
  });
});
