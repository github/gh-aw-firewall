'use strict';

/**
 * Builds the array of guard descriptors shared by the HTTP and WebSocket proxy
 * paths.  Centralising the list here ensures that every guard added to the HTTP
 * path is automatically enforced for WebSocket connections too.
 *
 * Each descriptor has:
 *   - block          — current block-state returned by the guard's getter
 *   - isBlocked      — predicate: returns true when the request should be halted
 *   - statusCode     — HTTP status code to send when blocked
 *   - eventName      — event name used for log / telemetry
 *   - buildError     — function(block) → error body object (JSON-serialisable)
 *   - buildLogFields — function(block) → extra log-fields object
 *
 * Model-specific guards (model_multiplier_cap, retired_model,
 * unknown_model_ai_credits) are only included when `model` is truthy (non-null
 * and non-empty string).  For WebSocket upgrade requests there is no JSON
 * request body, so callers should pass null and the model guards are skipped.
 *
 * @param {object} deps - Guard state getter and error-builder functions.
 * @param {Function} deps.getEffectiveTokenBlockState
 * @param {Function} deps.buildEffectiveTokenLimitError
 * @param {Function} deps.getMaxRunsBlockState
 * @param {Function} deps.buildMaxRunsExceededError
 * @param {Function} deps.getMaxCacheMissesBlockState
 * @param {Function} deps.buildMaxCacheMissesExceededError
 * @param {Function} deps.getPermissionDeniedBlockState
 * @param {Function} deps.buildPermissionDeniedLimitError
 * @param {Function} deps.getAiCreditsBlockState
 * @param {Function} deps.buildAiCreditsLimitError
 * @param {Function} deps.getModelMultiplierCapBlockState
 * @param {Function} deps.buildModelMultiplierCapError
 * @param {Function} deps.getRetiredModelBlockState
 * @param {Function} deps.buildRetiredModelError
 * @param {Function} deps.checkUnknownModelRejection
 * @param {Function} deps.getModelPolicyBlockState
 * @param {Function} deps.buildModelPolicyError
 * @param {string|null} model - Model name extracted from the request, or null
 *   to skip model-specific guards.
 * @returns {Array<object>} Array of guard descriptor objects.
 */
function buildCommonGuardChecks(deps, model) {
  const {
    getEffectiveTokenBlockState,
    buildEffectiveTokenLimitError,
    getMaxRunsBlockState,
    buildMaxRunsExceededError,
    getMaxCacheMissesBlockState,
    buildMaxCacheMissesExceededError,
    getPermissionDeniedBlockState,
    buildPermissionDeniedLimitError,
    getAiCreditsBlockState,
    buildAiCreditsLimitError,
    getModelMultiplierCapBlockState,
    buildModelMultiplierCapError,
    getRetiredModelBlockState,
    buildRetiredModelError,
    checkUnknownModelRejection,
    getModelPolicyBlockState,
    buildModelPolicyError,
  } = deps;

  return [
    {
      block: getEffectiveTokenBlockState(),
      isBlocked: block => block && block.maxExceeded,
      // Terminal hard cap: returning 429 would make LLM SDK clients treat this
      // as a transient rate-limit and retry-storm against a limit that never
      // recovers, burning the budget until the step times out. 403 is
      // non-retryable, so the agent stops cleanly.
      statusCode: 403,
      eventName: 'effective_tokens_limit_exceeded',
      buildError: buildEffectiveTokenLimitError,
      buildLogFields: block => ({
        total_effective_tokens: block.totalEffectiveTokens,
        max_effective_tokens: block.maxEffectiveTokens,
      }),
    },
    {
      block: getMaxRunsBlockState(),
      isBlocked: block => block && block.maxExceeded,
      // Terminal hard cap: 429 signals the agent has exhausted its allowed
      // turns.  Unlike transient rate-limits, the Retry-After is absent so
      // well-behaved clients won't retry indefinitely.
      statusCode: 429,
      eventName: 'max_runs_exceeded',
      buildError: buildMaxRunsExceededError,
      buildLogFields: block => ({
        invocation_count: block.invocationCount,
        max_runs: block.maxRuns,
      }),
    },
    {
      block: getMaxCacheMissesBlockState(),
      isBlocked: block => block && block.maxExceeded,
      // Terminal hard cap — non-retryable (see effective-tokens guard above).
      statusCode: 403,
      eventName: 'max_cache_misses_exceeded',
      buildError: buildMaxCacheMissesExceededError,
      buildLogFields: block => ({
        consecutive_cache_misses: block.consecutiveCacheMisses,
        max_cache_misses: block.maxCacheMisses,
      }),
    },
    {
      block: getPermissionDeniedBlockState(),
      isBlocked: block => block && block.maxExceeded,
      statusCode: 403,
      eventName: 'permission_denied_limit_exceeded',
      buildError: buildPermissionDeniedLimitError,
      buildLogFields: block => ({
        denied_count: block.deniedCount,
        max_permission_denied: block.maxPermissionDenied,
      }),
    },
    {
      block: getAiCreditsBlockState(),
      isBlocked: block => block && block.maxExceeded,
      // Terminal hard cap — non-retryable (see effective-tokens guard above).
      statusCode: 403,
      eventName: 'ai_credits_limit_exceeded',
      buildError: buildAiCreditsLimitError,
      buildLogFields: block => ({
        total_ai_credits: block.totalAiCredits,
        max_ai_credits: block.maxAiCredits,
        hard_cap: block.hardCap === true,
      }),
    },
    // Model-specific guards — only active when a model was identified in the request.
    ...(model ? [
      {
        block: getModelMultiplierCapBlockState(model),
        isBlocked: block => !!block,
        statusCode: 400,
        eventName: 'model_multiplier_cap_exceeded',
        buildError: buildModelMultiplierCapError,
        buildLogFields: block => ({
          model: block.model,
          model_multiplier: block.multiplier,
          max_model_multiplier: block.maxModelMultiplier,
        }),
      },
      {
        block: getRetiredModelBlockState(model),
        isBlocked: block => !!block,
        statusCode: 400,
        eventName: 'retired_model',
        buildError: buildRetiredModelError,
        buildLogFields: block => ({
          model: block.model,
          suggestion: block.suggestion,
        }),
      },
      {
        block: getModelPolicyBlockState(model),
        isBlocked: block => !!block,
        statusCode: 403,
        eventName: 'model_policy_violation',
        buildError: buildModelPolicyError,
        buildLogFields: block => ({
          model: block.model,
          reason: block.reason,
        }),
      },
      {
        block: checkUnknownModelRejection(model),
        isBlocked: block => !!block,
        statusCode: 400,
        eventName: 'unknown_model_ai_credits',
        buildError: block => block.error,
        buildLogFields: block => ({
          model: block.model,
        }),
      },
    ] : []),
  ];
}

module.exports = { buildCommonGuardChecks };
