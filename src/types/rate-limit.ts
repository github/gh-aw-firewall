/**
 * API proxy rate limit type.
 */

/**
 * Rate limiting configuration for the API proxy sidecar
 *
 * Controls per-provider rate limits enforced before requests reach upstream APIs.
 * All providers share the same limits but have independent counters.
 */
export interface RateLimitConfig {
  /** Whether rate limiting is enabled (default: true) */
  enabled: boolean;
  /** Max requests per minute per provider (default: 600 when enabled) */
  rpm: number;
  /** Max requests per hour per provider (default: 1000) */
  rph: number;
  /** Max request bytes per minute per provider (default: 52428800 = 50 MB) */
  bytesPm: number;
}
