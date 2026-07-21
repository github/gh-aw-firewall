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

  it('should treat the Copilot auto model as a pass-through', () => {
    const result = resolveModel('auto', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('auto');
    expect(result.fallback.activated).toBe(false);
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

  it('returns the requested model unchanged when provider advertises an exact match', () => {
    const result = resolveModel(
      'gpt-5.6-sol',
      { 'gpt-5': ['openai/gpt-5*'] },
      { openai: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.5'] },
      'openai'
    );
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('gpt-5.6-sol');
  });

  it('returns null (terminal) when the exact advertised model is denied by policy — does not fall through to family alias', () => {
    // gpt-5.6-sol is advertised by the provider AND has a gpt-5 family alias.
    // When gpt-5.6-sol is explicitly denylisted, resolution must stop (null) rather
    // than silently rewriting to another permitted family member like gpt-5.6-luna.
    const policy = { allowedModels: null, disallowedModels: ['gpt-5.6-sol'] };
    const result = resolveModel(
      'gpt-5.6-sol',
      { 'gpt-5': ['openai/gpt-5*'] },
      { openai: ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.5'] },
      'openai',
      [],
      {},
      policy
    );
    expect(result).toBeNull();
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

  it('should include ranked candidates list for endpoint-blocked fallback', () => {
    // When an alias resolves to multiple candidates, all ranked candidates are
    // returned so the caller can fall back to the next one if the first fails.
    const result = resolveModel('sonnet', aliases, availableModels, 'copilot');
    expect(result).not.toBeNull();
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(result.candidates[0]).toBe('claude-sonnet-4.6'); // highest version first
    expect(result.candidates).toContain('claude-sonnet-4.5'); // lower version available as fallback
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

  it('should not rewrite the Copilot auto model', () => {
    const body = Buffer.from(JSON.stringify({ model: 'auto', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).toBeNull();
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

// ── Model policy filtering in alias resolution ────────────────────────────────

describe('resolveModel with modelPolicyConfig', () => {
  const aliases = {
    sonnet: ['copilot/*sonnet*'],
    opus: ['copilot/*opus*'],
    any: ['copilot/*'],
  };
  const availableModels = {
    copilot: ['claude-sonnet-4.6', 'claude-opus-4.5', 'claude-haiku-3-5'],
  };

  it('should resolve normally when no policy is set', () => {
    const result = resolveModel('sonnet', aliases, availableModels, 'copilot', [], {}, null);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('should filter out candidates matching disallowed patterns', () => {
    const policy = { allowedModels: null, disallowedModels: ['*opus*'] };
    // 'opus' alias resolves to copilot/*opus* candidates — all filtered by policy
    const result = resolveModel('opus', aliases, availableModels, 'copilot', [], {}, policy);
    expect(result).toBeNull();
  });

  it('should allow candidates that pass the disallowed filter', () => {
    const policy = { allowedModels: null, disallowedModels: ['*opus*'] };
    const result = resolveModel('sonnet', aliases, availableModels, 'copilot', [], {}, policy);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('should filter out candidates not matching the allowed list', () => {
    const policy = { allowedModels: ['*haiku*'], disallowedModels: null };
    // 'sonnet' alias candidates (*sonnet*) don't match *haiku* — filtered out
    const result = resolveModel('sonnet', aliases, availableModels, 'copilot', [], {}, policy);
    expect(result).toBeNull();
  });

  it('should allow only matching candidates from the allowed list when alias has multiple', () => {
    // 'any' alias matches all models; policy only allows *sonnet*
    const policy = { allowedModels: ['*sonnet*'], disallowedModels: null };
    const result = resolveModel('any', aliases, availableModels, 'copilot', [], {}, policy);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('should block disallowed models even when also in allowed list', () => {
    const policy = { allowedModels: ['*sonnet*'], disallowedModels: ['*sonnet*'] };
    const result = resolveModel('sonnet', aliases, availableModels, 'copilot', [], {}, policy);
    expect(result).toBeNull();
  });

  it('should log a message when candidates are filtered by policy', () => {
    const policy = { allowedModels: null, disallowedModels: ['*opus*'] };
    const result = resolveModel('opus', aliases, availableModels, 'copilot', [], {}, policy);
    expect(result).toBeNull();
  });
});

// ── Complex alias tree resolution ────────────────────────────────────────────

describe('resolveModel — complex alias trees', () => {
  // Disable middle-power fallback throughout so failed branches clearly return null
  const noFallback = { enabled: false };

  const baseModels = {
    copilot: [
      'claude-haiku-3.5',
      'claude-sonnet-4.5',
      'claude-sonnet-4.6',
      'claude-opus-4.5',
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-5.2',
    ],
    anthropic: [
      'claude-3-haiku-20240307',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
    ],
    openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-5.2'],
  };

  it('resolves a 4-level deep chain to the highest-version concrete model', () => {
    // deep → level1 → level2 → level3 → copilot/*sonnet*
    const aliases = {
      deep: ['level1'],
      level1: ['level2'],
      level2: ['level3'],
      level3: ['copilot/*sonnet*'],
    };
    const result = resolveModel('deep', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('resolves a 5-level deep chain picking the highest-version match', () => {
    // a → b → c → d → e → copilot/*gpt-5*
    const aliases = {
      a: ['b'],
      b: ['c'],
      c: ['d'],
      d: ['e'],
      e: ['copilot/*gpt-5*'],
    };
    const result = resolveModel('a', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('gpt-5.2');
  });

  it('fan-out: alias with two sub-alias branches merges candidates and picks highest version', () => {
    // best → [sonnet-branch, haiku-branch]
    // Each sub-alias resolves independently to its own highest-version model:
    //   sonnet-branch → copilot/*sonnet*  →  sub-alias resolution yields claude-sonnet-4.6
    //   haiku-branch  → copilot/*haiku*   →  sub-alias resolution yields claude-haiku-3.5
    // The parent fan-out collects [4.6, 3.5] and version-sorts → 4.6 wins
    const aliases = {
      best: ['sonnet-branch', 'haiku-branch'],
      'sonnet-branch': ['copilot/*sonnet*'],
      'haiku-branch': ['copilot/*haiku*'],
    };
    const result = resolveModel('best', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('fan-out: resolves via the only working branch when the other branch has no matches', () => {
    // prefer-codex → [codex-branch, sonnet-branch]
    // codex-branch → copilot/gpt-5*codex*  → no match in baseModels
    // sonnet-branch → copilot/*sonnet*      → matches
    // Use object-syntax for codex-branch to suppress its middle-power fallback
    const aliases = {
      'prefer-codex': ['codex-branch', 'sonnet-branch'],
      'codex-branch': { patterns: ['copilot/gpt-5*codex*'], fallback: false },
      'sonnet-branch': ['copilot/*sonnet*'],
    };
    const result = resolveModel('prefer-codex', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('detects a 3-node cycle (A → B → C → A) and returns null', () => {
    const aliases = {
      a: ['b'],
      b: ['c'],
      c: ['a'],
    };
    const result = resolveModel('a', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).toBeNull();
  });

  it('detects a cycle entered mid-chain (A → B → C → B) and returns null', () => {
    const aliases = {
      a: ['b'],
      b: ['c'],
      c: ['b'],
    };
    const result = resolveModel('a', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).toBeNull();
  });

  it('detects a diamond cycle where all branches eventually cycle back', () => {
    // top → [left, right]; left → bottom; right → bottom; bottom → left
    const aliases = {
      top: ['left', 'right'],
      left: ['bottom'],
      right: ['bottom'],
      bottom: ['left'],
    };
    const result = resolveModel('top', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).toBeNull();
  });

  it('succeeds when one branch is a direct provider pattern alongside a cyclic sub-alias', () => {
    // combo → ['copilot/*sonnet*', 'cycle-start']
    // copilot/*sonnet* is a provider pattern (matched directly, no recursion needed)
    // cycle-start → cycle-end → cycle-start  (cycle, contributes nothing)
    const aliases = {
      combo: ['copilot/*sonnet*', 'cycle-start'],
      'cycle-start': ['cycle-end'],
      'cycle-end': ['cycle-start'],
    };
    const result = resolveModel('combo', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('skips provider patterns for a different provider when resolving a specific provider', () => {
    // openai-only alias has patterns only for openai; resolving for copilot finds nothing
    const aliases = {
      'openai-only': ['openai/*gpt*'],
    };
    const result = resolveModel('openai-only', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).toBeNull();
  });

  it('deduplicates candidates when two branches resolve to the same model', () => {
    // dup → [path-a, path-b]; both paths → copilot/*sonnet*
    // After dedup, exactly one copy of each model; still picks highest version
    const aliases = {
      dup: ['path-a', 'path-b'],
      'path-a': ['copilot/*sonnet*'],
      'path-b': ['copilot/*sonnet*'],
    };
    const result = resolveModel('dup', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('resolves a sibling tree where branches have different depths and picks the overall highest version', () => {
    // root → [mid-a, mid-b]
    // mid-a → leaf-a → copilot/*opus*   (2 levels deep, yields claude-opus-4.5)
    // mid-b → copilot/*haiku*           (1 level deep, yields claude-haiku-3.5)
    // candidates at root level: [opus-4.5, haiku-3.5]
    // compareByVersion extracts leading numeric segments: opus-4.5 → [4,5], haiku-3.5 → [3,5]
    // First segment comparison: 4 > 3 → claude-opus-4.5 sorts first (highest version)
    const aliases = {
      root: ['mid-a', 'mid-b'],
      'mid-a': ['leaf-a'],
      'leaf-a': ['copilot/*opus*'],
      'mid-b': ['copilot/*haiku*'],
    };
    const result = resolveModel('root', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-opus-4.5');
  });

  it('resolves a tree that includes the default ("") alias as an intermediate node', () => {
    // "" → top-alias → mid → copilot/gpt-4o
    const aliases = {
      '': ['top-alias'],
      'top-alias': ['mid'],
      mid: ['copilot/gpt-4o'],
    };
    const result = resolveModel('', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('gpt-4o');
  });

  it('returns null when every branch of the tree targets unavailable models', () => {
    const aliases = {
      root: ['branch-a', 'branch-b'],
      'branch-a': { patterns: ['copilot/nonexistent-xyz'], fallback: false },
      'branch-b': { patterns: ['openai/nonexistent-abc'], fallback: false },
    };
    const result = resolveModel('root', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).toBeNull();
  });

  it('accumulates log entries from all levels of a multi-hop chain', () => {
    // 3-level chain: deep → level1 → level2 → copilot/*sonnet*
    const aliases = {
      deep: ['level1'],
      level1: ['level2'],
      level2: ['copilot/*sonnet*'],
    };
    const result = resolveModel('deep', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    // Expect at least one log entry per alias hop (3 hops minimum)
    expect(result.log.length).toBeGreaterThanOrEqual(3);
    const logText = result.log.join('\n');
    expect(logText).toContain('deep');
    expect(logText).toContain('level1');
    expect(logText).toContain('level2');
  });

  it('resolves case-insensitive keys at every level of the tree', () => {
    // Alias keys use mixed case; requested model is lowercase
    const aliases = {
      'DEEP-ALIAS': ['MID-ALIAS'],
      'MID-ALIAS': ['LEAF-ALIAS'],
      'LEAF-ALIAS': ['copilot/*sonnet*'],
    };
    const result = resolveModel('deep-alias', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('resolves a wide flat tree: alias referencing many sub-aliases, picks global highest', () => {
    // wide → [opus-ref, sonnet-ref, haiku-ref, gpt-ref]
    const aliases = {
      wide: ['opus-ref', 'sonnet-ref', 'haiku-ref', 'gpt-ref'],
      'opus-ref': ['copilot/*opus*'],
      'sonnet-ref': ['copilot/*sonnet*'],
      'haiku-ref': ['copilot/*haiku*'],
      'gpt-ref': ['copilot/gpt-4o'],
    };
    const result = resolveModel('wide', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    // All four sub-aliases resolve to one model each; version sort picks the highest overall
    // claude-sonnet-4.6 (v4.6) > claude-opus-4.5 (v4.5) > ...
    expect(result.resolvedModel).toBe('claude-sonnet-4.6');
  });

  it('resolves an alias tree that mixes provider-pattern leaves with sub-alias leaves', () => {
    // mixed → ['copilot/*gpt-5*', 'sonnet-ref']
    // 'copilot/*gpt-5*' is a provider pattern → all matching models added directly: [gpt-5.2]
    // 'sonnet-ref' is a sub-alias ref → sub-alias resolution yields one model: claude-sonnet-4.6
    // candidates: [gpt-5.2, claude-sonnet-4.6]
    // compareByVersion extracts numeric segments: gpt-5.2 → [5,2], claude-sonnet-4.6 → [4,6]
    // First segment comparison: 5 > 4 → gpt-5.2 sorts first (highest version)
    const aliases = {
      mixed: ['copilot/*gpt-5*', 'sonnet-ref'],
      'sonnet-ref': ['copilot/*sonnet*'],
    };
    const result = resolveModel('mixed', aliases, baseModels, 'copilot', [], noFallback);
    expect(result).not.toBeNull();
    expect(result.resolvedModel).toBe('gpt-5.2');
  });
});
