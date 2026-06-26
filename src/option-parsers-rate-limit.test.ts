import {
  validateSkipPullWithBuildLocal,
  buildRateLimitConfig,
  validateRateLimitFlags,
  validateEnableTokenSteeringFlag,
} from './option-parsers';

describe('validateSkipPullWithBuildLocal', () => {
  it('should return valid when both flags are false', () => {
    const result = validateSkipPullWithBuildLocal(false, false);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when both flags are undefined', () => {
    const result = validateSkipPullWithBuildLocal(undefined, undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when only skipPull is true', () => {
    const result = validateSkipPullWithBuildLocal(true, false);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when only buildLocal is true', () => {
    const result = validateSkipPullWithBuildLocal(false, true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return invalid when both skipPull and buildLocal are true', () => {
    const result = validateSkipPullWithBuildLocal(true, true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('--skip-pull cannot be used with --build-local');
  });

  it('should return valid when skipPull is true and buildLocal is undefined', () => {
    const result = validateSkipPullWithBuildLocal(true, undefined);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return valid when skipPull is undefined and buildLocal is true', () => {
    const result = validateSkipPullWithBuildLocal(undefined, true);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('buildRateLimitConfig', () => {
  it('should return defaults when no options provided', () => {
    const r = buildRateLimitConfig({});
    expect('config' in r).toBe(true);
    if ('config' in r) { expect(r.config).toEqual({ enabled: false, rpm: 0, rph: 0, bytesPm: 0 }); }
  });
  it('should disable with rateLimit=false even if limits provided', () => {
    const r = buildRateLimitConfig({ rateLimit: false, rateLimitRpm: '30' });
    if ('config' in r) { expect(r.config.enabled).toBe(false); }
  });
  it('should enable and parse custom RPM', () => {
    const r = buildRateLimitConfig({ rateLimitRpm: '30' });
    if ('config' in r) { expect(r.config.enabled).toBe(true); expect(r.config.rpm).toBe(30); }
  });
  it('should enable and parse custom RPH', () => {
    const r = buildRateLimitConfig({ rateLimitRph: '500' });
    if ('config' in r) { expect(r.config.enabled).toBe(true); expect(r.config.rph).toBe(500); }
  });
  it('should enable and parse custom bytes-pm', () => {
    const r = buildRateLimitConfig({ rateLimitBytesPm: '1000000' });
    if ('config' in r) { expect(r.config.enabled).toBe(true); expect(r.config.bytesPm).toBe(1000000); }
  });
  it('should error on negative RPM', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRpm: '-5' })).toBe(true);
  });
  it('should error on zero RPM', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRpm: '0' })).toBe(true);
  });
  it('should error on non-integer RPM', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRpm: 'abc' })).toBe(true);
  });
  it('should error on negative RPH', () => {
    expect('error' in buildRateLimitConfig({ rateLimitRph: '-1' })).toBe(true);
  });
  it('should error on negative bytes-pm', () => {
    expect('error' in buildRateLimitConfig({ rateLimitBytesPm: '-100' })).toBe(true);
  });
  it('should ignore custom values when disabled via --no-rate-limit', () => {
    const r = buildRateLimitConfig({ rateLimit: false, rateLimitRpm: '999' });
    if ('config' in r) { expect(r.config.enabled).toBe(false); expect(r.config.rpm).toBe(0); }
  });
  it('should accept all custom values', () => {
    const r = buildRateLimitConfig({ rateLimitRpm: '10', rateLimitRph: '100', rateLimitBytesPm: '5000000' });
    if ('config' in r) { expect(r.config).toEqual({ enabled: true, rpm: 10, rph: 100, bytesPm: 5000000 }); }
  });
});

describe('validateRateLimitFlags', () => {
  it('should pass when api proxy is enabled', () => {
    expect(validateRateLimitFlags(true, { rateLimitRpm: '30' })).toEqual({ valid: true });
  });
  it('should pass when no rate limit flags used', () => {
    expect(validateRateLimitFlags(false, {})).toEqual({ valid: true });
  });
  it('should fail when --rate-limit-rpm used without api proxy', () => {
    const r = validateRateLimitFlags(false, { rateLimitRpm: '30' });
    expect(r.valid).toBe(false);
    expect(r.error).toContain('--enable-api-proxy');
  });
  it('should fail when --rate-limit-rph used without api proxy', () => {
    expect(validateRateLimitFlags(false, { rateLimitRph: '100' }).valid).toBe(false);
  });
  it('should fail when --rate-limit-bytes-pm used without api proxy', () => {
    expect(validateRateLimitFlags(false, { rateLimitBytesPm: '1000' }).valid).toBe(false);
  });
  it('should fail when --no-rate-limit used without api proxy', () => {
    expect(validateRateLimitFlags(false, { rateLimit: false }).valid).toBe(false);
  });
  it('should pass when all flags used with api proxy enabled', () => {
    const r = validateRateLimitFlags(true, { rateLimitRpm: '10', rateLimitRph: '100', rateLimit: false });
    expect(r.valid).toBe(true);
  });
});

describe('validateEnableTokenSteeringFlag', () => {
  it('should pass when both --enable-token-steering and --enable-api-proxy are set', () => {
    expect(validateEnableTokenSteeringFlag(true, true)).toEqual({ valid: true });
  });
  it('should pass when --enable-token-steering is false', () => {
    expect(validateEnableTokenSteeringFlag(false, false)).toEqual({ valid: true });
  });
  it('should pass when --enable-api-proxy is true and --enable-token-steering is false', () => {
    const enableApiProxy = true;
    const enableTokenSteering = false;
    expect(validateEnableTokenSteeringFlag(enableApiProxy, enableTokenSteering)).toEqual({ valid: true });
  });
  it('should fail when --enable-token-steering is true without --enable-api-proxy', () => {
    const r = validateEnableTokenSteeringFlag(false, true);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('--enable-api-proxy');
  });
});
