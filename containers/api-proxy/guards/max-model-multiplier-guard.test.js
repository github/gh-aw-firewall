'use strict';

const {
  getModelMultiplierCapBlockState,
  buildModelMultiplierCapError,
  resetMaxModelMultiplierGuardForTests,
} = require('./max-model-multiplier-guard');

describe('max-model-multiplier-guard', () => {
  beforeEach(() => {
    delete process.env.AWF_MAX_MODEL_MULTIPLIER;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER;
    resetMaxModelMultiplierGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_MODEL_MULTIPLIER;
    delete process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS;
    delete process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER;
    resetMaxModelMultiplierGuardForTests();
  });

  describe('getModelMultiplierCapBlockState', () => {
    it('returns null when AWF_MAX_MODEL_MULTIPLIER is not set', () => {
      expect(getModelMultiplierCapBlockState('claude-opus-4.7')).toBeNull();
    });

    it('returns null when model is null', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '5';
      expect(getModelMultiplierCapBlockState(null)).toBeNull();
    });

    it('returns null when model is empty string', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '5';
      expect(getModelMultiplierCapBlockState('')).toBeNull();
    });

    it('does not block when model multiplier equals the cap', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '4';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({ 'gpt-4o': 4 });

      const state = getModelMultiplierCapBlockState('gpt-4o');
      expect(state).not.toBeNull();
      expect(state.maxExceeded).toBe(false);
      expect(state.multiplier).toBe(4);
    });

    it('blocks when model multiplier exceeds the cap', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '4';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({
        'claude-opus-4.7': 27,
        'gpt-4o': 2,
      });

      const state = getModelMultiplierCapBlockState('claude-opus-4.7');
      expect(state.maxExceeded).toBe(true);
      expect(state.multiplier).toBe(27);
      expect(state.maxModelMultiplier).toBe(4);
      expect(state.model).toBe('claude-opus-4.7');
    });

    it('does not block when model multiplier is below the cap', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '4';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({
        'claude-opus-4.7': 27,
        'gpt-4o': 2,
      });

      const state = getModelMultiplierCapBlockState('gpt-4o');
      expect(state.maxExceeded).toBe(false);
      expect(state.multiplier).toBe(2);
    });

    it('resolves multiplier via prefix match', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '5';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({
        'claude-opus-4.7': 27,
      });

      const state = getModelMultiplierCapBlockState('claude-opus-4.7-20260501');
      expect(state.maxExceeded).toBe(true);
      expect(state.multiplier).toBe(27);
    });

    it('uses default multiplier (1) when model is unknown and no default is set', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '5';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({ 'gpt-4o': 2 });

      const state = getModelMultiplierCapBlockState('unknown-model');
      expect(state.maxExceeded).toBe(false);
      expect(state.multiplier).toBe(1);
    });

    it('uses configured default multiplier for unknown models', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '5';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({ 'gpt-4o': 2 });
      process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER = '10';

      const state = getModelMultiplierCapBlockState('unknown-model');
      expect(state.maxExceeded).toBe(true);
      expect(state.multiplier).toBe(10);
    });

    it('blocks unknown models when default multiplier exceeds cap', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '3';
      process.env.AWF_EFFECTIVE_TOKEN_DEFAULT_MODEL_MULTIPLIER = '27';

      const state = getModelMultiplierCapBlockState('any-model');
      expect(state.maxExceeded).toBe(true);
      expect(state.multiplier).toBe(27);
    });

    it('caches config across calls with same env vars', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '5';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({ 'gpt-4o': 2 });

      const state1 = getModelMultiplierCapBlockState('gpt-4o');
      const state2 = getModelMultiplierCapBlockState('gpt-4o');
      expect(state1.multiplier).toBe(state2.multiplier);
    });

    it('invalidates cache when env vars change', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '5';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({ 'gpt-4o': 2 });
      const state1 = getModelMultiplierCapBlockState('gpt-4o');
      expect(state1.multiplier).toBe(2);

      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({ 'gpt-4o': 8 });
      const state2 = getModelMultiplierCapBlockState('gpt-4o');
      expect(state2.multiplier).toBe(8);
    });

    it('uses longest prefix match when multiple prefixes match', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '10';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({
        'claude-opus': 20,
        'claude-opus-4.7': 27,
      });

      const state = getModelMultiplierCapBlockState('claude-opus-4.7-20260501');
      expect(state.multiplier).toBe(27); // longer match wins
    });
  });

  describe('buildModelMultiplierCapError', () => {
    it('returns a structured error object', () => {
      const state = { model: 'claude-opus-4.7', multiplier: 27, maxModelMultiplier: 5 };
      const err = buildModelMultiplierCapError(state);

      expect(err.error.type).toBe('model_multiplier_cap_exceeded');
      expect(err.error.model).toBe('claude-opus-4.7');
      expect(err.error.model_multiplier).toBe(27);
      expect(err.error.max_model_multiplier).toBe(5);
      expect(typeof err.error.message).toBe('string');
      expect(err.error.message).toContain('claude-opus-4.7');
      expect(err.error.message).toContain('27');
      expect(err.error.message).toContain('5');
    });
  });

  describe('resetMaxModelMultiplierGuardForTests', () => {
    it('clears cached config so new env vars take effect', () => {
      process.env.AWF_MAX_MODEL_MULTIPLIER = '5';
      process.env.AWF_EFFECTIVE_TOKEN_MODEL_MULTIPLIERS = JSON.stringify({ 'gpt-4o': 10 });
      getModelMultiplierCapBlockState('gpt-4o'); // populate cache

      // Reset and change env
      resetMaxModelMultiplierGuardForTests();
      delete process.env.AWF_MAX_MODEL_MULTIPLIER;

      expect(getModelMultiplierCapBlockState('gpt-4o')).toBeNull();
    });
  });
});
