'use strict';

const {
  getRetiredModelBlockState,
  buildRetiredModelError,
} = require('./retired-model-guard');

describe('retired-model-guard', () => {
  describe('getRetiredModelBlockState', () => {
    it('returns null for null model', () => {
      expect(getRetiredModelBlockState(null)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(getRetiredModelBlockState('')).toBeNull();
    });

    it('returns null for an active/supported model', () => {
      expect(getRetiredModelBlockState('gpt-4o')).toBeNull();
      expect(getRetiredModelBlockState('gpt-5.3-codex')).toBeNull();
      expect(getRetiredModelBlockState('claude-sonnet-4.6')).toBeNull();
    });

    it('returns a block state for the retired gpt-5-codex model', () => {
      const state = getRetiredModelBlockState('gpt-5-codex');
      expect(state).not.toBeNull();
      expect(state.model).toBe('gpt-5-codex');
      expect(state.suggestion).toBe('gpt-5.3-codex');
    });

    it('matches retired models case-insensitively', () => {
      expect(getRetiredModelBlockState('GPT-5-CODEX')).not.toBeNull();
      expect(getRetiredModelBlockState('Gpt-5-Codex')).not.toBeNull();
    });

    it('preserves the original casing in the returned model field', () => {
      const state = getRetiredModelBlockState('GPT-5-CODEX');
      expect(state.model).toBe('GPT-5-CODEX');
    });
  });

  describe('buildRetiredModelError', () => {
    it('includes the model and suggestion in the error body', () => {
      const state = { model: 'gpt-5-codex', suggestion: 'gpt-5.3-codex' };
      const result = buildRetiredModelError(state);
      expect(result.error.type).toBe('retired_model');
      expect(result.error.model).toBe('gpt-5-codex');
      expect(result.error.suggestion).toBe('gpt-5.3-codex');
      expect(result.error.message).toContain("gpt-5-codex");
      expect(result.error.message).toContain("gpt-5.3-codex");
      expect(result.error.message).toContain("Did you mean");
    });
  });
});
