const { _resolveAliasPatterns } = require('./model-alias-pattern-expansion');
const { resolveModel } = require('./model-resolver');
const { proxyEligibilityStore } = require('./model-eligibility');
const { clearRuntimeModels } = require('./runtime-model-catalog');

function context(overrides = {}) {
  return {
    aliasKey: 'coding',
    aliasDefinition: { patterns: ['copilot/gpt-*'], fallback: true },
    requestedModel: 'coding',
    aliases: {},
    availableModels: { copilot: ['gpt-5.3-codex', 'gpt-5.4'] },
    currentProvider: 'copilot',
    newChain: ['coding'],
    fallbackConfig: { enabled: true, strategy: 'middle_power' },
    log: [],
    modelPolicyConfig: null,
    resolutionState: { blocked: false, eligibilityRequest: {} },
    resolveModel,
    ...overrides,
  };
}

afterEach(() => {
  proxyEligibilityStore.replaceTrustedEvidence({});
  clearRuntimeModels();
});

describe('_resolveAliasPatterns', () => {
  test('keeps the facade exports unchanged', () => {
    expect(Object.keys(require('./model-resolver')).sort()).toEqual([
      'compareByVersion', 'extractVersionNumbers', 'filterAvailableModelsToConfiguredProviders',
      'filterResolvableAliases', 'globMatch', 'parseModelAliases', 'resolveModel', 'selectMiddlePowerFallback',
    ]);
  });

  test('matches provider prefixes case-insensitively, deduplicates, ranks and preserves parameters and log identity', () => {
    const ctx = context({
      requestedModel: 'coding?effort=high',
      aliasDefinition: {
        patterns: ['openai/gpt-9', 'CoPiLoT/GPT-*', 'copilot/gpt-5.4'], fallback: true,
      },
      log: ['prior resolution'],
    });

    expect(_resolveAliasPatterns(ctx)).toEqual({
      resolvedModel: 'gpt-5.4?effort=high',
      candidates: ['gpt-5.4?effort=high', 'gpt-5.3-codex?effort=high'],
      aliasKeys: ['coding'],
      log: ctx.log,
      fallback: {
        activated: false, selection_method: 'middle_power_median', reason: 'normal_resolution_succeeded',
      },
    });
    expect(ctx.log).toEqual([
      'prior resolution',
      '[model-resolver] alias: "coding?effort=high" → [openai/gpt-9, CoPiLoT/GPT-*, copilot/gpt-5.4]',
      '[model-resolver] resolved: "coding?effort=high" → "gpt-5.4" (2 candidates: gpt-5.4, gpt-5.3-codex)',
    ]);
  });

  test('filters policy-denied matches without synthesizing a replacement', () => {
    const ctx = context({
      aliasDefinition: { patterns: ['copilot/gpt-5.4'], fallback: true },
      modelPolicyConfig: { disallowedModels: ['gpt-5.4'] },
    });
    expect(_resolveAliasPatterns(ctx)).toBeNull();
    expect(ctx.resolutionState.blocked).toBe(true);
    expect(ctx.log).toContain('[model-resolver] model eligibility filtered out 1 candidate(s): gpt-5.4');
  });

  test('selects only policy-permitted matches', () => {
    expect(_resolveAliasPatterns(context({
      modelPolicyConfig: { allowedModels: ['gpt-5.3-codex'] },
    })).candidates).toEqual(['gpt-5.3-codex']);
  });

  test('retains the harness rejection and blocks synthesis when every genuine match is incompatible', () => {
    const { identity } = require('./model-identity').resolveModelIdentity('gpt-5.4', 'copilot');
    proxyEligibilityStore.replaceTrustedEvidence({
      models: [{
        identity,
        harnesses: [{
          name: 'copilot', scheme: 'semver', minimum: '1.2.0',
          scope: { provider: 'copilot', channel: 'copilot-api' },
        }],
      }],
      executionEnvironment: 'actual-agent',
      observations: [{
        name: 'copilot', scheme: 'semver', version: '1.1.0',
        scope: { provider: 'copilot', channel: 'copilot-api' },
        environment: 'actual-agent', verified: true, actual: true,
      }],
    });
    const ctx = context({ aliasDefinition: { patterns: ['copilot/gpt-5.4'], fallback: true } });
    expect(_resolveAliasPatterns(ctx)).toBeNull();
    expect(ctx.resolutionState).toMatchObject({
      blocked: true, harnessRejection: { harness: 'incompatible' },
    });
  });

  test.each([false, true])('blocks a retired target before discovery (advertised: %s)', advertised => {
    const ctx = context({
      aliasDefinition: { patterns: ['copilot/gpt-5-codex'], fallback: true },
      availableModels: { copilot: advertised ? ['gpt-5-codex', 'gpt-5.4'] : ['gpt-5.4'] },
    });
    expect(_resolveAliasPatterns(ctx)).toBeNull();
    expect(ctx.resolutionState.blocked).toBe(true);
    expect(ctx.log).toContain('[model-resolver] ignored retired model target "gpt-5-codex"');
  });

  test('excludes automatic-ineligible wildcard matches but preserves explicit choices', () => {
    const ctx = context({
      resolutionState: {
        blocked: false,
        eligibilityRequest: {
          awfRuntimePricing: { copilot: [{ id: 'gpt-5.4', modelPickerEnabled: false }] },
        },
      },
    });
    expect(_resolveAliasPatterns(ctx).candidates).toEqual(['gpt-5.3-codex']);
    expect(ctx.resolutionState.blocked).toBe(true);
    expect(_resolveAliasPatterns({
      ...ctx,
      aliasDefinition: { patterns: ['copilot/gpt-5.4'], fallback: true },
    }).resolvedModel).toBe('gpt-5.4');
  });

  test('does not synthesize after wildcard matches were rejected', () => {
    const ctx = context({
      aliasDefinition: { patterns: ['copilot/gpt-5.4*'], fallback: true },
      resolutionState: {
        blocked: false,
        eligibilityRequest: {
          awfRuntimePricing: { copilot: [{ id: 'gpt-5.4', modelPickerEnabled: false }] },
        },
      },
    });
    expect(_resolveAliasPatterns(ctx)).toBeNull();
    expect(ctx.resolutionState.blocked).toBe(true);
  });

  test('prefers a genuine sibling over a higher-ranked synthesized nested result', () => {
    const ctx = context({
      aliasDefinition: { patterns: ['missing', 'copilot/gpt-4.1'], fallback: true },
      aliases: { missing: ['copilot/unavailable'] },
      availableModels: { copilot: ['gpt-5.3-codex', 'gpt-5.4', 'gpt-4.1'] },
    });
    expect(_resolveAliasPatterns(ctx)).toMatchObject({
      resolvedModel: 'gpt-4.1', candidates: ['gpt-4.1'], aliasKeys: ['coding', 'missing'],
      fallback: { activated: false },
    });
    expect(ctx.log).toContain('[model-resolver] middle-power fallback: "missing" → "gpt-5.4"');
    expect(ctx.log).toContain(
      '[model-resolver] ignoring 1 synthesized fallback candidate(s) in favour of 1 genuine match(es)',
    );
  });

  test('uses nested synthesis only when no genuine sibling matched', () => {
    expect(_resolveAliasPatterns(context({
      aliasDefinition: { patterns: ['missing'], fallback: true },
      aliases: { missing: ['copilot/unavailable'] },
    }))).toMatchObject({
      aliasKeys: ['coding', 'missing'], fallback: { activated: true },
    });
  });

  test('propagates a nested rejection instead of using a synthesized sibling', () => {
    const ctx = context({
      aliasDefinition: { patterns: ['missing', 'retired'], fallback: true },
      aliases: { missing: ['copilot/unavailable'], retired: ['copilot/gpt-5-codex'] },
    });
    expect(_resolveAliasPatterns(ctx)).toBeNull();
    expect(ctx.resolutionState.blocked).toBe(true);
  });

  test('passes recursive inputs through the injected resolver and preserves its harness rejection', () => {
    const rejection = { harness: 'unverified' };
    const resolver = jest.fn((...args) => {
      args[8].blocked = true;
      args[8].harnessRejection = rejection;
      return null;
    });
    const ctx = context({
      aliasDefinition: { patterns: ['nested'], fallback: true },
      resolveModel: resolver,
    });
    expect(_resolveAliasPatterns(ctx)).toBeNull();
    expect(resolver).toHaveBeenCalledWith(
      'nested', ctx.aliases, ctx.availableModels, ctx.currentProvider, ctx.newChain,
      ctx.fallbackConfig, ctx.modelPolicyConfig, false,
      { blocked: true, eligibilityRequest: ctx.resolutionState.eligibilityRequest, harnessRejection: rejection },
    );
    expect(resolver.mock.calls[0][8]).not.toBe(ctx.resolutionState);
    expect(ctx.resolutionState.harnessRejection).toBe(rejection);
  });

  test.each([false, true])('marks a family replacement automatic unless a genuine sibling authorizes it (%s)', genuine => {
    const result = _resolveAliasPatterns(context({
      aliasDefinition: {
        patterns: ['gpt-5.9', ...(genuine ? ['copilot/gpt-5.4'] : [])], fallback: true,
      },
    }));
    expect(result.resolvedModel).toBe('gpt-5.4');
    expect(result.automaticReplacement).toBe(genuine ? undefined : true);
  });

  test.each([
    [['coding'], true],
    [['outer', 'coding'], false],
  ])('only synthesizes cross-provider misses at the top level (%j)', (newChain, expected) => {
    const result = _resolveAliasPatterns(context({
      newChain, aliasDefinition: { patterns: ['openai/unavailable'], fallback: true },
    }));
    expect(Boolean(result?.fallback.activated)).toBe(expected);
  });

  test('applies parameters and alias keys to a no-match synthesized result', () => {
    const ctx = context({
      requestedModel: 'coding?effort=high',
      aliasDefinition: { patterns: ['copilot/unavailable'], fallback: true },
      availableModels: { copilot: ['gpt-5.4'] },
    });
    expect(_resolveAliasPatterns(ctx)).toMatchObject({
      resolvedModel: 'gpt-5.4?effort=high', aliasKeys: ['coding'],
      log: ctx.log, fallback: { activated: true },
    });
  });

  test.each([
    { aliasDefinition: { patterns: ['copilot/unavailable'], fallback: false } },
    { aliasDefinition: { patterns: ['copilot/unavailable'], fallback: true }, fallbackConfig: { enabled: false } },
    { aliasDefinition: { patterns: ['copilot/unavailable'], fallback: true }, fallbackConfig: { enabled: true, strategy: 'unknown' } },
    { aliasDefinition: { patterns: ['copilot/unavailable'], fallback: true }, modelPolicyConfig: {} },
    { aliasDefinition: { patterns: ['coding'], fallback: true } },
    { availableModels: { copilot: null } },
    { availableModels: {} },
  ])('returns null rather than synthesizing for %j', overrides => {
    expect(_resolveAliasPatterns(context(overrides))).toBeNull();
  });
});
