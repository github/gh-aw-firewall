/**
 * Structured JSON logging for AWF API Proxy.
 *
 * Every log line is a single JSON object written to stdout.
 * Zero external dependencies — uses Node.js built-in crypto.
 */

'use strict';

const crypto = require('crypto');

/**
 * Generate a unique request ID (UUID v4).
 * @returns {string}
 */
function generateRequestId() {
  return crypto.randomUUID();
}

/**
 * Strip control characters and limit length for safe logging.
 * @param {string} str
 * @param {number} [maxLen=200]
 * @returns {string}
 */
function sanitizeForLog(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLen);
}

/**
 * Write a structured JSON log line to stdout.
 *
 * @param {string} level   - "info" | "warn" | "error"
 * @param {string} event   - e.g. "request_start", "request_complete", "request_error", "startup"
 * @param {object} [fields] - Additional key/value pairs merged into the log line
 */
function logRequest(level, event, fields = {}) {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  // Single JSON line to stdout — tee handles file persistence
  process.stdout.write(JSON.stringify(line) + '\n');
}

module.exports = { generateRequestId, sanitizeForLog, logRequest };
