/**
 * Tests for model-resolver.js
 *
 * Tests for the pure version utilities (globMatch, extractVersionNumbers,
 * compareByVersion) live in model-utils.test.js.
 *
 * This file covers alias parsing and filtering:
 *   - parseModelAliases
 *   - filterResolvableAliases
 *   - filterAvailableModelsToConfiguredProviders
 *   - cross-provider alias fan-out
 *
 * resolveModel coverage lives in model-resolver-resolution.test.js.
 * selectMiddlePowerFallback / rewriteModelInBody coverage lives in
 * model-resolver-fallback.test.js.
 */

const {
  parseModelAliases,
  filterResolvableAliases,
  filterAvailableModelsToConfiguredProviders,
  resolveModel,
} = require('./model-resolver');

// ── parseModelAliases ──────────────────────────────────────────────────────

describe('parseModelAliases', () => {
  it('should return null for null input', () => {
    expect(parseModelAliases(null)).toBeNull();
  });

  it('should return null for undefined input', () => {
    expect(parseModelAliases(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseModelAliases('')).toBeNull();
  });

  it('should return null for invalid JSON', () => {
    expect(parseModelAliases('not-json')).toBeNull();
  });

  it('should return null when models key is missing', () => {
    expect(parseModelAliases(JSON.stringify({ other: {} }))).toBeNull();
  });

  it('should return null when models is not an object', () => {
    expect(parseModelAliases(JSON.stringify({ models: [] }))).toBeNull();
    expect(parseModelAliases(JSON.stringify({ models: 'string' }))).toBeNull();
  });

  it('should return null when a value is not an array', () => {
    expect(parseModelAliases(JSON.stringify({ models: { sonnet: 'not-array' } }))).toBeNull();
  });

  it('should return null when an array entry is not a string', () => {
    expect(parseModelAliases(JSON.stringify({ models: { sonnet: [123] } }))).toBeNull();
  });

  it('should parse extended alias entries with patterns and fallback flag', () => {
    const raw = JSON.stringify({
      models: {
        sonnet: { patterns: ['copilot/*sonnet*'], fallback: false },
      },
    });
    const result = parseModelAliases(raw);
    expect(result).not.toBeNull();
    expect(result.models.sonnet).toEqual({ patterns: ['copilot/*sonnet*'], fallback: false });
  });

  it('should parse a valid config', () => {
    const raw = JSON.stringify({
      models: {
        sonnet: ['copilot/*sonnet*', 'anthropic/*sonnet*'],
        '': ['sonnet'],
      },
    });
    const result = parseModelAliases(raw);
    expect(result).not.toBeNull();
    expect(result.models.sonnet).toEqual(['copilot/*sonnet*', 'anthropic/*sonnet*']);
    expect(result.models['']).toEqual(['sonnet']);
  });

  it('should accept an empty models object', () => {
    const result = parseModelAliases(JSON.stringify({ models: {} }));
    expect(result).toEqual({ models: {} });
  });
});

// ── filterResolvableAliases ───────────────────────────────────────────────────

describe('filterResolvableAliases', () => {
  const aliases = {
    sonnet: ['copilot/*sonnet*', 'anthropic/*sonnet*'],
    'gpt-5-codex': ['copilot/gpt-5*-codex', 'openai/gpt-5*-codex'],
    '': ['sonnet'],
  };

  it('should keep aliases that resolve for at least one provider with model data', () => {
    const availableModels = {
      copilot: ['claude-sonnet-4.6', 'gpt-4o'],
    };
    const result = filterResolvableAliases(aliases, availableModels);
    // 'sonnet' resolves via copilot/*sonnet* → claude-sonnet-4.6
    expect(result).toHaveProperty('sonnet');
    // '' → 'sonnet' which resolves, so '' is kept too
    expect(result).toHaveProperty('');
    // 'gpt-5-codex' has no matching models
    expect(result).not.toHaveProperty('gpt-5-codex');
  });

  it('should return all aliases when no provider has model data', () => {
    const result = filterResolvableAliases(aliases, {});
    expect(Object.keys(result)).toEqual(Object.keys(aliases));
  });

  it('should return all aliases when all provider caches are null', () => {
    const result = filterResolvableAliases(aliases, { copilot: null, openai: null });
    expect(Object.keys(result)).toEqual(Object.keys(aliases));
  });

  it('should filter out aliases whose patterns match no available model', () => {
    const availableModels = {
      copilot: ['gpt-4o', 'gpt-5.2'],
    };
    const result = filterResolvableAliases(aliases, availableModels);
    // 'sonnet' has no match in copilot (no sonnet models)
    expect(result).not.toHaveProperty('sonnet');
    // 'gpt-5-codex' has no match
    expect(result).not.toHaveProperty('gpt-5-codex');
  });

  it('should not keep an alias solely because its key is an available model', () => {
    const collidingAliases = {
      'claude-sonnet-5': ['anthropic/claude-sonnet-6*'],
    };
    const availableModels = { anthropic: ['claude-sonnet-5'] };
    const result = filterResolvableAliases(collidingAliases, availableModels);
    expect(result).not.toHaveProperty('claude-sonnet-5');
    // '' → 'sonnet' → no match → filtered out too
    expect(result).not.toHaveProperty('');
  });

  it('should keep an alias if it resolves for any one of multiple providers', () => {
    const availableModels = {
      copilot: ['gpt-4o'],              // no sonnet models
      anthropic: ['claude-3-5-sonnet-20241022'],  // has sonnet
    };
    const result = filterResolvableAliases(aliases, availableModels);
    // 'sonnet' has anthropic/*sonnet* which matches
    expect(result).toHaveProperty('sonnet');
  });

  it('should keep recursive aliases that ultimately resolve', () => {
    const availableModels = { copilot: ['claude-sonnet-4.6'] };
    const result = filterResolvableAliases(aliases, availableModels);
    // '' → 'sonnet' → copilot/*sonnet* → resolves
    expect(result).toHaveProperty('');
  });

  it('should return aliases unchanged when aliases is empty', () => {
    const result = filterResolvableAliases({}, { copilot: ['gpt-4o'] });
    expect(result).toEqual({});
  });

  it('should preserve the original alias values (not mutate)', () => {
    const availableModels = { copilot: ['claude-sonnet-4.6'] };
    const result = filterResolvableAliases(aliases, availableModels);
    expect(result.sonnet).toBe(aliases.sonnet);
  });

  it('should return the input unchanged when aliases is not an object', () => {
    expect(filterResolvableAliases(null, { copilot: ['gpt-4o'] })).toBeNull();
    expect(filterResolvableAliases(undefined, { copilot: ['gpt-4o'] })).toBeUndefined();
  });

  it('should handle extended alias syntax (object with patterns)', () => {
    const extendedAliases = {
      sonnet: { patterns: ['copilot/*sonnet*'], fallback: false },
      legacy: { patterns: ['copilot/gpt-3*'], fallback: true },
    };
    const availableModels = { copilot: ['claude-sonnet-4.6'] };
    const result = filterResolvableAliases(extendedAliases, availableModels);
    expect(result).toHaveProperty('sonnet');
    expect(result).not.toHaveProperty('legacy');
  });
});

// ── filterAvailableModelsToConfiguredProviders ────────────────────────────────

describe('filterAvailableModelsToConfiguredProviders', () => {
  const availableModels = {
    copilot: ['claude-sonnet-4.5', 'gpt-5.4'],
    anthropic: ['claude-sonnet-5'],
  };

  it('blanks the model list of providers that are not configured', () => {
    const result = filterAvailableModelsToConfiguredProviders(
      availableModels,
      new Set(['anthropic']),
    );
    expect(result.copilot).toBeNull();
    expect(result.anthropic).toEqual(['claude-sonnet-5']);
  });

  it('accepts an array of configured provider keys', () => {
    const result = filterAvailableModelsToConfiguredProviders(availableModels, ['copilot']);
    expect(result.copilot).toEqual(['claude-sonnet-4.5', 'gpt-5.4']);
    expect(result.anthropic).toBeNull();
  });

  it('returns the map unchanged when the configured set is unknown', () => {
    expect(filterAvailableModelsToConfiguredProviders(availableModels, null)).toBe(availableModels);
    expect(filterAvailableModelsToConfiguredProviders(availableModels, undefined)).toBe(availableModels);
  });

  it('blanks every model list when no provider is configured', () => {
    expect(filterAvailableModelsToConfiguredProviders(availableModels, new Set())).toEqual({
      copilot: null,
      anthropic: null,
    });
  });

  it('prevents alias resolution from steering to an unconfigured provider', () => {
    // Copilot-first alias group, but only Anthropic has credentials this run.
    const aliases = { 'sonnet-6x': ['copilot/*sonnet*', 'anthropic/*sonnet*'] };
    const configuredOnly = filterAvailableModelsToConfiguredProviders(
      availableModels,
      new Set(['anthropic']),
    );

    // Copilot is unreachable: its own port must not resolve any candidate.
    expect(resolveModel('sonnet-6x', aliases, configuredOnly, 'copilot', [], { enabled: false })).toBeNull();
    // Anthropic still resolves normally.
    const anthropicResolution = resolveModel(
      'sonnet-6x', aliases, configuredOnly, 'anthropic', [], { enabled: false },
    );
    expect(anthropicResolution.resolvedModel).toBe('claude-sonnet-5');
  });

  it('drops aliases that only resolve on unconfigured providers', () => {
    const aliases = { 'copilot-only': ['copilot/gpt-5*'] };
    const configuredOnly = filterAvailableModelsToConfiguredProviders(
      availableModels,
      new Set(['anthropic']),
    );
    expect(filterResolvableAliases(aliases, configuredOnly)).not.toHaveProperty('copilot-only');
  });

  it('drops disabled-provider aliases before configured provider models are fetched', () => {
    const aliases = {
      'copilot-only': ['copilot/gpt-5*'],
      'anthropic-only': ['anthropic/*sonnet*'],
      default: ['anthropic-only'],
    };
    const noModelData = filterAvailableModelsToConfiguredProviders(
      { copilot: ['stale-model'], anthropic: null },
      new Set(['anthropic']),
    );

    expect(filterResolvableAliases(aliases, noModelData, new Set(['anthropic']))).toEqual({
      'anthropic-only': aliases['anthropic-only'],
      default: aliases.default,
    });
  });

  it('keeps aliases for configured providers whose model catalogue is still pending', () => {
    const aliases = {
      'openai-model': ['openai/gpt-*'],
      'anthropic-model': ['anthropic/claude-*'],
      'copilot-model': ['copilot/gpt-*'],
    };
    const configured = new Set(['openai', 'anthropic']);
    const models = filterAvailableModelsToConfiguredProviders({
      openai: ['gpt-5.4'],
      anthropic: null,
      copilot: ['stale-model'],
    }, configured);

    expect(filterResolvableAliases(aliases, models, configured)).toEqual({
      'openai-model': aliases['openai-model'],
      'anthropic-model': aliases['anthropic-model'],
    });
  });

  it('drops all provider aliases when no provider is configured', () => {
    expect(filterResolvableAliases(
      { sonnet: ['copilot/*sonnet*'], default: ['sonnet'] },
      { copilot: null },
      new Set(),
    )).toEqual({});
  });
});

// ── Cross-provider fan-out regression ──────────────────────────────────────
//
// Regression coverage for alias fan-outs that resolve against a single-provider
// proxy. A nested alias scoped to *other* providers (e.g. "haiku" on an OpenAI
// proxy) previously triggered middle-power fallback, synthesizing an unrelated
// model from the full live catalog that then out-ranked its legitimate siblings.

describe('cross-provider alias fan-out', () => {
  // Mirrors gh-aw's built-in table (pkg/workflow/data/model_aliases.json).
  const ghAwAliases = {
    detection: ['small'],
    small: ['mini'],
    mini: ['haiku', 'gpt-5-mini', 'gpt-5-nano', 'gemini-flash-lite'],
    haiku: ['copilot/*haiku*', 'anthropic/*haiku*'],
    'gpt-5-mini': ['copilot/gpt-5*mini*', 'openai/gpt-5*mini*'],
    'gpt-5-nano': ['copilot/gpt-5*nano*', 'openai/gpt-5*nano*'],
    'gemini-flash-lite': ['copilot/gemini-*flash*lite*', 'gemini/gemini-*flash*lite*'],
  };

  // A live OpenAI catalog containing internal staging models alongside real ones.
  const openaiCatalog = [
    'crest-alpha-0416-block-a-cy4-after-40-calls',
    'crest-alpha-0418-block-cy4.5',
    'crest-alpha-0420-block-z-cy4.9',
    'gpt-5-mini-2025-08-07',
    'gpt-5-nano-2025-08-07',
    'gpt-4-turbo',
  ];

  it('resolves a nested fan-out to a legitimate sibling, not a synthesized model', () => {
    const result = resolveModel('detection', ghAwAliases, { openai: openaiCatalog }, 'openai');
    expect(result).not.toBeNull();
    expect(result.resolvedModel).not.toMatch(/^crest-alpha/);
    expect(['gpt-5-mini-2025-08-07', 'gpt-5-nano-2025-08-07']).toContain(result.resolvedModel);
  });

  it('does not let a provider-mismatched nested alias contribute a candidate', () => {
    const result = resolveModel('mini', ghAwAliases, { openai: openaiCatalog }, 'openai');
    expect(result).not.toBeNull();
    expect(result.candidates.every(c => !c.startsWith('crest-alpha'))).toBe(true);
  });

  it('still reports fallback as not activated when a genuine match wins', () => {
    const result = resolveModel('detection', ghAwAliases, { openai: openaiCatalog }, 'openai');
    expect(result.fallback.activated).toBe(false);
  });

  it('preserves top-level graceful degradation for a directly requested model', () => {
    // "haiku" requested directly on an OpenAI proxy still substitutes something
    // rather than failing outright — only nested references are skipped.
    const result = resolveModel('haiku', ghAwAliases, { openai: openaiCatalog }, 'openai');
    expect(result).not.toBeNull();
    expect(result.fallback.activated).toBe(true);
  });

  it('yields no candidate when every nested alias targets another provider', () => {
    const aliases = {
      onlyremote: ['haiku', 'gemini-flash-lite'],
      haiku: ['copilot/*haiku*', 'anthropic/*haiku*'],
      'gemini-flash-lite': ['gemini/gemini-*flash*lite*'],
    };
    const result = resolveModel('onlyremote', aliases, { openai: openaiCatalog }, 'openai');
    expect(result).toBeNull();
  });

  it('marks fallback activated when only synthesized candidates exist', () => {
    // The nested alias DOES name the current provider, so it is eligible for
    // middle-power fallback — its pattern simply matches nothing. The parent then
    // has no genuine candidate and must fall through to the synthesized one.
    const aliases = {
      parent: ['missing-on-openai'],
      'missing-on-openai': ['openai/no-such-model-*'],
    };
    const result = resolveModel('parent', aliases, { openai: openaiCatalog }, 'openai');
    expect(result).not.toBeNull();
    expect(result.fallback.activated).toBe(true);
    expect(result.fallback.reason).toBe('no_alias_match_and_not_in_available_models');
  });

  it('prefers a genuine match over a synthesized one from a sibling pattern', () => {
    // One child synthesizes (names openai, matches nothing); the other matches for real.
    const aliases = {
      parent: ['missing-on-openai', 'gpt-5-nano'],
      'missing-on-openai': ['openai/no-such-model-*'],
      'gpt-5-nano': ['openai/gpt-5*nano*'],
    };
    const result = resolveModel('parent', aliases, { openai: openaiCatalog }, 'openai');
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('gpt-5-nano-2025-08-07');
    expect(result.fallback.activated).toBe(false);
    expect(result.log.some(l => l.includes('ignoring 1 synthesized fallback candidate'))).toBe(true);
  });
});
