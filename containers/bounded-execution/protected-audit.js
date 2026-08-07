'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Protected broker diagnostics.
 *
 * Written to a directory that is mounted into the broker only — never into
 * the agent and never into a query. This is where the *reason* for an
 * `{"result":"ERROR"}` lives; the agent-visible answer never distinguishes
 * failure classes.
 *
 * Records deliberately exclude repository contents, query stdout/stderr, and
 * script bytes.
 */

const MAX_REASON_LENGTH = 500;

/** Bounds protected diagnostic detail without changing its value shape. */
function redactAuditDetail(detail) {
  return detail === undefined ? undefined : String(detail).slice(0, MAX_REASON_LENGTH);
}

const DEFAULT_AUDIT_FILENAME = 'enclave.jsonl';

function createAuditLog(auditDir, fileName = DEFAULT_AUDIT_FILENAME) {
  let fd;
  try {
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    const auditPath = path.join(auditDir, fileName);
    fd = fs.openSync(auditPath, 'a', 0o600);
  } catch (error) {
    // Losing the audit file must not take the broker down; fall back to
    // stderr, which is captured by `docker logs` on the broker container
    // (also outside the agent's reach).
    process.stderr.write(`[awf-enclave] audit log unavailable: ${error.message}\n`);
    fd = undefined;
  }

  function write(record) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    if (fd !== undefined) {
      try {
        // Keep diagnostics durable when the broker is stopped immediately
        // after an invocation fails.
        fs.writeSync(fd, line);
        return;
      } catch (error) {
        process.stderr.write(`[awf-enclave] audit log unavailable: ${error.message}\n`);
        try {
          fs.closeSync(fd);
        } catch {
          // The original write error is the useful diagnostic.
        }
        fd = undefined;
      }
    }
    process.stderr.write(line);
  }

  return {
    /** Records a successfully completed invocation. */
    invocation(record) {
      write({ kind: 'invocation', ...record });
    },
    /** Records why an invocation resolved to the canonical ERROR result. */
    failure(invocationId, reason, detail) {
      write({
        kind: 'failure',
        invocationId,
        reason,
        detail: redactAuditDetail(detail),
      });
    },
    /** Records broker lifecycle events. */
    lifecycle(event, detail) {
      write({ kind: 'lifecycle', event, detail });
    },
  };
}

module.exports = {
  DEFAULT_AUDIT_FILENAME,
  createAuditLog,
  createProtectedAuditLog: createAuditLog,
  redactAuditDetail,
  MAX_REASON_LENGTH,
};
