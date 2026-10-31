/* global require, module, Buffer, process */
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const AUTH_FIELDS = {
  credential_source: ['github_token', 'provider_api_key', 'none'],
  credential_kind: ['none', 'placeholder', 'fine_grained_pat', 'classic_pat', 'oauth', 'user_token', 'installation_token', 'other'],
  credential_shape: ['missing', 'placeholder', 'embedded_whitespace', 'prefixed', 'whitespace', 'clean'],
  target_source: ['explicit', 'server', 'default'],
  server_kind: ['missing', 'invalid', 'github', 'ghec', 'ghes'],
  base_path: ['configured', 'none'],
  integration_source: ['copilot_integration_id', 'github_copilot_integration_id', 'default'],
  authorization_match: ['yes', 'no'],
  integration_match: ['yes', 'no'],
  target: ['standard', 'enterprise', 'business', 'ghec', 'custom'],
  target_match: ['yes', 'no'],
  method: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'other'],
  endpoint: ['models', 'models_session', 'auto', 'chat_completions', 'responses', 'other'],
  authorization: ['missing', 'multiple', 'malformed', 'bearer', 'token', 'other'],
  integration: ['missing', 'multiple', 'workflows', 'cli', 'custom'],
  error_class: ['none', 'expired', 'invalid_credential', 'insufficient_scope', 'entitlement', 'integration', 'malformed_auth', 'unclassified', 'uninspectable'],
  body_capture: ['complete', 'omitted', 'truncated', 'not_required'],
  challenge: ['missing', 'invalid_token', 'insufficient_scope', 'other', 'not_required'],
};

function isSafeCopilotAuthLogFields(value) {
  if (!value || value.length > 1024) return false;
  const entries = value.split(' ').map(field => field.split('='));
  if (entries.some(pair => pair.length !== 2)) return false;
  return Object.entries(AUTH_FIELDS).map(([name, allowed]) => {
    const pair = entries.find(([key]) => key === name);
    const candidate = pair?.[1];
    const safe = typeof candidate === 'string' && allowed.includes(candidate) ? candidate : 'unknown';
    return `${name}=${safe}`;
  }).join(' ') === value;
}

const MAX_STREAM_BYTES = 1024 * 1024;
const MAX_FILES = 32;
const MAX_RUN_PROJECTION_FILES = 4;
const MAX_STATUS_BYTES = 4096;
const MAX_PUBLISHED_FILES = MAX_FILES + MAX_RUN_PROJECTION_FILES + 1;
const MAX_PUBLISHED_BYTES = (MAX_FILES + MAX_RUN_PROJECTION_FILES) * MAX_STREAM_BYTES + MAX_STATUS_BYTES;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_USAGE_BYTES = 16 * 1024;
const ID = /^[a-f0-9]{32}$/;
const INVOCATION_ID = /^[a-f0-9]{16,64}$/;
const ENTRY_ID = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;
const LOG_NAME = /^(?:(?:stdout|stderr)\.log|diagnostics\.json|enclave-session\.log|enclave-proxy-events\.jsonl|enclave-proxy-container\.log|launcher-(?:stdout|stderr)\.log|guest-(?:stdout|stderr)\.raw\.log|cloud-hypervisor\.log|serial\.log|network-plan\.json|network-diagnostics\.txt|counters\.json|vm-info\.json|runtime\.json|confinement\.json|virtiofs-[0-9]-enclave-(?:seed|request|output|runtime|session-handoff|session-state)(?:\.log|-confinement\.json))$/;
const ROOTS = {
  journal: '/var/lib/awf-cloud-hypervisor/host-executor-journal',
  debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/cloud-hypervisor',
};
const STREAM_STATUSES = ['captured', 'missing', 'unsafe', 'oversized', 'read-failed', 'not-applicable', 'unavailable'];
const OPERATION_STAGES = ['storage-preparation', 'storage-probe', 'network-isolation', 'authority-handoff',
  'workload-create', 'workload-start', 'entrypoint-initialization', 'workload-exit', 'output-validation', 'cleanup'];
const ERROR_CATEGORIES = ['host-exception', 'not-found', 'permission-denied', 'operation-not-permitted',
  'symlink-loop', 'no-space', 'quota-exceeded', 'file-too-large', 'io-error', 'read-only-filesystem',
  'cancelled', 'timeout', 'workload-exit', 'result-invalid', 'cleanup-failed', 'retention-failed'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const exitCode = value => value === null || (Number.isInteger(value) && value >= -64 && value <= 255);
const SESSION_PATHS = ['copilot-executable', 'seed-directory', 'task-input', 'schema-input', 'output-file',
  'session-log', 'agent-directory', 'copilot-log-directory', 'github-agent-id', 'github-bearer',
  'temporary-directory', 'shared-memory'];
const OUTPUT_PATHS = ['output-parent', 'output-directory', 'output-link', 'output-file'];
const SESSION_OPERATIONS = [
  'engine-launch', 'github-mcp-config-chmod', 'preflight-seed-directory-list',
  'copilot-diagnostics-scan', 'copilot-diagnostics-lstat', 'resource-entry-lstat', 'resource-directory-walk',
  ...['output-reset', 'output-read', 'output-write', 'task-input-read', 'schema-input-read',
    'github-agent-id-read', 'github-bearer-read', 'github-mcp-config-write',
    'redaction-agent-id-read', 'redaction-bearer-read', 'copilot-diagnostics-read',
    ...['memory.current', 'memory.peak', 'memory.max', 'memory.events'].map(id => `resource-${id}-read`)]
    .flatMap(id => [id, `${id}-open`, `${id}-close`]),
  ...['stat', 'open', 'write', 'close'].map(id => `session-log-${id}`),
  ...SESSION_PATHS.flatMap(id => [`preflight-${id}`, `preflight-${id}-stat`]),
  ...['home-directory', 'copilot-directory', 'copilot-log-directory'].map(id => `runtime-path-creation-${id}`),
  ...['agent-directory', 'temporary-directory', 'shared-memory'].map(id => `resource-${id}-statvfs`),
  ...OUTPUT_PATHS.flatMap(id => [`snapshot-${id}-stat`, `snapshot-${id}-lstat`]),
  'verify-output-link-lstat', 'verify-output-link-readlink',
  ...['direct', 'alias'].flatMap(id =>
    ['open', 'fstat', 'validate', 'read', 'close'].map(op => `verify-output-${id}-${op}`)),
];
function fields(value, schema) {
  check(object(value), 'session-schema');
  const result = {};
  for (const [key, validate] of Object.entries(schema)) {
    if (value[key] === undefined) continue;
    check(validate(value[key]), 'session-schema');
    result[key] = value[key];
  }
  return result;
}
const boolean = value => typeof value === 'boolean';
const member = values => value => values.includes(value);
const boundedErrno = value => count(value) && value <= 4095;
const identityNumber = value => [0, 65534, 'other'].includes(value);
const OUTPUT_FLAGS = ['symlink', 'targetMatches', 'sameFile', 'directReadable', 'aliasReadable'];
function check(condition, failedCheck, category = 'invalid-evidence') {
  if (!condition) {
    const error = new Error(`Debug collection rejected: ${failedCheck}`);
    error.failedCheck = failedCheck;
    error.category = category;
    throw error;
  }
}

function decodeUtf8(bytes, failedCheck) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { check(false, failedCheck, 'invalid-evidence'); }
}

function projectOperation(value, failed = false) {
  check(object(value) && OPERATION_STAGES.includes(value.stage)
    && ['started', 'succeeded', 'failed', 'unavailable', 'not-applicable'].includes(value.status)
    && (!failed || (value.status === 'failed' && ERROR_CATEGORIES.includes(value.category)))
    && (value.category === undefined || ERROR_CATEGORIES.includes(value.category))
    && (value.errno === undefined || [2, 13, 1, 40, 28, 122, 27, 5, 30].includes(value.errno)), 'operation-schema');
  return { stage: value.stage, status: value.status,
    ...(value.category !== undefined ? { category: value.category } : {}),
    ...(value.errno !== undefined ? { errno: value.errno } : {}) };
}

// The diagnostics envelope keeps only finite operational evidence. Approved
// producer-redacted raw session streams are retained separately below.
function projectSessionEvent(value) {
  if (!object(value)) return undefined;
  const result = {};
  const stages = ['configuration-accepted', 'input-accepted', 'runtime-paths-ready', 'preflight-completed',
    'engine-launch-attempt', 'engine-started', 'engine-completed', 'output-normalization-started',
    'output-normalized', 'output-write-attempt', 'output-written'];
  const categories = [...ERROR_CATEGORIES, 'configuration-invalid', 'input-invalid', 'engine-failed',
    'result-write-failed', 'deadline-exceeded', 'result-read-failed', 'result-reset-failed', 'result-empty',
    'result-too-large', 'result-invalid-utf8', 'result-whitespace-only', 'diagnostic-encoding-failed',
    'not-executable', 'not-directory', 'is-directory', 'os-error', 'startup-crash', 'too-many-open-files'];
  if (value.event === 'progress' && stages.includes(value.stage)) {
    result.event = value.event;
    result.stage = value.stage;
    for (const key of ['attempt', 'runtimeMs']) if (count(value[key])) result[key] = value[key];
    if (typeof value.valid === 'boolean') result.valid = value.valid;
  } else if (value.event === 'failure' && categories.includes(value.category)) {
    result.event = value.event;
    result.category = value.category;
  } else if (value.event === 'preflight' && SESSION_PATHS.includes(value.path)) {
    Object.assign(result, { event: value.event, path: value.path }, fields(value, {
      type: member(['file', 'directory', 'missing', 'other', 'forbidden-seed-mount']),
      exists: boolean, executable: boolean, writable: boolean,
    }));
  } else if (value.event === 'operation-error' && SESSION_OPERATIONS.includes(value.operation)
      && categories.includes(value.category)) {
    Object.assign(result, { event: value.event, operation: value.operation, category: value.category },
      fields(value, { errno: boundedErrno, fatal: boolean }));
  } else if (['engine-result', 'engine-retry', 'success'].includes(value.event)) {
    result.event = value.event;
    if (count(value.signal) && value.signal <= 64) result.signal = value.signal;
  } else return undefined;
  if (value.exitCode !== undefined && exitCode(value.exitCode)) result.exitCode = value.exitCode;
  return result;
}

function projectSession(value) {
  check(object(value) && [...STREAM_STATUSES, 'empty', 'invalid', 'not-stopped'].includes(value.status), 'session-schema');
  const result = { status: value.status };
  for (const key of ['bytes', 'rejected', 'dropped']) {
    check(value[key] === undefined || count(value[key]), 'session-schema');
    if (value[key] !== undefined) result[key] = value[key];
  }
  check(value.bytes === undefined || value.bytes <= MAX_STREAM_BYTES, 'session-bound');
  if (value.events !== undefined) {
    check(Array.isArray(value.events) && value.events.length <= 32, 'session-bound');
    result.events = value.events.map(projectSessionEvent).filter(Boolean);
  }
  for (const key of ['lastEvent', 'failure']) {
    if (value[key] !== undefined) {
      const event = projectSessionEvent(value[key]);
      if (event) result[key] = event;
    }
  }
  if (value.operationErrors !== undefined) {
    check(Array.isArray(value.operationErrors) && value.operationErrors.length <= 16, 'session-bound');
    result.operationErrors = value.operationErrors.map(projectSessionEvent).filter(Boolean);
  }
  if (value.normalization !== undefined) {
    check(object(value.normalization) && ['empty', 'within-limit', 'oversized'].includes(value.normalization.inputState)
      && ['empty', 'present'].includes(value.normalization.stdoutState), 'session-schema');
    result.normalization = { inputState: value.normalization.inputState, stdoutState: value.normalization.stdoutState };
  }
  if (value.storageProbe !== undefined) {
    const probe = value.storageProbe;
    check(object(probe) && ['captured', 'missing', 'unsafe', 'oversized', 'invalid', 'read-failed'].includes(probe.status)
      && Array.isArray(probe.milestones) && probe.milestones.length <= 16, 'session-schema');
    result.storageProbe = { status: probe.status, milestones: probe.milestones.map(item => {
      check(object(item) && ['started', 'storage-complete', 'cleanup-started', 'cleanup-complete',
        'output-write-started', 'output-write-complete', 'output-check-failed', 'output-verified'].includes(item.stage),
      'session-schema');
      return { stage: item.stage, ...fields(item, {
        ...Object.fromEntries([...OUTPUT_FLAGS, 'enospcObserved', 'probeFilesRemoved',
          'directMatchesExpected', 'aliasMatchesExpected'].map(key => [key, boolean])),
        errno: boundedErrno,
        operation: member(['link-lstat', 'link-readlink', 'direct-stat', 'alias-stat',
          ...['direct', 'alias'].flatMap(id => ['open', 'read', 'close'].map(op => `${id}-${op}`))]),
      }) };
    }) };
  }
  if (value.outputVerification !== undefined) {
    check(Array.isArray(value.outputVerification) && value.outputVerification.length <= 2, 'session-schema');
    result.outputVerification = value.outputVerification.map(item => {
      check(object(item) && ['before-engine', 'after-engine'].includes(item.stage), 'session-schema');
      return { stage: item.stage, ...fields(item, {
        ...Object.fromEntries([...OUTPUT_FLAGS, 'contentsMatch'].map(key => [key, boolean])),
        directState: member(['empty', 'within-limit', 'oversized', 'unavailable']),
        aliasState: member(['empty', 'within-limit', 'oversized', 'unavailable']),
      }) };
    });
  }
  if (value.output !== undefined) {
    const output = value.output;
    check(object(output) && ['before-engine', 'after-engine'].includes(output.stage)
      && identityNumber(output.uid) && identityNumber(output.gid)
      && Array.isArray(output.paths) && output.paths.length <= 4, 'session-schema');
    result.output = { stage: output.stage, uid: output.uid, gid: output.gid, paths: output.paths.map(item => {
      check(object(item) && OUTPUT_PATHS.includes(item.path)
        && ['file', 'directory', 'symlink', 'other', 'unavailable'].includes(item.type), 'session-schema');
      return { path: item.path, type: item.type, ...fields(item, {
        uid: identityNumber, gid: identityNumber, mode: value => count(value) && value <= 0o7777,
        readable: boolean, writable: boolean, executable: boolean,
        size: member(['empty', 'within-limit', 'oversized']),
      }) };
    }) };
  }
  if (value.resources !== undefined) {
    const resources = value.resources;
    check(object(resources) && ['before-engine', 'after-engine'].includes(resources.stage)
      && object(resources.memory) && Array.isArray(resources.filesystems) && resources.filesystems.length <= 3,
    'session-schema');
    result.resources = { stage: resources.stage,
      memory: fields(resources.memory, Object.fromEntries(
        ['currentBytes', 'peakBytes', 'limitBytes', 'high', 'max', 'oom', 'oom_kill'].map(key => [key, count]))),
      filesystems: resources.filesystems.map(item => {
        check(object(item) && ['agent-directory', 'temporary-directory', 'shared-memory'].includes(item.path)
          && count(item.capacityBytes) && count(item.availableBytes), 'session-schema');
        return { path: item.path, capacityBytes: item.capacityBytes, availableBytes: item.availableBytes };
      }),
    };
  }
  return result;
}

function projectDiagnostics(value, identity) {
  check(object(value) && value.version === 1, 'diagnostics-schema');
  check(value.runId === identity.runId && value.invocationId === identity.invocationId
    && value.entryId === identity.entryId && value.runtime === identity.runtime, 'diagnostics-identity');
  // CLI roots are the protected namespaces populated only after the producer's
  // public-debug and anonymous all-repository visibility gates. Older producers
  // do not emit an eligibility field; never accept a contradictory marker.
  if (value.retentionEligibility !== undefined) {
    check(object(value.retentionEligibility) && value.retentionEligibility.publicDebug === true
      && value.retentionEligibility.repositoryVisibility === 'all-public-verified'
      && Object.keys(value.retentionEligibility).length === 2, 'retention-eligibility', 'ineligible');
  }
  check(['agent', 'script'].includes(value.executorKind)
    && ['setup', 'execution', 'result', 'stop', 'retention', 'complete'].includes(value.stage)
    && ['setup-failed', 'execution-exception', 'workload-exit', 'result-invalid', 'cancelled', 'timeout',
      'retention-failed', 'none'].includes(value.failure) && exitCode(value.exitCode), 'diagnostics-schema');
  check(value.workloadStopped === true && typeof value.workloadLaunched === 'boolean'
    && value.stopProof === (value.workloadLaunched ? 'verified' : 'not-launched')
    && (value.workloadLaunched || (value.exitCode === null
      && ((['setup-failed', 'cancelled', 'timeout'].includes(value.failure) && value.stage === 'setup')
        || (value.failure === 'retention-failed' && value.stage === 'retention')))),
  'stop-proof', 'not-stopped');
  check(Array.isArray(value.stages) && value.stages.length <= 64, 'operation-schema');
  check(object(value.streams) && ['stdout', 'stderr', 'session'].every(key =>
    STREAM_STATUSES.includes(value.streams[key])), 'stream-schema');
  const streams = Object.fromEntries(['stdout', 'stderr', 'session'].map(key => [key, value.streams[key]]));
  const coverage = value.streamCoverage;
  check(object(coverage), 'coverage-schema');
  const streamCoverage = {};
  for (const key of ['stdout', 'stderr']) {
    const source = coverage[key];
    check(object(source) && ['workload-file', 'backend-stream', 'agent-session', 'unavailable'].includes(source.artifactSource)
      && ['captured', 'unavailable'].includes(source.agentSession), 'coverage-schema');
    check(source.artifactSource === 'unavailable' || streams[key] === 'captured', 'coverage-schema');
    streamCoverage[key] = { artifactSource: source.artifactSource, agentSession: source.agentSession };
  }
  check(['agent-session', 'unavailable'].includes(coverage.copilotDiagnostics), 'coverage-schema');
  streamCoverage.copilotDiagnostics = coverage.copilotDiagnostics;
  if (coverage.captureErrors !== undefined) {
    check(object(coverage.captureErrors) && Object.keys(coverage.captureErrors).every(key =>
      ['stdout', 'stderr'].includes(key) && ERROR_CATEGORIES.includes(coverage.captureErrors[key])), 'coverage-schema');
    streamCoverage.captureErrors = Object.fromEntries(Object.entries(coverage.captureErrors));
  }
  if (coverage.captureDrain !== undefined) {
    check(coverage.captureDrain === 'unavailable', 'coverage-schema');
    streamCoverage.captureDrain = 'unavailable';
  }
  const evidence = value.backendEvidence;
  check(object(evidence) && object(evidence.dockerInspect) && object(evidence.vmCounters)
    && object(evidence.network) && evidence.network.status === 'unavailable', 'backend-schema');
  let dockerInspect = { status: evidence.dockerInspect.status };
  if (identity.runtime === 'docker') {
    check(['captured', 'unavailable'].includes(dockerInspect.status), 'backend-schema');
    if (dockerInspect.status === 'captured') {
      check(evidence.dockerInspect.running === false && exitCode(evidence.dockerInspect.exitCode)
        && (evidence.dockerInspect.oomKilled === null || typeof evidence.dockerInspect.oomKilled === 'boolean'),
      'docker-stop-proof', 'not-stopped');
      dockerInspect = { status: 'captured', running: false, exitCode: evidence.dockerInspect.exitCode,
        oomKilled: evidence.dockerInspect.oomKilled };
    }
    check(evidence.vmCounters.status === 'not-applicable', 'backend-schema');
  } else {
    check(dockerInspect.status === 'not-applicable'
      && ['supplemental', 'unavailable'].includes(evidence.vmCounters.status)
      && (evidence.vmCounters.status !== 'supplemental' || evidence.vmCounters.artifact === 'counters.json'), 'backend-schema');
  }
  const projection = {
    version: 1, ...identity, executorKind: value.executorKind, stage: value.stage, failure: value.failure,
    exitCode: value.exitCode, workloadStopped: true, workloadLaunched: value.workloadLaunched, stopProof: value.stopProof,
    ...(value.retentionEligibility !== undefined ? {
      retentionEligibility: { publicDebug: true, repositoryVisibility: 'all-public-verified' },
    } : {}),
    stages: value.stages.map(event => projectOperation(event)), streams, streamCoverage,
    session: projectSession(value.session), backendEvidence: {
      dockerInspect, vmCounters: { status: evidence.vmCounters.status,
        ...(evidence.vmCounters.status === 'supplemental' ? { artifact: 'counters.json' } : {}) },
      network: { status: 'unavailable' },
    },
  };
  for (const key of ['primaryFailure', 'cleanupFailure']) {
    if (value[key] !== undefined) projection[key] = projectOperation(value[key], true);
  }
  return Buffer.from(JSON.stringify(projection) + '\n');
}

function redactCredentials(bytes) {
  const redactText = text => text
    .replace(/\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\bbearer\s+[^\r\n]+/gi, '[REDACTED]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED]');
  const redactValue = (value, depth = 0) => {
    check(depth <= 64, 'credential-redaction-bound', 'oversized');
    if (typeof value === 'string') {
      let embedded;
      try {
        embedded = JSON.parse(value);
      } catch { return redactText(value); }
      if (object(embedded) || Array.isArray(embedded)) {
        const sanitized = redactValue(embedded, depth + 1);
        return JSON.stringify(sanitized) === JSON.stringify(embedded) ? value : JSON.stringify(sanitized);
      }
      return redactText(value);
    }
    if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactText(key), /^(?:proxy-)?authorization$/i.test(key) ? '[REDACTED]' : redactValue(item, depth + 1),
    ]));
    return value;
  };
  // Preserve every approved retained field. Decode JSON only for credential
  // redaction, so an auth line inside a raw stream cannot consume its JSON tail.
  const redacted = Buffer.from(bytes.toString('utf8').split('\n').map(line => {
    let value;
    try { value = JSON.parse(line); } catch { return redactText(line); }
    const sanitized = redactValue(value);
    return JSON.stringify(sanitized) === JSON.stringify(value) ? line : JSON.stringify(sanitized);
  }).join('\n'));
  check(redacted.length <= MAX_STREAM_BYTES, 'stream-bound');
  return redacted;
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
      throw error;
    }
  }
}

function parseRecord(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === 'object' && !Array.isArray(record) ? record : undefined;
  } catch {
    return undefined;
  }
}

// Independent closed projection: even a compromised host diagnostic cannot
// turn this public-fixture collector into a path/message/payload export.
function projectProxyUsage(value) {
  const usage = { scope: 'run-cumulative', requests: { status: 'malformed' }, tokens: { status: 'malformed' } };
  const count = n => Number.isSafeInteger(n) && n >= 0;
  const record = n => n && typeof n === 'object' && !Array.isArray(n);
  for (const kind of ['requests', 'tokens']) {
    const source = value?.[kind];
    if (!record(source)) continue;
    if (['empty', 'missing', 'unsafe', 'oversized', 'record-limit', 'malformed', 'read-failed',
      'not-drained', 'not-applicable'].includes(source.status)) {
      usage[kind] = { status: source.status };
      continue;
    }
    if (source.status !== 'captured' || !count(source.records) || source.records < 1 || source.records > 4096) continue;
    if (kind === 'tokens') {
      const keys = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
      if (!record(source.totals) || !keys.every(key => count(source.totals[key])) ||
          source.usageRecords !== source.records) continue;
      usage.tokens = {
        status: 'captured', records: source.records, usageRecords: source.usageRecords,
        totals: Object.fromEntries(keys.map(key => [key, source.totals[key]])),
      };
    } else {
      if (!count(source.trackedResponses) || source.trackedResponses > source.records ||
          !count(source.websocketSessions) || source.websocketSessions > source.records - source.trackedResponses ||
          !record(source.statuses) || !record(source.results)) continue;
      const statuses = {};
      const results = {};
      for (let status = 100; status <= 599; status++) {
        const n = source.statuses[String(status)];
        if (count(n) && n <= source.records) statuses[String(status)] = n;
      }
      for (const key of ['ok', 'no_usage', 'skip_status', 'unsupported_accounting', 'skip_encoding']) {
        const n = source.results[key];
        if (count(n) && n <= source.records) results[key] = n;
      }
      if (Object.values(statuses).reduce((sum, n) => sum + n, 0) !== source.trackedResponses ||
          Object.values(results).reduce((sum, n) => sum + n, 0) > source.records) continue;
      usage.requests = {
        status: 'captured', records: source.records, trackedResponses: source.trackedResponses,
        websocketSessions: source.websocketSessions, statuses, results,
      };
    }
  }
  return usage;
}

function projectProxyEvents(bytes) {
  if (!bytes.length) return bytes;
  const text = decodeUtf8(bytes, 'proxy-event-encoding');
  check(text.endsWith('\n'), 'proxy-event-completeness');
  const lines = text.slice(0, -1).split('\n');
  check(lines.length <= 4096, 'proxy-event-count', 'oversized');
  return Buffer.from(lines.map(line => {
    const event = parseRecord(line);
    if (event?.schemaVersion !== 1 || !Number.isInteger(event.status) ||
        event.status < 100 || event.status > 599 ||
        !['local', 'upstream'].includes(event.origin)) {
      check(false, 'proxy-event-schema');
    }
    return JSON.stringify({ schemaVersion: 1, origin: event.origin, status: event.status });
  }).join('\n') + '\n');
}

function projectProxyResponse(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  if (source?.schemaVersion !== 1 || source.component !== 'enclave-proxy-response' ||
      source.scope !== 'run-cumulative') check(false, 'proxy-response-schema');
  const states = ['empty', 'missing', 'unsafe', 'oversized', 'record-limit', 'malformed',
    'read-failed', 'not-drained', 'not-applicable'];
  if (states.includes(source.status)) return {
    schemaVersion: 1, component: 'enclave-proxy-response',
    scope: 'run-cumulative', status: source.status,
  };
  const counts = [];
  const projection = {};
  for (const origin of ['local', 'upstream']) {
    const bucket = source[origin];
    if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
      check(false, 'proxy-response-schema');
    }
    projection[origin] = {};
    for (const [status, count] of Object.entries(bucket)) {
      if (!/^[1-5][0-9]{2}$/.test(status) || !Number.isSafeInteger(count) || count < 1) {
        check(false, 'proxy-response-schema');
      }
      projection[origin][status] = count;
      counts.push(count);
    }
  }
  if (source.status !== 'captured' || !Number.isSafeInteger(source.records) ||
      source.records < 1 || source.records > 4096 ||
      counts.reduce((sum, count) => sum + count, 0) !== source.records) {
    check(false, 'proxy-response-schema');
  }
  return { schemaVersion: 1, component: 'enclave-proxy-response',
    scope: 'run-cumulative', status: 'captured', records: source.records, ...projection };
}

function projectProxyContainerLog(bytes) {
  check(bytes.length <= 32 * 1024, 'proxy-container-size', 'oversized');
  const text = decodeUtf8(bytes, 'proxy-container-encoding');
  const lines = text.split('\n');
  const trailer = lines.at(-2);
  const events = new Set([
    'startup', 'startup_complete', 'server_start', 'shutdown', 'request_start',
    'request_complete', 'request_error', 'upstream_error_response', 'upstream_auth_error',
    'copilot_auth_diagnostic',
    'request_transform_failed', 'key_validation_error', 'oidc_startup_failed',
    'model_fetch_error', 'model_routing_bootstrap_error',
    'enclave_model_budget_rejected', 'rate_limited', 'request_validation_failed', 'model_fallback_exhausted',
    'enclave_model_capability_missing', 'enclave_model_capability_scheme', 'enclave_model_capability_format',
    'enclave_model_capability_signature', 'enclave_model_capability_claims', 'enclave_model_capability_claims_changed',
    'enclave_model_token_limit',
    'enclave_model_token_body_missing', 'enclave_model_token_input_reservation',
    'enclave_model_token_request_json', 'enclave_model_token_request_shape',
    'enclave_model_token_output_conflict', 'enclave_model_token_output_shape',
    'enclave_model_token_stream_options', 'enclave_model_token_budget_exhausted',
  ]);
  if (lines.at(-1) !== '' ||
      !/^capture_status=(?:captured dropped=(?:[0-9]{1,5})|empty|unavailable)$/.test(trailer ?? '') ||
      !lines.slice(0, -2).every(line => {
        const match = /^source=(stdout|stderr) level=(info|warn|error) event=([a-z_]+)(?: status=([1-5]\d\d))?(?: (.+))?$/.exec(line);
        return match && events.has(match[3])
          && (match[3] === 'copilot_auth_diagnostic' ? isSafeCopilotAuthLogFields(match[5]) : !match[5]);
      })) check(false, 'proxy-container-schema');
  return bytes;
}

function prepare(runDirectory, roots = ROOTS, uid = 0, trustedRoot = '/', binding) {
  directory(path.dirname(runDirectory), uid, trustedRoot);
  fs.mkdirSync(runDirectory, { mode: 0o700 });
  const baseline = {
    ...(binding ? { binding } : {}),
    journals: inventory(roots.journal, uid, trustedRoot).filter(name => name.endsWith('.journal')),
    proxyDebug: inventory(path.join(roots.journal, 'diagnostics'), uid, trustedRoot)
      .filter(name => name.endsWith('.proxy-debug.json')),
    debug: inventory(roots.debug, uid, trustedRoot),
  };
  fs.writeFileSync(path.join(runDirectory, 'baseline.json'), JSON.stringify(baseline),
    { mode: 0o600, flag: 'wx' });
}

function collect(runDirectory, runnerUid, runnerGid, roots = ROOTS, uid = 0, trustedRoot = '/', binding,
  privilegedUid = 0, stagingTrustedRoot = '/') {
  const stagingUid = binding ? privilegedUid : uid;
  directory(runDirectory, stagingUid, stagingTrustedRoot);
  const prepared = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), 1024 * 1024, stagingUid));
  const baseline = prepared.sourceScopes
    ? prepared.sourceScopes.find(scope => scope.journal === roots.journal) : prepared;
  check(object(baseline) && ['journals', 'debug', 'proxyDebug'].every(key => Array.isArray(baseline[key])
    && baseline[key].length <= MAX_DIRECTORY_ENTRIES && baseline[key].every(name => typeof name === 'string')),
  'prepared-scope');
  check(!binding || JSON.stringify(binding) === JSON.stringify(prepared.binding), 'prepared-scope');
  fs.writeFileSync(path.join(runDirectory, 'collected'), '', { mode: 0o600, flag: 'wx' });
  const journals = inventory(roots.journal, uid, trustedRoot)
    .filter(name => name.endsWith('.journal') && !baseline.journals.includes(name));
  const debug = inventory(roots.debug, uid, trustedRoot).filter(name => !baseline.debug.includes(name));
  const proxyDebug = inventory(path.join(roots.journal, 'diagnostics'), uid, trustedRoot)
    .filter(name => name.endsWith('.proxy-debug.json') && !(baseline.proxyDebug ?? []).includes(name));
  if (journals.length > 1 || debug.length > 1 || proxyDebug.length > 1) {
    check(false, 'run-budget', 'concurrent-runs');
  }
  let invocation;
  let invocationEntry;
  let runId;
  let invocationStopped = false;
  let nonInvocationRecords = 0;
  let invalidIdentityRecords = 0;
  if (journals.length) {
    const journal = journals[0];
    check(/^[a-f0-9]{32}\.journal$/.test(journal), 'journal-identity');
    const records = readRegular(path.join(roots.journal, journal), 64 * 1024, uid)
      .toString('utf8').trim().split('\n').map(parseRecord);
    runId = journal.slice(0, 32);
    check(records[0]?.version === 1 && records[0]?.runId === runId && records[0]?.state === 'open', 'journal-identity');
    for (const record of records.slice(1)) {
      if (!record) {
        check(false, 'journal-schema');
      }
      check(record.runId === undefined || record.runId === runId, 'journal-identity');
      if (record.invocationId === undefined || record.invocationId === 'queue' ||
          record.invocationId === 'budget') {
        nonInvocationRecords += 1;
        continue;
      }
      if (typeof record.invocationId !== 'string' || !INVOCATION_ID.test(record.invocationId) ||
          typeof record.entryId !== 'string' || !ENTRY_ID.test(record.entryId)) {
        check(false, 'journal-identity');
      }
      const candidate = record.invocationId;
      if (invocation && (invocation !== candidate || invocationEntry !== record.entryId)) {
        check(false, 'invocation-budget', 'multiple-invocations');
      }
      invocation = candidate;
      invocationEntry = record.entryId;
      if (record.state === 'terminal') invocationStopped = true;
    }
  }
  if (proxyDebug.length) {
    const match = /^([a-f0-9]{32})-([a-f0-9]{32})\.proxy-debug\.json$/.exec(proxyDebug[0]);
    const expected = match && createHash('sha256').update(`awf-enclave-proxy-debug-v1:${match[1]}`)
      .digest('hex').slice(0, 32);
    if (!match || match[2] !== expected || (runId && runId !== match[1])) {
      check(false, 'proxy-run-identity');
    }
    runId = match[1];
  }
  if (debug.length && (!ID.test(debug[0]) || debug[0] !== runId || !invocation)) {
    check(false, 'artifact-run-identity');
  }
  const debugInvocations = debug.length
    ? inventory(path.join(roots.debug, runId), uid, trustedRoot) : [];
  check(debugInvocations.length <= 1, 'invocation-budget', 'multiple-invocations');
  if (debugInvocations.some(name => !INVOCATION_ID.test(name) || name !== invocation)) {
    check(false, 'artifact-invocation-identity');
  }
  const files = [];
  const runtime = binding?.backend ?? roots.backend ?? 'cloud-hypervisor';
  check(['docker', 'cloud-hypervisor'].includes(runtime), 'prepared-scope');
  let envelope;
  if (debugInvocations.length) {
    const source = path.join(roots.debug, runId, invocation);
    directory(source, uid, trustedRoot);
    const metadata = fs.lstatSync(source);
    check(metadata.uid === uid && (metadata.mode & 0o7777) === 0o700, 'artifact-directory');
    try {
      envelope = projectDiagnostics(parseRecord(readRegular(path.join(source, 'diagnostics.json'),
        MAX_STREAM_BYTES, uid).toString('utf8')),
      { runId, invocationId: invocation, entryId: invocationEntry, runtime });
    } catch (error) {
      if (error.code === 'ENOENT' && runtime === 'cloud-hypervisor') {
        check(invocationStopped, 'stop-proof', 'not-stopped');
        // Pre-shared-envelope CH releases still retain bounded public-only
        // supplemental evidence only after the journal proves backend cleanup.
        envelope = undefined;
      } else if (error.code === 'ENOENT') check(false, 'diagnostics-envelope', 'absent-evidence');
      else throw error;
    }
  }
  // Independently closed, identity-checked run-cumulative projections can
  // diagnose early failures even when no invocation artifacts were retained.
  let usageStatus = 'missing';
  let responseStatus = 'missing';
  if (runId) {
    const id = createHash('sha256').update(`awf-enclave-proxy-usage-v1:${runId}`).digest('hex').slice(0, 32);
    const diagnostics = path.join(roots.journal, 'diagnostics');
    const source = path.join(diagnostics, `${runId}-${id}.json`);
    try {
      directory(diagnostics, uid, trustedRoot);
      const value = parseRecord(readRegular(source, MAX_USAGE_BYTES, uid).toString('utf8'));
      check(value?.schemaVersion === 1 && value.component === 'enclave-proxy-usage'
        && value.runId === runId && object(value.usage) && value.usage.scope === 'run-cumulative',
      'proxy-run-identity');
      const usage = projectProxyUsage(value.usage);
      usageStatus = `${usage.requests.status}/${usage.tokens.status}`;
      files.push(['enclave-proxy-usage.json', Buffer.from(JSON.stringify({
        schemaVersion: 1, component: 'enclave-proxy-usage', usage,
      }) + '\n')]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const responseId = createHash('sha256').update(`awf-enclave-proxy-response-v1:${runId}`)
      .digest('hex').slice(0, 32);
    try {
      directory(diagnostics, uid, trustedRoot);
      const value = parseRecord(readRegular(
        path.join(diagnostics, `${runId}-${responseId}.json`), MAX_USAGE_BYTES, uid).toString('utf8'));
      if (value?.schemaVersion !== 1 || value.component !== 'enclave-proxy-response'
          || value.runId !== runId) check(false, 'proxy-run-identity');
      const projected = Buffer.from(JSON.stringify(projectProxyResponse({
        schemaVersion: 1, component: 'enclave-proxy-response', ...value.diagnostics,
      })) + '\n');
      responseStatus = JSON.parse(projected.toString('utf8')).status;
      files.push(['enclave-proxy-response.json', projected]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const debugId = createHash('sha256').update(`awf-enclave-proxy-debug-v1:${runId}`)
      .digest('hex').slice(0, 32);
    try {
      directory(diagnostics, uid, trustedRoot);
      const value = parseRecord(readRegular(
        path.join(diagnostics, `${runId}-${debugId}.proxy-debug.json`), 320 * 1024, uid).toString('utf8'));
      if (value?.schemaVersion !== 1 || value.component !== 'enclave-proxy-debug' ||
          value.scope !== 'run-cumulative' || value.runId !== runId ||
          !Array.isArray(value.events) || value.events.length > 4096 ||
          typeof value.containerLog !== 'string') check(false, 'proxy-run-identity');
      files.push(['enclave-proxy-events.jsonl', projectProxyEvents(Buffer.from(
        value.events.map(event => JSON.stringify(event) + '\n').join('')))]);
      files.push(['enclave-proxy-container.log', projectProxyContainerLog(Buffer.from(value.containerLog))]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (debugInvocations.length) {
    const source = path.join(roots.debug, runId, invocation);
    directory(source, uid, trustedRoot);
    const names = inventory(source, uid, trustedRoot);
    check(names.length <= MAX_FILES, 'artifact-count', 'oversized');
    const projected = envelope ? JSON.parse(envelope.toString('utf8')) : undefined;
    const sourceStreams = { 'stdout.log': 'stdout', 'stderr.log': 'stderr', 'enclave-session.log': 'session' };
    for (const name of names) {
      check(LOG_NAME.test(name), 'artifact-name');
      const bytes = readRegular(path.join(source, name), MAX_STREAM_BYTES, uid);
      check(runtime !== 'docker' || projected || !['stdout.log', 'stderr.log'].includes(name),
        'diagnostics-envelope', 'absent-evidence');
      if (sourceStreams[name] && projected && projected.streams[sourceStreams[name]] !== 'captured') {
        check(bytes.length === 0, 'stream-status');
      }
      check(runtime !== 'docker' || ['stdout.log', 'stderr.log', 'enclave-session.log', 'diagnostics.json'].includes(name),
        'artifact-name');
      files.push([name, name === 'diagnostics.json' ? envelope
        : name === 'enclave-session.log' ? redactCredentials(bytes)
        : name === 'enclave-proxy-events.jsonl' ? projectProxyEvents(bytes)
            : name === 'enclave-proxy-container.log' ? projectProxyContainerLog(bytes) : redactCredentials(bytes)]);
    }
    for (const [stream, name] of projected
      ? [['stdout', 'stdout.log'], ['stderr', 'stderr.log'], ['session', 'enclave-session.log']] : []) {
      check(projected.streams[stream] !== 'captured' || names.includes(name), 'captured-stream', 'absent-evidence');
      if (projected.streams[stream] !== 'captured' && names.includes(name)) {
        check(files.find(([candidate]) => candidate === name)[1].length === 0, 'stream-status');
      }
    }
  }
  check(files.length > 0, 'run-evidence', 'absent-evidence');
  const statusContents = `Collected ${files.length} bounded public-fixture debug files.\n` +
    `Non-invocation records: ${nonInvocationRecords}; invalid identity records: ${invalidIdentityRecords}.\n` +
    'Enclave proxy projection scope: run-cumulative.\n' +
    `Shared diagnostics envelope: ${envelope ? 'validated'
      : debugInvocations.length ? 'absent-legacy-supplemental-only' : 'absent-run-level-only'}.\n` +
    `Enclave proxy usage (requests/tokens): ${usageStatus}.\n` +
    `Enclave proxy response diagnostics: ${responseStatus}.\n`;
  assertPublicationBounds(files, statusContents);
  // Publish only after every source passes validation, outside all guest mounts.
  const upload = path.join(runDirectory, 'upload');
  const pending = path.join(runDirectory, 'pending');
  fs.mkdirSync(pending, { mode: 0o700 });
  for (const [name, bytes] of files) {
    const target = path.join(pending, name);
    fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
    fs.chownSync(target, runnerUid, runnerGid);
  }
  const status = path.join(pending, 'collection-status.txt');
  fs.writeFileSync(status, statusContents, { mode: 0o600, flag: 'wx' });
  fs.chownSync(status, runnerUid, runnerGid);
  fs.chownSync(pending, runnerUid, runnerGid);
  fs.renameSync(pending, upload);
  fs.chmodSync(runDirectory, 0o711);
  return files.length;
}

function assertPublicationBounds(files, status) {
  check(files.length + 1 <= MAX_PUBLISHED_FILES, 'publication-file-count', 'oversized');
  const statusBytes = Buffer.byteLength(status);
  check(statusBytes <= MAX_STATUS_BYTES, 'publication-status-size', 'oversized');
  check(files.reduce((total, [, bytes]) => total + bytes.length, statusBytes) <= MAX_PUBLISHED_BYTES,
    'publication-bytes', 'oversized');
  check(new Set(files.map(([name]) => name)).size === files.length, 'artifact-collision');
}

module.exports = {
  prepare, collect, MAX_STREAM_BYTES, MAX_FILES, MAX_PUBLISHED_FILES, MAX_PUBLISHED_BYTES, MAX_STATUS_BYTES,
  directory, inventory, readRegular, projectProxyUsage, projectProxyResponse,
  projectProxyEvents, projectProxyContainerLog, isSafeCopilotAuthLogFields,
  projectDiagnostics, cliRoots, cliCandidates, parseArguments, main, publishCollectionFailure,
  assertPublicationBounds, redactCredentials,
};

function cliRoots(backend, runnerUid) {
  if (backend === 'cloud-hypervisor') return { ...ROOTS, backend, sourceUid: 0 };
  const base = `/var/lib/awf/enclave-storage/${runnerUid}/host-state`;
  return { backend, sourceUid: runnerUid, journal: path.join(base, 'host-executor-journal'),
    debug: path.join(base, 'debug-artifacts', 'docker') };
}

function cliCandidates(backend, runnerUid) {
  const selected = cliRoots(backend, runnerUid);
  return backend === 'docker' ? [selected, {
    backend, sourceUid: 0, journal: ROOTS.journal,
    debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/docker',
  }] : [selected];
}

function snapshot(roots) {
  const trustedRoot = roots.trustedRoot ?? '/';
  return { journal: roots.journal,
    journals: inventory(roots.journal, roots.sourceUid, trustedRoot).filter(name => name.endsWith('.journal')),
    proxyDebug: inventory(path.join(roots.journal, 'diagnostics'), roots.sourceUid, trustedRoot)
      .filter(name => name.endsWith('.proxy-debug.json')),
    debug: inventory(roots.debug, roots.sourceUid, trustedRoot),
  };
}

function parseArguments(args) {
  let [operation, backend, key, uidText, gidText] = args;
  const legacy = (args.length === 2 && operation === 'prepare')
    || (args.length === 4 && operation === 'collect');
  if (legacy) {
    [operation, key, uidText = '0', gidText = '0'] = args;
    backend = 'cloud-hypervisor';
  }
  const validId = value => /^(?:0|[1-9][0-9]{0,9})$/.test(value ?? '')
    && Number(value) <= 0xfffffffe;
  check((args.length === 5 || legacy)
    && ['prepare', 'collect'].includes(operation) && ['docker', 'cloud-hypervisor'].includes(backend)
    && /^[0-9]{1,20}-[0-9]{1,10}$/.test(key ?? '') && validId(uidText) && validId(gidText), 'cli-arguments');
  const runnerUid = Number(uidText);
  const runnerGid = Number(gidText);
  // Historical CH prepare callers did not supply the runner identity. They
  // remain root-only and CH-only; never reinterpret their scope as Docker.
  const binding = legacy ? { backend, legacy: true } : { backend, runnerUid, runnerGid };
  return { operation, backend, key, runnerUid, runnerGid, binding };
}

function main(args = process.argv.slice(2), options = {}) {
  const privilegedUid = options.privilegedUid ?? 0;
  const exportRoot = options.exportRoot ?? '/var/lib/awf-enclave-smoke-export';
  const exportTrustedRoot = options.exportTrustedRoot ?? '/';
  const candidatesForBackend = options.candidatesForBackend ?? cliCandidates;
  check(process.getuid() === privilegedUid, 'cli-arguments');
  const { operation, backend, key, runnerUid, runnerGid, binding } = parseArguments(args);
  const candidates = candidatesForBackend(backend, runnerUid);
  const runDirectory = path.join(exportRoot, key);
  if (operation === 'prepare') {
    // Source ownership may be the unprivileged Docker runner, but staging is root-only.
    directory(path.dirname(runDirectory), privilegedUid, exportTrustedRoot);
    fs.mkdirSync(runDirectory, { mode: 0o700 });
    const baseline = { binding, sourceScopes: candidates.map(snapshot) };
    fs.writeFileSync(path.join(runDirectory, 'baseline.json'), JSON.stringify(baseline), { mode: 0o600, flag: 'wx' });
    return 0;
  }
  try {
    directory(runDirectory, privilegedUid, exportTrustedRoot);
    check(!fs.existsSync(path.join(runDirectory, 'collected')), 'prepared-scope', 'scope-already-collected');
    const prepared = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), MAX_STREAM_BYTES, privilegedUid));
    check(object(prepared) && JSON.stringify(prepared.binding) === JSON.stringify(binding)
      && Array.isArray(prepared.sourceScopes) && prepared.sourceScopes.length === candidates.length, 'prepared-scope');
    const active = candidates.filter((candidate, index) => {
      const before = prepared.sourceScopes[index];
      check(object(before) && before.journal === candidate.journal
        && ['journals', 'debug', 'proxyDebug'].every(key => Array.isArray(before[key])
          && before[key].length <= MAX_DIRECTORY_ENTRIES && before[key].every(name => typeof name === 'string')),
      'prepared-scope');
      const after = snapshot(candidate);
      return ['journals', 'debug', 'proxyDebug'].some(key => after[key].some(name => !before[key].includes(name)));
    });
    if (active.length > 1) {
      fs.writeFileSync(path.join(runDirectory, 'collected'), '', { mode: 0o600, flag: 'wx' });
      check(false, 'run-budget', 'concurrent-runs');
    }
    const roots = active[0] ?? candidates[0];
    collect(runDirectory, runnerUid, runnerGid, roots, roots.sourceUid, roots.trustedRoot ?? '/',
      binding, privilegedUid, exportTrustedRoot);
    return 0;
  } catch (error) {
    const failure = classifyFailure(error);
    publishCollectionFailure(runDirectory, runnerUid, runnerGid, error, privilegedUid, exportTrustedRoot, binding);
    process.stderr.write(`Collection failed: failedCheck=${failure.failedCheck} category=${failure.category}\n`);
    return 1;
  }
}

function publishCollectionFailure(runDirectory, runnerUid, runnerGid, error, uid = 0, trustedRoot = '/', binding) {
  const failure = classifyFailure(error);
  directory(runDirectory, uid, trustedRoot);
  const baseline = JSON.parse(readRegular(path.join(runDirectory, 'baseline.json'), MAX_STREAM_BYTES, uid));
  check(!binding || JSON.stringify(baseline.binding) === JSON.stringify(binding), 'prepared-scope');
  if (!fs.existsSync(path.join(runDirectory, 'collected'))) {
    fs.writeFileSync(path.join(runDirectory, 'collected'), '', { mode: 0o600, flag: 'wx' });
  }
  // Never overwrite a successful export or publish partially validated data.
  if (!fs.existsSync(path.join(runDirectory, 'upload'))) {
    const pending = path.join(runDirectory, 'pending');
    if (fs.existsSync(pending)) directory(pending, uid, trustedRoot);
    fs.rmSync(pending, { recursive: true, force: true });
    const upload = path.join(runDirectory, 'upload');
    fs.mkdirSync(upload, { mode: 0o700 });
    const target = path.join(upload, 'collection-status.txt');
    fs.writeFileSync(target, `Collection failed: failedCheck=${failure.failedCheck} category=${failure.category}\n`,
      { mode: 0o600, flag: 'wx' });
    fs.chownSync(target, runnerUid, runnerGid);
    fs.chownSync(upload, runnerUid, runnerGid);
    fs.chmodSync(runDirectory, 0o711);
  }
}

function classifyFailure(error) {
  const checks = ['operation-schema', 'session-schema', 'session-bound', 'stream-bound',
    'diagnostics-schema', 'diagnostics-identity',
    'retention-eligibility', 'stop-proof', 'stream-schema', 'coverage-schema', 'backend-schema', 'docker-stop-proof',
    'prepared-scope', 'run-budget', 'journal-schema', 'journal-identity', 'invocation-budget', 'proxy-run-identity',
    'artifact-run-identity', 'artifact-invocation-identity', 'artifact-directory', 'diagnostics-envelope',
    'run-evidence', 'artifact-name', 'captured-stream', 'stream-status', 'artifact-collision', 'cli-arguments',
    'path-containment', 'directory-metadata', 'inventory-count', 'file-type', 'file-links', 'file-owner',
    'file-permissions', 'file-size', 'file-device', 'file-growth', 'proxy-event-completeness', 'proxy-event-count',
    'proxy-event-schema', 'proxy-response-schema', 'proxy-container-size', 'proxy-container-schema', 'artifact-count',
    'proxy-event-encoding', 'proxy-container-encoding',
    'publication-file-count', 'publication-status-size', 'publication-bytes', 'credential-redaction-bound'];
  if (checks.includes(error.failedCheck) && ['invalid-evidence', 'ineligible', 'not-stopped',
    'absent-evidence', 'scope-already-collected', 'unsafe-directory', 'unsafe-file', 'unsafe-permissions',
    'oversized', 'concurrent-runs', 'multiple-invocations'].includes(error.category)) {
    return { failedCheck: error.failedCheck, category: error.category };
  }
  const filesystem = {
    ENOENT: { failedCheck: 'source-presence', category: 'absent-evidence' },
    EEXIST: { failedCheck: 'prepared-scope', category: 'scope-already-collected' },
    ELOOP: { failedCheck: 'source-link', category: 'unsafe-file' },
    EACCES: { failedCheck: 'filesystem-permissions', category: 'unsafe-permissions' },
    EPERM: { failedCheck: 'filesystem-permissions', category: 'unsafe-permissions' },
    EFBIG: { failedCheck: 'file-size', category: 'oversized' },
  };
  return filesystem[error.code] ?? { failedCheck: 'source-io', category: 'read-failed' };
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) {
    const failure = classifyFailure(error);
    process.stderr.write(`Collection failed: failedCheck=${failure.failedCheck} category=${failure.category}\n`);
    process.exitCode = 1;
  }
}
