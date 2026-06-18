/**
 * Token usage tracking for AWF API Proxy — re-export facade.
 *
 * Maintains the original public API while delegating to focused modules:
 *   - token-persistence.js  : log stream lifecycle, record validation, disk writes
 *   - token-parsers.js      : pure SSE/JSON parsing and usage normalization
 *   - token-tracker-http.js : HTTP response tracker (trackTokenUsage)
 *   - token-tracker-ws.js   : WebSocket tracker (parseWebSocketFrames, trackWebSocketTokenUsage)
 */

'use strict';

const { trackTokenUsage } = require('./token-tracker-http');
const { parseWebSocketFrames, trackWebSocketTokenUsage } = require('./token-tracker-ws');
const {
  closeLogStream,
  validateTokenUsageRecord,
  writeTokenUsage,
  TOKEN_LOG_FILE,
} = require('./token-persistence');
const {
  extractUsageFromJson,
  extractUsageFromSseLine,
  parseSseDataLines,
  normalizeUsage,
  isStreamingResponse,
  looksLikeCompletionRequest,
  isCompressedResponse,
} = require('./token-parsers');

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
  looksLikeCompletionRequest,
  isCompressedResponse,
  validateTokenUsageRecord,
  writeTokenUsage,
  TOKEN_LOG_FILE,
};
