/**
 * HTTP response token usage tracker — re-export facade.
 *
 * State/listeners, usage extraction, and finalization live in focused modules.
 */

'use strict';

const { trackTokenUsage, createChunkHandler } = require('./token-tracker-http-state');
const { finalizeHttpTracking, buildAndWriteTokenRecord } = require('./token-tracker-http-finalize');
const { extractUsageFromTrackedState, hasCompleteModelUsage } = require('./token-usage-extraction');

module.exports = {
  trackTokenUsage,
  createChunkHandler,
  finalizeHttpTracking,
  extractUsageFromTrackedState,
  buildAndWriteTokenRecord,
  hasCompleteModelUsage,
};
