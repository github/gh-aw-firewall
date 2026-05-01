/**
 * Tests for model-resolver.js
 */

const {
  parseModelAliases,
  globMatch,
  extractVersionNumbers,
  compareByVersion,
  resolveModel,
  rewriteModelInBody,
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

// ── globMatch ──────────────────────────────────────────────────────────────

describe('globMatch', () => {
  it('should match exact strings', () => {
    expect(globMatch('gpt-4o', 'gpt-4o')).toBe(true);
  });

  it('should not match different strings', () => {
    expect(globMatch('gpt-4o', 'gpt-4')).toBe(false);
  });

  it('should match * wildcard at end', () => {
    expect(globMatch('gpt-4*', 'gpt-4o')).toBe(true);
    expect(globMatch('gpt-4*', 'gpt-4-turbo')).toBe(true);
  });

  it('should match * wildcard in middle', () => {
    expect(globMatch('claude-*-sonnet*', 'claude-3.5-sonnet-20241022')).toBe(true);
  });

  it('should match * wildcard at start', () => {
    expect(globMatch('*sonnet*', 'claude-3.5-sonnet-20241022')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(globMatch('CLAUDE-*', 'claude-3.5-sonnet')).toBe(true);
    expect(globMatch('*SONNET*', 'claude-3.5-sonnet')).toBe(true);
  });

  it('should not match * as a partial segment', () => {
    expect(globMatch('gpt-5-codex', 'gpt-5-codex-extra')).toBe(false);
  });

  it('should match model names with version numbers', () => {
    expect(globMatch('*sonnet*', 'claude-sonnet-4.6')).toBe(true);
    expect(globMatch('*sonnet*', 'claude-sonnet-4.5')).toBe(true);
  });

  it('should treat ? as a literal character, not a regex quantifier', () => {
    // Pattern with literal '?' should only match a string containing '?'
    expect(globMatch('model?version', 'model?version')).toBe(true);
    expect(globMatch('model?version', 'modelXversion')).toBe(false);
    expect(globMatch('model?version', 'modelversion')).toBe(false);
  });

  it('should treat other regex metacharacters as literals', () => {
    expect(globMatch('model.v1', 'modelXv1')).toBe(false);  // '.' is literal, not wildcard
    expect(globMatch('model.v1', 'model.v1')).toBe(true);
    expect(globMatch('(test)', '(test)')).toBe(true);
    expect(globMatch('(test)', 'xtest)')).toBe(false);
  });
});

// ── extractVersionNumbers ──────────────────────────────────────────────────

describe('extractVersionNumbers', () => {
  it('should extract version from claude-sonnet-4.6', () => {
    expect(extractVersionNumbers('claude-sonnet-4.6')).toEqual([4, 6]);
  });

  it('should extract version from gpt-4o', () => {
    expect(extractVersionNumbers('gpt-4o')).toEqual([4]);
  });

  it('should extract version from gemini-1.5-pro', () => {
    expect(extractVersionNumbers('gemini-1.5-pro')).toEqual([1, 5]);
  });

  it('should return empty array for model with no numbers', () => {
    expect(extractVersionNumbers('my-model')).toEqual([]);
  });

  it('should handle multi-digit version numbers', () => {
    expect(extractVersionNumbers('model-20241022')).toEqual([20241022]);
  });
});

// ── compareByVersion ───────────────────────────────────────────────────────

describe('compareByVersion', () => {
  it('should sort higher version first', () => {
    const models = ['claude-sonnet-4.5', 'claude-sonnet-4.6', 'claude-sonnet-4.7'];
    models.sort(compareByVersion);
    expect(models[0]).toBe('claude-sonnet-4.7');
  });

  it('should sort claude-sonnet-4.6 before claude-sonnet-4.5', () => {
    expect(compareByVersion('claude-sonnet-4.5', 'claude-sonnet-4.6')).toBeGreaterThan(0);
    expect(compareByVersion('claude-sonnet-4.6', 'claude-sonnet-4.5')).toBeLessThan(0);
  });

  it('should use lexicographic fallback for same version', () => {
    // Both have no version numbers — falls back to localeCompare
    const result = compareByVersion('alpha-model', 'beta-model');
    expect(result).toBeLessThan(0); // 'alpha' < 'beta' lexicographically
  });

  it('should handle models without version numbers gracefully', () => {
    const models = ['gpt-4o', 'o1'];
    expect(() => models.sort(compareByVersion)).not.toThrow();
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

  it('should return null when no alias matches and model is not available', () => {
    const result = resolveModel('unknown-model', aliases, availableModels, 'copilot');
    expect(result).toBeNull();
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

  it('should not match provider patterns for a different provider', () => {
    // "gpt-5-codex" only has copilot/... and openai/... patterns
    // When resolving for anthropic, there's nothing to match
    const result = resolveModel('gpt-5-codex', aliases, availableModels, 'anthropic');
    expect(result).toBeNull();
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

  it('should return null when alias cannot be resolved', () => {
    const body = Buffer.from(JSON.stringify({ model: 'unknown-alias', messages: [] }));
    const result = rewriteModelInBody(body, 'copilot', aliases, availableModels);
    expect(result).toBeNull();
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
