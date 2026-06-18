'use strict';

const {
  applyMaxCacheMissesUsage,
  getMaxCacheMissesBlockState,
  getMaxCacheMissesReflectState,
  resetMaxCacheMissesGuardForTests,
  buildMaxCacheMissesExceededError,
} = require('./max-cache-misses-guard');

describe('max-cache-misses-guard', () => {
  beforeEach(() => {
    delete process.env.AWF_MAX_CACHE_MISSES;
    resetMaxCacheMissesGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_CACHE_MISSES;
    resetMaxCacheMissesGuardForTests();
  });

  it('is disabled when AWF_MAX_CACHE_MISSES is not configured', () => {
    applyMaxCacheMissesUsage({ input_tokens: 100, cache_read_tokens: 0 });
    expect(getMaxCacheMissesBlockState()).toBeNull();
    expect(getMaxCacheMissesReflectState()).toEqual({
      enabled: false,
      max_cache_misses: null,
      consecutive_cache_misses: 0,
      remaining_cache_misses: null,
    });
  });

  it('tracks consecutive cache misses only for non-zero input runs', () => {
    process.env.AWF_MAX_CACHE_MISSES = '3';
    resetMaxCacheMissesGuardForTests();

    applyMaxCacheMissesUsage({ input_tokens: 100, cache_read_tokens: 0 });
    applyMaxCacheMissesUsage({ input_tokens: 0, cache_read_tokens: 0 });
    applyMaxCacheMissesUsage({ input_tokens: 200, cache_read_tokens: 0 });

    expect(getMaxCacheMissesBlockState()).toEqual({
      maxCacheMisses: 3,
      consecutiveCacheMisses: 2,
      maxExceeded: false,
    });
  });

  it('resets streak when cache_read_tokens is non-zero', () => {
    process.env.AWF_MAX_CACHE_MISSES = '3';
    resetMaxCacheMissesGuardForTests();

    applyMaxCacheMissesUsage({ input_tokens: 100, cache_read_tokens: 0 });
    applyMaxCacheMissesUsage({ input_tokens: 100, cache_read_tokens: 25 });

    expect(getMaxCacheMissesBlockState()).toEqual({
      maxCacheMisses: 3,
      consecutiveCacheMisses: 0,
      maxExceeded: false,
    });
  });

  it('blocks once streak reaches the configured max', () => {
    process.env.AWF_MAX_CACHE_MISSES = '2';
    resetMaxCacheMissesGuardForTests();

    applyMaxCacheMissesUsage({ input_tokens: 50, cache_read_tokens: 0 });
    applyMaxCacheMissesUsage({ input_tokens: 60, cache_read_tokens: 0 });

    expect(getMaxCacheMissesBlockState()).toEqual({
      maxCacheMisses: 2,
      consecutiveCacheMisses: 2,
      maxExceeded: true,
    });
    expect(getMaxCacheMissesReflectState()).toEqual({
      enabled: true,
      max_cache_misses: 2,
      consecutive_cache_misses: 2,
      remaining_cache_misses: 0,
    });
  });

  it('builds structured guard error payload', () => {
    const error = buildMaxCacheMissesExceededError({
      maxCacheMisses: 3,
      consecutiveCacheMisses: 3,
    });
    expect(error).toEqual({
      error: {
        type: 'max_cache_misses_exceeded',
        message: expect.stringContaining('3 / 3'),
        consecutive_cache_misses: 3,
        max_cache_misses: 3,
      },
    });
  });
});
