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
   * Maximum total AI credits allowed for the current AWF run.
   *
   * When set, the API proxy tracks AI credits across responses using
   * model-specific pricing and rejects additional requests once this limit is
   * reached.
   */
  maxAiCredits?: number;

  /**
   * Default AI credits pricing for models not in the built-in pricing table.
   *
   * When maxAiCredits is active and the api-proxy encounters a model not in its
   * pricing table, it uses these rates as a fallback. If not set and the model
   * is unrecognized, the request is rejected with HTTP 400 (type:
   * unknown_model_ai_credits) to prevent unaccounted spending.
   *
   * Rates are per 1 million tokens in dollars.
   *
   * @example { input: 3.0, output: 15.0, cachedInput: 0.3, cacheWrite: 3.75 }
   */
  defaultAiCreditsPricing?: { input: number; output: number; cachedInput?: number; cacheWrite?: number | null };

  /**
   * Model-specific multipliers used by effective token accounting.
   *
   * Keys are model names and values are positive numeric multipliers.
   * Resolution uses exact match first, then a hyphen-suffix prefix match
   * (for example `claude-opus-4.7` matches `claude-opus-4.7-20260501`).
   * Models that still do not match use `effectiveTokenDefaultModelMultiplier`
   * when set, otherwise the highest configured multiplier.
   */
  effectiveTokenModelMultipliers?: Record<string, number>;

  /**
   * Default multiplier used for models not present in
   * `effectiveTokenModelMultipliers`.
   */
  effectiveTokenDefaultModelMultiplier?: number;

  /**
   * Maximum allowed model multiplier for the current AWF run.
   *
   * When set, the API proxy resolves each incoming request's model against the
   * configured `effectiveTokenModelMultipliers` (and `effectiveTokenDefaultModelMultiplier`)
   * and rejects any request whose resolved multiplier exceeds this cap with
   * HTTP 400 and error type `model_multiplier_cap_exceeded`.
   *
   * This is a guardrail against unexpected pricing spikes from model routing
   * changes — for example, if an alias or fallback resolves to a much more
   * expensive model than intended.
   *
   * @example
   * // Allow models with multiplier ≤ 4 (e.g. claude-sonnet) but block
   * // models with multiplier > 4 (e.g. claude-opus at 27×).
   * maxModelMultiplierCap: 4
   */
  maxModelMultiplierCap?: number;

  /**
   * Maximum number of LLM invocations allowed for the current AWF run.
   *
   * When set, the API proxy counts each successful upstream LLM response and
   * rejects additional requests once this absolute limit is reached.
   */
  maxRuns?: number;

  /**
   * Maximum number of upstream permission-denied (401/403) responses allowed
   * for the current AWF run.
   *
   * When set, the API proxy counts upstream 401/403 responses and rejects
   * further requests once this threshold is reached, stopping the run early
   * to avoid wasting tokens on misconfigured or missing API credentials.
   * When unset, the guard is disabled and permission errors are not counted.
   */
  maxPermissionDenied?: number;

  /**
   * Maximum number of consecutive cache misses allowed for the current AWF run.
   *
   * A cache miss is counted only when a successful response reports
   * `input_tokens > 0` and `cache_read_tokens === 0`. Responses with
   * `cache_read_tokens > 0` reset the miss streak to zero.
   */
  maxCacheMisses?: number;

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
