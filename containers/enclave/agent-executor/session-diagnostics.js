/* global TextDecoder, module */
'use strict';

const MAX_SESSION_BYTES = 1024 * 1024;
const MAX_EVENTS = 32;
const PATHS = [
  'copilot-executable', 'codex-executable', 'claude-executable', 'seed-directory', 'task-input', 'schema-input', 'output-file',
  'session-log', 'agent-directory', 'copilot-log-directory', 'codex-log-directory', 'claude-log-directory', 'github-agent-id', 'github-bearer',
  'temporary-directory', 'shared-memory',
];
const STAGES = [
  'configuration-accepted', 'input-accepted', 'runtime-paths-ready', 'preflight-completed',
  'engine-launch-attempt', 'engine-started', 'engine-completed', 'output-normalization-started',
  'output-normalized', 'output-write-attempt', 'output-written',
  'claude-first-byte', 'claude-initialized', 'claude-response', 'claude-tool-requested',
  'claude-tool-completed', 'claude-permission-denied', 'claude-api-retry', 'claude-result', 'claude-stream-summary',
  'claude-startup-failure',
];
const CATEGORIES = [
  'configuration-invalid', 'input-invalid', 'engine-failed', 'result-write-failed', 'deadline-exceeded',
  'result-read-failed', 'result-reset-failed', 'result-empty', 'result-too-large',
  'result-invalid-utf8', 'result-whitespace-only', 'diagnostic-encoding-failed',
  'not-found', 'permission-denied', 'not-executable', 'not-directory', 'is-directory',
  'read-only-filesystem', 'os-error', 'startup-crash',
  'no-space', 'quota-exceeded', 'file-too-large', 'io-error', 'symlink-loop',
  'operation-not-permitted', 'too-many-open-files',
];
const OUTPUT_PATHS = ['output-parent', 'output-directory', 'output-link', 'output-file'];
const STORAGE_PROBE_STATUSES = ['captured', 'missing', 'unsafe', 'oversized', 'invalid', 'read-failed'];
const STORAGE_PROBE_STAGES = [
  'started', 'storage-complete', 'cleanup-started', 'cleanup-complete',
  'output-write-started', 'output-write-complete', 'output-check-failed', 'output-verified',
];
const OUTPUT_FLAGS = ['symlink', 'targetMatches', 'sameFile', 'directReadable', 'aliasReadable'];
const STORAGE_PROBE_FLAGS = [...OUTPUT_FLAGS, 'enospcObserved', 'probeFilesRemoved',
  'directMatchesExpected', 'aliasMatchesExpected'];
const STORAGE_PROBE_OPERATIONS = ['link-lstat', 'link-readlink', 'direct-stat', 'alias-stat',
  ...['direct', 'alias'].flatMap(id => ['open', 'read', 'close'].map(op => `${id}-${op}`))];
const FILE_OPERATIONS = [
  'output-reset', 'output-read', 'output-write', 'task-input-read', 'schema-input-read',
  'github-agent-id-read', 'github-bearer-read', 'github-mcp-config-write',
  'redaction-agent-id-read', 'redaction-bearer-read', 'copilot-diagnostics-read',
  ...['memory.current', 'memory.peak', 'memory.max', 'memory.events'].map(id => `resource-${id}-read`),
];
const OPERATIONS = [
  'engine-launch', 'github-mcp-config-chmod', 'preflight-seed-directory-list',
  'copilot-diagnostics-scan', 'copilot-diagnostics-lstat', 'resource-entry-lstat', 'resource-directory-walk',
  ...FILE_OPERATIONS.flatMap(id => [id, `${id}-open`, `${id}-close`]),
  ...['stat', 'open', 'write', 'close'].map(id => `session-log-${id}`),
  ...PATHS.flatMap(id => [`preflight-${id}`, `preflight-${id}-stat`]),
  ...['home-directory', 'copilot-directory', 'copilot-log-directory',
    'codex-directory', 'codex-log-directory', 'claude-directory', 'claude-log-directory']
    .map(id => `runtime-path-creation-${id}`),
  ...['agent-directory', 'temporary-directory', 'shared-memory'].map(id => `resource-${id}-statvfs`),
  ...OUTPUT_PATHS.flatMap(id => [`snapshot-${id}-stat`, `snapshot-${id}-lstat`]),
  'verify-output-link-lstat', 'verify-output-link-readlink',
  ...['direct', 'alias'].flatMap(id =>
    ['open', 'fstat', 'validate', 'read', 'close'].map(op => `verify-output-${id}-${op}`)),
];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function integer(value) {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function allowed(value, values) {
  return typeof value === 'string' && values.some(item => item === value);
}

function projectEvent(value) {
  const result = {};
  if (value.event === 'progress' && allowed(value.stage, STAGES)) {
    result.event = 'progress';
    result.stage = value.stage;
    for (const key of ['attempt', 'runtimeMs']) if (integer(value[key])) result[key] = value[key];
    if (typeof value.valid === 'boolean') result.valid = value.valid;
    if (String(value.stage).startsWith('claude-')) {
      for (const key of ['shellAvailable', 'toolError', 'resultError', 'stdoutObserved',
        'stderrObserved', 'captureTruncated']) {
        if (typeof value[key] === 'boolean') result[key] = value[key];
      }
      if (allowed(value.permissionMode, ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'unknown'])) {
        result.permissionMode = value.permissionMode;
      }
      if (allowed(value.outputState, ['present', 'empty', 'unavailable'])) result.outputState = value.outputState;
      if (value.stage === 'claude-startup-failure' && allowed(value.classification, [
        'unknown-option', 'invalid-option-value', 'missing-option-value',
        'invalid-settings', 'invalid-mcp-config', 'unknown',
      ])) result.classification = value.classification;
      if (value.httpStatus === null || (integer(value.httpStatus)
        && [400, 401, 403, 404, 408, 429, 500, 502, 503, 504, 529].includes(value.httpStatus))) {
        result.httpStatus = value.httpStatus;
      }
    }
  } else if (value.event === 'preflight' && allowed(value.path, PATHS)) {
    result.event = 'preflight';
    result.path = value.path;
    if (allowed(value.type, ['file', 'directory', 'missing', 'other', 'forbidden-seed-mount'])) result.type = value.type;
    for (const key of ['exists', 'executable', 'writable']) {
      if (typeof value[key] === 'boolean') result[key] = value[key];
    }
  } else if (value.event === 'failure' && allowed(value.category, CATEGORIES)) {
    result.event = 'failure';
    result.category = value.category;
  } else if (value.event === 'operation-error') {
    if (!allowed(value.operation, OPERATIONS) || !allowed(value.category, CATEGORIES)) return undefined;
    result.event = 'operation-error';
    result.operation = value.operation;
    result.category = value.category;
    if (integer(value.errno) && value.errno <= 4095) result.errno = value.errno;
    if (typeof value.fatal === 'boolean') result.fatal = value.fatal;
  } else if (value.event === 'engine-result' || value.event === 'engine-retry') {
    result.event = value.event;
    if (integer(value.signal) && value.signal <= 64) result.signal = value.signal;
  } else if (value.event === 'success') {
    result.event = 'success';
  } else {
    return undefined;
  }
  if (value.exitCode === null || (Number.isInteger(value.exitCode)
      && typeof value.exitCode === 'number' && value.exitCode >= -64 && value.exitCode <= 255)) {
    result.exitCode = value.exitCode;
  }
  return result;
}

/** Shared host/broker boundary: retain closed metadata, never guest text or stream payloads. */
function projectEnclaveSessionDiagnostics(bytes) {
  if (bytes.length > MAX_SESSION_BYTES) return { status: 'oversized' };
  if (bytes.length === 0) return { status: 'empty', bytes: 0 };
  const result = {
    status: 'captured', bytes: bytes.length, events: [], rejected: 0, dropped: 0,
  };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { status: 'invalid', bytes: bytes.length };
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let value;
    try {
      value = record(JSON.parse(line));
    } catch {
      result.rejected += 1;
      continue;
    }
    if (!value) {
      result.rejected += 1;
      continue;
    }
    if (value.event === 'storage-probe' && allowed(value.status, STORAGE_PROBE_STATUSES)) {
      let status = value.status;
      const milestones = [];
      if (status === 'captured') {
        if (!Array.isArray(value.milestones) || value.milestones.length === 0 || value.milestones.length > 16) {
          status = 'invalid';
        } else {
          for (const item of value.milestones) {
            const source = record(item);
            if (!source || !allowed(source.stage, STORAGE_PROBE_STAGES)
                || STORAGE_PROBE_FLAGS.some(key => source[key] !== undefined && typeof source[key] !== 'boolean')
                || (source.operation !== undefined && !allowed(source.operation, STORAGE_PROBE_OPERATIONS))
                || (source.errno !== undefined && (!integer(source.errno) || source.errno > 4095))) {
              status = 'invalid';
              break;
            }
            const milestone = { stage: source.stage };
            for (const key of STORAGE_PROBE_FLAGS) {
              if (typeof source[key] === 'boolean') milestone[key] = source[key];
            }
            if (allowed(source.operation, STORAGE_PROBE_OPERATIONS)) milestone.operation = source.operation;
            if (integer(source.errno) && source.errno <= 4095) milestone.errno = source.errno;
            milestones.push(milestone);
          }
        }
      }
      result.storageProbe = { status, milestones: status === 'captured' ? milestones : [] };
      continue;
    }
    if (value.event === 'output-verification' && allowed(value.stage, ['before-engine', 'after-engine'])) {
      const verification = { stage: value.stage };
      for (const key of [...OUTPUT_FLAGS, 'contentsMatch']) {
        if (typeof value[key] === 'boolean') verification[key] = value[key];
      }
      for (const key of ['directState', 'aliasState']) {
        if (allowed(value[key], ['empty', 'within-limit', 'oversized', 'unavailable'])) {
          verification[key] = value[key];
        }
      }
      result.outputVerification ??= [];
      result.outputVerification = result.outputVerification.filter(item => item.stage !== value.stage);
      result.outputVerification.push(verification);
      continue;
    }
    if (value.event === 'output-normalization'
        && allowed(value.inputState, ['empty', 'within-limit', 'oversized'])
        && allowed(value.stdoutState, ['empty', 'present'])) {
      result.normalization = { inputState: value.inputState, stdoutState: value.stdoutState };
      continue;
    }
    if (value.event === 'output-snapshot' && allowed(value.stage, ['before-engine', 'after-engine'])
        && Array.isArray(value.paths)) {
      const identity = id => id === 0 || id === 65534 ? id : 'other';
      const paths = [];
      for (const id of OUTPUT_PATHS) {
        const source = value.paths.map(record).find(item => item?.path === id);
        if (!source || !allowed(source.type, ['file', 'directory', 'symlink', 'other', 'unavailable'])) continue;
        const metadata = { path: id, type: source.type };
        if (source.type !== 'unavailable') {
          metadata.uid = identity(source.uid);
          metadata.gid = identity(source.gid);
          if (integer(source.mode) && source.mode <= 0o7777) metadata.mode = source.mode;
          for (const key of ['readable', 'writable', 'executable']) {
            if (typeof source[key] === 'boolean') metadata[key] = source[key];
          }
          if (id === 'output-file' && allowed(source.size, ['empty', 'within-limit', 'oversized'])) {
            metadata.size = source.size;
          }
        }
        paths.push(metadata);
      }
      result.output = {
        stage: value.stage, uid: identity(value.uid), gid: identity(value.gid), paths,
      };
      continue;
    }
    if (value.event === 'resource-snapshot' && allowed(value.stage, ['before-engine', 'after-engine'])) {
      const memory = {};
      const source = record(value.memory);
      for (const key of ['currentBytes', 'peakBytes', 'limitBytes']) {
        if (integer(source?.[key])) memory[key] = source[key];
      }
      const events = record(source?.events);
      for (const key of ['high', 'max', 'oom', 'oom_kill']) {
        if (integer(events?.[key])) memory[key] = events[key];
      }
      const filesystems = [];
      if (Array.isArray(value.filesystems)) {
        for (const id of ['agent-directory', 'temporary-directory', 'shared-memory']) {
          const filesystem = value.filesystems.map(record).find(item => item?.path === id);
          if (filesystem && integer(filesystem.capacityBytes) && integer(filesystem.availableBytes)) {
            filesystems.push({ path: id, capacityBytes: filesystem.capacityBytes, availableBytes: filesystem.availableBytes });
          }
        }
      }
      result.resources = { stage: value.stage, memory, filesystems };
      continue;
    }
    const event = projectEvent(value);
    if (!event) {
      result.rejected += 1;
      continue;
    }
    result.lastEvent = event;
    if (event.event === 'progress' && event.stage === 'claude-stream-summary') {
      result.claudeStreamSummary = event;
    }
    if (event.event === 'progress' && event.stage === 'claude-startup-failure') {
      result.claudeStartupFailure = event;
    }
    if (event.event === 'failure' || (event.event === 'operation-error' && event.fatal !== false)) {
      result.failure ??= event;
    }
    if (event.event === 'operation-error') {
      result.operationErrors ??= [];
      if (result.operationErrors.length === 16) result.operationErrors.shift();
      result.operationErrors.push(event);
    }
    if (result.events.length < MAX_EVENTS) result.events.push(event);
    else result.dropped += 1;
  }
  if (result.events.length === 0 && !result.resources && !result.output
      && !result.storageProbe && !result.normalization && !result.outputVerification) result.status = 'invalid';
  return result;
}

module.exports = { projectEnclaveSessionDiagnostics };
