/**
 * Token usage tracking for AWF API Proxy.
 *
 * Intercepts LLM API responses (both streaming SSE and non-streaming JSON)
 * to extract token usage data without adding latency to the client.
 *
 * Architecture:
 *   proxyRes → PassThrough (accumulates chunks) → res (client)
 *                     ↓ on('end')
 *              parse usage → log to file + metrics
 *
 * For non-streaming responses: parse the buffered JSON body on 'end'.
 * For streaming (SSE) responses: scan each chunk for usage events as they
 * pass through, accumulate usage from message_start / message_delta / final
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

let logStream = null;

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
 */
function writeTokenUsage(record) {
  const stream = getLogStream();
  if (stream) {
    stream.write(JSON.stringify(record) + '\n');
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
      result.usage = {};
      // Anthropic fields
      if (typeof json.usage.input_tokens === 'number') {
        result.usage.input_tokens = json.usage.input_tokens;
      }
      if (typeof json.usage.output_tokens === 'number') {
        result.usage.output_tokens = json.usage.output_tokens;
      }
      if (typeof json.usage.cache_creation_input_tokens === 'number') {
        result.usage.cache_creation_input_tokens = json.usage.cache_creation_input_tokens;
      }
      if (typeof json.usage.cache_read_input_tokens === 'number') {
        result.usage.cache_read_input_tokens = json.usage.cache_read_input_tokens;
      }
      // OpenAI/Copilot fields
      if (typeof json.usage.prompt_tokens === 'number') {
        result.usage.prompt_tokens = json.usage.prompt_tokens;
      }
      if (typeof json.usage.completion_tokens === 'number') {
        result.usage.completion_tokens = json.usage.completion_tokens;
      }
      if (typeof json.usage.total_tokens === 'number') {
        result.usage.total_tokens = json.usage.total_tokens;
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
 * @param {string} opts.method - HTTP method
 * @param {string} opts.path - Request path
 * @param {string} opts.targetHost - Upstream host
 * @param {number} opts.startTime - Request start time (Date.now())
 * @param {object} opts.metrics - Metrics module reference
 */
function trackTokenUsage(proxyRes, opts) {
  const { requestId, provider, method, path: reqPath, targetHost, startTime, metrics: metricsRef } = opts;
  const streaming = isStreamingResponse(proxyRes.headers);

  // Accumulate response body for usage extraction
  const chunks = [];
  let totalBytes = 0;
  let overflow = false;

  // For streaming: accumulate usage across SSE events
  let streamingUsage = {};
  let streamingModel = null;
  let partialLine = '';

  proxyRes.on('data', (chunk) => {
    totalBytes += chunk.length;

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
    if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) return;

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
      request_bytes: 0, // filled by caller if needed
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
 * Close the log stream (for graceful shutdown).
 */
function closeLogStream() {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}

module.exports = {
  trackTokenUsage,
  closeLogStream,
  // Exported for testing
  extractUsageFromJson,
  extractUsageFromSseLine,
  parseSseDataLines,
  normalizeUsage,
  isStreamingResponse,
  writeTokenUsage,
  TOKEN_LOG_FILE,
};
