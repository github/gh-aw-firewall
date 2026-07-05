'use strict';

const { matchesGlobPattern, lookupModelEndpoints, getModelApiMappingReflect } = require('./model-api-mapping');

describe('model-api-mapping', () => {
  describe('matchesGlobPattern', () => {
    it('matches exact strings', () => {
      expect(matchesGlobPattern('gpt-4', 'gpt-4')).toBe(true);
    });

    it('rejects non-matching exact strings', () => {
      expect(matchesGlobPattern('gpt-4o', 'gpt-4')).toBe(false);
    });

    it('matches trailing wildcard', () => {
      expect(matchesGlobPattern('gpt-5.5-turbo', 'gpt-5.5*')).toBe(true);
    });

    it('matches prefix-only with wildcard', () => {
      expect(matchesGlobPattern('gpt-5.5', 'gpt-5.5*')).toBe(true);
    });

    it('rejects non-matching wildcard', () => {
      expect(matchesGlobPattern('gpt-4o', 'gpt-5*')).toBe(false);
    });
  });

  describe('lookupModelEndpoints', () => {
    it('finds GPT-5.5 as responses-only', () => {
      const result = lookupModelEndpoints('gpt-5.5', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('gpt-5.5');
      expect(result.endpoints).toEqual(['responses']);
    });

    it('finds GPT-5.1 as supporting both endpoints', () => {
      const result = lookupModelEndpoints('gpt-5.1-codex', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('gpt-5.1');
      expect(result.endpoints).toContain('chat_completions');
      expect(result.endpoints).toContain('responses');
    });

    it('finds GPT-5.1-codex-max as responses-only', () => {
      const result = lookupModelEndpoints('gpt-5.1-codex-max', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('gpt-5.1-codex-max');
      expect(result.endpoints).toEqual(['responses']);
    });

    it('finds GPT-5-codex as responses-only', () => {
      const result = lookupModelEndpoints('gpt-5-codex', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('gpt-5-codex/pro');
      expect(result.endpoints).toEqual(['responses']);
    });

    it('finds o4-mini-deep-research as responses-only', () => {
      const result = lookupModelEndpoints('o4-mini-deep-research', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('o4-mini-deep-research');
      expect(result.endpoints).toEqual(['responses']);
    });

    it('finds GPT-5.5-turbo as responses-only', () => {
      const result = lookupModelEndpoints('gpt-5.5-turbo', 'openai');
      expect(result).not.toBeNull();
      expect(result.endpoints).toEqual(['responses']);
    });

    it('finds GPT-4o as supporting both endpoints', () => {
      const result = lookupModelEndpoints('gpt-4o', 'openai');
      expect(result).not.toBeNull();
      expect(result.endpoints).toContain('chat_completions');
      expect(result.endpoints).toContain('responses');
    });

    it('finds Claude models as messages endpoint', () => {
      const result = lookupModelEndpoints('claude-sonnet-4-6', 'anthropic');
      expect(result).not.toBeNull();
      expect(result.endpoints).toEqual(['messages']);
    });

    it('finds Claude Sonnet 5 as messages endpoint', () => {
      const result = lookupModelEndpoints('claude-sonnet-5', 'anthropic');
      expect(result).not.toBeNull();
      expect(result.family).toBe('claude-sonnet-5');
      expect(result.endpoints).toEqual(['messages']);
    });

    it('finds models without provider hint', () => {
      const result = lookupModelEndpoints('gpt-5.5');
      expect(result).not.toBeNull();
      expect(result.endpoints).toEqual(['responses']);
    });

    it('returns null for unknown models', () => {
      const result = lookupModelEndpoints('unknown-model-xyz');
      expect(result).toBeNull();
    });

    it('returns null for empty model string', () => {
      const result = lookupModelEndpoints('');
      expect(result).toBeNull();
    });
  });

  describe('getModelApiMappingReflect', () => {
    it('returns available mapping with provider list', () => {
      const reflect = getModelApiMappingReflect();
      expect(reflect.available).toBe(true);
      expect(reflect.providers).toContain('openai');
      expect(reflect.providers).toContain('anthropic');
      expect(reflect.last_updated).toBe('2026-07-05T06:27:39Z');
      expect(reflect.error).toBeNull();
    });
  });
});
