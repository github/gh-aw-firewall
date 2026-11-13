'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const diagnosticCollector = require('../collect-enclave-smoke-debug.cjs');
const { HOST_EXECUTOR_ID_PATTERN } = require('../../../dist/enclave/host-executor-protocol');
const { HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY } = require('../../../dist/enclave/host-executor-journal');
const { mcpFailure, mcpFailures, mcpResponseMetadata, acceptanceCheck } = require('./mcp-client');
const { failedSpawns } = require('./startup-evidence');

function countBucket(count) {
  return count === 0 ? 'zero' : count === 1 ? 'one' : 'many';
}

function resourceRecords(directory, inventory = {}) {
  inventory.operation = 'directory-lstat';
  inventory.location = directory === HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY ? 'default' : 'custom';
  try {
    const stat = fs.lstatSync(directory);
    inventory.directory = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'ready' : 'not-directory';
    inventory.operation = 'directory-trust';
    diagnosticCollector.directory(directory, process.getuid());
    inventory.operation = 'directory-readdir';
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    inventory.entries = countBucket(entries.length);
    if (entries.length > 4096) throw new Error('Resource inventory exceeds bound');
    const regular = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink());
    inventory.regularFiles = countBucket(regular.length);
    const suffixed = regular.filter(entry => entry.name.endsWith('.resources.json'));
    inventory.resourceSuffix = countBucket(suffixed.length);
    const named = suffixed.filter(entry =>
      entry.name.slice(0, -'.resources.json'.length).split('-').length === 2
      && entry.name.slice(0, -'.resources.json'.length).split('-').every(id => HOST_EXECUTOR_ID_PATTERN.test(id)));
    inventory.nameMatches = countBucket(named.length);
    inventory.rejectedNames = countBucket(suffixed.length - named.length);
    return named.map(entry => {
      const file = path.join(directory, entry.name);
      inventory.operation = 'record-read';
      const bytes = diagnosticCollector.readRegular(file, 128 * 1024, process.getuid(),
        operation => { inventory.operation = `record-${operation}`; });
      inventory.operation = 'record-parse';
      const record = JSON.parse(bytes);
      inventory.operation = 'record-identity';
      if (!record || !['pending', 'cleaned'].includes(record.state)
          || !HOST_EXECUTOR_ID_PATTERN.test(record.runId || '')
          || !HOST_EXECUTOR_ID_PATTERN.test(record.invocationId || '')
          || entry.name !== `${record.runId}-${record.invocationId}.resources.json`) {
        throw new Error('Resource record identity differs from filename');
      }
      inventory.operation = 'complete';
      return { file, record };
    });
  } catch (cause) {
    inventory.code = ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'ELOOP'].includes(cause.code)
      ? cause.code : 'unknown';
    if (inventory.operation === 'directory-lstat') {
      inventory.directory = cause.code === 'ENOENT' ? 'missing' : 'unavailable';
    }
    const error = mcpFailure('resource-inventory-failed');
    mcpFailures.get(error).inventory = inventory;
    throw error;
  }
}

function readRecoveredInvocation(directory, file) {
  const inventory = {};
  const records = resourceRecords(directory, inventory);
  const match = records.find(record => record.file === file);
  if (!match) {
    const error = mcpFailure('recovery-record-missing');
    mcpFailures.get(error).inventory = inventory;
    throw error;
  }
  return { after: match.record, records, inventory };
}

function readCrashRecoveryBaseline(directory, active, ownerPid) {
  const { after, records, inventory } = readRecoveredInvocation(directory, active.file);
  const stableIdentity = record => {
    const identity = { ...record, storage: { ...record.storage } };
    delete identity.storage.mounts;
    delete identity.storage.pending;
    return identity;
  };
  const beforeMounts = active.record.storage?.mounts;
  const mounts = after.storage?.mounts;
  const baseline = {
    uniqueRecord: records.filter(({ record }) =>
      record.runId === active.record.runId && record.invocationId === active.record.invocationId).length === 1,
    pending: after.state === 'pending',
    ownerMatches: Number.isSafeInteger(ownerPid) && ownerPid > 0 && after.owner?.pid === ownerPid,
    identityMatches: isDeepStrictEqual(stableIdentity(after), stableIdentity(active.record)),
    mountsRetained: Array.isArray(beforeMounts) && Array.isArray(mounts)
      && beforeMounts.every((mount, index) => isDeepStrictEqual(mounts[index], mount)),
    mountsCommitted: after.storage?.pending === undefined
      && after.mountPending === false && after.snapshotPending === false,
    snapshotMounted: typeof after.snapshot?.path === 'string' && Array.isArray(mounts)
      && mounts.filter(mount => mount?.mountPoint === after.snapshot.path).length === 1,
  };
  if (Object.values(baseline).some(value => !value)) {
    const error = mcpFailure('crash-baseline-invalid');
    Object.assign(mcpFailures.get(error), { inventory, baseline });
    throw error;
  }
  return { record: after, inventory, baseline };
}

function resourceDiscoveryEvidence(directory, ownerPid, inventory) {
  const result = { ...inventory };
  let ownNamespace;
  result.namespaceOperation = 'observer-readlink';
  try {
    ownNamespace = fs.readlinkSync('/proc/self/ns/mnt');
    result.namespaceOperation = 'host-readlink';
    result.mountNamespace = ownNamespace === fs.readlinkSync(`/proc/${ownerPid}/ns/mnt`)
      ? 'same' : 'different';
    result.namespaceOperation = 'complete';
  } catch (error) {
    result.mountNamespace = 'unavailable';
    result.namespaceCode = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'unknown';
  }
  result.producer = 'missing';
  result.producerOperation = 'directory-trust';
  try {
    const diagnostics = path.join(directory, 'diagnostics');
    diagnosticCollector.directory(diagnostics, process.getuid());
    result.producerOperation = 'directory-readdir';
    const names = fs.readdirSync(diagnostics);
    if (names.length > 4096) throw new Error('Producer inventory exceeds bound');
    const files = names.filter(name => /^[a-f0-9]{16,64}-[a-f0-9]{32}\.json$/.test(name));
    if (files.length > 128) throw new Error('Producer diagnostics exceed bound');
    result.producerOperation = 'directory-lstat';
    const ownDirectory = fs.lstatSync(directory);
    let matches = 0;
    for (const name of files) {
      result.producerOperation = 'record-read';
      const bytes = diagnosticCollector.readRegular(
        path.join(diagnostics, name), 320 * 1024, process.getuid(),
        operation => { result.producerOperation = `record-${operation}`; },
      );
      result.producerOperation = 'record-parse';
      const value = JSON.parse(bytes);
      const evidence = value.resourcePublication;
      if (!evidence || evidence.ownerPid !== ownerPid) continue;
      matches += 1;
      result.producer = evidence.status;
      result.producerLocation = evidence.location;
      result.producerRecordSafe = evidence.recordSafe;
      result.producerDirectory = !evidence.directoryIdentity ? 'unavailable'
        : evidence.directoryIdentity.device === ownDirectory.dev && evidence.directoryIdentity.inode === ownDirectory.ino
          ? 'same' : 'different';
      result.producerNamespace = !ownNamespace || !evidence.mountNamespace ? 'unavailable'
        : ownNamespace === evidence.mountNamespace ? 'same' : 'different';
      const active = !value.milestones?.some(event => event.phase === 'cleanup-start');
      result.producerActive = active;
      if (active) break;
    }
    result.producerMatches = countBucket(matches);
    result.producerOperation = 'complete';
  } catch (error) {
    result.producer = 'read-failed';
    result.producerCode = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code) ? error.code : 'unknown';
  }
  return result;
}

function observeInvocationRecords(records, existing, ownerPid) {
  const counts = {};
  let candidates = records.filter(({ file }) => !existing.has(file));
  const bucket = count => count === 0 ? 'zero' : count === 1 ? 'one' : 'many';
  counts.newRecords = bucket(candidates.length);
  for (const [key, predicate] of [
    ['pending', value => value.state === 'pending'],
    ['ownerMatches', value => value.owner?.pid === ownerPid],
    ['directoryReady', value => Boolean(value.storage?.directory)],
    ['identityReady', value => Boolean(value.directoryIdentity)],
    ['snapshotReady', value => Boolean(value.snapshot)],
  ]) {
    candidates = candidates.filter(({ record }) => predicate(record));
    counts[key] = bucket(candidates.length);
  }
  counts.eligible = bucket(candidates.length);
  return { counts, record: candidates[0] };
}

async function waitForInvocationRecord(directory, existing, ownerPid, timeoutMs, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const read = dependencies.read || resourceRecords;
  const deadline = now() + timeoutMs;
  let counts;
  let lastInventory;
  while (now() < deadline) {
    let observation;
    const inventory = {};
    try {
      observation = observeInvocationRecords(read(directory, inventory), existing, ownerPid);
    } catch (cause) {
      const error = mcpFailures.has(cause) ? cause : mcpFailure('resource-inventory-failed');
      Object.assign(mcpFailures.get(error), { resources: counts,
        inventory: resourceDiscoveryEvidence(directory, ownerPid, mcpFailures.get(error).inventory || inventory) });
      throw error;
    }
    counts = observation.counts;
    const record = observation.record;
    if (record) return { ...record, inventory: resourceDiscoveryEvidence(directory, ownerPid, inventory) };
    lastInventory = inventory;
    await sleep(100);
  }
  const error = mcpFailure('resource-discovery-timeout');
  mcpFailures.get(error).resources = counts;
  mcpFailures.get(error).inventory = resourceDiscoveryEvidence(directory, ownerPid, lastInventory);
  throw error;
}

async function waitForInvocationOutcome(directory, identity, expected, timeoutMs = 15_000, dependencies = {}) {
  if (!HOST_EXECUTOR_ID_PATTERN.test(identity.runId || '')
      || !HOST_EXECUTOR_ID_PATTERN.test(identity.invocationId || '')
      || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(identity.entryId || '')
      || !['timeout', 'cancelled'].includes(expected)) {
    throw mcpFailure('invocation-evidence-invalid');
  }
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const read = dependencies.read || (() => {
    diagnosticCollector.directory(directory, process.getuid());
    return diagnosticCollector.readRegular(
      path.join(directory, `${identity.runId}.journal`), 1024 * 1024, process.getuid(),
    ).toString('utf8');
  });
  const deadline = now() + timeoutMs;
  const expectedDigest = require('../../../dist/enclave/host-executor-protocol').hostExecutorResultDigest(expected);
  while (now() < deadline) {
    let records;
    try {
      records = read().trim().split('\n').map(line => JSON.parse(line));
      if (records[0]?.runId !== identity.runId) throw new Error('Invalid run identity');
    } catch {
      throw mcpFailure('invocation-evidence-invalid');
    }
    const terminal = records.filter(record => record.entryId === identity.entryId
      && record.invocationId === identity.invocationId && ['terminal', 'settled'].includes(record.state));
    if (terminal.some(record => (record.state === 'terminal' && record.outcome !== expected)
        || record.resultDigest !== expectedDigest)) throw mcpFailure('invocation-outcome-mismatch');
    if (terminal.some(record => record.state === 'terminal')
        && terminal.some(record => record.state === 'settled')) return;
    await sleep(100);
  }
  throw mcpFailure('invocation-evidence-timeout');
}

function findProcessForSocket(apiSocketPath) {
  for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    let commandLine;
    try {
      commandLine = fs.readFileSync(path.join('/proc', entry.name, 'cmdline'));
    } catch {
      continue;
    }
    if (commandLine.includes(Buffer.from(apiSocketPath, 'utf8'))) return Number(entry.name);
  }
  return undefined;
}

async function waitForPath(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink()) return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Live enclave guest did not reach its bounded crash-probe marker');
}

function assertNoSuccessfulResult(response) {
  if (response?.result?.structuredContent?.status === 'ok') {
    const error = new Error('Interrupted live enclave invocation returned a successful result');
    mcpFailures.set(error, { reason: 'interrupted-success', ...mcpResponseMetadata(response, 12) });
    throw error;
  }
}

function assertRecoveredInvocation(before, after, records) {
  const matches = records.filter(({ record }) =>
    record.runId === before.runId && record.invocationId === before.invocationId);
  const recovery = {
    uniqueRecord: matches.length === 1,
    cleaned: after?.state === 'cleaned',
    runMatches: after?.runId === before.runId,
    invocationMatches: after?.invocationId === before.invocationId,
    directoryIdentityPresent: !!before.directoryIdentity,
    storageDirectoryIdentityPresent: !!before.storage?.directoryIdentity,
    storageMountedIdentityPresent: !!before.storage?.mountedIdentity,
    snapshotPresent: !!before.snapshot,
    directoryMatches: isDeepStrictEqual(after?.directory, before.directory),
    directoryIdentityMatches: isDeepStrictEqual(after?.directoryIdentity, before.directoryIdentity),
    ancestorsMatch: isDeepStrictEqual(after?.ancestors, before.ancestors),
    mountMatches: isDeepStrictEqual(after?.mount, before.mount),
    snapshotMatches: isDeepStrictEqual(after?.snapshot, before.snapshot),
    storageDirectoryMatches: isDeepStrictEqual(after?.storage?.directory, before.storage?.directory),
    storageParentIdentityMatches: isDeepStrictEqual(after?.storage?.parentIdentity, before.storage?.parentIdentity),
    storageAncestorsMatch: isDeepStrictEqual(after?.storage?.ancestors, before.storage?.ancestors),
    storageDirectoryIdentityMatches: isDeepStrictEqual(
      after?.storage?.directoryIdentity, before.storage?.directoryIdentity,
    ),
    storageMountedIdentityMatches: isDeepStrictEqual(after?.storage?.mountedIdentity, before.storage?.mountedIdentity),
    storageMountsMatch: isDeepStrictEqual(after?.storage?.mounts, before.storage?.mounts),
  };
  if (Object.values(recovery).some(value => !value)) {
    const error = new Error('Live VMM crash recovery did not clean the exact interrupted invocation');
    mcpFailures.set(error, { reason: 'recovery-validation-failed', recovery });
    throw error;
  }
  return recovery;
}

function killAwfForRecovery(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null || failedSpawns.has(child)) {
      reject(mcpFailure('host-already-exited'));
      return;
    }
    const finish = (error) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = () => finish(mcpFailure('host-kill-failed'));
    const timer = setTimeout(() => finish(mcpFailure('host-exit-timeout')), timeoutMs);
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      if (!child.kill('SIGKILL') && child.exitCode === null && child.signalCode === null) {
        finish(mcpFailure('host-kill-failed'));
      }
    } catch (cause) {
      const error = mcpFailure('host-kill-failed');
      mcpFailures.get(error).code = cause?.code;
      finish(error);
    }
  });
}

async function withCrashRecoveryCleanup(context, action, cleanups, onCleanupFailure) {
  try {
    return await action();
  } catch (error) {
    for (const { phase, action: cleanup } of cleanups) {
      try {
        await acceptanceCheck(context, 'crash-recovery', phase, cleanup);
      } catch {
        onCleanupFailure();
      }
    }
    throw error;
  }
}

module.exports = {
  countBucket,
  resourceRecords,
  readRecoveredInvocation,
  readCrashRecoveryBaseline,
  resourceDiscoveryEvidence,
  observeInvocationRecords,
  waitForInvocationRecord,
  waitForInvocationOutcome,
  findProcessForSocket,
  waitForPath,
  assertNoSuccessfulResult,
  assertRecoveredInvocation,
  killAwfForRecovery,
  withCrashRecoveryCleanup,
};
