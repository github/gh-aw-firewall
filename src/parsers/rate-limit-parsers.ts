import { type FlagValidationResult, type RateLimitConfig } from '../types';

/**
 * Builds a RateLimitConfig from parsed CLI options.
 */
export function buildRateLimitConfig(options: {
  rateLimit?: boolean;
  rateLimitRpm?: string;
  rateLimitRph?: string;
  rateLimitBytesPm?: string;
}): { config: RateLimitConfig } | { error: string } {
  // --no-rate-limit explicitly disables (even if other flags are set)
  if (options.rateLimit === false) {
    return { config: { enabled: false, rpm: 0, rph: 0, bytesPm: 0 } };
  }

  // Rate limiting is opt-in: disabled unless at least one --rate-limit-* flag is provided
  const hasAnyLimit = options.rateLimitRpm !== undefined ||
    options.rateLimitRph !== undefined ||
    options.rateLimitBytesPm !== undefined;

  if (!hasAnyLimit) {
    return { config: { enabled: false, rpm: 0, rph: 0, bytesPm: 0 } };
  }

  // Defaults for any limit not explicitly set
  const config: RateLimitConfig = { enabled: true, rpm: 600, rph: 10000, bytesPm: 52428800 };

  if (options.rateLimitRpm !== undefined) {
    const rpm = parseInt(options.rateLimitRpm, 10);
    if (isNaN(rpm) || rpm <= 0) return { error: '--rate-limit-rpm must be a positive integer' };
    config.rpm = rpm;
  }
  if (options.rateLimitRph !== undefined) {
    const rph = parseInt(options.rateLimitRph, 10);
    if (isNaN(rph) || rph <= 0) return { error: '--rate-limit-rph must be a positive integer' };
    config.rph = rph;
  }
  if (options.rateLimitBytesPm !== undefined) {
    const bytesPm = parseInt(options.rateLimitBytesPm, 10);
    if (isNaN(bytesPm) || bytesPm <= 0) return { error: '--rate-limit-bytes-pm must be a positive integer' };
    config.bytesPm = bytesPm;
  }

  return { config };
}

/**
 * Validates that rate-limit flags are not used without --enable-api-proxy.
 */
export function validateRateLimitFlags(enableApiProxy: boolean, options: {
  rateLimit?: boolean;
  rateLimitRpm?: string;
  rateLimitRph?: string;
  rateLimitBytesPm?: string;
}): FlagValidationResult {
  if (!enableApiProxy) {
    const hasRateLimitFlags = options.rateLimitRpm !== undefined ||
      options.rateLimitRph !== undefined ||
      options.rateLimitBytesPm !== undefined ||
      options.rateLimit === false;
    if (hasRateLimitFlags) {
      return { valid: false, error: 'Rate limit flags require --enable-api-proxy' };
    }
  }
  return { valid: true };
}

/**
 * Validates that --enable-token-steering is not used without --enable-api-proxy.
 */
export function validateEnableTokenSteeringFlag(enableApiProxy: boolean, enableTokenSteering: boolean): FlagValidationResult {
  if (enableTokenSteering && !enableApiProxy) {
    return { valid: false, error: '--enable-token-steering requires --enable-api-proxy' };
  }
  return { valid: true };
}
