'use strict';

const { parsePositiveInteger } = require('./guard-utils');

/**
 * Factory for creating counter-based guard modules.
 *
 * Both max-runs-guard and max-permission-denied-guard follow identical patterns:
 * config cache → state tracking → increment → block check → reflect → reset.
 * This factory eliminates that duplication.
 *
 * @param {object} opts
 * @param {string} opts.envVar - Environment variable name (e.g. 'AWF_MAX_RUNS')
 * @param {string} opts.countField - Name of the counter field in state (e.g. 'invocationCount')
 * @returns {{ getConfig, getState, applyIncrement, getBlockState, resetForTests }}
 */
function createCounterGuard({ envVar, countField }) {
  let guardState = { configKey: null, [countField]: 0 };
  const configCache = { rawMax: undefined, parsed: null };

  function getConfig() {
    const rawMax = process.env[envVar];
    if (configCache.rawMax === rawMax) return configCache.parsed;
    configCache.rawMax = rawMax;
    configCache.parsed = parsePositiveInteger(rawMax);
    return configCache.parsed;
  }

  function getState(max) {
    if (!max) return null;
    const configKey = String(max);
    if (guardState.configKey !== configKey) {
      guardState = { configKey, [countField]: 0 };
    }
    return guardState;
  }

  function applyIncrement() {
    const max = getConfig();
    const state = getState(max);
    if (!state) return;
    state[countField] += 1;
  }

  function getBlockState(maxField) {
    const max = getConfig();
    const state = getState(max);
    if (!state) return null;
    return {
      [maxField]: max,
      [countField]: state[countField],
      maxExceeded: state[countField] >= max,
    };
  }

  function resetForTests() {
    guardState = { configKey: null, [countField]: 0 };
    configCache.rawMax = undefined;
    configCache.parsed = null;
  }

  return { getConfig, getState, applyIncrement, getBlockState, resetForTests };
}

module.exports = { createCounterGuard };
