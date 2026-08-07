'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_RESULT_BYTES } = require('../../bounded-execution/finite-disclosure');

/**
 * Per-invocation private workspace management.
 *
 * Every invocation receives a fresh copy of exactly one immutable seed. The
 * copy is mounted read-only at an internal path and materialized by the fixed
 * query entrypoint into the size-limited tmpfs at `/query/repo`, where the
 * submitted script may modify it freely.
 *
 * `/query` is backed by a size-limited tmpfs so the query cannot create
 * unbounded numbers of files on the Docker host. The query writes its
 * answer to `/query/out`, which resolves to the pre-created `/awf/out` bind
 * outside the workspace tmpfs so Docker cannot mask the result channel,
 * contents the broker reads back from the host filesystem after the
 * container exits.
 */

/** Layout of one invocation directory, relative to the broker's work dir. */
function invocationLayout(workDir, invocationId) {
  const root = path.join(workDir, invocationId);
  return {
    root,
    // The seed copy is mounted read-only at /awf/seed for the fixed entrypoint.
    repoDir: path.join(root, 'repo'),
    // Pre-created empty file bound at /awf/out; the entrypoint links /query/out
    // to it after Docker mounts the bounded /query tmpfs.
    // its answer to the host filesystem; the broker reads it back after exit.
    outPath: path.join(root, 'out'),
    // The submitted script is bound read-only at queryScriptPath.
    scriptPath: path.join(root, 'script.py'),
  };
}

/** Recursively grants the query user ownership and write access to a tree. */
function grantQueryOwnership(target, uid, gid) {
  const stat = fs.lstatSync(target);
  fs.lchownSync(target, uid, gid);

  if (stat.isSymbolicLink()) return;

  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o700);
    for (const entry of fs.readdirSync(target)) {
      grantQueryOwnership(path.join(target, entry), uid, gid);
    }
    return;
  }

  fs.chmodSync(target, (stat.mode & 0o777) | 0o600);
}

/**
 * Materializes the invocation workspace: a private copy of the seed repo,
 * the submitted script, and a pre-created empty output file.
 *
 * The seed copy is mounted read-only for the fixed entrypoint, which copies it
 * into the bounded `/query` tmpfs. The output file is a bind-mounted regular
 * file owned by the query uid so the query can write its answer there.
 */
function createInvocationWorkspace(params) {
  const { config, invocationId, seedId, script } = params;
  const layout = invocationLayout(config.workDir, invocationId);

  fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });

  // Copy the seed to layout.repoDir. The copy is mounted read-only for
  // the fixed query entrypoint, but the broker-side copy
  // must be writable so the broker can delete it after the query exits.
  // FS permissions on the host do NOT enforce the query's read-only
  // constraint — the Docker mount flag does.
  fs.cpSync(path.join(config.seedsDir, seedId), layout.repoDir, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    force: true,
    errorOnExist: false,
  });

  // Ensure every entry in the repo copy is owner-writable so the broker
  // can remove it cleanly after the query exits. The seed is read-locked;
  // without this, rmSync on the invocation root would fail with EACCES.
  const makeOwnerWritable = (p) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) return;
      fs.chmodSync(p, stat.mode | (stat.isDirectory() ? 0o700 : 0o200));
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(p)) {
          makeOwnerWritable(path.join(p, entry));
        }
      }
    } catch {
      // best-effort
    }
  };
  makeOwnerWritable(layout.repoDir);

  // Script: broker-owned read-only on the host, mounted ro into the query.
  fs.writeFileSync(layout.scriptPath, script, { mode: 0o444 });
  fs.chmodSync(layout.scriptPath, 0o444);

  // Output file: pre-created as an empty file so Docker can bind-mount it
  // into the tmpfs-backed /query directory. Owned by the query uid so the
  // query process (--user queryUid:queryGid) can write to it.
  fs.writeFileSync(layout.outPath, '', { mode: 0o600 });
  fs.chownSync(layout.outPath, config.queryUid, config.queryGid);

  return layout;
}

/**
 * Reads the query's result file defensively.
 *
 * `O_NOFOLLOW` plus an explicit regular-file check means a query cannot make
 * the server read something else by replacing `/awf/out`,
 * FIFO, device, or socket. Anything unexpected returns `undefined`, which the
 * caller maps to the canonical error result.
 */
function readQueryOutput(outPath, maxResultBytes = MAX_RESULT_BYTES) {
  if (!Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1 || maxResultBytes > MAX_RESULT_BYTES) {
    return undefined;
  }
  let fd;
  try {
    fd = fs.openSync(outPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return undefined;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return undefined;
    if (stat.size > maxResultBytes) return undefined;

    const buffer = Buffer.alloc(maxResultBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxResultBytes, 0);
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
  readQueryOutput,
  destroyInvocationWorkspace,
};
