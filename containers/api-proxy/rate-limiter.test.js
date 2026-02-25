'use strict';

const { RateLimiter, create } = require('./rate-limiter');

describe('rate-limiter', () => {
  describe('constructor', () => {
    it('should use defaults when no config provided', () => {
      const limiter = new RateLimiter();
      expect(limiter.rpm).toBe(60);
      expect(limiter.rph).toBe(1000);
      expect(limiter.bytesPm).toBe(50 * 1024 * 1024);
      expect(limiter.enabled).toBe(true);
    });

    it('should respect custom config values', () => {
      const limiter = new RateLimiter({ rpm: 10, rph: 100, bytesPm: 1024, enabled: true });
      expect(limiter.rpm).toBe(10);
      expect(limiter.rph).toBe(100);
      expect(limiter.bytesPm).toBe(1024);
      expect(limiter.enabled).toBe(true);
    });

    it('should default enabled to true', () => {
      const limiter = new RateLimiter({});
      expect(limiter.enabled).toBe(true);
    });

    it('should allow disabling via config', () => {
      const limiter = new RateLimiter({ enabled: false });
      expect(limiter.enabled).toBe(false);
    });
  });

  describe('create() factory', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should read from environment variables', () => {
      process.env.AWF_RATE_LIMIT_RPM = '30';
      process.env.AWF_RATE_LIMIT_RPH = '500';
      process.env.AWF_RATE_LIMIT_BYTES_PM = '10485760';
      const limiter = create();
      expect(limiter.rpm).toBe(30);
      expect(limiter.rph).toBe(500);
      expect(limiter.bytesPm).toBe(10485760);
      expect(limiter.enabled).toBe(true);
    });

    it('should create disabled limiter when AWF_RATE_LIMIT_ENABLED=false', () => {
      process.env.AWF_RATE_LIMIT_ENABLED = 'false';
      const limiter = create();
      expect(limiter.enabled).toBe(false);
    });

    it('should use defaults for negative env var values', () => {
      process.env.AWF_RATE_LIMIT_RPM = '-5';
      process.env.AWF_RATE_LIMIT_RPH = '-100';
      process.env.AWF_RATE_LIMIT_BYTES_PM = '-1024';
      const limiter = create();
      expect(limiter.rpm).toBe(60);
      expect(limiter.rph).toBe(1000);
      expect(limiter.bytesPm).toBe(50 * 1024 * 1024);
    });

    it('should use defaults for zero env var values', () => {
      process.env.AWF_RATE_LIMIT_RPM = '0';
      process.env.AWF_RATE_LIMIT_RPH = '0';
      process.env.AWF_RATE_LIMIT_BYTES_PM = '0';
      const limiter = create();
      expect(limiter.rpm).toBe(60);
      expect(limiter.rph).toBe(1000);
      expect(limiter.bytesPm).toBe(50 * 1024 * 1024);
    });

    it('should use defaults for non-numeric env var values', () => {
      process.env.AWF_RATE_LIMIT_RPM = 'abc';
      process.env.AWF_RATE_LIMIT_RPH = 'xyz';
      process.env.AWF_RATE_LIMIT_BYTES_PM = '';
      const limiter = create();
      expect(limiter.rpm).toBe(60);
      expect(limiter.rph).toBe(1000);
      expect(limiter.bytesPm).toBe(50 * 1024 * 1024);
    });

    it('should use defaults when env vars are not set', () => {
      delete process.env.AWF_RATE_LIMIT_RPM;
      delete process.env.AWF_RATE_LIMIT_RPH;
      delete process.env.AWF_RATE_LIMIT_BYTES_PM;
      delete process.env.AWF_RATE_LIMIT_ENABLED;
      const limiter = create();
      expect(limiter.rpm).toBe(60);
      expect(limiter.rph).toBe(1000);
      expect(limiter.bytesPm).toBe(50 * 1024 * 1024);
      expect(limiter.enabled).toBe(true);
    });
  });

  describe('basic RPM limiting', () => {
    it('should allow requests under RPM limit', () => {
      const limiter = new RateLimiter({ rpm: 5, rph: 10000 });
      for (let i = 0; i < 5; i++) {
        const result = limiter.check('openai');
        expect(result.allowed).toBe(true);
      }
    });

    it('should reject request when RPM limit exceeded', () => {
      const limiter = new RateLimiter({ rpm: 3, rph: 10000 });
      // Use up all 3 requests
      for (let i = 0; i < 3; i++) {
        expect(limiter.check('openai').allowed).toBe(true);
      }
      // 4th request should be denied
      const result = limiter.check('openai');
      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('rpm');
      expect(result.limit).toBe(3);
    });
  });

  describe('basic RPH limiting', () => {
    it('should allow requests under RPH limit', () => {
      const limiter = new RateLimiter({ rpm: 10000, rph: 5 });
      for (let i = 0; i < 5; i++) {
        expect(limiter.check('openai').allowed).toBe(true);
      }
    });

    it('should reject when RPH limit exceeded', () => {
      const limiter = new RateLimiter({ rpm: 10000, rph: 3 });
      for (let i = 0; i < 3; i++) {
        expect(limiter.check('openai').allowed).toBe(true);
      }
      const result = limiter.check('openai');
      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('rph');
      expect(result.limit).toBe(3);
    });
  });

  describe('bytes per minute limiting', () => {
    it('should allow requests under bytes limit', () => {
      const limiter = new RateLimiter({ rpm: 10000, rph: 10000, bytesPm: 1000 });
      const result = limiter.check('openai', 500);
      expect(result.allowed).toBe(true);
    });

    it('should reject when bytes limit exceeded', () => {
      const limiter = new RateLimiter({ rpm: 10000, rph: 10000, bytesPm: 1000 });
      expect(limiter.check('openai', 600).allowed).toBe(true);
      const result = limiter.check('openai', 500);
      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('bytes_pm');
      expect(result.limit).toBe(1000);
    });

    it('should handle zero-byte requests', () => {
      const limiter = new RateLimiter({ rpm: 10000, rph: 10000, bytesPm: 1000 });
      const result = limiter.check('openai', 0);
      expect(result.allowed).toBe(true);
    });

    it('should handle exactly-at-limit', () => {
      const limiter = new RateLimiter({ rpm: 10000, rph: 10000, bytesPm: 1000 });
      // First request uses exactly 1000 bytes
      expect(limiter.check('openai', 1000).allowed).toBe(true);
      // Next request with any bytes should be rejected
      const result = limiter.check('openai', 1);
      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('bytes_pm');
    });
  });

  describe('per-provider independence', () => {
    it('should track providers independently', () => {
      const limiter = new RateLimiter({ rpm: 2, rph: 10000 });
      // Use up openai's limit
      expect(limiter.check('openai').allowed).toBe(true);
      expect(limiter.check('openai').allowed).toBe(true);
      expect(limiter.check('openai').allowed).toBe(false);
      // anthropic should still be allowed
      expect(limiter.check('anthropic').allowed).toBe(true);
      expect(limiter.check('anthropic').allowed).toBe(true);
      expect(limiter.check('anthropic').allowed).toBe(false);
    });

    it('should track copilot separately from openai and anthropic', () => {
      const limiter = new RateLimiter({ rpm: 1, rph: 10000 });
      expect(limiter.check('openai').allowed).toBe(true);
      expect(limiter.check('anthropic').allowed).toBe(true);
      expect(limiter.check('copilot').allowed).toBe(true);
      // All three should now be rate limited
      expect(limiter.check('openai').allowed).toBe(false);
      expect(limiter.check('anthropic').allowed).toBe(false);
      expect(limiter.check('copilot').allowed).toBe(false);
    });
  });

  describe('disabled rate limiter', () => {
    it('should always allow when enabled: false', () => {
      const limiter = new RateLimiter({ enabled: false, rpm: 1 });
      // Even though RPM is 1, all requests should be allowed
      for (let i = 0; i < 100; i++) {
        const result = limiter.check('openai');
        expect(result.allowed).toBe(true);
      }
    });
  });

  describe('fail-open', () => {
    it('should allow on internal errors', () => {
      const limiter = new RateLimiter({ rpm: 5 });
      // Corrupt internal state to cause an error
      limiter._getState = () => { throw new Error('internal error'); };
      const result = limiter.check('openai');
      expect(result.allowed).toBe(true);
    });
  });

  describe('response fields', () => {
    it('should return positive retryAfter when rate limited', () => {
      const limiter = new RateLimiter({ rpm: 1, rph: 10000 });
      limiter.check('openai');
      const result = limiter.check('openai');
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should return 0 retryAfter when allowed', () => {
      const limiter = new RateLimiter({ rpm: 10 });
      const result = limiter.check('openai');
      expect(result.retryAfter).toBe(0);
    });

    it('should decrease remaining as requests are made', () => {
      const limiter = new RateLimiter({ rpm: 5, rph: 10000 });
      const r1 = limiter.check('openai');
      expect(r1.remaining).toBe(4);
      const r2 = limiter.check('openai');
      expect(r2.remaining).toBe(3);
      const r3 = limiter.check('openai');
      expect(r3.remaining).toBe(2);
    });
  });

  describe('getStatus', () => {
    it('should return correct format for known provider', () => {
      const limiter = new RateLimiter({ rpm: 10, rph: 100 });
      limiter.check('openai');
      const status = limiter.getStatus('openai');
      expect(status.enabled).toBe(true);
      expect(status.rpm).toBeDefined();
      expect(status.rpm.limit).toBe(10);
      expect(status.rpm.remaining).toBe(9);
      expect(status.rph).toBeDefined();
      expect(status.rph.limit).toBe(100);
    });

    it('should return full limits for unknown provider', () => {
      const limiter = new RateLimiter({ rpm: 10, rph: 100 });
      const status = limiter.getStatus('unknown_provider');
      expect(status.enabled).toBe(true);
      expect(status.rpm.remaining).toBe(10);
      expect(status.rph.remaining).toBe(100);
    });

    it('should return disabled when limiter is disabled', () => {
      const limiter = new RateLimiter({ enabled: false });
      const status = limiter.getStatus('openai');
      expect(status.enabled).toBe(false);
    });
  });

  describe('getAllStatus', () => {
    it('should return all known providers', () => {
      const limiter = new RateLimiter({ rpm: 10, rph: 100 });
      limiter.check('openai');
      limiter.check('anthropic');
      limiter.check('copilot');
      const allStatus = limiter.getAllStatus();
      expect(allStatus).toHaveProperty('openai');
      expect(allStatus).toHaveProperty('anthropic');
      expect(allStatus).toHaveProperty('copilot');
    });

    it('should return empty object when no providers have been used', () => {
      const limiter = new RateLimiter({ rpm: 10 });
      const allStatus = limiter.getAllStatus();
      expect(Object.keys(allStatus)).toHaveLength(0);
    });
  });

  describe('window rollover', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should allow requests again after RPM window passes', () => {
      const limiter = new RateLimiter({ rpm: 2, rph: 10000 });

      // Set a base time
      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      expect(limiter.check('openai').allowed).toBe(true);
      expect(limiter.check('openai').allowed).toBe(true);
      expect(limiter.check('openai').allowed).toBe(false);

      // Advance time by 61 seconds (past the 60-second window)
      jest.setSystemTime(new Date('2026-01-01T00:01:01Z'));

      // Should be allowed again
      expect(limiter.check('openai').allowed).toBe(true);
    });

    it('should allow requests again after RPH window passes', () => {
      const limiter = new RateLimiter({ rpm: 10000, rph: 2 });

      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      expect(limiter.check('openai').allowed).toBe(true);
      expect(limiter.check('openai').allowed).toBe(true);
      expect(limiter.check('openai').allowed).toBe(false);

      // Advance time by 61 minutes (past the 60-minute window)
      jest.setSystemTime(new Date('2026-01-01T01:01:00Z'));

      expect(limiter.check('openai').allowed).toBe(true);
    });
  });
});
