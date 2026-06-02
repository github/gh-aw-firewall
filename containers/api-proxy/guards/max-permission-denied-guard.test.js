'use strict';

const {
  applyPermissionDenied,
  getPermissionDeniedBlockState,
  getPermissionDeniedReflectState,
  resetPermissionDeniedGuardForTests,
  buildPermissionDeniedLimitError,
} = require('./max-permission-denied-guard');

describe('max-permission-denied-guard', () => {
  beforeEach(() => {
    delete process.env.AWF_MAX_PERMISSION_DENIED;
    resetPermissionDeniedGuardForTests();
  });

  afterEach(() => {
    delete process.env.AWF_MAX_PERMISSION_DENIED;
    resetPermissionDeniedGuardForTests();
  });

  describe('when AWF_MAX_PERMISSION_DENIED is not configured', () => {
    it('applyPermissionDenied does nothing', () => {
      applyPermissionDenied();
      expect(getPermissionDeniedBlockState()).toBeNull();
    });

    it('getPermissionDeniedBlockState returns null', () => {
      expect(getPermissionDeniedBlockState()).toBeNull();
    });

    it('getPermissionDeniedReflectState returns disabled state', () => {
      expect(getPermissionDeniedReflectState()).toEqual({
        enabled: false,
        max_permission_denied: null,
        denied_count: 0,
      });
    });
  });

  describe('when AWF_MAX_PERMISSION_DENIED is configured', () => {
    beforeEach(() => {
      process.env.AWF_MAX_PERMISSION_DENIED = '3';
      resetPermissionDeniedGuardForTests();
    });

    it('starts with denied_count of 0 and maxExceeded false', () => {
      const state = getPermissionDeniedBlockState();
      expect(state).toEqual({
        maxPermissionDenied: 3,
        deniedCount: 0,
        maxExceeded: false,
      });
    });

    it('increments denied count on each applyPermissionDenied call', () => {
      applyPermissionDenied();
      applyPermissionDenied();
      const state = getPermissionDeniedBlockState();
      expect(state.deniedCount).toBe(2);
      expect(state.maxExceeded).toBe(false);
    });

    it('sets maxExceeded true when denied count reaches the max', () => {
      applyPermissionDenied();
      applyPermissionDenied();
      applyPermissionDenied();
      const state = getPermissionDeniedBlockState();
      expect(state.deniedCount).toBe(3);
      expect(state.maxExceeded).toBe(true);
    });

    it('remains exceeded after further denials beyond the limit', () => {
      for (let i = 0; i < 5; i++) applyPermissionDenied();
      const state = getPermissionDeniedBlockState();
      expect(state.deniedCount).toBe(5);
      expect(state.maxExceeded).toBe(true);
    });

    it('returns enabled reflect state with running count', () => {
      applyPermissionDenied();
      expect(getPermissionDeniedReflectState()).toEqual({
        enabled: true,
        max_permission_denied: 3,
        denied_count: 1,
      });
    });

    it('resets state correctly between tests', () => {
      applyPermissionDenied();
      resetPermissionDeniedGuardForTests();
      const state = getPermissionDeniedBlockState();
      expect(state.deniedCount).toBe(0);
      expect(state.maxExceeded).toBe(false);
    });
  });

  describe('when AWF_MAX_PERMISSION_DENIED is invalid', () => {
    it('treats zero as unconfigured', () => {
      process.env.AWF_MAX_PERMISSION_DENIED = '0';
      resetPermissionDeniedGuardForTests();
      expect(getPermissionDeniedBlockState()).toBeNull();
    });

    it('treats non-numeric value as unconfigured', () => {
      process.env.AWF_MAX_PERMISSION_DENIED = 'abc';
      resetPermissionDeniedGuardForTests();
      expect(getPermissionDeniedBlockState()).toBeNull();
    });

    it('treats negative value as unconfigured', () => {
      process.env.AWF_MAX_PERMISSION_DENIED = '-1';
      resetPermissionDeniedGuardForTests();
      expect(getPermissionDeniedBlockState()).toBeNull();
    });
  });

  describe('buildPermissionDeniedLimitError', () => {
    it('builds a structured error payload', () => {
      const state = { deniedCount: 3, maxPermissionDenied: 3 };
      const error = buildPermissionDeniedLimitError(state);
      expect(error).toEqual({
        error: {
          type: 'permission_denied_limit_exceeded',
          message: expect.stringContaining('3 / 3'),
          denied_count: 3,
          max_permission_denied: 3,
        },
      });
    });

    it('includes investigation hint in the message', () => {
      const state = { deniedCount: 2, maxPermissionDenied: 2 };
      const error = buildPermissionDeniedLimitError(state);
      expect(error.error.message).toMatch(/check/i);
    });
  });

  describe('config cache invalidation', () => {
    it('picks up a new AWF_MAX_PERMISSION_DENIED value at runtime', () => {
      process.env.AWF_MAX_PERMISSION_DENIED = '2';
      resetPermissionDeniedGuardForTests();

      applyPermissionDenied();
      applyPermissionDenied();
      expect(getPermissionDeniedBlockState().maxExceeded).toBe(true);

      // Raise the limit while the process is running
      process.env.AWF_MAX_PERMISSION_DENIED = '5';
      const state = getPermissionDeniedBlockState();
      expect(state.deniedCount).toBe(0);
      expect(state.maxPermissionDenied).toBe(5);
      expect(state.maxExceeded).toBe(false);
    });
  });
});
