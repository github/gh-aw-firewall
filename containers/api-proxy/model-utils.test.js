/**
 * Tests for model-utils.js — pure version comparison and glob utilities.
 */

const { globMatch, extractVersionNumbers, compareByVersion, stripRedundantProviderPrefix } = require('./model-utils');

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

// ── stripRedundantProviderPrefix ──────────────────────────────────────────

describe('stripRedundantProviderPrefix', () => {
  it('strips a "<provider>/" prefix matching the current provider', () => {
    expect(stripRedundantProviderPrefix('copilot/auto', 'copilot')).toBe('auto');
    expect(stripRedundantProviderPrefix('copilot/gpt-5.3-codex', 'copilot')).toBe('gpt-5.3-codex');
  });

  it('is case-insensitive when comparing the prefix to the provider', () => {
    expect(stripRedundantProviderPrefix('Copilot/auto', 'copilot')).toBe('auto');
    expect(stripRedundantProviderPrefix('COPILOT/AUTO', 'copilot')).toBe('AUTO');
  });

  it('leaves a model unchanged when the prefix does not match the provider', () => {
    expect(stripRedundantProviderPrefix('openai/gpt-4o', 'copilot')).toBe('openai/gpt-4o');
  });

  it('leaves a model unchanged when there is no prefix', () => {
    expect(stripRedundantProviderPrefix('auto', 'copilot')).toBe('auto');
  });

  it('leaves the model unchanged when stripping would produce an empty string', () => {
    expect(stripRedundantProviderPrefix('copilot/', 'copilot')).toBe('copilot/');
  });

  it('handles non-string/empty inputs gracefully', () => {
    expect(stripRedundantProviderPrefix('', 'copilot')).toBe('');
    expect(stripRedundantProviderPrefix(undefined, 'copilot')).toBeUndefined();
    expect(stripRedundantProviderPrefix('copilot/auto', '')).toBe('copilot/auto');
  });
});
