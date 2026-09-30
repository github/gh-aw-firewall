'use strict';

const {
  matchesGlobPattern,
  lookupModelEndpoints,
  lookupModelRoutingMetadata,
  getModelApiMappingReflect,
} = require('./model-api-mapping');

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
    it('finds GPT-5.6 as supporting both endpoints', () => {
      const result = lookupModelEndpoints('gpt-5.6-sol', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('gpt-5.6');
      expect(result.endpoints).toContain('chat_completions');
      expect(result.endpoints).toContain('responses');
    });

    it('finds GPT-6 Astra as supporting both endpoints', () => {
      const result = lookupModelEndpoints('gpt-6-astra', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('gpt-6-astra');
      expect(result.endpoints).toContain('chat_completions');
      expect(result.endpoints).toContain('responses');
    });

    it.each([
      ['gpt-6-sol', 'gpt-6-sol'],
      ['gpt-6-luna', 'gpt-6-luna'],
      ['gpt-4.5-preview', 'gpt-4.5'],
    ])('finds %s as supporting both endpoints', (model, family) => {
      const result = lookupModelEndpoints(model, 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe(family);
      expect(result.endpoints).toContain('chat_completions');
      expect(result.endpoints).toContain('responses');
    });

    it.each([
      ['gpt-rosalind-research', 'gpt-rosalind-research'],
      ['gpt-5.3-codex', 'gpt-5.3-codex'],
      ['gpt-5.2-codex', 'gpt-5.2-codex'],
      ['gpt-5.2-pro', 'gpt-5.2-pro'],
      ['codex-mini-latest', 'codex-mini'],
    ])('finds %s as responses-only', (model, family) => {
      const result = lookupModelEndpoints(model, 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe(family);
      expect(result.endpoints).toEqual(['responses']);
    });

    it('finds GPT-5.5 as supporting both endpoints', () => {
      const result = lookupModelEndpoints('gpt-5.5', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('gpt-5.5');
      expect(result.endpoints).toContain('chat_completions');
      expect(result.endpoints).toContain('responses');
    });

    it('finds GPT-5.5-pro as responses-only', () => {
      const result = lookupModelEndpoints('gpt-5.5-pro', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('gpt-5.5-pro');
      expect(result.endpoints).toEqual(['responses']);
    });

    it('finds GPT-5.1-codex as responses-only', () => {
      const result = lookupModelEndpoints('gpt-5.1-codex', 'openai');
      expect(result).not.toBeNull();
      expect(result.family).toBe('gpt-5.1-codex');
      expect(result.endpoints).toEqual(['responses']);
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

    it('finds GPT-5.5-turbo as supporting both endpoints', () => {
      const result = lookupModelEndpoints('gpt-5.5-turbo', 'openai');
      expect(result).not.toBeNull();
      expect(result.endpoints).toContain('chat_completions');
      expect(result.endpoints).toContain('responses');
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

    it('finds Claude Opus 5 as messages endpoint', () => {
      const result = lookupModelEndpoints('claude-opus-5', 'anthropic');
      expect(result).not.toBeNull();
      expect(result.family).toBe('claude-opus-5');
      expect(result.endpoints).toEqual(['messages']);
    });

    it('finds Claude 3.7 Sonnet as messages endpoint', () => {
      const result = lookupModelEndpoints('claude-3-7-sonnet-latest', 'anthropic');
      expect(result).not.toBeNull();
      expect(result.family).toBe('claude-3.7-sonnet');
      expect(result.endpoints).toEqual(['messages']);
    });

    it('finds models without provider hint', () => {
      const result = lookupModelEndpoints('gpt-5.5');
      expect(result).not.toBeNull();
      expect(result.endpoints).toContain('chat_completions');
      expect(result.endpoints).toContain('responses');
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

  describe('lookupModelRoutingMetadata', () => {
    it('returns verified OpenAI effort and context data only for covered model IDs', () => {
      expect(lookupModelRoutingMetadata('gpt-5.4', 'openai')).toEqual({
        family: 'gpt-5.4',
        endpoints: ['chat_completions', 'responses'],
        reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        contextWindowTokens: 1_050_000,
      });
      expect(lookupModelRoutingMetadata('gpt-5.4-mini', 'openai')).toBeNull();
      expect(lookupModelRoutingMetadata('o3', 'openai')).toBeNull();
      expect(lookupModelRoutingMetadata('gpt-5.4-2026-03-05', 'openai'))
        .toMatchObject({ contextWindowTokens: 1_050_000 });
    });

    it('returns Anthropic Messages effort and context metadata for maintained families', () => {
      expect(lookupModelRoutingMetadata('claude-opus-5-5', 'anthropic')).toEqual({
        family: 'claude-opus-5',
        endpoints: ['messages'],
        reasoningEfforts: ['low', 'medium', 'high', 'max'],
        contextWindowTokens: 1_000_000,
      });
      expect(lookupModelRoutingMetadata('claude-haiku-4-5-20251001', 'anthropic')).toBeNull();
    });
  });

  describe('getModelApiMappingReflect', () => {
    it('returns available mapping with provider list', () => {
      const reflect = getModelApiMappingReflect();
      expect(reflect.available).toBe(true);
      expect(reflect.providers).toContain('openai');
      expect(reflect.providers).toContain('anthropic');
      expect(reflect.last_updated).toBe('2026-09-30T07:10:00Z');
      expect(reflect.models.anthropic.models[0].family).toBe('claude-opus-5');
      expect(reflect.models.openai.models.find(model => model.family === 'gpt-5.4').routing)
        .toEqual({
          reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
          contextWindowTokens: 1_050_000,
        });
      expect(reflect.error).toBeNull();
    });
  });
});
