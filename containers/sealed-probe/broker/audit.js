'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Protected broker diagnostics.
 *
 * Written to a directory that is mounted into the broker only — never into
 * the agent and never into a probe. This is where the *reason* for an
 * `{"result":"ERROR"}` lives; the agent-visible answer never distinguishes
 * failure classes.
 *
 * Records deliberately exclude repository contents, probe stdout/stderr, and
 * script bytes.
 */

const MAX_REASON_LENGTH = 500;

function createAuditLog(auditDir) {
  let stream;
  try {
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    const auditPath = path.join(auditDir, 'sealed-probe.jsonl');
    const fd = fs.openSync(auditPath, 'a', 0o600);
    stream = fs.createWriteStream(null, {
      fd,
      flags: 'a',
      mode: 0o600,
      autoClose: true,
    });
    stream.on('error', (error) => {
      process.stderr.write(`[sealed-probe] audit log unavailable: ${error.message}\n`);
      stream = undefined;
    });
  } catch (error) {
    // Losing the audit stream must not take the broker down; fall back to
    // stderr, which is captured by `docker logs` on the broker container
    // (also outside the agent's reach).
    process.stderr.write(`[sealed-probe] audit log unavailable: ${error.message}\n`);
    stream = undefined;
  }

  function write(record) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    if (stream && !stream.destroyed) {
      stream.write(line + '\n');
    } else {
      process.stderr.write(line + '\n');
    }
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
        detail: detail === undefined ? undefined : String(detail).slice(0, MAX_REASON_LENGTH),
      });
    },
    /** Records broker lifecycle events. */
    lifecycle(event, detail) {
      write({ kind: 'lifecycle', event, detail });
    },
  };
}

module.exports = { createAuditLog };
