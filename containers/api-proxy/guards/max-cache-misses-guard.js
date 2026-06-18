'use strict';

const { parsePositiveInteger } = require('./guard-utils');

function createMaxCacheMissesState(configKey = null) {
  return {
    configKey,
    consecutiveCacheMisses: 0,
  };
}

let guardState = createMaxCacheMissesState();
const configCache = { rawMax: undefined, parsed: null };

function getMaxCacheMissesConfig() {
  const rawMax = process.env.AWF_MAX_CACHE_MISSES;
  if (configCache.rawMax === rawMax) return configCache.parsed;
  configCache.rawMax = rawMax;
  configCache.parsed = parsePositiveInteger(rawMax);
  return configCache.parsed;
}

function getMaxCacheMissesState(maxCacheMisses) {
  if (!maxCacheMisses) return null;
  const configKey = String(maxCacheMisses);
  if (guardState.configKey !== configKey) {
    guardState = createMaxCacheMissesState(configKey);
  }
  return guardState;
}

function applyMaxCacheMissesUsage(normalizedUsage) {
  const maxCacheMisses = getMaxCacheMissesConfig();
  const state = getMaxCacheMissesState(maxCacheMisses);
  if (!state || !normalizedUsage) return;

  const inputTokens = normalizedUsage.input_tokens || 0;
  const cacheReadTokens = normalizedUsage.cache_read_tokens || 0;

  // Only runs with non-zero input tokens are considered for cache-miss streaks.
  if (inputTokens <= 0) return;

  if (cacheReadTokens > 0) {
    state.consecutiveCacheMisses = 0;
    return;
  }

  state.consecutiveCacheMisses += 1;
}

function getMaxCacheMissesBlockState() {
  const maxCacheMisses = getMaxCacheMissesConfig();
  const state = getMaxCacheMissesState(maxCacheMisses);
  if (!state) return null;
  return {
    maxCacheMisses,
    consecutiveCacheMisses: state.consecutiveCacheMisses,
    maxExceeded: state.consecutiveCacheMisses >= maxCacheMisses,
  };
}

function getMaxCacheMissesReflectState() {
  const maxCacheMisses = getMaxCacheMissesConfig();
  const state = getMaxCacheMissesState(maxCacheMisses);
  if (!state) {
    return {
      enabled: false,
      max_cache_misses: null,
      consecutive_cache_misses: 0,
      remaining_cache_misses: null,
    };
  }
  return {
    enabled: true,
    max_cache_misses: maxCacheMisses,
    consecutive_cache_misses: state.consecutiveCacheMisses,
    remaining_cache_misses: Math.max(0, maxCacheMisses - state.consecutiveCacheMisses),
  };
}

function resetMaxCacheMissesGuardForTests() {
  guardState = createMaxCacheMissesState();
  configCache.rawMax = undefined;
  configCache.parsed = null;
}

function buildMaxCacheMissesExceededError(state) {
  return {
    error: {
      type: 'max_cache_misses_exceeded',
      message: `Maximum consecutive cache misses exceeded (${state.consecutiveCacheMisses} / ${state.maxCacheMisses}).`,
      consecutive_cache_misses: state.consecutiveCacheMisses,
      max_cache_misses: state.maxCacheMisses,
    },
  };
}

module.exports = {
  applyMaxCacheMissesUsage,
  getMaxCacheMissesBlockState,
  getMaxCacheMissesReflectState,
  resetMaxCacheMissesGuardForTests,
  buildMaxCacheMissesExceededError,
};
