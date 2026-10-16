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

function createAuditLog(auditDir, fileName = DEFAULT_AUDIT_FILENAME, protectedOnly = false) {
  let fd;
  try {
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    const auditPath = path.join(auditDir, fileName);
    fd = fs.openSync(auditPath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        (stat.mode & 0o777) !== 0o600) {
      throw new Error('Unsafe audit file');
    }
  } catch (error) {
    // Protected records must never fall back to ordinary container logs.
    process.stderr.write(protectedOnly
      ? '[awf-enclave] protected audit unavailable (reason=storage-unavailable)\n'
      : `[awf-enclave] audit log unavailable: ${error.message}\n`);
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        process.stderr.write('[awf-enclave] audit close failed (reason=storage-unavailable)\n');
      }
    }
    fd = undefined;
  }

  function write(record) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    if (fd !== undefined) {
      try {
        // Keep diagnostics durable when the broker is stopped immediately
        // after an invocation fails.
        fs.writeSync(fd, line);
        if (protectedOnly) fs.fsyncSync(fd);
        return;
      } catch (error) {
        process.stderr.write(protectedOnly
          ? '[awf-enclave] protected audit unavailable (reason=write-failed)\n'
          : `[awf-enclave] audit log unavailable: ${error.message}\n`);
        try {
          fs.closeSync(fd);
        } catch {
          // The original write error is the useful diagnostic.
        }
        fd = undefined;
      }
    }
    if (!protectedOnly) process.stderr.write(line);
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
  createProtectedAuditLog: (auditDir, fileName) => createAuditLog(auditDir, fileName, true),
  redactAuditDetail,
  MAX_REASON_LENGTH,
};
