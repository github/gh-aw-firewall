'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCopilotInteractionId } = require('./request-headers');

// Keep payload-bearing fields out of the persisted routing evidence.
const FIELDS = new Set([
  'stage', 'purpose', 'attempt', 'classifier_model', 'classifier_effort',
  'objective', 'provider', 'selected_id', 'selected_model', 'selected_effort',
  'selected_provider', 'selected_endpoint', 'wire_model', 'endpoint',
  'degraded_classification', 'degraded_reason', 'classifier_attempts',
  'eligible_choices', 'catalogue_overlap', 'latency_ms', 'labels', 'mode',
  'router', 'ranked_choices', 'conversation_sha256', 'phase', 'code', 'detail',
  'request_id', 'routed', 'deviations', 'unavailable', 'method', 'pathname',
  'requested_model', 'requested_effort', 'outcome', 'status',
]);

/**
 * Append routing metadata only. Synchronous, small writes need no shutdown
 * flush and failures must never change routing or inference.
 */
function writeRoutingRecord(record) {
  let fd;
  try {
    const fields = Object.fromEntries(Object.entries(record).filter(([key]) => FIELDS.has(key)));
    const line = {
      _schema: `model-routing/v${process.env.AWF_VERSION || '0.0.0-dev'}`,
      timestamp: new Date().toISOString(),
      event: 'model_routing',
      ...fields,
      ...(record.stage === 'selection' ? {
        interaction_id: resolveCopilotInteractionId(),
        ...(process.env.GITHUB_REPOSITORY?.trim() && {
          github_repository: process.env.GITHUB_REPOSITORY.trim(),
        }),
        ...(process.env.GITHUB_WORKFLOW_REF?.trim() && {
          github_workflow_ref: process.env.GITHUB_WORKFLOW_REF.trim(),
        }),
      } : {}),
    };
    const directory = process.env.AWF_TOKEN_LOG_DIR || '/var/log/api-proxy';
    fs.mkdirSync(directory, { recursive: true });
    fd = fs.openSync(path.join(directory, 'model-routing.jsonl'),
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return;
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(line) + '\n');
  } catch {
    // Best-effort tracking.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

module.exports = { writeRoutingRecord };
