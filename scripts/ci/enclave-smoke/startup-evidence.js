'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Match only the first fatal header, never stdout, stack frames, or cleanup warnings.
const STARTUP_CATEGORIES = new Map([
  ['The Docker primary-agent runtime is unavailable; enclaves never fall back', 'container-runtime'],
  ['Cloud Hypervisor enclave runtime configuration is missing', 'configuration'],
  ['Cloud Hypervisor enclaves require a staged trusted run ID', 'configuration'],
  ['Preflight storage requires root-owned trusted directories', 'host-preflight'],
  ['Preflight storage requires a normalized absolute directory', 'host-preflight'],
  ['Trusted enclave artifact has invalid file metadata', 'artifact'],
  ['Trusted enclave artifact has invalid content size', 'artifact'],
  ['Enclave artifact manifest bundle must use its fixed release filename', 'artifact'],
  ['Cloud Hypervisor enclave host service could not start', 'host-service'],
  ['Unsafe Cloud Hypervisor enclave recovery directory; private state is preserved', 'recovery-state'],
  ['Trusted enclave MCP gateway container is unavailable', 'broker'],
  ['Trusted enclave MCP gateway identity could not be inspected', 'broker'],
  ['Trusted enclave MCP gateway identity did not match the compiler handoff', 'broker'],
  ['Enclave MCP control network is unavailable', 'broker'],
  ['Failed to attach the trusted enclave MCP gateway to its private control network', 'broker'],
]);

for (const tool of ['mount', 'umount', 'rsync']) {
  STARTUP_CATEGORIES.set(`Bounded enclave preflight requires trusted host tool "${tool}"`, 'host-preflight');
}

for (const role of ['script', 'agent']) {
  STARTUP_CATEGORIES.set(
    `${role} enclave rootfs does not match its trusted manifest digest and size`, 'artifact',
  );
  STARTUP_CATEGORIES.set(
    `${role} enclave rootfs SBOM does not match its trusted manifest digest`, 'artifact',
  );
}

const failedSpawns = new WeakSet();

const { schema: hostPreflightSchema } = require('../../../dist/cloud-hypervisor/host-preflight-schema');

const mountTopologySchema = require('../../../src/cloud-hypervisor/mount-topology-schema.json');

const storagePropagationSchema = require('../../../src/cloud-hypervisor/storage-propagation-schema.json');

function safeStoragePropagation(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !==
      '["destinationBeforeBind","invocationLocation","mounts","schemaVersion","sourceBeforeBind"]'
      || value.schemaVersion !== 1 || !storagePropagationSchema.location.includes(value.invocationLocation)
      || [value.sourceBeforeBind, value.destinationBeforeBind].some((item) =>
        item !== null && !storagePropagationSchema.propagation.includes(item))
      || !value.mounts || JSON.stringify(Object.keys(value.mounts).sort()) !==
        JSON.stringify([...storagePropagationSchema.mounts].sort())) return undefined;
  const mounts = {};
  for (const key of storagePropagationSchema.mounts) {
    const item = value.mounts[key];
    if (item !== null && (!Array.isArray(item) || item.length !== 4
        || JSON.stringify(Object.keys(item)) !== '["0","1","2","3"]'
        || item.some((field, index) => !storagePropagationSchema.observation[index].includes(field)))) return undefined;
    mounts[key] = item === null ? null : [...item];
  }
  return {
    schemaVersion: 1, invocationLocation: value.invocationLocation,
    sourceBeforeBind: value.sourceBeforeBind, destinationBeforeBind: value.destinationBeforeBind, mounts,
  };
}

function safeMountTopology(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== '["after","before","bindCalls","schemaVersion"]'
      || value.schemaVersion !== 1 || !['zero', 'one', 'multiple'].includes(value.bindCalls)) return undefined;
  const observation = (item) => {
    if (item === null) return null;
    if (!item || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(Object.keys(mountTopologySchema).sort())) {
      return undefined;
    }
    const safe = {};
    for (const [key, values] of Object.entries(mountTopologySchema)) {
      if (!values.includes(item[key])) return undefined;
      safe[key] = item[key];
    }
    return safe;
  };
  const before = observation(value.before);
  const after = observation(value.after);
  if (before === undefined || after === undefined) return undefined;
  return { schemaVersion: 1, bindCalls: value.bindCalls, before, after };
}

function safeHostPreflight(value) {
  const keys = ['checks', 'schemaVersion', 'scope'];
  if (value?.schemaVersion === 2) keys.push('phase', 'profile');
  if (value && Object.prototype.hasOwnProperty.call(value, 'mountTopology')) keys.push('mountTopology');
  if (value && Object.prototype.hasOwnProperty.call(value, 'storagePropagation')) keys.push('storagePropagation');
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
      || ![1, 2].includes(value.schemaVersion)
      || (value.schemaVersion === 2
        && (!['preflight', 'execution', 'cleanup', 'persistence'].includes(value.phase)
          || !['common', 'primary', 'script', 'agent'].includes(value.profile)))
      || typeof value.scope !== 'string'
      || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.scopes, value.scope)
      || !Array.isArray(value.checks)) return undefined;
  const expected = Object.keys(hostPreflightSchema.scopes[value.scope]);
  if (value.checks.length !== expected.length) return undefined;
  const checks = [];
  for (let index = 0; index < expected.length; index += 1) {
    const check = value.checks[index];
    if (!check || JSON.stringify(Object.keys(check).sort()) !== '["id","reason","result"]'
        || check.id !== expected[index]
        || !['not-attempted', 'not-required', 'attempted', 'passed', 'failed'].includes(check.result)
        || typeof check.reason !== 'string'
        || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.reasons, check.reason)
        || (check.result === 'failed' ? check.reason === 'none' : check.reason !== 'none')
        || (check.result === 'not-required'
          && !hostPreflightSchema.optionalChecks.includes(`${value.scope}/${check.id}`))) {
      return undefined;
    }
    checks.push({ id: check.id, result: check.result, reason: check.reason });
  }
  const mountTopology = value.mountTopology === undefined ? undefined : safeMountTopology(value.mountTopology);
  if (Object.prototype.hasOwnProperty.call(value, 'mountTopology') && !mountTopology) return undefined;
  const storagePropagation = value.storagePropagation === undefined ? undefined : safeStoragePropagation(value.storagePropagation);
  if (Object.prototype.hasOwnProperty.call(value, 'storagePropagation') && !storagePropagation) return undefined;
  return {
    schemaVersion: value.schemaVersion, scope: value.scope,
    ...(value.schemaVersion === 2 ? { phase: value.phase, profile: value.profile } : {}),
    checks, ...(mountTopology ? { mountTopology } : {}),
    ...(storagePropagation ? { storagePropagation } : {}),
  };
}

function safeStartupChecklist(value) {
  if (!value || JSON.stringify(Object.keys(value).sort()) !== '["checks","ready","schemaVersion"]'
      || value.schemaVersion !== 1 || typeof value.ready !== 'boolean'
      || !value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)) return undefined;
  const checks = {};
  const scopes = new Set();
  for (const [id, outcome] of Object.entries(value.checks)) {
    const [scope, check, extra] = id.split('/');
    if (extra !== undefined || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.scopes, scope)
        || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.scopes[scope], check)
        || !Array.isArray(outcome) || outcome.length !== 2
        || !['not-attempted', 'not-required', 'attempted', 'passed', 'failed'].includes(outcome[0])
        || typeof outcome[1] !== 'string'
        || !Object.prototype.hasOwnProperty.call(hostPreflightSchema.reasons, outcome[1])
        || (outcome[0] === 'failed' ? outcome[1] === 'none' : outcome[1] !== 'none')
        || (outcome[0] === 'not-required' && !hostPreflightSchema.optionalChecks.includes(id))) return undefined;
    checks[id] = [outcome[0], outcome[1]];
    scopes.add(scope);
  }
  for (const scope of scopes) {
    if (Object.keys(hostPreflightSchema.scopes[scope]).some((id) =>
      !Object.prototype.hasOwnProperty.call(checks, `${scope}/${id}`))) return undefined;
  }
  if (value.ready && (checks['startup/readiness']?.[0] !== 'passed'
    || Object.values(checks).some(([result]) => result !== 'passed' && result !== 'not-required'))) return undefined;
  return { schemaVersion: 1, ready: value.ready, checks };
}

const ENCLAVE_STARTUP_STAGES = [
  'host-bootstrap', 'runtime-preflight', 'configuration', 'enclave-preflight',
  'host-preflight', 'artifact-preflight', 'seed-staging', 'storage-preflight',
  'recovery', 'host-service',
  'host-network', 'compose-config', 'containers', 'gateway-attach',
  'github-readiness', 'gateway-contract', 'initialize', 'initialized',
  'tools-list', 'delegation', 'primary-agent',
];

function safeEnclaveStartup(value) {
  const keys = ['attempts', 'code', 'httpStatus', 'perspective', 'readiness', 'schemaVersion', 'stage'];
  if (value && Object.prototype.hasOwnProperty.call(value, 'hostPreflight')) keys.push('hostPreflight');
  if (value && Object.prototype.hasOwnProperty.call(value, 'startupChecks')) keys.push('startupChecks');
  if (value && Object.prototype.hasOwnProperty.call(value, 'mountTopology')) keys.push('mountTopology');
  if (value && Object.prototype.hasOwnProperty.call(value, 'storagePropagation')) keys.push('storagePropagation');
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort())
      || value.schemaVersion !== 1 || value.perspective !== 'awf-host'
      || !ENCLAVE_STARTUP_STAGES.includes(value.stage)
      || !['not-attempted', 'attempted', 'ready'].includes(value.readiness)
      || ![
        'none', 'unknown', 'dns-not-found', 'dns-temporary', 'connection-refused',
        'connection-timeout', 'request-timeout', 'network-unreachable', 'host-unreachable',
        'connection-reset', 'transport-other', 'http-auth', 'http-status',
        'backend-unavailable', 'response-too-large', 'malformed-json',
        'malformed-protocol', 'rpc-error', 'identity-mismatch', 'tools-mismatch', 'readiness-deadline', 'ready',
      ].includes(value.code)
      || !Number.isInteger(value.attempts) || value.attempts < 0 || value.attempts > 1200
      || !(value.httpStatus === null
        || (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599))
      || (value.readiness === 'not-attempted'
        && (value.attempts !== 0 || !['none', 'unknown', 'readiness-deadline'].includes(value.code)))
      || (value.readiness !== 'not-attempted' && value.attempts === 0)
      || (value.readiness === 'ready'
        && (value.code !== 'ready' || !['tools-list', 'delegation', 'primary-agent'].includes(value.stage)))) {
    return undefined;
  }
  const hostPreflight = value.hostPreflight === undefined ? undefined : safeHostPreflight(value.hostPreflight);
  if (Object.prototype.hasOwnProperty.call(value, 'hostPreflight') && !hostPreflight) return undefined;
  const startupChecks = value.startupChecks === undefined ? undefined : safeStartupChecklist(value.startupChecks);
  if (Object.prototype.hasOwnProperty.call(value, 'startupChecks') && !startupChecks) return undefined;
  const mountTopology = value.mountTopology === undefined ? undefined : safeMountTopology(value.mountTopology);
  if (Object.prototype.hasOwnProperty.call(value, 'mountTopology') && !mountTopology) return undefined;
  const storagePropagation = value.storagePropagation === undefined ? undefined : safeStoragePropagation(value.storagePropagation);
  if (Object.prototype.hasOwnProperty.call(value, 'storagePropagation') && !storagePropagation) return undefined;
  return {
    schemaVersion: 1, perspective: 'awf-host', stage: value.stage,
    readiness: value.readiness, code: value.code, attempts: value.attempts,
    httpStatus: value.httpStatus,
    ...(hostPreflight ? { hostPreflight } : {}),
    ...(startupChecks ? { startupChecks } : {}),
    ...(mountTopology ? { mountTopology } : {}),
    ...(storagePropagation ? { storagePropagation } : {}),
  };
}

function gatewayCategory(code) {
  if (['dns-not-found', 'dns-temporary'].includes(code)) return 'dns';
  if ([
    'connection-refused', 'connection-timeout', 'request-timeout', 'network-unreachable',
    'host-unreachable', 'connection-reset',
  ].includes(code)) return 'connectivity';
  if (code === 'http-auth') return 'gateway-auth';
  if (code === 'backend-unavailable' || code === 'readiness-deadline') return 'gateway-readiness';
  if ([
    'http-status', 'response-too-large', 'malformed-json', 'malformed-protocol',
    'rpc-error', 'identity-mismatch', 'tools-mismatch',
  ].includes(code)) return 'gateway-protocol';
  if (code === 'transport-other') return 'other';
  return undefined;
}

function trackAwfChild(child) {
  awfStartTimes.set(child, Date.now());
  child.on('error', () => {
    if (!child.pid) failedSpawns.add(child);
  });
  return child;
}

// Bounds are deliberately generous: later startup stages carry more checks and
// --build-local compose output reaches AWF stderr. Only fixed codes leave this module.
const STARTUP_RECORD_MAX_BYTES = 64 * 1024;

const STDERR_SCAN_MAX_BYTES = 8 * 1024 * 1024;

const STDERR_TAIL_BYTES = 1024 * 1024;

const STABLE_READ_ATTEMPTS = 5;

const STABLE_READ_DELAY_MS = 200;

const startupRecordCache = new Map();

const awfStartTimes = new WeakMap();

function sizeBucket(size) {
  if (!Number.isInteger(size) || size < 0) return null;
  if (size === 0) return 'empty';
  if (size <= 16 * 1024) return '<=16KiB';
  if (size <= 64 * 1024) return '<=64KiB';
  if (size <= 1024 * 1024) return '<=1MiB';
  if (size <= 8 * 1024 * 1024) return '<=8MiB';
  return '>8MiB';
}

function elapsedBucket(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  for (const [limit, label] of [
    [60_000, '<1m'], [3 * 60_000, '<3m'], [5 * 60_000, '<5m'], [8 * 60_000, '<8m'],
    [10 * 60_000, '<10m'], [15 * 60_000, '<15m'],
  ]) {
    if (ms < limit) return label;
  }
  return '>=15m';
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Returns a fixed outcome code plus bytes only from a regular, unlinked-safe file.
// Oversized files either fail ("oversize") or, when tailBytes is set, yield a
// stable tail ("tail"). Changing files are retried on the same inode before
// reporting "unstable"; a different inode reports "replaced".
function inspectDiagnosticFile(file, maxBytes, {
  tailBytes, attempts = STABLE_READ_ATTEMPTS, ownerOnly = false,
} = {}) {
  let result = { outcome: 'io-error', size: null, attempts: 0 };
  let identity;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY
        | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) return { outcome: 'not-regular', size: null, attempts: attempt };
      if (ownerOnly && (stat.uid !== process.getuid() || stat.nlink !== 1
          || (stat.mode & 0o777) !== 0o600)) {
        return { outcome: 'unsafe-owner', size: null, attempts: attempt };
      }
      // Retries must observe the same inode; a replaced pathname is never trusted.
      if (identity && (identity.dev !== stat.dev || identity.ino !== stat.ino)) {
        return { outcome: 'replaced', size: null, attempts: attempt };
      }
      identity = { dev: stat.dev, ino: stat.ino };
      let offset = 0;
      let length = stat.size;
      let outcome = 'ok';
      if (stat.size > maxBytes) {
        if (!tailBytes) return { outcome: 'oversize', size: stat.size, attempts: attempt };
        offset = stat.size - tailBytes;
        length = tailBytes;
        outcome = 'tail';
      }
      const buffer = Buffer.alloc(length + 1);
      let size = 0;
      while (size < buffer.length) {
        const bytes = fs.readSync(descriptor, buffer, size, buffer.length - size, offset + size);
        if (bytes === 0) break;
        size += bytes;
      }
      const after = fs.fstatSync(descriptor);
      if (size !== length || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
          || after.ctimeMs !== stat.ctimeMs) {
        result = { outcome: 'unstable', size: after.size, attempts: attempt };
      } else {
        return { outcome, size: stat.size, attempts: attempt, buffer: buffer.subarray(0, size) };
      }
    } catch (error) {
      if (error.code === 'ENOENT') return { outcome: 'missing', size: null, attempts: attempt };
      if (error.code === 'ELOOP') return { outcome: 'not-regular', size: null, attempts: attempt };
      return { outcome: 'io-error', size: null, attempts: attempt };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    if (attempt < attempts) sleepSync(STABLE_READ_DELAY_MS);
  }
  return result;
}

function parseStartupRecord(buffer) {
  let record;
  try {
    record = JSON.parse(buffer.toString('utf8'));
  } catch {
    return { outcome: 'parse' };
  }
  if ((record?.phase === 'startup'
      || (record?.phase === 'enclave-startup-progress'
        && record.message === 'Enclave startup in progress'))
      && typeof record.message === 'string'
      && typeof record.timestamp === 'string'
      && [
        '["message","phase","timestamp"]',
        '["enclaveStartup","message","phase","timestamp"]',
      ].includes(JSON.stringify(Object.keys(record).sort()))) {
    return { outcome: 'valid', record };
  }
  return { outcome: 'shape' };
}

// Caches the last validated record so AWF cleanup removing its work directory
// cannot erase the only failure evidence before the probe reads it.
function cacheStartupRecord(file) {
  if (!file) return undefined;
  const inspected = inspectDiagnosticFile(file, STARTUP_RECORD_MAX_BYTES, { attempts: 1 });
  if (inspected.outcome !== 'ok') return undefined;
  const parsed = parseStartupRecord(inspected.buffer);
  if (parsed.outcome !== 'valid') return undefined;
  const previous = startupRecordCache.get(file);
  startupRecordCache.set(file, {
    record: parsed.record, size: inspected.size, polls: (previous?.polls ?? 0) + 1,
  });
  return parsed.record;
}

const EXIT_MARKER = 'AWF_STARTUP_EXIT ';

const EARLY_FAILURE_MARKER = 'AWF_EARLY_STARTUP_FAILURE ';

const earlyStartupSchema = require('../../../src/logs/early-startup-schema.json');

const WRITE_OUTCOMES = ['written', 'oversize', 'unsafe-target', 'io-error', 'error', 'not-attempted'];

function safeEarlyFailureMarker(line) {
  try {
    const value = JSON.parse(line.slice(EARLY_FAILURE_MARKER.length));
    if (!value || JSON.stringify(Object.keys(value).sort()) !== '["phase","reason","schemaVersion"]'
        || value.schemaVersion !== 1
        || typeof value.phase !== 'string' || typeof value.reason !== 'string'
        || !Object.hasOwn(earlyStartupSchema.phases, value.phase)
        || !Object.hasOwn(earlyStartupSchema.reasons, value.reason)) return undefined;
    return { schemaVersion: 1, phase: value.phase, reason: value.reason };
  } catch {
    return undefined;
  }
}

function safeExitMarker(line) {
  let value;
  try {
    value = JSON.parse(line.slice(EXIT_MARKER.length));
  } catch {
    return undefined;
  }
  const keys = '["agentStarted","cleanup","containersStarted","elapsed","exitCode","failedCheck",'
    + '"lastProgressWrite","path","progressWriteFailures","recordAfterCleanup","recordWrite",'
    + '"schemaVersion","stage"]';
  if (!value || typeof value !== 'object' || JSON.stringify(Object.keys(value).sort()) !== keys
      || value.schemaVersion !== 1
      || !['fatal', 'workflow-return'].includes(value.path)
      || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255
      || !(value.stage === null || ENCLAVE_STARTUP_STAGES.includes(value.stage))
      || !(value.failedCheck === null || (typeof value.failedCheck === 'string'
        && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(value.failedCheck)
        && Object.prototype.hasOwnProperty.call(hostPreflightSchema.scopes, value.failedCheck.split('/')[0])
        && Object.prototype.hasOwnProperty.call(
          hostPreflightSchema.scopes[value.failedCheck.split('/')[0]],
          value.failedCheck.split('/')[1],
        )))
      || typeof value.containersStarted !== 'boolean' || typeof value.agentStarted !== 'boolean'
      || !WRITE_OUTCOMES.includes(value.recordWrite)
      || !WRITE_OUTCOMES.includes(value.lastProgressWrite)
      || !Number.isInteger(value.progressWriteFailures) || value.progressWriteFailures < 0
      || value.progressWriteFailures > 1_000_000
      || !['pending', 'completed', 'failed'].includes(value.cleanup)
      || !['present', 'missing', 'unknown'].includes(value.recordAfterCleanup)
      || !(value.elapsed === null || [
        '<1m', '<3m', '<5m', '<8m', '<10m', '<15m', '>=15m',
      ].includes(value.elapsed))) return undefined;
  return {
    schemaVersion: 1, path: value.path, exitCode: value.exitCode, stage: value.stage,
    failedCheck: value.failedCheck, containersStarted: value.containersStarted,
    agentStarted: value.agentStarted, recordWrite: value.recordWrite,
    lastProgressWrite: value.lastProgressWrite,
    progressWriteFailures: value.progressWriteFailures, cleanup: value.cleanup,
    recordAfterCleanup: value.recordAfterCleanup, elapsed: value.elapsed,
  };
}

function collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile) {
  let category = 'unknown';
  let logInspection = 'unavailable';
  let enclaveStartup;
  let earlyFailure;
  let cachedRecordApplied = false;
  const evidence = {
    schemaVersion: 1,
    record: { final: 'not-attempted', size: null, source: 'none', cachedPolls: 0, cachedSize: null },
    stderr: { inspection: 'not-attempted', size: null, attempts: 0 },
    awfExit: null,
    awfExitMarkers: 0,
    elapsed: child && awfStartTimes.has(child) ? elapsedBucket(Date.now() - awfStartTimes.get(child)) : null,
  };
  const applyRecord = (record) => {
    category = STARTUP_CATEGORIES.get(record.message) || 'unknown';
    logInspection = 'structured';
    enclaveStartup = safeEnclaveStartup(record.enclaveStartup);
    if (enclaveStartup) {
      category = gatewayCategory(enclaveStartup.code)
        || (enclaveStartup.hostPreflight?.checks.some((check) => check.result === 'failed')
          || Object.values(enclaveStartup.startupChecks?.checks ?? {}).some(([result]) => result === 'failed')
          ? 'host-preflight' : category);
    }
  };
  if (reason !== 'spawn-failure' && startupErrorFile) {
    const inspected = inspectDiagnosticFile(startupErrorFile, STARTUP_RECORD_MAX_BYTES);
    evidence.record.size = sizeBucket(inspected.size);
    evidence.record.final = inspected.outcome;
    if (inspected.outcome === 'ok') {
      const parsed = parseStartupRecord(inspected.buffer);
      evidence.record.final = parsed.outcome;
      if (parsed.outcome === 'valid') {
        applyRecord(parsed.record);
        evidence.record.source = 'final';
      }
    }
    const cached = startupRecordCache.get(startupErrorFile);
    if (cached) {
      evidence.record.cachedPolls = Math.min(cached.polls, 1_000_000);
      evidence.record.cachedSize = sizeBucket(cached.size);
      if (evidence.record.source === 'none') {
        applyRecord(cached.record);
        evidence.record.source = 'cached';
        cachedRecordApplied = true;
      }
    }
  }
  if (reason !== 'spawn-failure') {
    const inspected = inspectDiagnosticFile(stderrFile, STDERR_SCAN_MAX_BYTES, { tailBytes: STDERR_TAIL_BYTES });
    evidence.stderr = {
      inspection: inspected.outcome, size: sizeBucket(inspected.size), attempts: inspected.attempts,
    };
    if (inspected.buffer) {
      const lines = inspected.buffer.toString('utf8').split('\n');
      for (const line of lines.filter(line => line.startsWith(EARLY_FAILURE_MARKER)).reverse()) {
        earlyFailure = safeEarlyFailureMarker(line);
        if (earlyFailure) break;
      }
      if (earlyFailure && !enclaveStartup) category = earlyStartupSchema.reasons[earlyFailure.reason];
      const markers = lines.filter((line) => line.startsWith(EXIT_MARKER));
      evidence.awfExitMarkers = Math.min(markers.length, 1000);
      for (const line of markers.reverse()) {
        const marker = safeExitMarker(line);
        if (marker) {
          evidence.awfExit = marker;
          break;
        }
      }
      if (logInspection !== 'structured') logInspection = 'bounded';
      if (category === 'unknown' && (logInspection !== 'structured' || cachedRecordApplied)) {
        const header = lines.find((line) => line.startsWith('[ERROR] Fatal error: '));
        const prefix = '[ERROR] Fatal error: Error: ';
        if (header?.startsWith(prefix)) {
          category = STARTUP_CATEGORIES.get(header.slice(prefix.length)) || 'unknown';
        } else if (header?.startsWith('[ERROR] Fatal error: CloudHypervisorUnsupportedHostError: ')) {
          category = 'unsupported-host';
        }
      }
    }
  }
  const diagnostic = {
    schemaVersion: enclaveStartup ? 2 : 1,
    phase: enclaveStartup ? 'host-startup' : 'pre-broker',
    stage: stage === 'recovery' ? 'recovery' : 'initial',
    reason: ['exit', 'signal', 'timeout', 'spawn-failure'].includes(reason) ? reason : 'unknown',
    category,
    exitCode: Number.isInteger(child?.exitCode) && child.exitCode >= 0 && child.exitCode <= 255
      ? child.exitCode : null,
    signal: ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS']
      .includes(child?.signalCode) ? child.signalCode : null,
    logInspection,
    ...(enclaveStartup ? { enclaveStartup } : {}),
    ...(earlyFailure ? { earlyFailure } : {}),
  };
  return { diagnostic, evidence };
}

function startupDiagnostic(child, reason, stage, stderrFile, startupErrorFile) {
  return collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile).diagnostic;
}

function startupEvidence(child, reason, stage, stderrFile, startupErrorFile) {
  return collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile).evidence;
}

function startupSnapshot(child, reason, stage, profile, stderrFile, startupErrorFile) {
  if (!['initial', 'recovery', 'script-only', 'agent-only'].includes(stage)
      || !['combined', 'script-only', 'agent-only'].includes(profile)) {
    throw new Error('Invalid public enclave startup snapshot identity');
  }
  return {
    stage, profile,
    ...collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile),
  };
}

function emitStartupDiagnostic(child, reason, stage, stderrFile, startupErrorFile) {
  const { diagnostic, evidence } = collectStartupEvidence(child, reason, stage, stderrFile, startupErrorFile);
  console.error(`AWF_HOST_STARTUP_DIAGNOSTIC ${JSON.stringify(diagnostic)}`);
  console.error(`AWF_HOST_STARTUP_EVIDENCE ${JSON.stringify(evidence)}`);
}

async function waitForBroker(child, container, deadline, diagnostics) {
  const fail = (reason, message) => {
    if (diagnostics) emitStartupDiagnostic(
      child, reason, diagnostics.stage, diagnostics.stderrFile, diagnostics.startupErrorFile,
    );
    throw new Error(message);
  };
  while (Date.now() < deadline) {
    if (failedSpawns.has(child)) {
      fail('spawn-failure', 'Could not spawn AWF before public enclave broker readiness');
    }
    if (child.signalCode !== null) {
      fail('signal', 'AWF was signalled before the public enclave broker became ready');
    }
    if (child.exitCode !== null) {
      fail('exit', 'AWF exited before the public enclave broker became ready');
    }
    cacheStartupRecord(diagnostics?.startupErrorFile);
    const result = spawnSync('docker', [
      'inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
      container,
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: Math.max(1, Math.min(10_000, deadline - Date.now())),
      killSignal: 'SIGKILL',
    });
    if (result.status === 0 && ['healthy', 'running'].includes(result.stdout.trim())) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail('timeout', 'Timed out waiting for the live enclave broker');
}

async function waitForHostGatewayReadiness(child, deadline, diagnostics) {
  const fail = (reason, message) => {
    emitStartupDiagnostic(
      child, reason, diagnostics.stage, diagnostics.stderrFile, diagnostics.startupErrorFile,
    );
    throw new Error(message);
  };
  while (Date.now() < deadline) {
    if (failedSpawns.has(child)) fail('spawn-failure', 'Could not spawn AWF before host gateway readiness');
    if (child.signalCode !== null) fail('signal', 'AWF was signalled before host gateway readiness');
    if (child.exitCode !== null) fail('exit', 'AWF exited before host gateway readiness');
    let progress;
    // Publication can be interrupted; only a complete validated record proves readiness.
    const record = cacheStartupRecord(diagnostics.startupErrorFile);
    if (record?.phase === 'enclave-startup-progress'
        && record.message === 'Enclave startup in progress') {
      progress = safeEnclaveStartup(record.enclaveStartup);
    }
    if (progress?.readiness === 'ready'
        && (!progress.startupChecks || progress.startupChecks.ready)) {
      console.log(`AWF_HOST_GATEWAY_READINESS ${JSON.stringify(progress)}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
  fail('timeout', 'Timed out waiting for actual AWF host gateway readiness');
}

module.exports = {
  STARTUP_CATEGORIES,
  failedSpawns,
  hostPreflightSchema,
  mountTopologySchema,
  storagePropagationSchema,
  safeStoragePropagation,
  safeMountTopology,
  safeHostPreflight,
  safeStartupChecklist,
  ENCLAVE_STARTUP_STAGES,
  safeEnclaveStartup,
  gatewayCategory,
  trackAwfChild,
  STARTUP_RECORD_MAX_BYTES,
  STDERR_SCAN_MAX_BYTES,
  STDERR_TAIL_BYTES,
  STABLE_READ_ATTEMPTS,
  STABLE_READ_DELAY_MS,
  startupRecordCache,
  awfStartTimes,
  sizeBucket,
  elapsedBucket,
  sleepSync,
  inspectDiagnosticFile,
  parseStartupRecord,
  cacheStartupRecord,
  EXIT_MARKER,
  EARLY_FAILURE_MARKER,
  earlyStartupSchema,
  WRITE_OUTCOMES,
  safeEarlyFailureMarker,
  safeExitMarker,
  collectStartupEvidence,
  startupDiagnostic,
  startupEvidence,
  startupSnapshot,
  emitStartupDiagnostic,
  waitForBroker,
  waitForHostGatewayReadiness,
};
