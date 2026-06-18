import { buildRateLimitConfig, validateRateLimitFlags, validateEnableTokenSteeringFlag } from './rate-limit-parsers';

describe('buildRateLimitConfig', () => {
  it('returns disabled config when rateLimit is explicitly false', () => {
    const result = buildRateLimitConfig({ rateLimit: false });
    expect(result).toEqual({ config: { enabled: false, rpm: 0, rph: 0, bytesPm: 0 } });
  });

  it('returns disabled config when no rate-limit flags are provided', () => {
    const result = buildRateLimitConfig({});
    expect(result).toEqual({ config: { enabled: false, rpm: 0, rph: 0, bytesPm: 0 } });
  });

  it('returns enabled config with defaults when only rateLimitRpm is set', () => {
    const result = buildRateLimitConfig({ rateLimitRpm: '100' });
    expect(result).toEqual({ config: { enabled: true, rpm: 100, rph: 10000, bytesPm: 52428800 } });
  });

  it('returns enabled config with defaults when only rateLimitRph is set', () => {
    const result = buildRateLimitConfig({ rateLimitRph: '5000' });
    expect(result).toEqual({ config: { enabled: true, rpm: 600, rph: 5000, bytesPm: 52428800 } });
  });

  it('returns enabled config with defaults when only rateLimitBytesPm is set', () => {
    const result = buildRateLimitConfig({ rateLimitBytesPm: '1048576' });
    expect(result).toEqual({ config: { enabled: true, rpm: 600, rph: 10000, bytesPm: 1048576 } });
  });

  it('returns enabled config with all limits set', () => {
    const result = buildRateLimitConfig({ rateLimitRpm: '50', rateLimitRph: '2000', rateLimitBytesPm: '1024' });
    expect(result).toEqual({ config: { enabled: true, rpm: 50, rph: 2000, bytesPm: 1024 } });
  });

  it('returns error for non-integer rateLimitRpm', () => {
    const result = buildRateLimitConfig({ rateLimitRpm: 'abc' });
    expect(result).toEqual({ error: '--rate-limit-rpm must be a positive integer' });
  });

  it('returns error for zero rateLimitRpm', () => {
    const result = buildRateLimitConfig({ rateLimitRpm: '0' });
    expect(result).toEqual({ error: '--rate-limit-rpm must be a positive integer' });
  });

  it('returns error for negative rateLimitRpm', () => {
    const result = buildRateLimitConfig({ rateLimitRpm: '-1' });
    expect(result).toEqual({ error: '--rate-limit-rpm must be a positive integer' });
  });

  it('returns error for non-integer rateLimitRph', () => {
    const result = buildRateLimitConfig({ rateLimitRph: 'bad' });
    expect(result).toEqual({ error: '--rate-limit-rph must be a positive integer' });
  });

  it('returns error for zero rateLimitRph', () => {
    const result = buildRateLimitConfig({ rateLimitRph: '0' });
    expect(result).toEqual({ error: '--rate-limit-rph must be a positive integer' });
  });

  it('returns error for non-integer rateLimitBytesPm', () => {
    const result = buildRateLimitConfig({ rateLimitBytesPm: 'big' });
    expect(result).toEqual({ error: '--rate-limit-bytes-pm must be a positive integer' });
  });

  it('returns error for zero rateLimitBytesPm', () => {
    const result = buildRateLimitConfig({ rateLimitBytesPm: '0' });
    expect(result).toEqual({ error: '--rate-limit-bytes-pm must be a positive integer' });
  });

  it('ignores rateLimit: true when no specific limit flags are set', () => {
    const result = buildRateLimitConfig({ rateLimit: true });
    expect(result).toEqual({ config: { enabled: false, rpm: 0, rph: 0, bytesPm: 0 } });
  });

  it('rateLimit: false overrides any rate limit flags', () => {
    const result = buildRateLimitConfig({ rateLimit: false, rateLimitRpm: '100', rateLimitRph: '1000' });
    expect(result).toEqual({ config: { enabled: false, rpm: 0, rph: 0, bytesPm: 0 } });
  });
});

describe('validateRateLimitFlags', () => {
  it('returns valid when api proxy is enabled with rate limit flags', () => {
    const result = validateRateLimitFlags(true, { rateLimitRpm: '100' });
    expect(result).toEqual({ valid: true });
  });

  it('returns valid when no rate limit flags are set without api proxy', () => {
    const result = validateRateLimitFlags(false, {});
    expect(result).toEqual({ valid: true });
  });

  it('returns error when rateLimitRpm is set without api proxy', () => {
    const result = validateRateLimitFlags(false, { rateLimitRpm: '100' });
    expect(result).toEqual({ valid: false, error: 'Rate limit flags require --enable-api-proxy' });
  });

  it('returns error when rateLimitRph is set without api proxy', () => {
    const result = validateRateLimitFlags(false, { rateLimitRph: '1000' });
    expect(result).toEqual({ valid: false, error: 'Rate limit flags require --enable-api-proxy' });
  });

  it('returns error when rateLimitBytesPm is set without api proxy', () => {
    const result = validateRateLimitFlags(false, { rateLimitBytesPm: '1024' });
    expect(result).toEqual({ valid: false, error: 'Rate limit flags require --enable-api-proxy' });
  });

  it('returns error when rateLimit is false (--no-rate-limit) without api proxy', () => {
    const result = validateRateLimitFlags(false, { rateLimit: false });
    expect(result).toEqual({ valid: false, error: 'Rate limit flags require --enable-api-proxy' });
  });

  it('returns valid when api proxy is enabled with no-rate-limit', () => {
    const result = validateRateLimitFlags(true, { rateLimit: false });
    expect(result).toEqual({ valid: true });
  });
});

describe('validateEnableTokenSteeringFlag', () => {
  it('returns valid when token steering is disabled', () => {
    const result = validateEnableTokenSteeringFlag(false, false);
    expect(result).toEqual({ valid: true });
  });

  it('returns valid when both token steering and api proxy are enabled', () => {
    const result = validateEnableTokenSteeringFlag(true, true);
    expect(result).toEqual({ valid: true });
  });

  it('returns error when token steering is enabled without api proxy', () => {
    const result = validateEnableTokenSteeringFlag(false, true);
    expect(result).toEqual({ valid: false, error: '--enable-token-steering requires --enable-api-proxy' });
  });

  it('returns valid when api proxy is enabled but token steering is disabled', () => {
    const result = validateEnableTokenSteeringFlag(true, false);
    expect(result).toEqual({ valid: true });
  });
});
