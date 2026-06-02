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
