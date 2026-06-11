'use strict';

/**
 * Warn when observed streaming cache-read tokens don't match the final rollup.
 * This indicates the provider's final usage object dropped cache_read_tokens
 * that were present in incremental streaming deltas.
 */
function warnCacheReadRollupMismatch({ logRequest, diag, requestId, provider, model, observedCacheReadTokens, normalizedCacheReadTokens, streaming, transport }) {
  if (observedCacheReadTokens > 0 && normalizedCacheReadTokens === 0) {
    const context = {
      request_id: requestId,
      provider,
      model: model || 'unknown',
      observed_cache_read_tokens: observedCacheReadTokens,
      rolled_up_cache_read_tokens: normalizedCacheReadTokens,
      streaming,
      ...(transport ? { transport } : {}),
    };
    logRequest('warn', 'token_cache_read_rollup_mismatch', context);
    diag('CACHE_READ_ROLLUP_MISMATCH', context);
  }
}

/**
 * Merge budget result fields (effective tokens, AI credits, model multiplier)
 * onto a token usage log record.
 */
function mergeBudgetFields(record, budgetResult) {
  if (!budgetResult) return;
  if (budgetResult.effective_tokens_this_response != null) {
    record.effective_tokens_this_response = budgetResult.effective_tokens_this_response;
  }
  if (budgetResult.effective_tokens_total != null) {
    record.effective_tokens_total = budgetResult.effective_tokens_total;
  }
  if (budgetResult.model_multiplier != null) {
    record.model_multiplier = budgetResult.model_multiplier;
  }
  if (budgetResult.ai_credits_this_response != null) {
    record.ai_credits_this_response = budgetResult.ai_credits_this_response;
  }
  if (budgetResult.ai_credits_total != null) {
    record.ai_credits_total = budgetResult.ai_credits_total;
  }
}

module.exports = {
  warnCacheReadRollupMismatch,
  mergeBudgetFields,
};
