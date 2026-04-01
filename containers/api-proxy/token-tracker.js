/**
 * Token usage tracking for AWF API Proxy.
 *
 * Intercepts LLM API responses (both streaming SSE and non-streaming JSON)
 * to extract token usage data without adding latency to the client.
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
 *
 * Zero external dependencies — uses Node.js built-in streams and fs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { logRequest } = require('./logging');

// Max response body to buffer for non-streaming usage extraction (5 MB).
// Responses larger than this are still forwarded but usage is not extracted.
const MAX_BUFFER_SIZE = 5 * 1024 * 1024;

// Token usage log file path (inside the mounted log volume)
const TOKEN_LOG_DIR = process.env.AWF_TOKEN_LOG_DIR || '/var/log/api-proxy';
const TOKEN_LOG_FILE = path.join(TOKEN_LOG_DIR, 'token-usage.jsonl');
const DIAG_LOG_FILE = path.join(TOKEN_LOG_DIR, 'token-diag.log');

let logStream = null;
let diagStream = null;

// Log that the module loaded successfully
try {
  fs.mkdirSync(TOKEN_LOG_DIR, { recursive: true });
  fs.writeFileSync(
    DIAG_LOG_FILE,
    `${new Date().toISOString()} TOKEN_TRACKER_LOADED dir=${TOKEN_LOG_DIR}\n`,
    { flag: 'a' }
  );
} catch { /* best-effort — dir may not be writable yet */ }

/**
 * Write a diagnostic line to the diagnostics log file.
 * This file is captured in the artifact alongside token-usage.jsonl.
 */
function diag(msg, data) {
  try {
    if (!diagStream) {
      fs.mkdirSync(TOKEN_LOG_DIR, { recursive: true });
      diagStream = fs.createWriteStream(DIAG_LOG_FILE, { flags: 'a' });
      diagStream.on('error', () => { diagStream = null; });
    }
    const line = `${new Date().toISOString()} ${msg}` +
      (data ? ' ' + JSON.stringify(data) : '') + '\n';
    diagStream.write(line);
  } catch { /* best-effort */ }
}

/**
 * Get or create the JSONL append stream for token usage logs.
 * Uses a lazy singleton — created on first write.
 */
function getLogStream() {
  if (logStream) return logStream;
  try {
    // Ensure directory exists
    fs.mkdirSync(TOKEN_LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(TOKEN_LOG_FILE, { flags: 'a' });
    logStream.on('error', (err) => {
      logRequest('warn', 'token_log_error', { error: err.message });
      logStream = null;
    });
    return logStream;
  } catch (err) {
    logRequest('warn', 'token_log_init_error', { error: err.message });
    return null;
  }
}

/**
 * Write a token usage record to the JSONL log file.
 * Handles backpressure by dropping writes when the stream buffer is full.
 */
function writeTokenUsage(record) {
  const stream = getLogStream();
  if (stream && !stream.writableEnded) {
    const ok = stream.write(JSON.stringify(record) + '\n');
    if (!ok) {
      // Backpressure — stream buffer full. Drop this write rather than
      // accumulating unbounded memory. The 'drain' event will unblock
      // future writes naturally.
      logRequest('warn', 'token_log_backpressure', { request_id: record.request_id });
    }
  }
}

/**
 * Check if a response is SSE (Server-Sent Events) streaming.
 */
function isStreamingResponse(headers) {
  const ct = headers['content-type'] || '';
  return ct.includes('text/event-stream');
}

/**
 * Extract token usage from a non-streaming JSON response body.
 *
 * Supports:
 *   - OpenAI/Copilot: { usage: { prompt_tokens, completion_tokens, total_tokens } }
 *   - Anthropic: { usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } }
 *
 * Also extracts the model field if present.
 *
 * @param {Buffer} body - Response body
 * @returns {{ usage: object|null, model: string|null }}
 */
function extractUsageFromJson(body) {
  try {
    const text = body.toString('utf8');
    const json = JSON.parse(text);
    const result = { usage: null, model: json.model || null };

    if (json.usage && typeof json.usage === 'object') {
      const usage = {};
      let hasField = false;
      // Anthropic fields
      if (typeof json.usage.input_tokens === 'number') {
        usage.input_tokens = json.usage.input_tokens;
        hasField = true;
      }
      if (typeof json.usage.output_tokens === 'number') {
        usage.output_tokens = json.usage.output_tokens;
        hasField = true;
      }
      if (typeof json.usage.cache_creation_input_tokens === 'number') {
        usage.cache_creation_input_tokens = json.usage.cache_creation_input_tokens;
        hasField = true;
      }
      if (typeof json.usage.cache_read_input_tokens === 'number') {
        usage.cache_read_input_tokens = json.usage.cache_read_input_tokens;
        hasField = true;
      }
      // OpenAI/Copilot fields
      if (typeof json.usage.prompt_tokens === 'number') {
        usage.prompt_tokens = json.usage.prompt_tokens;
        hasField = true;
      }
      if (typeof json.usage.completion_tokens === 'number') {
        usage.completion_tokens = json.usage.completion_tokens;
        hasField = true;
      }
      if (typeof json.usage.total_tokens === 'number') {
        usage.total_tokens = json.usage.total_tokens;
        hasField = true;
      }
      if (hasField) {
        result.usage = usage;
      }
    }

    return result;
  } catch {
    return { usage: null, model: null };
  }
}

/**
 * Extract token usage from a single SSE data line.
 *
 * SSE format: "data: {json}\n\n"
 *
 * Anthropic streaming events with usage:
 *   - message_start: { type: "message_start", message: { usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens } } }
 *   - message_delta: { type: "message_delta", usage: { output_tokens } }
 *
 * OpenAI/Copilot streaming events with usage:
 *   - Final chunk: { usage: { prompt_tokens, completion_tokens, total_tokens } }
 *
 * @param {string} line - A single SSE data line (without "data: " prefix)
 * @returns {{ usage: object|null, model: string|null }}
 */
function extractUsageFromSseLine(line) {
  if (!line || line === '[DONE]') return { usage: null, model: null };

  try {
    const json = JSON.parse(line);
    const result = { usage: null, model: json.model || null };

    // Anthropic message_start: usage is inside message object
    if (json.type === 'message_start' && json.message && json.message.usage) {
      result.usage = {};
      const u = json.message.usage;
      if (typeof u.input_tokens === 'number') result.usage.input_tokens = u.input_tokens;
      if (typeof u.cache_creation_input_tokens === 'number') result.usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
      if (typeof u.cache_read_input_tokens === 'number') result.usage.cache_read_input_tokens = u.cache_read_input_tokens;
      result.model = (json.message && json.message.model) || result.model;
      return result;
    }

    // Anthropic message_delta: usage at top level
    if (json.type === 'message_delta' && json.usage) {
      result.usage = {};
      if (typeof json.usage.output_tokens === 'number') result.usage.output_tokens = json.usage.output_tokens;
      return result;
    }

    // OpenAI/Copilot: usage at top level in final chunk
    if (json.usage && typeof json.usage === 'object') {
      result.usage = {};
      if (typeof json.usage.prompt_tokens === 'number') result.usage.prompt_tokens = json.usage.prompt_tokens;
      if (typeof json.usage.completion_tokens === 'number') result.usage.completion_tokens = json.usage.completion_tokens;
      if (typeof json.usage.total_tokens === 'number') result.usage.total_tokens = json.usage.total_tokens;
      return result;
    }

    return result;
  } catch {
    return { usage: null, model: null };
  }
}

/**
 * Extract all SSE data lines from a text chunk.
 * Lines are prefixed with "data: " in the SSE protocol.
 */
function parseSseDataLines(text) {
  const lines = [];
  const parts = text.split('\n');
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('data: ')) {
      lines.push(trimmed.slice(6));
    } else if (trimmed === 'data:') {
      // empty data line
    }
  }
  return lines;
}

/**
 * Normalize extracted usage into a unified format.
 *
 * Output fields:
 *   - input_tokens: number (from Anthropic input_tokens or OpenAI prompt_tokens)
 *   - output_tokens: number (from Anthropic output_tokens or OpenAI completion_tokens)
 *   - cache_read_tokens: number (Anthropic only, 0 for others)
 *   - cache_write_tokens: number (Anthropic only, 0 for others)
 */
function normalizeUsage(usage) {
  if (!usage) return null;

  return {
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Attach token usage tracking to an upstream response.
 *
 * This function listens on the proxyRes 'data' and 'end' events to extract
 * token usage. It does NOT modify the response stream — the caller still
 * does proxyRes.pipe(res) as before.
 *
 * @param {http.IncomingMessage} proxyRes - Upstream response
 * @param {object} opts
 * @param {string} opts.requestId - Request ID for correlation
 * @param {string} opts.provider - Provider name (openai, anthropic, copilot, opencode)
 * @param {string} opts.path - Request path
 * @param {number} opts.startTime - Request start time (Date.now())
 * @param {object} opts.metrics - Metrics module reference
 */
function trackTokenUsage(proxyRes, opts) {
  const { requestId, provider, path: reqPath, startTime, metrics: metricsRef } = opts;
  const streaming = isStreamingResponse(proxyRes.headers);
  const contentType = proxyRes.headers['content-type'] || '(none)';

  logRequest('debug', 'token_track_start', {
    request_id: requestId,
    provider,
    path: reqPath,
    streaming,
    content_type: contentType,
    status: proxyRes.statusCode,
  });
  diag('HTTP_TRACK_START', { request_id: requestId, provider, path: reqPath, streaming, content_type: contentType, status: proxyRes.statusCode });

  // Accumulate response body for usage extraction
  const chunks = [];
  let totalBytes = 0;
  let overflow = false;
  let rawSample = ''; // Capture first 1KB of raw SSE for diagnostics
  const RAW_SAMPLE_LIMIT = 1024;

  // For streaming: accumulate usage across SSE events
  let streamingUsage = {};
  let streamingModel = null;
  let partialLine = '';

  proxyRes.on('data', (chunk) => {
    totalBytes += chunk.length;

    // Capture raw data sample for diagnostics
    if (rawSample.length < RAW_SAMPLE_LIMIT) {
      rawSample += chunk.toString('utf8').slice(0, RAW_SAMPLE_LIMIT - rawSample.length);
    }

    if (streaming) {
      // Parse SSE data lines from this chunk to extract usage events
      const text = partialLine + chunk.toString('utf8');
      // Keep any incomplete line at the end for next chunk
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline >= 0) {
        const complete = text.slice(0, lastNewline);
        partialLine = text.slice(lastNewline + 1);

        const dataLines = parseSseDataLines(complete);
        for (const line of dataLines) {
          const { usage, model } = extractUsageFromSseLine(line);
          if (model && !streamingModel) streamingModel = model;
          if (usage) {
            // Merge usage fields (Anthropic sends input in message_start, output in message_delta)
            for (const [k, v] of Object.entries(usage)) {
              streamingUsage[k] = v;
            }
          }
        }
      } else {
        partialLine = text;
      }
    } else if (!overflow) {
      if (totalBytes <= MAX_BUFFER_SIZE) {
        chunks.push(chunk);
      } else {
        overflow = true;
        chunks.length = 0; // free memory
      }
    }
  });

  proxyRes.on('end', () => {
    // Only process successful responses (2xx)
    if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
      logRequest('debug', 'token_track_skip_status', {
        request_id: requestId,
        provider,
        status: proxyRes.statusCode,
      });
      diag('HTTP_TRACK_SKIP_STATUS', { request_id: requestId, provider, status: proxyRes.statusCode });
      return;
    }

    const duration = Date.now() - startTime;
    let usage = null;
    let model = null;

    if (streaming) {
      // Process any remaining partial line
      if (partialLine.trim()) {
        const dataLines = parseSseDataLines(partialLine);
        for (const line of dataLines) {
          const { usage: u, model: m } = extractUsageFromSseLine(line);
          if (m && !streamingModel) streamingModel = m;
          if (u) {
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
    });
    diag('HTTP_TRACK_END', { request_id: requestId, provider, streaming, total_bytes: totalBytes, overflow, has_usage: !!usage, usage_keys: usage ? Object.keys(usage) : [], model, raw_sample: rawSample.slice(0, 500) });

    const normalized = normalizeUsage(usage);
    if (!normalized) return;

    // Update metrics
    if (metricsRef) {
      metricsRef.increment('input_tokens_total', { provider }, normalized.input_tokens);
      metricsRef.increment('output_tokens_total', { provider }, normalized.output_tokens);
    }

    // Build log record
    const record = {
      timestamp: new Date().toISOString(),
      request_id: requestId,
      provider,
      model: model || 'unknown',
      path: reqPath,
      status: proxyRes.statusCode,
      streaming,
      input_tokens: normalized.input_tokens,
      output_tokens: normalized.output_tokens,
      cache_read_tokens: normalized.cache_read_tokens,
      cache_write_tokens: normalized.cache_write_tokens,
      duration_ms: duration,
      response_bytes: totalBytes,
    };

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
  });
}

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

    if (masked) headerSize += 4; // skip masking key

    const frameEnd = pos + headerSize + payloadLength;
    if (frameEnd > buf.length) break;

    // Extract text frames (opcode 1) with FIN set
    if (opcode === 1 && fin) {
      messages.push(buf.slice(pos + headerSize, frameEnd).toString('utf8'));
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
 */
function trackWebSocketTokenUsage(upstreamSocket, opts) {
  const { requestId, provider, path: reqPath, startTime, metrics: metricsRef } = opts;

  logRequest('debug', 'ws_token_track_start', {
    request_id: requestId,
    provider,
    path: reqPath,
  });
  diag('WS_TRACK_START', { request_id: requestId, provider, path: reqPath });

  let httpHeaderParsed = false;
  let buffer = Buffer.alloc(0);
  let totalBytes = 0;
  let streamingUsage = {};
  let streamingModel = null;
  let finalized = false;
  let frameCount = 0;
  let textMessageCount = 0;

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
      buffer = buffer.slice(headerEnd + 4);
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

    if (metricsRef) {
      metricsRef.increment('input_tokens_total', { provider }, normalized.input_tokens);
      metricsRef.increment('output_tokens_total', { provider }, normalized.output_tokens);
    }

    const record = {
      timestamp: new Date().toISOString(),
      request_id: requestId,
      provider,
      model: streamingModel || 'unknown',
      path: reqPath,
      status: 200,
      streaming: true,
      input_tokens: normalized.input_tokens,
      output_tokens: normalized.output_tokens,
      cache_read_tokens: normalized.cache_read_tokens,
      cache_write_tokens: normalized.cache_write_tokens,
      duration_ms: duration,
      response_bytes: totalBytes,
    };

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

/**
 * Close the log stream (for graceful shutdown).
 * Returns a Promise that resolves once the stream has flushed.
 */
function closeLogStream() {
  return new Promise((resolve) => {
    let pending = 0;
    const check = () => { if (pending === 0) resolve(); };
    if (logStream) {
      pending++;
      logStream.end(() => { logStream = null; pending--; check(); });
    }
    if (diagStream) {
      pending++;
      diagStream.end(() => { diagStream = null; pending--; check(); });
    }
    if (pending === 0) resolve();
  });
}

module.exports = {
  trackTokenUsage,
  trackWebSocketTokenUsage,
  closeLogStream,
  // Exported for testing
  extractUsageFromJson,
  extractUsageFromSseLine,
  parseSseDataLines,
  parseWebSocketFrames,
  normalizeUsage,
  isStreamingResponse,
  writeTokenUsage,
  TOKEN_LOG_FILE,
};
