/**
 * Rate limiting configuration options.
 */

import type { RateLimitConfig } from './rate-limit';

export interface RateLimitOptions {
  /**
   * Rate limiting configuration for the API proxy sidecar
   *
   * Controls per-provider rate limits enforced by the API proxy before
   * requests are forwarded to upstream LLM APIs.
   *
   * @see RateLimitConfig
   */
  rateLimitConfig?: RateLimitConfig;

  /**
   * Maximum total effective tokens allowed for the current AWF run.
   *
   * When set, the API proxy tracks effective token usage across requests and
   * rejects additional requests once this limit is reached.
   */
  maxEffectiveTokens?: number;

  /**
   * Model-specific multipliers used by effective token accounting.
   *
   * Keys are model names and values are positive numeric multipliers.
   * Models not present in this map default to multiplier 1.0.
   */
  effectiveTokenModelMultipliers?: Record<string, number>;

  /**
   * Maximum number of LLM invocations allowed for the current AWF run.
   *
   * When set, the API proxy counts each successful upstream LLM response and
   * rejects additional requests once this absolute limit is reached.
   */
  maxRuns?: number;

  /**
   * Enable effective token budget steering warnings in the API proxy
   *
   * When true, the api-proxy injects budget-warning system messages into outgoing
   * LLM requests when cumulative usage crosses the configured thresholds (80%, 90%,
   * 95%, 99%). This nudges the agent to wrap up before hitting the hard limit.
   * When false (the default), no steering messages are injected.
   *
   * Requires `maxEffectiveTokens` to be set. Has no effect without a configured
   * effective token budget.
   *
   * @default false
   */
  enableTokenSteering?: boolean;
}
