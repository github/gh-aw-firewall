'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Per-invocation private workspace management.
 *
 * A enclave agent never writes to the repository: the immutable seed is
 * bind-mounted read-only straight into the enclave, so there is no writable
 * copy of private source anywhere on the host. The workspace therefore holds
 * only three small, broker-owned files:
 *
 *  - `task.txt`   the caller's byte-bounded task text (read-only in the enclave)
 *  - `schema.json` the caller's finite response schema (read-only in the enclave)
 *  - `out`        a pre-created, size-bounded regular file the enclave writes
 *                 its single JSON answer to
 *  - `session.jsonl` a bounded transcript copied only to broker-private audit
 */

/** Layout of one invocation directory, relative to the broker's work dir. */
function invocationLayout(workDir, invocationId) {
  const root = path.join(workDir, invocationId);
  return {
    root,
    taskPath: path.join(root, 'task.txt'),
    schemaPath: path.join(root, 'schema.json'),
    outPath: path.join(root, 'out'),
    sessionLogPath: path.join(root, 'session.jsonl'),
  };
}

/**
 * Materializes the invocation workspace.
 *
 * The task and schema are written broker-owned and read-only; the output file
 * is owned by the enclave uid so the unprivileged enclave process can write to
 * it through its `rw` bind mount.
 */
function createInvocationWorkspace(params) {
  const { config, invocationId, task, schema } = params;
  const layout = invocationLayout(config.workDir, invocationId);

  fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });

  fs.writeFileSync(layout.taskPath, task, { mode: 0o444 });
  fs.chmodSync(layout.taskPath, 0o444);

  fs.writeFileSync(layout.schemaPath, JSON.stringify(schema), { mode: 0o444 });
  fs.chmodSync(layout.schemaPath, 0o444);

  fs.writeFileSync(layout.outPath, '', { mode: 0o600 });
  fs.chownSync(layout.outPath, config.enclaveUid, config.enclaveGid);
  fs.writeFileSync(layout.sessionLogPath, '', { mode: 0o600 });
  fs.chownSync(layout.sessionLogPath, config.enclaveUid, config.enclaveGid);

  return layout;
}

function preserveInvocationSession(sessionLogPath, auditDir, invocationId) {
  let sourceFd;
  try {
    sourceFd = fs.openSync(
      sessionLogPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    const stat = fs.fstatSync(sourceFd);
    if (!stat.isFile() || stat.size > 1024 * 1024) return false;
    const sessionsDir = path.join(auditDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    const destination = path.join(sessionsDir, `${invocationId}.jsonl`);
    const data = Buffer.alloc(stat.size);
    const bytesRead = fs.readSync(sourceFd, data, 0, stat.size, 0);
    fs.writeFileSync(destination, data.subarray(0, bytesRead), { mode: 0o600 });
    fs.chmodSync(destination, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
  }
}

/**
 * Reads the enclave's result file defensively.
 *
 * `O_NOFOLLOW` plus an explicit regular-file check means an enclave cannot make
 * the broker read something else by replacing the result file with a symlink,
 * FIFO, device, or socket. The size is checked against the configured exact
 * bound before any bytes are consumed. Anything unexpected returns `undefined`,
 * which the caller maps to the canonical error result.
 */
function readEnclaveOutput(outPath, maxOutputBytes) {
  let fd;
  try {
    fd = fs.openSync(outPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return undefined;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return undefined;
    if (stat.size > maxOutputBytes) return undefined;

    const buffer = Buffer.alloc(maxOutputBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxOutputBytes, 0);
    const slice = buffer.subarray(0, bytesRead);

    // Reject anything that is not valid UTF-8 before it reaches the parser.
    const text = slice.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(slice)) return undefined;

    return text;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Destroys an invocation workspace. Safe to call repeatedly. */
function destroyInvocationWorkspace(workDir, invocationId) {
  fs.rmSync(path.join(workDir, invocationId), { recursive: true, force: true, maxRetries: 3 });
}

module.exports = {
  invocationLayout,
  createInvocationWorkspace,
  readEnclaveOutput,
  preserveInvocationSession,
  destroyInvocationWorkspace,
};
