'use strict';

const { logRequest } = require('./logging');
const {
  parseSseDataLines,
  extractUsageFromSseLine,
  extractUsageFromJson,
  normalizeUsage,
} = require('./token-parsers');
const { auditTrack } = require('./token-persistence');

/**
 * Extract usage and model from accumulated tracking state.
 *
 * Encapsulates the streaming-vs-non-streaming branching so each path can be
 * tested independently. Mutates `state` in place for streaming (flushes the
 * remaining partial line and updates `state.observedCacheReadTokens`).
 *
 * @param {object} state - Mutable tracking state from initHttpState
 * @returns {{ usage: object|null, model: string|null }}
 */
function extractUsageFromTrackedState(state) {
  let usage = null;
  let model = null;

  if (state.streaming) {
    // Process any remaining partial line
    if (state.partialLine.trim()) {
      const dataLines = parseSseDataLines(state.partialLine);
      for (const line of dataLines) {
        const { usage: u, model: m } = extractUsageFromSseLine(line);
        if (m && !state.streamingModel) state.streamingModel = m;
        if (u) {
          const normalizedLineUsage = normalizeUsage(u);
          if (normalizedLineUsage && normalizedLineUsage.cache_read_tokens > state.observedCacheReadTokens) {
            state.observedCacheReadTokens = normalizedLineUsage.cache_read_tokens;
          }
          for (const [k, v] of Object.entries(u)) {
            state.streamingUsage[k] = v;
          }
        }
      }
    }

    if (Object.keys(state.streamingUsage).length > 0) {
      usage = state.streamingUsage;
      model = state.streamingModel;
    }
  } else if (!state.overflow && state.chunks.length > 0) {
    const body = Buffer.concat(state.chunks);
    const result = extractUsageFromJson(body);
    usage = result.usage;
    model = result.model;
    const normalizedSingleUsage = normalizeUsage(usage);
    if (normalizedSingleUsage && normalizedSingleUsage.cache_read_tokens > state.observedCacheReadTokens) {
      state.observedCacheReadTokens = normalizedSingleUsage.cache_read_tokens;
    }
  }

  return { usage, model };
}

function hasCompleteModelUsage(usage) {
  if (!usage || typeof usage !== 'object') return false;
  const hasInput = Number.isSafeInteger(usage.input_tokens) ||
    Number.isSafeInteger(usage.prompt_tokens);
  const hasOutput = Number.isSafeInteger(usage.output_tokens) ||
    Number.isSafeInteger(usage.completion_tokens);
  return hasInput && hasOutput;
}

function reportUnsupportedCursorAccounting(state, proxyRes, opts, reason = 'native_usage_contract_unverified', contentEncoding) {
  const { requestId, provider, path: reqPath } = opts;
  // The native Cursor stream is not an OpenAI completion just because it
  // uses the OpenAI upstream route. No verified native usage decoder exists.
  if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300
    || !state.streaming || typeof reqPath !== 'string'
    || reqPath.split('?')[0] !== '/agent.v1.AgentService/RunSSE') {
    return false;
  }

  const accounting = {
    provider,
    path: '/agent.v1.AgentService/RunSSE',
    status: proxyRes.statusCode,
    streaming: true,
    protocol: 'cursor-runsse',
    reason,
    ...(contentEncoding ? { content_encoding: contentEncoding } : {}),
  };
  auditTrack('TRACK_END', { rid: requestId, result: 'unsupported_accounting', ...accounting });
  logRequest('warn', 'token_track_unsupported_accounting', {
    request_id: requestId,
    ...accounting,
    message: 'Cursor native token usage could not be extracted: AWF has no verified native usage decoder. ' +
      'Token and AI-credit budgets cannot account for this response; missing usage does not mean zero cost.',
  });
  return true;
}

module.exports = {
  extractUsageFromTrackedState,
  hasCompleteModelUsage,
  reportUnsupportedCursorAccounting,
};
