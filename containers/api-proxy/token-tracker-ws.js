/**
 * WebSocket token usage tracker for AWF API Proxy.
 *
 * Claude Code CLI uses WebSocket streaming to the Anthropic API. The
 * api-proxy relays this as a raw socket pipe (tlsSocket ↔ clientSocket).
 * This module adds a non-blocking 'data' listener on the upstream socket
 * to parse WebSocket frames and extract token usage from JSON text messages.
 */

'use strict';

const { logRequest } = require('./logging');
const { extractUsageFromSseLine, normalizeUsage } = require('./token-parsers');
const {
  writeTokenUsage,
  buildTokenUsageRecord,
  incrementTokenMetrics,
  diag,
} = require('./token-persistence');
const { warnCacheReadRollupMismatch, mergeBudgetFields } = require('./token-tracker-shared');

/**
 * Parse WebSocket frames from a buffer (server→client direction, unmasked).
 *
 * Returns an object with:
 *   - messages: Array of decoded text frame payloads (strings)
 *   - consumed: Number of bytes consumed from the buffer
 *
 * Only handles non-fragmented text frames (FIN=1, opcode=1).
 * Other frame types (binary, ping, pong, close, continuation) are consumed
 * but their payloads are not returned.
 *
 * @param {Buffer} buf - Buffer containing WebSocket frame data
 * @returns {{ messages: string[], consumed: number }}
 */
function parseWebSocketFrames(buf) {
  const messages = [];
  let pos = 0;

  while (pos + 2 <= buf.length) {
    const firstByte = buf[pos];
    const secondByte = buf[pos + 1];
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0F;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7F;
    let headerSize = 2;

    if (payloadLength === 126) {
      if (pos + 4 > buf.length) break;
      payloadLength = buf.readUInt16BE(pos + 2);
      headerSize = 4;
    } else if (payloadLength === 127) {
      if (pos + 10 > buf.length) break;
      payloadLength = Number(buf.readBigUInt64BE(pos + 2));
      headerSize = 10;
    }

    if (masked) {
      if (pos + headerSize + 4 > buf.length) break;
      headerSize += 4; // masking key length
    }

    const frameEnd = pos + headerSize + payloadLength;
    if (frameEnd > buf.length) break;

    // Extract text frames (opcode 1) with FIN set
    if (opcode === 1 && fin) {
      const payloadStart = pos + headerSize;
      if (masked) {
        const maskKeyStart = payloadStart - 4;
        const maskingKey = buf.slice(maskKeyStart, maskKeyStart + 4);
        const maskedPayload = buf.slice(payloadStart, frameEnd);
        const unmasked = Buffer.allocUnsafe(payloadLength);
        for (let i = 0; i < payloadLength; i++) {
          unmasked[i] = maskedPayload[i] ^ maskingKey[i % 4];
        }
        messages.push(unmasked.toString('utf8'));
      } else {
        messages.push(buf.slice(payloadStart, frameEnd).toString('utf8'));
      }
    }

    pos = frameEnd;
  }

  return { messages, consumed: pos };
}

/**
 * Attach token usage tracking to a WebSocket upstream connection.
 *
 * Claude Code CLI uses WebSocket streaming to the Anthropic API. The
 * api-proxy relays this as a raw socket pipe (tlsSocket ↔ clientSocket).
 * This function adds a non-blocking 'data' listener on the upstream socket
 * to parse WebSocket frames and extract token usage from JSON text messages.
 *
 * The upstream stream starts with an HTTP 101 response header, followed by
 * WebSocket frames. This function skips the HTTP header before parsing frames.
 *
 * @param {import('tls').TLSSocket} upstreamSocket - Upstream TLS socket
 * @param {object} opts
 * @param {string} opts.requestId - Request ID for correlation
 * @param {string} opts.provider - Provider name (anthropic, copilot, etc.)
 * @param {string} opts.path - Request path
 * @param {number} opts.startTime - Request start time (Date.now())
 * @param {object} opts.metrics - Metrics module reference
 * @param {(normalizedUsage: object, model: string|null) => Record<string, number>|void} [opts.onUsage] - Optional callback invoked after normalized usage is extracted
 */
function trackWebSocketTokenUsage(upstreamSocket, opts) {
  const { requestId, provider, path: reqPath, startTime, metrics: metricsRef, onUsage } = opts;

  logRequest('debug', 'ws_token_track_start', {
    request_id: requestId,
    provider,
    path: reqPath,
  });
  diag('WS_TRACK_START', { request_id: requestId, provider, path: reqPath });

  let httpHeaderParsed = false;
  let buffer = Buffer.alloc(0);
  let totalBytes = 0;
  let headerBytes = 0;
  let streamingUsage = {};
  let streamingModel = null;
  let finalized = false;
  let frameCount = 0;
  let textMessageCount = 0;
  let observedCacheReadTokens = 0;

  // Max buffer to prevent unbounded memory growth (1 MB)
  const MAX_WS_BUFFER = 1 * 1024 * 1024;

  upstreamSocket.on('data', (chunk) => {
    totalBytes += chunk.length;
    buffer = Buffer.concat([buffer, chunk]);

    // Safety: drop buffer if it grows too large (malformed frames)
    if (buffer.length > MAX_WS_BUFFER) {
      buffer = Buffer.alloc(0);
      httpHeaderParsed = true; // skip header parsing
      return;
    }

    // Skip the HTTP 101 Switching Protocols response header
    if (!httpHeaderParsed) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return; // need more data for full header
      headerBytes = headerEnd + 4;
      buffer = buffer.slice(headerBytes);
      httpHeaderParsed = true;
    }

    // Parse any complete WebSocket frames
    const { messages, consumed } = parseWebSocketFrames(buffer);
    if (consumed > 0) {
      buffer = buffer.slice(consumed);
    }
    frameCount += messages.length;

    for (const text of messages) {
      textMessageCount++;
      const { usage, model } = extractUsageFromSseLine(text);
      if (model && !streamingModel) streamingModel = model;
      if (usage) {
        const normalizedLineUsage = normalizeUsage(usage);
        if (normalizedLineUsage && normalizedLineUsage.cache_read_tokens > observedCacheReadTokens) {
          observedCacheReadTokens = normalizedLineUsage.cache_read_tokens;
        }
        logRequest('debug', 'ws_token_usage_found', {
          request_id: requestId,
          provider,
          usage_keys: Object.keys(usage),
          model,
        });
        for (const [k, v] of Object.entries(usage)) {
          streamingUsage[k] = v;
        }
      }
    }
  });

  function doFinalize() {
    if (finalized) return;
    finalized = true;

    logRequest('debug', 'ws_token_track_end', {
      request_id: requestId,
      provider,
      total_bytes: totalBytes,
      frame_count: frameCount,
      text_message_count: textMessageCount,
      has_usage: Object.keys(streamingUsage).length > 0,
      usage_keys: Object.keys(streamingUsage),
      model: streamingModel,
    });
    diag('WS_TRACK_END', { request_id: requestId, provider, total_bytes: totalBytes, frame_count: frameCount, text_message_count: textMessageCount, has_usage: Object.keys(streamingUsage).length > 0, usage_keys: Object.keys(streamingUsage), model: streamingModel });

    if (Object.keys(streamingUsage).length === 0) return;

    const duration = Date.now() - startTime;
    const normalized = normalizeUsage(streamingUsage);
    if (!normalized) return;
    if (observedCacheReadTokens > 0 && normalized.cache_read_tokens === 0) {
      warnCacheReadRollupMismatch({ logRequest, diag, requestId, provider, model: streamingModel, observedCacheReadTokens, normalizedCacheReadTokens: normalized.cache_read_tokens, streaming: true, transport: 'websocket' });
    }
    let budgetResult;
    if (typeof onUsage === 'function') {
      try {
        budgetResult = onUsage(normalized, streamingModel || 'unknown');
      } catch {
        // best-effort callback
      }
    }

    incrementTokenMetrics(metricsRef, provider, normalized);

    const record = buildTokenUsageRecord(normalized, {
      requestId,
      provider,
      model: streamingModel,
      reqPath,
      status: 101,
      streaming: true,
      duration,
      responseBytes: totalBytes - headerBytes,
    });

    // Include effective token and AI credit budget fields when computed
    mergeBudgetFields(record, budgetResult);

    writeTokenUsage(record);

    logRequest('info', 'token_usage', {
      request_id: requestId,
      provider,
      model: streamingModel || 'unknown',
      input_tokens: normalized.input_tokens,
      output_tokens: normalized.output_tokens,
      cache_read_tokens: normalized.cache_read_tokens,
      cache_write_tokens: normalized.cache_write_tokens,
      streaming: true,
      transport: 'websocket',
    });
  }

  upstreamSocket.on('close', doFinalize);
  upstreamSocket.on('end', doFinalize);
}

module.exports = { parseWebSocketFrames, trackWebSocketTokenUsage };
