/**
 * Tests for model-resolver.js
 *
 * Tests for the pure version utilities (globMatch, extractVersionNumbers,
 * compareByVersion) live in model-utils.test.js.
 */

const {
  parseModelAliases,
  selectMiddlePowerFallback,
  filterResolvableAliases,
  resolveModel,
} = require('./model-resolver');
const { rewriteModelInBody } = require('./model-body-rewriter');

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

// ── resolveModel ───────────────────────────────────────────────────────────

describe('resolveModel', () => {
  const availableModels = {
    copilot: ['claude-sonnet-4.5', 'claude-sonnet-4.6', 'gpt-4o', 'o1'],
    anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'],
    openai: ['gpt-4o', 'gpt-4-turbo'],
  };

  const aliases = {
    sonnet: ['copilot/*sonnet*', 'anthropic/*sonnet*'],
    'gpt-5-codex': ['copilot/gpt-5*-codex', 'openai/gpt-5*-codex'],
    '': ['sonnet', 'gpt-5-codex'],
  };

  it('should resolve a simple alias to copilot models', () => {
    const result = resolveModel('sonnet', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    // Should pick the highest version sonnet model
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('should resolve a simple alias to anthropic models', () => {
    const result = resolveModel('sonnet', aliases, availableModels, 'anthropic');
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-3-5-sonnet-20241022');
  });

  it('should resolve the default alias (empty string key)', () => {
    const result = resolveModel('', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    // "" → sonnet → copilot/*sonnet* → claude-sonnet-4.6
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('should activate middle-power fallback when no alias matches and model is unavailable', () => {
    const result = resolveModel('unknown-model', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    expect(result.fallback.activated).toBe(true);
    expect(result.fallback.reason).toBe('no_alias_match_and_not_in_available_models');
  });

  it('should return a direct match when model is already in available list', () => {
    const result = resolveModel('gpt-4o', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('gpt-4o');
  });

  it('should be case-insensitive for alias lookup', () => {
    const result = resolveModel('SONNET', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('should resolve gpt-5 minor-version aliases via gpt-5 family fallback', () => {
    const result = resolveModel(
      'gpt-5.4',
      { 'gpt-5': ['copilot/gpt-5*'] },
      { copilot: ['gpt-5.3', 'gpt-5.4'] },
      'copilot'
    );
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('gpt-5.4');
  });

  it('should fall back to highest available gpt-5 model when requested gpt-5 minor is unavailable', () => {
    const result = resolveModel(
      'gpt-5.5',
      aliases,
      { copilot: ['gpt-5.2', 'gpt-5.4', 'gpt-4.1'] },
      'copilot'
    );
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('gpt-5.4');
    expect(result.log.some(l => l.includes('falling back to "gpt-5.4"'))).toBe(true);
  });

  it('should fall back when provider patterns do not match current provider', () => {
    // "gpt-5-codex" only has copilot/... and openai/... patterns
    // When resolving for anthropic, alias expansion has no candidates.
    const result = resolveModel('gpt-5-codex', aliases, availableModels, 'anthropic');
    expect(result).not.toBeNull();
    expect(result.fallback.activated).toBe(true);
  });

  it('should include a resolution log', () => {
    const result = resolveModel('sonnet', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    expect(Array.isArray(result.log)).toBe(true);
    expect(result.log.length).toBeGreaterThan(0);
    // Log should mention the alias and the resolved model
    expect(result.log.some(l => l.includes('sonnet'))).toBe(true);
  });

  it('should detect loops and return null', () => {
    const loopAliases = {
      a: ['b'],
      b: ['a'],
    };
    const result = resolveModel('a', loopAliases, availableModels, 'copilot');
    expect(result).toBeNull();
  });

  it('should detect self-referential loops', () => {
    const selfLoop = { self: ['self'] };
    const result = resolveModel('self', selfLoop, availableModels, 'copilot');
    expect(result).toBeNull();
  });

  it('should handle empty available models gracefully', () => {
    const result = resolveModel('sonnet', aliases, {}, 'copilot');
    expect(result).toBeNull();
  });

  it('should handle null available models for a provider', () => {
    const modelsWithNull = { copilot: null };
    const result = resolveModel('sonnet', aliases, modelsWithNull, 'copilot');
    expect(result).toBeNull();
  });

  it('should pick highest version when multiple models match', () => {
    const result = resolveModel('sonnet', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6'); // 4.6 > 4.5
  });

  it('should resolve recursive aliases across multiple levels', () => {
    // "" → ["sonnet"] → ["copilot/*sonnet*"] → matches copilot models
    const result = resolveModel('', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('should skip middle-power fallback when globally disabled', () => {
    const result = resolveModel(
      'unknown-model',
      aliases,
      availableModels,
      'copilot',
      [],
      { enabled: false, strategy: 'middle_power' }
    );
    expect(result).toBeNull();
  });

  it('should skip middle-power fallback for aliases with fallback=false', () => {
    const result = resolveModel(
      'sonnet',
      { sonnet: { patterns: ['openai/*sonnet*'], fallback: false } },
      availableModels,
      'copilot'
    );
    expect(result).toBeNull();
  });
});

describe('selectMiddlePowerFallback', () => {
  it('sorts Anthropic tiers as opus > sonnet > haiku and picks median', () => {
    const result = selectMiddlePowerFallback(
      'unknown',
      { anthropic: ['claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4-5'] },
      'anthropic',
      'no_alias_match_and_not_in_available_models',
      { enabled: true, strategy: 'middle_power' }
    );
    expect(result.fallback.candidates.map(c => c.model)).toEqual([
      'claude-opus-4-1',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
    ]);
    expect(result.resolvedModel).toBe('claude-sonnet-4-5');
  });

  it('sorts OpenAI/Copilot tiers as gpt-5 > gpt-4 > gpt-3.5 and picks median', () => {
    const result = selectMiddlePowerFallback(
      'unknown',
      { openai: ['gpt-3.5-turbo', 'gpt-5.2', 'gpt-4.1'] },
      'openai',
      'no_alias_match_and_not_in_available_models',
      { enabled: true, strategy: 'middle_power' }
    );
    expect(result.fallback.candidates.map(c => c.model)).toEqual([
      'gpt-5.2',
      'gpt-4.1',
      'gpt-3.5-turbo',
    ]);
    expect(result.resolvedModel).toBe('gpt-4.1');
  });

  it('uses lexicographic sorting for unknown providers and picks median', () => {
    const result = selectMiddlePowerFallback(
      'unknown',
      { gemini: ['z-model', 'a-model', 'm-model'] },
      'gemini',
      'no_alias_match_and_not_in_available_models',
      { enabled: true, strategy: 'middle_power' }
    );
    expect(result.fallback.candidates.map(c => c.model)).toEqual(['a-model', 'm-model', 'z-model']);
    expect(result.resolvedModel).toBe('m-model');
  });

  it('returns null when no models are available for provider', () => {
    const result = selectMiddlePowerFallback(
      'unknown',
      { copilot: [] },
      'copilot',
      'no_alias_match_and_not_in_available_models',
      { enabled: true, strategy: 'middle_power' }
    );
    expect(result).toBeNull();
  });
});

// ── rewriteModelInBody ─────────────────────────────────────────────────────

describe('rewriteModelInBody', () => {
  const availableModels = {
    copilot: ['claude-sonnet-4.5', 'claude-sonnet-4.6', 'gpt-4o'],
  };

  const aliases = {
    sonnet: ['copilot/*sonnet*'],
  };

  it('should rewrite an aliased model in the request body', () => {
    const body = Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
    expect(result.originalModel).toBe('sonnet');
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.model).toBe('claude-sonnet-4.6');
  });

  it('should return null for a model with no alias', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-4o', messages: [] }));
    // gpt-4o is a direct match, but the resolved model equals the original so we return null
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).toBeNull(); // No rewrite needed
  });

  it('should return null for non-JSON body', () => {
    const body = Buffer.from('not json');
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).toBeNull();
  });

  it('should return null for an empty body', () => {
    const result = rewriteModelInBody(Buffer.alloc(0), 'copilot', aliases, availableModels);
    expect(result).toBeNull();
  });

  it('should rewrite to middle-power fallback when alias cannot be resolved', () => {
    const body = Buffer.from(JSON.stringify({ model: 'unknown-alias', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).not.toBeNull();
    expect(result.fallback.activated).toBe(true);
  });

  it('should rewrite to highest available gpt-5 model when requested minor is unavailable', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-5.5', messages: [] }));
    const result = rewriteModelInBody(
      body,
      'copilot',
      aliases,
      { copilot: ['gpt-5.2', 'gpt-5.4', 'gpt-4.1'] }
    );
    expect(result).not.toBeNull();
    expect(result.originalModel).toBe('gpt-5.5');
    expect(result.resolvedModel).toBe('gpt-5.4');
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.model).toBe('gpt-5.4');
  });

  it('should try the default alias when model field is absent', () => {
    const defaultAliases = {
      '': ['copilot/*sonnet*'],
    };
    const body = Buffer.from(JSON.stringify({ messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', defaultAliases, availableModels);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
    expect(result.originalModel).toBe('');
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.model).toBe('claude-sonnet-4.6');
  });

  it('should include a resolution log', () => {
    const body = Buffer.from(JSON.stringify({ model: 'sonnet', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).not.toBeNull();
    expect(Array.isArray(result.log)).toBe(true);
    expect(result.log.length).toBeGreaterThan(0);
  });

  it('should preserve other fields in the request body', () => {
    const original = { model: 'sonnet', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 };
    const body = Buffer.from(JSON.stringify(original));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result.body.toString('utf8'));
    expect(parsed.messages).toEqual(original.messages);
    expect(parsed.temperature).toBe(0.7);
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
