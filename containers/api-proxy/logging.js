/**
 * Structured JSON logging for AWF API Proxy.
 *
 * Every log line is a single JSON object written to stdout.
 * Zero external dependencies — uses Node.js built-in crypto.
 */

'use strict';

const crypto = require('crypto');
const { parseBodyAsObject } = require('./body-utils');
const { redactTrustedServiceSecrets } = require('./trusted-service');

// Only fixed protocol labels may reach shape logs, never caller-supplied types.
const INPUT_ITEM_TYPES = new Set([
  'message', 'function_call', 'function_call_output', 'reasoning',
  'item_reference', 'custom_tool_call', 'custom_tool_call_output',
]);
const CONTENT_PART_TYPES = new Set([
  'input_text', 'input_image', 'input_file', 'input_audio', 'output_text',
  'text', 'image', 'image_url', 'audio', 'refusal',
]);

/**
 * Log Copilot/OpenAI content types/counts without prompts, tool outputs or image data.
 * Counts stay bounded in size even for large histories or unrecognized types.
 */
function logRequestShape(body, provider, requestId, stage) {
  if ((provider !== 'copilot' && provider !== 'openai') || body.length === 0) return;
  const parsed = parseBodyAsObject(body);
  const fields = { request_id: requestId, provider, stage, body_bytes: body.length };
  if (!parsed) {
    logRequest('debug', 'request_shape', { ...fields, body_format: 'unrecognized' });
    return;
  }
  const inputTypes = {};
  const contentTypes = {};
  const outputTypes = {};
  function count(counts, type, allowed) {
    const label = allowed.has(type) ? type : 'unknown';
    counts[label] = (counts[label] || 0) + 1;
  }
  function countContent(content, counts) {
    if (typeof content === 'string') {
      count(counts, 'text', CONTENT_PART_TYPES);
    } else if (Array.isArray(content)) {
      for (const part of content) count(counts, part?.type, CONTENT_PART_TYPES);
    }
  }
  if (typeof parsed.input === 'string') countContent(parsed.input, contentTypes);
  const items = Array.isArray(parsed.input) ? parsed.input
    : Array.isArray(parsed.messages) ? parsed.messages : [];
  for (const item of items) {
    count(inputTypes, item?.type ?? (item?.role ? 'message' : 'unknown'), INPUT_ITEM_TYPES);
    countContent(item?.content, contentTypes);
    if (item?.type === 'function_call_output') countContent(item.output, outputTypes);
  }
  logRequest('debug', 'request_shape', {
    ...fields,
    input_item_types: inputTypes,
    content_part_types: contentTypes,
    tool_output_part_types: outputTypes,
  });
}

/**
 * Generate a unique request ID (UUID v4).
 * @returns {string}
 */
function generateRequestId() {
  return crypto.randomUUID();
}

/**
 * Strip control characters and limit length for safe logging.
 * Newline characters are removed to prevent log injection via line splitting.
 * @param {string} str
 * @param {number} [maxLen=200]
 * @returns {string}
 */
function sanitizeForLog(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  // Remove ASCII control characters, including CR and LF, then truncate
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x1f\x7f]/g, '').slice(0, maxLen);
}

/**
 * Write a structured JSON log line to stdout.
 *
 * @param {string} level   - "debug" | "info" | "warn" | "error"
 * @param {string} event   - e.g. "request_start", "request_complete", "request_error", "startup"
 * @param {object} [fields] - Additional key/value pairs merged into the log line
 */
function logRequest(level, event, fields = {}) {
  const sensitiveTarget = (process.env.AWF_SENSITIVE_OPENAI_TARGET || '').trim();
  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item)]));
    value = redactTrustedServiceSecrets(value);
    if (!sensitiveTarget || typeof value !== 'string') return value;
    return value.replace(
      new RegExp(sensitiveTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      '[REDACTED]'
    );
  };
  const line = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redact(value)])),
  };
  // Single JSON line to stdout — tee handles file persistence
  process.stdout.write(JSON.stringify(line) + '\n');
}

module.exports = { generateRequestId, sanitizeForLog, logRequest, logRequestShape };
