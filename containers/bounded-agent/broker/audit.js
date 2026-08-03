'use strict';

const { createAuditLog: createProtectedAuditLog } = require('../bounded-execution/protected-audit');

/** Filename of the bounded-agent protected audit log. */
const BOUNDED_AGENT_AUDIT_FILENAME = 'bounded-agent.jsonl';

/**
 * Protected bounded-agent diagnostics.
 *
 * Uses the shared PR1 protected-audit primitive with a bounded-agent-specific
 * filename so the two subsystems' audit trails are never confused, even though
 * they already live in disjoint broker-private roots.
 */
function createAuditLog(auditDir) {
  return createProtectedAuditLog(auditDir, BOUNDED_AGENT_AUDIT_FILENAME);
}

module.exports = { BOUNDED_AGENT_AUDIT_FILENAME, createAuditLog };
