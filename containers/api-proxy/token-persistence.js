/**
 * Token usage persistence layer for AWF API Proxy.
 *
 * Manages the NDJSON token-usage log file: stream lifecycle, record
 * validation, and disk writes.  Also owns the optional diagnostics log
 * (AWF_DEBUG_TOKENS=1).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { logRequest } = require('./logging');

// Token usage log file path (inside the mounted log volume)
const TOKEN_LOG_DIR = process.env.AWF_TOKEN_LOG_DIR || '/var/log/api-proxy';
const TOKEN_LOG_FILE = path.join(TOKEN_LOG_DIR, 'token-usage.jsonl');
const DIAG_LOG_FILE = path.join(TOKEN_LOG_DIR, 'token-diag.jsonl');
const DIAG_ENABLED = process.env.AWF_DEBUG_TOKENS === '1';

// AWF version used to identify schema version in JSONL records.
// Set to the container image version at build time via ARG AWF_VERSION in the Dockerfile
// (baked in by the release workflow with --build-arg AWF_VERSION=<version>).
// Falls back to "0.0.0-dev" for local/un-versioned builds.
const AWF_VERSION = process.env.AWF_VERSION;
if (!AWF_VERSION) {
  // Log a warning (to stderr to avoid polluting stdout) when running without the env var.
  // This can happen during local development or tests outside the container.
  process.stderr.write('{"level":"warn","event":"awf_version_missing","message":"AWF_VERSION env var not set; _schema will use 0.0.0-dev"}\n');
}
const TOKEN_USAGE_SCHEMA = `token-usage/v${AWF_VERSION || '0.0.0-dev'}`;
const TOKEN_DIAG_SCHEMA = `token-diag/v${AWF_VERSION || '0.0.0-dev'}`;

let logStream = null;
let diagStream = null;

/**
 * Write a diagnostic line to the diagnostics log file.
 * Only active when AWF_DEBUG_TOKENS=1 environment variable is set.
 * Does not persist request/response payload data.
 */
function validateTokenDiagRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record._schema !== 'string') return false;
  if (!/^token-diag\/v\d+\.\d+\.\d+(-\w+)?$/.test(record._schema)) return false;
  if (typeof record.timestamp !== 'string') return false;
  if (typeof record.event !== 'string') return false;
  if (record.data !== undefined && (typeof record.data !== 'object' || record.data === null || Array.isArray(record.data))) return false;
  return true;
}

function buildTokenDiagRecord(event, data) {
  return {
    _schema: TOKEN_DIAG_SCHEMA,
    timestamp: new Date().toISOString(),
    event: typeof event === 'string' ? event : 'DIAG',
    ...(data && typeof data === 'object' && !Array.isArray(data) ? { data } : {}),
  };
}

function diag(msg, data) {
  if (!DIAG_ENABLED) return;
  try {
    if (!diagStream) {
      fs.mkdirSync(TOKEN_LOG_DIR, { recursive: true });
      diagStream = fs.createWriteStream(DIAG_LOG_FILE, { flags: 'a' });
      diagStream.on('error', () => { diagStream = null; });
    }
    const record = buildTokenDiagRecord(msg, data);
    if (!validateTokenDiagRecord(record)) return;
    diagStream.write(JSON.stringify(record) + '\n');
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
 * Validate a token usage record against the token-usage schema contract.
 *
 * Checks that all required fields are present and have the expected types.
 * Logs a warning and returns false if the record is non-conformant; does
 * not throw, so a bad record is dropped rather than crashing the proxy.
 *
 * @param {object} record - The record to validate
 * @returns {boolean} true if the record is valid, false otherwise
 */
function validateTokenUsageRecord(record) {
  if (!record || typeof record !== 'object') {
    logRequest('warn', 'token_record_schema_violation', {
      field: 'record',
      expected: 'object',
      actual: record === null ? 'null' : typeof record,
    });
    return false;
  }

  const required = [
    ['_schema', 'string'],
    ['timestamp', 'string'],
    ['event', 'string'],
    ['request_id', 'string'],
    ['provider', 'string'],
    ['model', 'string'],
    ['path', 'string'],
    ['status', 'number'],
    ['streaming', 'boolean'],
    ['input_tokens', 'number'],
    ['output_tokens', 'number'],
    ['cache_read_tokens', 'number'],
    ['cache_write_tokens', 'number'],
    ['duration_ms', 'number'],
  ];

  for (const [field, expectedType] of required) {
    // eslint-disable-next-line valid-typeof
    if (typeof record[field] !== expectedType) {
      logRequest('warn', 'token_record_schema_violation', {
        request_id: record.request_id,
        field,
        expected: expectedType,
        actual: typeof record[field],
      });
      return false;
    }
  }

  if (!/^token-usage\/v\d+\.\d+\.\d+(-\w+)?$/.test(record._schema)) {
    logRequest('warn', 'token_record_schema_violation', {
      request_id: record.request_id,
      field: '_schema',
      expected: 'token-usage/v<semver>',
      actual: record._schema,
    });
    return false;
  }

  if (record.event !== 'token_usage') {
    logRequest('warn', 'token_record_schema_violation', {
      request_id: record.request_id,
      field: 'event',
      expected: 'token_usage',
      actual: record.event,
    });
    return false;
  }

  return true;
}

/**
 * Build a token usage record for JSONL persistence.
 *
 * @param {object} normalized - Normalized usage object from normalizeUsage()
 * @param {object} opts
 * @param {string} opts.requestId
 * @param {string} opts.provider
 * @param {string|null} opts.model
 * @param {string} opts.reqPath
 * @param {number} opts.status
 * @param {boolean} opts.streaming
 * @param {number} opts.duration
 * @param {number} opts.responseBytes
 * @returns {object}
 */
function buildTokenUsageRecord(normalized, opts) {
  const { requestId, provider, model, reqPath, status, streaming, duration, responseBytes } = opts;
  return {
    _schema: TOKEN_USAGE_SCHEMA,
    timestamp: new Date().toISOString(),
    event: 'token_usage',
    request_id: requestId,
    provider,
    model: model || 'unknown',
    path: reqPath,
    status,
    streaming,
    input_tokens: normalized.input_tokens,
    output_tokens: normalized.output_tokens,
    cache_read_tokens: normalized.cache_read_tokens,
    cache_write_tokens: normalized.cache_write_tokens,
    duration_ms: duration,
    response_bytes: responseBytes,
  };
}

/**
 * Increment token usage metrics when a metrics sink is available.
 *
 * @param {object|null} metricsRef
 * @param {string} provider
 * @param {object} normalized
 */
function incrementTokenMetrics(metricsRef, provider, normalized) {
  if (!metricsRef) return;
  metricsRef.increment('input_tokens_total', { provider }, normalized.input_tokens);
  metricsRef.increment('output_tokens_total', { provider }, normalized.output_tokens);
}

/**
 * Write a token usage record to the JSONL log file.
 * Validates the record against the token-usage schema before writing.
 * Handles backpressure by dropping writes when the stream buffer is full.
 */
function writeTokenUsage(record) {
  if (!validateTokenUsageRecord(record)) return;

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
 * Close the log stream (for graceful shutdown).
 * Returns a Promise that resolves once the stream has flushed.
 */
function closeLogStream() {
  // Also close the blocked-request diagnostics stream if the module is loaded.
  let closeBlockedRequestDiagStream = () => Promise.resolve();
  try {
    ({ closeBlockedRequestDiagStream } = require('./blocked-request-diagnostics'));
  } catch { /* optional module — no-op when absent */ }

  return Promise.all([
    new Promise((resolve) => {
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
    }),
    closeBlockedRequestDiagStream(),
  ]).then(() => {});
}

module.exports = {
  TOKEN_LOG_FILE,
  TOKEN_USAGE_SCHEMA,
  TOKEN_DIAG_SCHEMA,
  diag,
  buildTokenDiagRecord,
  buildTokenUsageRecord,
  incrementTokenMetrics,
  validateTokenDiagRecord,
  validateTokenUsageRecord,
  writeTokenUsage,
  closeLogStream,
};
