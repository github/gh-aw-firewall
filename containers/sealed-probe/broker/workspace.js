'use strict';

const fs = require('fs');
const path = require('path');
const { MAX_RESULT_BYTES } = require('./protocol');

/**
 * Per-invocation private workspace management.
 *
 * Every invocation receives a *fresh, full, writable copy* of exactly one
 * immutable seed. The seed itself is mounted read-only into the broker and is
 * never handed to a probe, so a probe can neither observe nor mutate it, nor
 * reach any other repository.
 *
 * Copy-on-write is deliberately not used: a full copy is the safe fallback and
 * this repository has no proof that a CoW snapshot cannot share metadata or
 * object storage across repositories/invocations.
 */

/** Layout of one invocation directory, relative to the broker's work dir. */
function invocationLayout(workDir, invocationId) {
  const root = path.join(workDir, invocationId);
  const probeDir = path.join(root, 'probe');
  return {
    root,
    probeDir,
    repoDir: path.join(probeDir, 'repo'),
    outPath: path.join(probeDir, 'out'),
    scriptPath: path.join(root, 'script.py'),
  };
}

/** Recursively grants the probe user ownership and write access to a tree. */
function grantProbeOwnership(target, uid, gid) {
  const stat = fs.lstatSync(target);
  fs.lchownSync(target, uid, gid);

  if (stat.isSymbolicLink()) return;

  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o700);
    for (const entry of fs.readdirSync(target)) {
      grantProbeOwnership(path.join(target, entry), uid, gid);
    }
    return;
  }

  fs.chmodSync(target, (stat.mode & 0o777) | 0o600);
}

/**
 * Materializes the invocation workspace: a private writable copy of the seed
 * plus the submitted script at its own path.
 */
function createInvocationWorkspace(params) {
  const { config, invocationId, seedId, script } = params;
  const layout = invocationLayout(config.workDir, invocationId);

  fs.mkdirSync(layout.probeDir, { recursive: true, mode: 0o700 });

  // Symlinks are copied as symlinks, never dereferenced: dereferencing would
  // let a seed's symlink pull in broker-container files, and inside the probe
  // a dangling/absolute symlink resolves within the probe's own rootfs.
  fs.cpSync(path.join(config.seedsDir, seedId), layout.repoDir, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    force: true,
    errorOnExist: false,
  });

  fs.writeFileSync(layout.scriptPath, script, { mode: 0o444 });
  fs.chmodSync(layout.scriptPath, 0o444);

  grantProbeOwnership(layout.probeDir, config.probeUid, config.probeGid);

  return layout;
}

/**
 * Reads the probe's result file defensively.
 *
 * `O_NOFOLLOW` plus an explicit regular-file check means a probe cannot make
 * the broker read something else by replacing `/probe/out` with a symlink,
 * FIFO, device, or socket. Anything unexpected returns `undefined`, which the
 * caller maps to the canonical error result.
 */
function readProbeOutput(outPath) {
  let fd;
  try {
    fd = fs.openSync(outPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return undefined;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_RESULT_BYTES) return undefined;

    const buffer = Buffer.alloc(MAX_RESULT_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, MAX_RESULT_BYTES, 0);
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
  readProbeOutput,
  destroyInvocationWorkspace,
};
