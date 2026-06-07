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

// Max response body to buffer for non-streaming usage extraction (5 MB).
// Responses larger than this are still forwarded but usage is not extracted.
const MAX_BUFFER_SIZE = 5 * 1024 * 1024;

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
 * @param {(normalizedUsage: object, model: string|null) => void} [opts.onUsage] - Optional callback invoked after normalized usage is extracted
 * @param {(statusCode: number) => void} [opts.onSpanEnd] - Optional callback invoked at end of finalizeTracking() to signal span completion
 */
function trackTokenUsage(proxyRes, opts) {
  const { requestId, provider, path: reqPath, startTime, metrics: metricsRef, billingInfo, initiatorSent, onUsage, onSpanEnd } = opts;
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

  // Accumulate response body for usage extraction
  const chunks = [];
  let totalBytes = 0;
  let bufferedBytes = 0;
  let overflow = false;

  // For streaming: accumulate usage across SSE events
  let streamingUsage = {};
  let streamingModel = null;
  let observedCacheReadTokens = 0;
  let partialLine = '';

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

  // The source for text parsing: decompressor output (if compressed) or raw chunks
  function handleDecodedChunk(text) {
    if (streaming) {
      const combined = partialLine + text;
      const lastNewline = combined.lastIndexOf('\n');
      if (lastNewline >= 0) {
        const complete = combined.slice(0, lastNewline);
        partialLine = combined.slice(lastNewline + 1);

        const dataLines = parseSseDataLines(complete);
        for (const line of dataLines) {
          const { usage, model } = extractUsageFromSseLine(line);
          if (model && !streamingModel) streamingModel = model;
          if (usage) {
            const normalizedLineUsage = normalizeUsage(usage);
            if (normalizedLineUsage && normalizedLineUsage.cache_read_tokens > observedCacheReadTokens) {
              observedCacheReadTokens = normalizedLineUsage.cache_read_tokens;
            }
            for (const [k, v] of Object.entries(usage)) {
              streamingUsage[k] = v;
            }
          }
        }
      } else {
        partialLine = combined;
      }
    } else if (!overflow) {
      const chunkBuffer = Buffer.from(text, 'utf8');
      if (bufferedBytes + chunkBuffer.length > MAX_BUFFER_SIZE) {
        const attemptedBytes = bufferedBytes + chunkBuffer.length;
        overflow = true;
        chunks.length = 0;
        bufferedBytes = 0;
        diag('HTTP_TRACK_BUFFER_OVERFLOW', { request_id: requestId, provider, buffered_bytes: attemptedBytes });
        return;
      }
      chunks.push(chunkBuffer);
      bufferedBytes += chunkBuffer.length;
    }
  }

  if (decompressor) {
    // Feed decompressed text to our parser
    decompressor.on('data', (decompressedChunk) => {
      handleDecodedChunk(decompressedChunk.toString('utf8'));
    });

    // Feed raw compressed bytes into the decompressor
    proxyRes.on('data', (chunk) => {
      totalBytes += chunk.length;
      try { decompressor.write(chunk); } catch { /* ignore write errors */ }
    });

    proxyRes.on('end', () => {
      try { decompressor.end(); } catch { /* ignore */ }
    });

    // Finalize on decompressor end
    decompressor.on('end', () => {
      finalizeTracking();
    });
  } else {
    // No compression — parse raw chunks directly
    proxyRes.on('data', (chunk) => {
      totalBytes += chunk.length;
      handleDecodedChunk(chunk.toString('utf8'));
    });

    proxyRes.on('end', () => {
      finalizeTracking();
    });
  }

  function finalizeTracking() {
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
      if (partialLine.trim()) {
        const dataLines = parseSseDataLines(partialLine);
        for (const line of dataLines) {
          const { usage: u, model: m } = extractUsageFromSseLine(line);
          if (m && !streamingModel) streamingModel = m;
          if (u) {
            const normalizedLineUsage = normalizeUsage(u);
            if (normalizedLineUsage && normalizedLineUsage.cache_read_tokens > observedCacheReadTokens) {
              observedCacheReadTokens = normalizedLineUsage.cache_read_tokens;
            }
            for (const [k, v] of Object.entries(u)) {
              streamingUsage[k] = v;
            }
          }
        }
      }

      if (Object.keys(streamingUsage).length > 0) {
        usage = streamingUsage;
        model = streamingModel;
      }
    } else if (!overflow && chunks.length > 0) {
      const body = Buffer.concat(chunks);
      const result = extractUsageFromJson(body);
      usage = result.usage;
      model = result.model;
      const normalizedSingleUsage = normalizeUsage(usage);
      if (normalizedSingleUsage && normalizedSingleUsage.cache_read_tokens > observedCacheReadTokens) {
        observedCacheReadTokens = normalizedSingleUsage.cache_read_tokens;
      }
    }

    logRequest('debug', 'token_track_end', {
      request_id: requestId,
      provider,
      streaming,
      total_bytes: totalBytes,
      overflow,
      has_usage: !!usage,
      usage_keys: usage ? Object.keys(usage) : [],
      model,
      compressed,
    });
    diag('HTTP_TRACK_END', { request_id: requestId, provider, streaming, total_bytes: totalBytes, overflow, has_usage: !!usage, usage_keys: usage ? Object.keys(usage) : [], model, compressed, content_encoding: contentEncoding });

    const normalized = normalizeUsage(usage);
    if (!normalized) {
      if (typeof onSpanEnd === 'function') onSpanEnd(proxyRes.statusCode);
      return;
    }
    if (observedCacheReadTokens > 0 && normalized.cache_read_tokens === 0) {
      logRequest('warn', 'token_cache_read_rollup_mismatch', {
        request_id: requestId,
        provider,
        model: model || 'unknown',
        observed_cache_read_tokens: observedCacheReadTokens,
        rolled_up_cache_read_tokens: normalized.cache_read_tokens,
        streaming,
      });
      diag('CACHE_READ_ROLLUP_MISMATCH', {
        request_id: requestId,
        provider,
        model: model || 'unknown',
        observed_cache_read_tokens: observedCacheReadTokens,
        rolled_up_cache_read_tokens: normalized.cache_read_tokens,
        streaming,
      });
    }
    if (typeof onUsage === 'function') {
      try {
        budgetResult = onUsage(normalized, model || 'unknown');
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
      model,
      reqPath,
      status: proxyRes.statusCode,
      streaming,
      duration,
      responseBytes: totalBytes,
    });

    // Include billing/quota info when available (Copilot PRU tracking)
    if (initiatorSent) record.x_initiator = initiatorSent;
    if (billingInfo) record.billing = billingInfo;

    // Include effective token and AI credit budget fields when computed
    if (budgetResult) {
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

    // Write to JSONL log file
    writeTokenUsage(record);

    // Log summary to stdout
    logRequest('info', 'token_usage', {
      request_id: requestId,
      provider,
      model: model || 'unknown',
      input_tokens: normalized.input_tokens,
      output_tokens: normalized.output_tokens,
      cache_read_tokens: normalized.cache_read_tokens,
      cache_write_tokens: normalized.cache_write_tokens,
      streaming,
    });

    if (typeof onSpanEnd === 'function') onSpanEnd(proxyRes.statusCode);
  }
}

module.exports = { trackTokenUsage };
