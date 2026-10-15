/* global require, module, Buffer, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const MAX_DIRECTORY_ENTRIES = 4096;
const ID = /^[a-f0-9]{32}$/;
const LOG_NAME = /^(?:launcher-(?:stdout|stderr)\.log|guest-(?:stdout|stderr)\.raw\.log|cloud-hypervisor\.log|serial\.log|network-plan\.json|network-diagnostics\.txt|counters\.json|vm-info\.json|runtime\.json|confinement\.json|virtiofs-[0-9]-(?:enclave-seed|enclave-request|enclave-output|enclave-runtime)(?:\.log|-confinement\.json))$/;
const ROOTS = {
  journal: '/var/lib/awf-cloud-hypervisor/host-executor-journal',
  debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/cloud-hypervisor',
};

function directory(target, uid) {
  let current = path.parse(target).root;
  for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0) ||
        (stat.mode & 0o022) !== 0) {
      throw new Error('Unsafe debug collection directory');
    }
  }
}

function inventory(target, uid) {
  try {
    directory(target, uid);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const names = fs.readdirSync(target);
  if (names.length > MAX_DIRECTORY_ENTRIES) throw new Error('Debug inventory exceeds bound');
  return names;
}

function readRegular(target, limit, uid) {
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW |
    fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid ||
        (stat.mode & 0o077) !== 0 || stat.size > limit) {
      throw new Error('Unsafe or oversized debug collection file');
    }
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new Error('Debug collection file grew beyond bound');
    return bytes.subarray(0, size);
  } finally {
    fs.closeSync(fd);
  }
}

function prepare(runDirectory, roots = ROOTS, uid = 0) {
  directory(path.dirname(runDirectory), uid);
  fs.mkdirSync(runDirectory, { mode: 0o700 });
  const baseline = {
    journals: inventory(roots.journal, uid).filter(name => name.endsWith('.journal')),
    debug: inventory(roots.debug, uid),
  };
  fs.writeFileSync(path.join(runDirectory, 'baseline.json'), JSON.stringify(baseline),
    { mode: 0o600, flag: 'wx' });
}

function collect(runDirectory, runnerUid, runnerGid, roots = ROOTS, uid = 0) {
  directory(runDirectory, uid);
  const baseline = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), 1024 * 1024, uid));
  const journals = inventory(roots.journal, uid)
    .filter(name => name.endsWith('.journal') && !baseline.journals.includes(name));
  const debug = inventory(roots.debug, uid).filter(name => !baseline.debug.includes(name));
  if (journals.length > 1 || debug.length > 1) throw new Error('Unexpected concurrent enclave runs');
  let invocation;
  if (journals.length) {
    const journal = journals[0];
    if (!/^[a-f0-9]{32}\.journal$/.test(journal)) throw new Error('Invalid journal identity');
    const records = readRegular(path.join(roots.journal, journal), 64 * 1024, uid)
      .toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    const runId = journal.slice(0, 32);
    if (records[0].runId !== runId || records[0].state !== 'open') {
      throw new Error('Journal run identity mismatch');
    }
    const invocations = records.filter(record => record.invocationId !== undefined);
    for (const record of invocations) {
      if (!ID.test(record.invocationId) ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(record.entryId)) {
        throw new Error('Invalid invocation identity');
      }
      const candidate = createHash('sha256').update(JSON.stringify([
        'awf-host-enclave-v1', runId, record.entryId, record.invocationId,
      ])).digest('hex').slice(0, 32);
      if (invocation && invocation !== candidate) throw new Error('Invocation budget exceeded');
      invocation = candidate;
    }
  }
  if (debug.length && (!ID.test(debug[0]) || debug[0] !== invocation)) {
    throw new Error('Debug artifacts do not belong to this run');
  }
  const files = [];
  if (debug.length) {
    const source = path.join(roots.debug, invocation);
    directory(source, uid);
    const names = inventory(source, uid);
    if (names.length > MAX_FILES) throw new Error('Debug file count exceeds bound');
    for (const name of names) {
      if (!LOG_NAME.test(name)) throw new Error('Unexpected debug artifact name');
      files.push([name, readRegular(path.join(source, name), MAX_STREAM_BYTES, uid)]);
    }
  }
  // Publish only after every source passes validation, outside all guest mounts.
  const upload = path.join(runDirectory, 'upload');
  fs.mkdirSync(upload, { mode: 0o700 });
  for (const [name, bytes] of files) {
    const target = path.join(upload, name);
    fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
    fs.chownSync(target, runnerUid, runnerGid);
  }
  const status = path.join(upload, 'collection-status.txt');
  fs.writeFileSync(status, files.length
    ? `Collected ${files.length} bounded public-fixture debug files.\n`
    : 'No public-fixture debug logs were produced for this run.\n', { mode: 0o600, flag: 'wx' });
  fs.chownSync(status, runnerUid, runnerGid);
  fs.chownSync(upload, runnerUid, runnerGid);
  fs.chmodSync(runDirectory, 0o711);
  return files.length;
}

module.exports = { prepare, collect, MAX_STREAM_BYTES, MAX_FILES };

if (require.main === module) {
  const [operation, key, runnerUid, runnerGid] = process.argv.slice(2);
  if (process.getuid() !== 0 || !/^[0-9]+-[0-9]+$/.test(key ?? '')) {
    throw new Error('Debug collector requires root and an Actions run/attempt identity');
  }
  const runDirectory = path.join('/var/lib/awf-enclave-smoke-export', key);
  if (operation === 'prepare') prepare(runDirectory);
  else if (operation === 'collect' && /^[0-9]+$/.test(runnerUid ?? '') &&
      /^[0-9]+$/.test(runnerGid ?? '')) {
    collect(runDirectory, Number(runnerUid), Number(runnerGid));
  } else throw new Error('Invalid debug collector operation');
}
