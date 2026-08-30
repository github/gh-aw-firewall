'use strict';

const { createManagementHandlers } = require('./management');
const { resetGuardResultTrackerForTests } = require('./guards/guard-result-tracker');

function makeDeps() {
  return {
    getAdapters: () => [],
    getCachedModels: () => ({}),
    isModelFetchComplete: () => true,
    getKeyValidationState: () => ({ complete: true, results: {} }),
    getLimiter: () => ({ getAllStatus: () => ({}) }),
    httpsProxy: undefined,
    getModelAliases: () => null,
    getModelFallback: () => ({ enabled: false, strategy: 'none' }),
    getEffectiveModelFallback: () => ({}),
    getAiCreditsUsage: () => ({}),
    getMaxRunsUsage: () => ({}),
    getMaxCacheMissesUsage: () => ({}),
    getPermissionDeniedUsage: () => ({}),
  };
}

function makeRes() {
  return {
    writeHead: jest.fn(),
    end: jest.fn(),
  };
}

describe('management /guard-snapshot gating', () => {
  beforeEach(() => {
    resetGuardResultTrackerForTests();
    delete process.env.AWF_GUARD_RESULT_ENABLED;
  });

  afterEach(() => {
    resetGuardResultTrackerForTests();
    delete process.env.AWF_GUARD_RESULT_ENABLED;
  });

  it('does not handle /guard-snapshot when the guard-result channel was not validated', () => {
    const { handleManagementEndpoint } = createManagementHandlers(makeDeps());
    const req = { method: 'GET', url: '/guard-snapshot' };
    const res = makeRes();
    const handled = handleManagementEndpoint(req, res);
    expect(handled).toBe(false);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('handles /guard-snapshot when the host validated a guard-result channel', () => {
    process.env.AWF_GUARD_RESULT_ENABLED = '1';
    const { handleManagementEndpoint } = createManagementHandlers(makeDeps());
    const req = { method: 'GET', url: '/guard-snapshot' };
    const res = makeRes();
    const handled = handleManagementEndpoint(req, res);
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalled();
  });
});
