/* global require, module, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { check, MAX_DIRECTORY_ENTRIES } = require('./common.cjs');

function decodeUtf8(bytes, failedCheck) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { check(false, failedCheck, 'invalid-evidence'); }
}

function directory(target, uid, trustedRoot = '/', stickyAncestor) {
  const root = path.resolve(trustedRoot);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(root, resolvedTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    check(false, 'path-containment', 'unsafe-directory');
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      (rootStat.uid !== uid && rootStat.uid !== 0) || (rootStat.mode & 0o022) !== 0) {
    check(false, 'directory-metadata', 'unsafe-directory');
  }
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    const protectedStickyAncestor = current === stickyAncestor && current !== resolvedTarget
      && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !protectedStickyAncestor)) {
      check(false, 'directory-metadata', 'unsafe-directory');
    }
  }
}

function inventory(target, uid, trustedRoot) {
  try {
    directory(target, uid, trustedRoot);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const names = fs.readdirSync(target);
  check(names.length <= MAX_DIRECTORY_ENTRIES, 'inventory-count', 'oversized');
  return names;
}

function readRegular(target, limit, uid, observe) {
  observe?.('open');
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
    fs.constants.O_NONBLOCK);
  let failed = false;
  try {
    observe?.('fstat');
    const stat = fs.fstatSync(fd);
    observe?.('validate');
    check(stat.isFile(), 'file-type', 'unsafe-file');
    check(stat.nlink === 1, 'file-links', 'unsafe-file');
    check(stat.uid === uid, 'file-owner', 'unsafe-permissions');
    check((stat.mode & 0o7777) === 0o600, 'file-permissions', 'unsafe-permissions');
    check(stat.size <= limit, 'file-size', 'oversized');
    check(stat.dev === fs.lstatSync(path.dirname(target)).dev, 'file-device', 'unsafe-file');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      observe?.('read');
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    check(size <= limit, 'file-growth', 'oversized');
    return bytes.subarray(0, size);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (!failed) observe?.('close');
      fs.closeSync(fd);
    } catch (error) {
      observe?.('close');
      // eslint-disable-next-line no-unsafe-finally -- Preserve close failures as collection failures.
      throw error;
    }
  }
}

module.exports = { directory, inventory, readRegular, decodeUtf8 };
