'use strict';

const { createCounterGuard } = require('./counter-guard');

describe('createCounterGuard', () => {
  const ENV_VAR = 'AWF_TEST_COUNTER_GUARD';
  const COUNT_FIELD = 'testCount';
  const MAX_FIELD = 'maxTest';

  let guard;

  beforeEach(() => {
    delete process.env[ENV_VAR];
    guard = createCounterGuard({ envVar: ENV_VAR, countField: COUNT_FIELD });
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  describe('getConfig', () => {
    it('returns null when env var is not set', () => {
      expect(guard.getConfig()).toBeNull();
    });

    it('returns null for zero', () => {
      process.env[ENV_VAR] = '0';
      expect(guard.getConfig()).toBeNull();
    });

    it('returns null for negative values', () => {
      process.env[ENV_VAR] = '-1';
      expect(guard.getConfig()).toBeNull();
    });

    it('returns null for non-numeric values', () => {
      process.env[ENV_VAR] = 'abc';
      expect(guard.getConfig()).toBeNull();
    });

    it('returns parsed integer for a valid positive value', () => {
      process.env[ENV_VAR] = '5';
      expect(guard.getConfig()).toBe(5);
    });

    it('memoizes the parsed config when the env var does not change', () => {
      process.env[ENV_VAR] = '3';
      const first = guard.getConfig();
      const second = guard.getConfig();
      expect(first).toBe(second);
    });

    it('re-parses when the env var changes at runtime', () => {
      process.env[ENV_VAR] = '3';
      expect(guard.getConfig()).toBe(3);
      process.env[ENV_VAR] = '7';
      expect(guard.getConfig()).toBe(7);
    });
  });

  describe('getState', () => {
    it('returns null when max is falsy', () => {
      expect(guard.getState(null)).toBeNull();
      expect(guard.getState(0)).toBeNull();
    });

    it('returns state with zero count for a new max', () => {
      const state = guard.getState(5);
      expect(state).toEqual({ configKey: '5', [COUNT_FIELD]: 0 });
    });

    it('resets state when the max (configKey) changes', () => {
      const state1 = guard.getState(3);
      state1[COUNT_FIELD] = 2;

      const state2 = guard.getState(5);
      expect(state2[COUNT_FIELD]).toBe(0);
    });

    it('returns the same state object when the max is unchanged', () => {
      const state1 = guard.getState(5);
      state1[COUNT_FIELD] = 2;
      const state2 = guard.getState(5);
      expect(state2[COUNT_FIELD]).toBe(2);
    });
  });

  describe('applyIncrement', () => {
    it('does nothing when env var is not configured', () => {
      guard.applyIncrement();
      expect(guard.getBlockState(MAX_FIELD)).toBeNull();
    });

    it('increments the counter on each call', () => {
      process.env[ENV_VAR] = '5';
      guard.applyIncrement();
      guard.applyIncrement();
      const state = guard.getBlockState(MAX_FIELD);
      expect(state[COUNT_FIELD]).toBe(2);
    });
  });

  describe('getBlockState', () => {
    it('returns null when env var is not configured', () => {
      expect(guard.getBlockState(MAX_FIELD)).toBeNull();
    });

    it('returns initial state with maxExceeded false', () => {
      process.env[ENV_VAR] = '3';
      expect(guard.getBlockState(MAX_FIELD)).toEqual({
        [MAX_FIELD]: 3,
        [COUNT_FIELD]: 0,
        maxExceeded: false,
      });
    });

    it('sets maxExceeded true when count reaches the max', () => {
      process.env[ENV_VAR] = '2';
      guard.applyIncrement();
      guard.applyIncrement();
      const state = guard.getBlockState(MAX_FIELD);
      expect(state[COUNT_FIELD]).toBe(2);
      expect(state.maxExceeded).toBe(true);
    });

    it('remains exceeded after count exceeds the max', () => {
      process.env[ENV_VAR] = '2';
      for (let i = 0; i < 4; i++) guard.applyIncrement();
      const state = guard.getBlockState(MAX_FIELD);
      expect(state[COUNT_FIELD]).toBe(4);
      expect(state.maxExceeded).toBe(true);
    });
  });

  describe('resetForTests', () => {
    it('resets counter and config cache', () => {
      process.env[ENV_VAR] = '3';
      guard.applyIncrement();
      guard.applyIncrement();

      guard.resetForTests();

      const state = guard.getBlockState(MAX_FIELD);
      expect(state[COUNT_FIELD]).toBe(0);
      expect(state.maxExceeded).toBe(false);
    });

    it('allows picking up a changed env var after reset', () => {
      process.env[ENV_VAR] = '3';
      guard.applyIncrement();

      process.env[ENV_VAR] = '10';
      guard.resetForTests();

      const state = guard.getBlockState(MAX_FIELD);
      expect(state[MAX_FIELD]).toBe(10);
      expect(state[COUNT_FIELD]).toBe(0);
    });
  });

  describe('config cache invalidation', () => {
    it('resets state when max changes due to env var update', () => {
      process.env[ENV_VAR] = '2';
      guard.applyIncrement();
      guard.applyIncrement();
      expect(guard.getBlockState(MAX_FIELD).maxExceeded).toBe(true);

      process.env[ENV_VAR] = '5';
      const state = guard.getBlockState(MAX_FIELD);
      expect(state[COUNT_FIELD]).toBe(0);
      expect(state[MAX_FIELD]).toBe(5);
      expect(state.maxExceeded).toBe(false);
    });
  });

  describe('each factory call returns an independent instance', () => {
    it('two guards with the same env var do not share state', () => {
      process.env[ENV_VAR] = '5';
      const guard2 = createCounterGuard({ envVar: ENV_VAR, countField: COUNT_FIELD });

      guard.applyIncrement();
      guard.applyIncrement();

      expect(guard.getBlockState(MAX_FIELD)[COUNT_FIELD]).toBe(2);
      expect(guard2.getBlockState(MAX_FIELD)[COUNT_FIELD]).toBe(0);
    });
  });
});
