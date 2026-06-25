'use strict';

/**
 * Opt-in diagnostics for blocked LLM requests.
 *
 * When AWF_CAPTURE_BLOCKED_LLM_REQUESTS is set, writes a JSONL record to
 * blocked-request-diag.jsonl for every request that is rejected by a guard
 * (effective_tokens_limit_exceeded, ai_credits_limit_exceeded, etc.).
 *
 * Capture modes:
 *   false / not set : disabled (default)
 *   summary         : body-shape metadata only — counts, sizes, hashes. No content.
 *   redacted        : summary + first 200 chars of each message (may still contain secrets)
 *   full            : full body capture up to AWF_MAX_BLOCKED_CAPTURE_BYTES
 *
 * The resulting file is written to the same directory as token-usage.jsonl
 * (AWF_TOKEN_LOG_DIR, default /var/log/api-proxy) so it is picked up by the
 * same log-collection infrastructure.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Config (read at module load; tests override via jest.isolateModules) ───────
const TOKEN_LOG_DIR = process.env.AWF_TOKEN_LOG_DIR || '/var/log/api-proxy';
const DIAG_FILE = path.join(TOKEN_LOG_DIR, 'blocked-request-diag.jsonl');

const AWF_VERSION = process.env.AWF_VERSION || '0.0.0-dev';
const SCHEMA = `blocked-request-diag/v${AWF_VERSION}`;

/** Maximum bytes to capture in 'full' mode (per-record total). */
const DEFAULT_MAX_CAPTURED_BYTES = 250_000;

let diagStream = null;

// ── Capture-mode helpers ──────────────────────────────────────────────────────

/**
 * Returns the configured capture mode for blocked LLM requests.
 * Read at call time so it can be changed between requests in tests.
 *
 * @returns {'summary'|'redacted'|'full'|false}
 */
function getCaptureMode() {
  const raw = process.env.AWF_CAPTURE_BLOCKED_LLM_REQUESTS;
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1' || raw === 'summary') return 'summary';
  if (raw === 'redacted') return 'redacted';
  if (raw === 'full') return 'full';
  return false;
}

// ── Body analysis ─────────────────────────────────────────────────────────────

/**
 * Compute a short (16-hex-char) SHA-256 prefix of a buffer for correlation.
 * @param {Buffer} buf
 * @returns {string}
 */
function sha256Short(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/**
 * Rough token estimate — 4 characters per token, consistent with many
 * provider pricing calculators for English text.
 * @param {string} str
 * @returns {number}
 */
function estimateTokens(str) {
  if (!str || typeof str !== 'string') return 0;
  return Math.ceil(str.length / 4);
}

/**
 * Analyse the text content of a single message content value.
 * Handles both plain-string content and Anthropic/OpenAI structured
 * content-block arrays.
 *
 * @param {unknown} content
 * @returns {{ type: string, chars: number, bytes: number, estimated_tokens: number }}
 */
function analyzeContent(content) {
  if (typeof content === 'string') {
    const bytes = Buffer.byteLength(content, 'utf8');
    return {
      type: 'text',
      chars: content.length,
      bytes,
      estimated_tokens: estimateTokens(content),
    };
  }

  if (Array.isArray(content)) {
    let totalChars = 0;
    let totalBytes = 0;
    let totalTokens = 0;
    const types = new Set();

    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const blockType = typeof block.type === 'string' ? block.type : 'unknown';
      types.add(blockType);

      // Text block
      if (typeof block.text === 'string') {
        totalChars += block.text.length;
        totalBytes += Buffer.byteLength(block.text, 'utf8');
        totalTokens += estimateTokens(block.text);
      }
      // Tool result content (nested string)
      if (typeof block.content === 'string') {
        totalChars += block.content.length;
        totalBytes += Buffer.byteLength(block.content, 'utf8');
        totalTokens += estimateTokens(block.content);
      }
      // Tool result content (nested array — recurse one level)
      if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner && typeof inner.text === 'string') {
            totalChars += inner.text.length;
            totalBytes += Buffer.byteLength(inner.text, 'utf8');
            totalTokens += estimateTokens(inner.text);
          }
        }
      }
      // Base64-encoded image data — estimate decoded size
      if (block.source && typeof block.source === 'object' &&
          typeof block.source.data === 'string') {
        const decodedBytes = Math.ceil(block.source.data.length * 3 / 4);
        totalBytes += decodedBytes;
      }
    }

    return {
      type: [...types].sort().join(',') || 'mixed',
      chars: totalChars,
      bytes: totalBytes,
      estimated_tokens: totalTokens,
    };
  }

  return { type: 'unknown', chars: 0, bytes: 0, estimated_tokens: 0 };
}

/**
 * Extract a short content preview (first 200 chars of concatenated text).
 * Used in 'redacted' and 'full' modes.
 *
 * @param {unknown} content
 * @returns {string|undefined}
 */
function extractContentPreview(content) {
  if (typeof content === 'string') {
    return content.slice(0, 200) || undefined;
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.text === 'string') parts.push(block.text.slice(0, 100));
      else if (typeof block.content === 'string') parts.push(block.content.slice(0, 100));
    }
    const joined = parts.join(' ').slice(0, 200);
    return joined || undefined;
  }
  return undefined;
}

/**
 * Analyse a messages array (OpenAI or Anthropic format).
 *
 * @param {unknown[]} messages
 * @param {'summary'|'redacted'|'full'} captureMode
 * @returns {{ messageCount: number, toolResultCount: number, messageSizes: object[] } | null}
 */
function analyzeMessages(messages, captureMode) {
  if (!Array.isArray(messages)) return null;

  let messageCount = 0;
  let toolResultCount = 0;
  const messageSizes = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    messageCount++;

    const role = typeof msg.role === 'string' ? msg.role : 'unknown';
    const contentAnalysis = analyzeContent(msg.content);

    // Count tool-result blocks (Anthropic: type='tool_result'; OpenAI: role='tool')
    let toolBlocksInMsg = 0;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && block.type === 'tool_result') {
          toolBlocksInMsg++;
          toolResultCount++;
        }
      }
    }
    if (role === 'tool') {
      toolResultCount++;
    }

    const entry = {
      role,
      content_type: contentAnalysis.type,
      chars: contentAnalysis.chars,
      bytes: contentAnalysis.bytes,
      estimated_tokens: contentAnalysis.estimated_tokens,
    };
    if (toolBlocksInMsg > 0) entry.tool_blocks = toolBlocksInMsg;

    if (captureMode === 'redacted' || captureMode === 'full') {
      const preview = extractContentPreview(msg.content);
      if (preview !== undefined) entry.content_preview = preview;
    }

    messageSizes.push(entry);
  }

  return { messageCount, toolResultCount, messageSizes };
}

/**
 * Analyse a request body buffer and return diagnostic shape information.
 *
 * @param {Buffer} body - Final (possibly transformed) request body
 * @param {'summary'|'redacted'|'full'} captureMode
 * @returns {object}
 */
function analyzeRequestBody(body, captureMode) {
  const bodyBytes = body ? body.length : 0;
  const result = {
    body_bytes: bodyBytes,
    body_sha256: body && bodyBytes > 0 ? sha256Short(body) : null,
  };

  if (!body || bodyBytes === 0) return result;

  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    result.parse_error = true;
    return result;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;

  if (typeof parsed.model === 'string') result.model = parsed.model;
  if (parsed.stream === true) result.streaming = true;

  if (captureMode === 'full') {
    // Full mode: include the entire body, truncated to the configured byte cap.
    const maxBytes = parseInt(process.env.AWF_MAX_BLOCKED_CAPTURE_BYTES, 10) || DEFAULT_MAX_CAPTURED_BYTES;
    const raw = body.slice(0, maxBytes).toString('utf8');
    result.body_full = raw;
  }

  if (Array.isArray(parsed.messages)) {
    const analysis = analyzeMessages(parsed.messages, captureMode);
    if (analysis) {
      result.message_count = analysis.messageCount;
      result.tool_result_count = analysis.toolResultCount;
      result.message_sizes = analysis.messageSizes;
    }
  }

  return result;
}

// ── Stream management ─────────────────────────────────────────────────────────

/**
 * Lazy singleton write stream for the diagnostics log.
 * Reads TOKEN_LOG_DIR at call time to support test overrides via
 * jest.isolateModules (TOKEN_LOG_DIR is constant per module instance).
 *
 * @returns {fs.WriteStream|null}
 */
function getDiagStream() {
  if (diagStream) return diagStream;
  try {
    fs.mkdirSync(TOKEN_LOG_DIR, { recursive: true });
    diagStream = fs.createWriteStream(DIAG_FILE, { flags: 'a', mode: 0o644 });
    diagStream.on('error', () => { diagStream = null; });
    return diagStream;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write a blocked-request diagnostic record.
 *
 * Silently does nothing when:
 *   - AWF_CAPTURE_BLOCKED_LLM_REQUESTS is not set or is 'false'
 *   - the log directory cannot be created
 *   - any other error occurs (best-effort, never throws)
 *
 * @param {object} opts
 * @param {string}        opts.requestId       - Unique request identifier
 * @param {string}        opts.provider        - Provider name (openai, anthropic, …)
 * @param {string}        opts.path            - Sanitized request path
 * @param {string}        opts.guardType       - Guard event name
 * @param {object}        opts.guardLogFields  - Guard-specific totals / limits
 * @param {Buffer}        opts.body            - Final request body (after transforms)
 * @param {number}        opts.inboundBytes    - Raw body bytes before transforms
 */
function writeBlockedRequestDiag(opts) {
  const captureMode = getCaptureMode();
  if (!captureMode) return;

  const { requestId, provider, path: reqPath, guardType, guardLogFields, body, inboundBytes } = opts;

  let bodyAnalysis;
  try {
    bodyAnalysis = analyzeRequestBody(body, captureMode);
  } catch {
    bodyAnalysis = { body_bytes: body ? body.length : 0, analysis_error: true };
  }

  const bodyTransformed = (body ? body.length : 0) !== inboundBytes;

  const record = {
    _schema: SCHEMA,
    timestamp: new Date().toISOString(),
    event: 'blocked_request_diag',
    capture_mode: captureMode,
    request_id: requestId,
    provider,
    path: reqPath,
    guard_type: guardType,
    guard_totals: guardLogFields || {},
    body_transformed: bodyTransformed,
    inbound_bytes: inboundBytes,
    ...bodyAnalysis,
  };

  try {
    const stream = getDiagStream();
    if (stream && !stream.writableEnded) {
      stream.write(JSON.stringify(record) + '\n');
    }
  } catch { /* best-effort */ }
}

/**
 * Close the diagnostics write stream (called during graceful shutdown).
 * Returns a Promise that resolves once the stream has been flushed.
 *
 * @returns {Promise<void>}
 */
function closeBlockedRequestDiagStream() {
  return new Promise((resolve) => {
    if (diagStream) {
      diagStream.end(() => { diagStream = null; resolve(); });
    } else {
      resolve();
    }
  });
}

// ── Internal test helpers ─────────────────────────────────────────────────────

/** @internal Test-only: reset singleton stream so tests start clean. */
// ts-prune-ignore-next
const testHelpers = {
  resetDiagStream() {
    if (diagStream) {
      try { diagStream.destroy(); } catch { /* ignore */ }
      diagStream = null;
    }
  },
  DIAG_FILE,
  SCHEMA,
};

module.exports = {
  getCaptureMode,
  analyzeRequestBody,
  analyzeMessages,
  writeBlockedRequestDiag,
  closeBlockedRequestDiagStream,
  DIAG_FILE,
  SCHEMA,
  testHelpers,
};
