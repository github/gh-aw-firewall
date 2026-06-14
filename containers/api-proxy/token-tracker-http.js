/**
 * HTTP response token usage tracker for AWF API Proxy.
 *
 * Intercepts LLM API HTTP responses (both streaming SSE and non-streaming
 * JSON) to extract token usage data without adding latency to the client.
 *
 * Architecture:
 *   proxyRes (LLM response) → res (client)
 *        ├─ on('data'): buffer/inspect chunks for usage extraction
 *        └─ on('end'): finalize parsing → log to file + metrics
 *
 * For non-streaming responses: buffer the JSON body (up to MAX_BUFFER_SIZE),
 * then parse it on 'end' to extract usage fields.
 * For streaming (SSE) responses: scan each chunk for usage events as they
 * are received, accumulate usage from message_start / message_delta / final
 * data events, and log the aggregated result on 'end'.
 */

'use strict';

const { logRequest } = require('./logging');
const {
  isStreamingResponse,
  isCompressedResponse,
  createDecompressor,
  parseSseDataLines,
  extractUsageFromSseLine,
  extractUsageFromJson,
  normalizeUsage,
} = require('./token-parsers');
const {
  writeTokenUsage,
  buildTokenUsageRecord,
  incrementTokenMetrics,
  diag,
} = require('./token-persistence');
const { warnCacheReadRollupMismatch, mergeBudgetFields } = require('./token-tracker-shared');

// Max response body to buffer for non-streaming usage extraction (5 MB).
// Responses larger than this are still forwarded but usage is not extracted.
const MAX_BUFFER_SIZE = 5 * 1024 * 1024;

/**
 * Initialize mutable tracking state for an HTTP response.
 *
 * @param {object} flags
 * @param {boolean} flags.streaming
 * @param {boolean} flags.compressed
 * @param {string} flags.contentType
 * @param {string} flags.contentEncoding
 * @returns {object}
 */
function initHttpState({ streaming, compressed, contentType, contentEncoding }) {
  return {
    streaming,
    compressed,
    contentType,
    contentEncoding,
    chunks: [],
    totalBytes: 0,
    bufferedBytes: 0,
    overflow: false,
    streamingUsage: {},
    streamingModel: null,
    observedCacheReadTokens: 0,
    partialLine: '',
  };
}

/**
 * Create a decoded-chunk handler that accumulates SSE events or buffers JSON.
 *
 * Returns a function that accepts a decoded text string and mutates `state`
 * in place — no closure over outer scope needed.
 *
 * @param {object} state - Mutable tracking state (returned by initHttpState)
 * @param {object} context
 * @param {string} context.requestId
 * @param {string} context.provider
 * @returns {(text: string) => void}
 */
function createChunkHandler(state, { requestId, provider }) {
  return function handleDecodedChunk(text) {
    if (state.streaming) {
      const combined = state.partialLine + text;
      const lastNewline = combined.lastIndexOf('\n');
      if (lastNewline >= 0) {
        const complete = combined.slice(0, lastNewline);
        state.partialLine = combined.slice(lastNewline + 1);

        const dataLines = parseSseDataLines(complete);
        for (const line of dataLines) {
          const { usage, model } = extractUsageFromSseLine(line);
          if (model && !state.streamingModel) state.streamingModel = model;
          if (usage) {
            const normalizedLineUsage = normalizeUsage(usage);
            if (normalizedLineUsage && normalizedLineUsage.cache_read_tokens > state.observedCacheReadTokens) {
              state.observedCacheReadTokens = normalizedLineUsage.cache_read_tokens;
            }
            for (const [k, v] of Object.entries(usage)) {
              state.streamingUsage[k] = v;
            }
          }
        }
      } else {
        state.partialLine = combined;
      }
    } else if (!state.overflow) {
      const chunkBuffer = Buffer.from(text, 'utf8');
      if (state.bufferedBytes + chunkBuffer.length > MAX_BUFFER_SIZE) {
        const attemptedBytes = state.bufferedBytes + chunkBuffer.length;
        state.overflow = true;
        state.chunks.length = 0;
        state.bufferedBytes = 0;
        diag('HTTP_TRACK_BUFFER_OVERFLOW', { request_id: requestId, provider, buffered_bytes: attemptedBytes });
        return;
      }
      state.chunks.push(chunkBuffer);
      state.bufferedBytes += chunkBuffer.length;
    }
  };
}

/**
 * Wire data/end event listeners onto proxyRes and optional decompressor.
 *
 * @param {object} proxyRes - Upstream response stream
 * @param {object|null} decompressor - Zlib decompressor stream, or null
 * @param {object} state - Mutable tracking state
 * @param {(text: string) => void} onChunk - Decoded-chunk callback
 * @param {() => void} onFinalize - Finalization callback
 */
function wireListeners(proxyRes, decompressor, state, onChunk, onFinalize) {
  if (decompressor) {
    // Feed decompressed text to our parser
    decompressor.on('data', (decompressedChunk) => {
      onChunk(decompressedChunk.toString('utf8'));
    });

    // Feed raw compressed bytes into the decompressor
    proxyRes.on('data', (chunk) => {
      state.totalBytes += chunk.length;
      try { decompressor.write(chunk); } catch { /* ignore write errors */ }
    });

    proxyRes.on('end', () => {
      try { decompressor.end(); } catch { /* ignore */ }
    });

    // Finalize on decompressor end
    decompressor.on('end', onFinalize);
  } else {
    // No compression — parse raw chunks directly
    proxyRes.on('data', (chunk) => {
      state.totalBytes += chunk.length;
      onChunk(chunk.toString('utf8'));
    });

    proxyRes.on('end', onFinalize);
  }
}

/**
 * Finalize token tracking for an HTTP response.
 *
 * Parses accumulated SSE events or buffered JSON, normalizes usage,
 * calls optional callbacks, updates metrics, and writes the log record.
 * Accepts explicit state instead of relying on a closure, making it
 * independently unit-testable.
 *
 * @param {object} state - Mutable tracking state from initHttpState
 * @param {object} proxyRes - Upstream response (only statusCode is read)
 * @param {object} opts - Original options passed to trackTokenUsage
 */
function finalizeHttpTracking(state, proxyRes, opts) {
  const { requestId, provider, path: reqPath, startTime, metrics: metricsRef, billingInfo, initiatorSent, requestModel, onUsage, onSpanEnd } = opts;
  const { streaming, compressed, contentEncoding } = state;

  // Only process successful responses (2xx)
  if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
    logRequest('debug', 'token_track_skip_status', {
      request_id: requestId,
      provider,
      status: proxyRes.statusCode,
    });
    diag('HTTP_TRACK_SKIP_STATUS', { request_id: requestId, provider, status: proxyRes.statusCode });
    if (typeof onSpanEnd === 'function') onSpanEnd(proxyRes.statusCode);
    return;
  }

  const duration = Date.now() - startTime;
  let usage = null;
  let model = null;
  let budgetResult;

  if (streaming) {
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

  logRequest('debug', 'token_track_end', {
    request_id: requestId,
    provider,
    streaming,
    total_bytes: state.totalBytes,
    overflow: state.overflow,
    has_usage: !!usage,
    usage_keys: usage ? Object.keys(usage) : [],
    model,
    compressed,
  });
  diag('HTTP_TRACK_END', { request_id: requestId, provider, streaming, total_bytes: state.totalBytes, overflow: state.overflow, has_usage: !!usage, usage_keys: usage ? Object.keys(usage) : [], model, compressed, content_encoding: contentEncoding });

  const normalized = normalizeUsage(usage);
  if (!normalized) {
    if (typeof onSpanEnd === 'function') onSpanEnd(proxyRes.statusCode);
    return;
  }
  if (state.observedCacheReadTokens > 0 && normalized.cache_read_tokens === 0) {
    warnCacheReadRollupMismatch({ logRequest, diag, requestId, provider, model, observedCacheReadTokens: state.observedCacheReadTokens, normalizedCacheReadTokens: normalized.cache_read_tokens, streaming });
  }
  if (typeof onUsage === 'function') {
    try {
      budgetResult = onUsage(normalized, model || requestModel || provider || 'unknown');
    } catch {
      // best-effort callback
    }
  }

  // Update metrics
  incrementTokenMetrics(metricsRef, provider, normalized);

  // Build log record
  const record = buildTokenUsageRecord(normalized, {
    requestId,
    provider,
    model: model || requestModel || provider,
    reqPath,
    status: proxyRes.statusCode,
    streaming,
    duration,
    responseBytes: state.totalBytes,
  });

  // Include billing/quota info when available (Copilot PRU tracking)
  if (initiatorSent) record.x_initiator = initiatorSent;
  if (billingInfo) record.billing = billingInfo;

  // Include effective token and AI credit budget fields when computed
  mergeBudgetFields(record, budgetResult);

  // Write to JSONL log file
  writeTokenUsage(record);

  // Log summary to stdout
  logRequest('info', 'token_usage', {
    request_id: requestId,
    provider,
    model: model || requestModel || provider || 'unknown',
    input_tokens: normalized.input_tokens,
    output_tokens: normalized.output_tokens,
    cache_read_tokens: normalized.cache_read_tokens,
    cache_write_tokens: normalized.cache_write_tokens,
    streaming,
  });

  if (typeof onSpanEnd === 'function') onSpanEnd(proxyRes.statusCode);
}

/**
 * Attach token usage tracking to an upstream response.
 *
 * This function listens on the proxyRes 'data' and 'end' events to extract
 * token usage. It does NOT modify the response stream — the caller still
 * does proxyRes.pipe(res) as before.
 *
 * If the response is gzip/deflate compressed (common with Anthropic API),
 * we decompress a copy of the data for parsing while the compressed bytes
 * still flow to the client unchanged.
 *
 * @param {http.IncomingMessage} proxyRes - Upstream response
 * @param {object} opts
 * @param {string} opts.requestId - Request ID for correlation
 * @param {string} opts.provider - Provider name (openai, anthropic, copilot, gemini)
 * @param {string} opts.path - Request path
 * @param {number} opts.startTime - Request start time (Date.now())
 * @param {object} opts.metrics - Metrics module reference
 * @param {object|null} opts.billingInfo - Extracted billing/quota headers from response
 * @param {string|null} opts.initiatorSent - X-Initiator value sent on the request
 * @param {string|null} [opts.requestModel] - Model extracted from the request body, used as fallback when response omits model
 * @param {(normalizedUsage: object, model: string|null) => Record<string, number>|void} [opts.onUsage] - Optional callback invoked after normalized usage is extracted
 * @param {(statusCode: number) => void} [opts.onSpanEnd] - Optional callback invoked at end of finalizeHttpTracking() to signal span completion
 */
function trackTokenUsage(proxyRes, opts) {
  const { requestId, provider, path: reqPath } = opts;
  const streaming = isStreamingResponse(proxyRes.headers);
  const contentType = proxyRes.headers['content-type'] || '(none)';
  const contentEncoding = proxyRes.headers['content-encoding'] || '(none)';
  const compressed = isCompressedResponse(proxyRes.headers);

  logRequest('debug', 'token_track_start', {
    request_id: requestId,
    provider,
    path: reqPath,
    streaming,
    content_type: contentType,
    content_encoding: contentEncoding,
    status: proxyRes.statusCode,
  });
  diag('HTTP_TRACK_START', { request_id: requestId, provider, path: reqPath, streaming, content_type: contentType, content_encoding: contentEncoding, status: proxyRes.statusCode });

  const state = initHttpState({ streaming, compressed, contentType, contentEncoding });

  // If the response is compressed, create a decompressor.
  // We feed raw chunks into it and listen on the decompressed output.
  // The raw proxyRes still flows to the client unchanged via pipe().
  let decompressor = null;
  if (compressed) {
    decompressor = createDecompressor(proxyRes.headers);
    if (decompressor) {
      decompressor.on('error', (err) => {
        diag('DECOMPRESS_ERROR', { request_id: requestId, error: err.message });
      });
    }
  }

  const onChunk = createChunkHandler(state, { requestId, provider });
  const onFinalize = () => finalizeHttpTracking(state, proxyRes, opts);
  wireListeners(proxyRes, decompressor, state, onChunk, onFinalize);
}

module.exports = { trackTokenUsage, createChunkHandler, finalizeHttpTracking };
