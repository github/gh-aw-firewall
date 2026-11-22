/* global require, module, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports */
const { MAX_STREAM_BYTES, object, check, parseRecord } = require('./common.cjs');
const { decodeUtf8 } = require('./safe-fs.cjs');
const { isSafeCopilotAuthLogFields } = require('./redaction.cjs');

const STREAM_STATUSES = ['captured', 'missing', 'unsafe', 'oversized', 'read-failed', 'not-applicable', 'unavailable'];
const OPERATION_STAGES = ['storage-preparation', 'storage-probe', 'network-isolation', 'authority-handoff',
  'workload-create', 'workload-start', 'entrypoint-initialization', 'workload-exit', 'output-validation', 'cleanup'];
const ERROR_CATEGORIES = ['host-exception', 'not-found', 'permission-denied', 'operation-not-permitted',
  'symlink-loop', 'no-space', 'quota-exceeded', 'file-too-large', 'io-error', 'read-only-filesystem',
  'cancelled', 'timeout', 'workload-exit', 'result-invalid', 'cleanup-failed', 'retention-failed'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const exitCode = value => value === null || (Number.isInteger(value) && value >= -64 && value <= 255);
const SESSION_PATHS = ['copilot-executable', 'codex-executable', 'claude-executable', 'seed-directory', 'task-input', 'schema-input', 'output-file',
  'session-log', 'agent-directory', 'copilot-log-directory', 'codex-log-directory', 'claude-log-directory', 'github-agent-id', 'github-bearer',
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
  ...['home-directory', 'copilot-directory', 'copilot-log-directory',
    'codex-directory', 'codex-log-directory', 'claude-directory', 'claude-log-directory']
    .map(id => `runtime-path-creation-${id}`),
  ...['agent-directory', 'temporary-directory', 'shared-memory'].map(id => `resource-${id}-statvfs`),
  ...OUTPUT_PATHS.flatMap(id => [`snapshot-${id}-stat`, `snapshot-${id}-lstat`]),
  'verify-output-link-lstat', 'verify-output-link-readlink',
  ...['direct', 'alias'].flatMap(id =>
    ['open', 'fstat', 'validate', 'read', 'close'].map(op => `verify-output-${id}-${op}`)),
];
const ENTRYPOINT_OPERATIONS = SESSION_OPERATIONS.filter(operation =>
  operation.startsWith('preflight-') || operation.startsWith('runtime-path-creation-')
  || operation.startsWith('session-log-') || operation === 'engine-launch'
  || /^(?:task-input-read|schema-input-read|github-agent-id-read|github-bearer-read|github-mcp-config-(?:write|chmod))(?:-open|-close)?$/.test(operation));
function fields(value, schema, failedCheck = 'session-schema') {
  check(object(value), failedCheck);
  const result = {};
  for (const [key, validate] of Object.entries(schema)) {
    if (value[key] === undefined) continue;
    check(validate(value[key]), failedCheck);
    result[key] = value[key];
  }
  return result;
}
const boolean = value => typeof value === 'boolean';
const member = values => value => values.includes(value);
const boundedErrno = value => count(value) && value <= 4095;
const identityNumber = value => [0, 65534, 'other'].includes(value);
const OUTPUT_FLAGS = ['symlink', 'targetMatches', 'sameFile', 'directReadable', 'aliasReadable'];

function projectOperation(value, failed = false) {
  check(object(value) && OPERATION_STAGES.includes(value.stage)
    && ['started', 'succeeded', 'failed', 'unavailable', 'not-applicable'].includes(value.status)
    && (!failed || (value.status === 'failed' && ERROR_CATEGORIES.includes(value.category)))
    && (value.category === undefined || ERROR_CATEGORIES.includes(value.category))
    && (value.errno === undefined || [2, 13, 1, 40, 28, 122, 27, 5, 30].includes(value.errno))
    && (value.operation === undefined || (value.stage === 'entrypoint-initialization' && value.status === 'failed'
      && ENTRYPOINT_OPERATIONS.includes(value.operation))), 'operation-schema');
  return { stage: value.stage, status: value.status,
    ...(value.category !== undefined ? { category: value.category } : {}),
    ...(value.errno !== undefined ? { errno: value.errno } : {}),
    ...(value.operation !== undefined ? { operation: value.operation } : {}) };
}

function projectRetentionUnavailable(value, identity) {
  check(object(value) && value.version === 1 && value.runtime === 'docker' && identity.runtime === 'docker'
    && value.runId === identity.runId && value.invocationId === identity.invocationId
    && value.entryId === identity.entryId && ['agent', 'script'].includes(value.executorKind)
    && value.stage === 'setup' && value.status === 'unavailable'
    && value.reason === 'host-reconciliation-incomplete'
    && Array.isArray(value.stages) && value.stages.length <= 64 && object(value.primaryFailure),
  'retention-unavailable-schema');
  return Buffer.from(JSON.stringify({
    version: 1, runtime: 'docker', runId: identity.runId, invocationId: identity.invocationId,
    entryId: identity.entryId, executorKind: value.executorKind,
    stage: 'setup', status: 'unavailable', reason: 'host-reconciliation-incomplete',
    stages: value.stages.map(event => projectOperation(event)),
    primaryFailure: projectOperation({ ...value.primaryFailure, status: 'failed' }, true),
    ...(value.cleanupFailure ? { cleanupFailure: projectOperation({ ...value.cleanupFailure, status: 'failed' }, true) } : {}),
  }) + '\n');
}

// The diagnostics envelope keeps only finite operational evidence. Approved
// producer-redacted raw session streams are retained separately below.
function projectSessionEvent(value) {
  if (!object(value)) return undefined;
  const result = {};
  const stages = ['configuration-accepted', 'input-accepted', 'runtime-paths-ready', 'preflight-completed',
    'engine-launch-attempt', 'engine-started', 'engine-completed', 'output-normalization-started',
    'output-normalized', 'output-write-attempt', 'output-written',
    'claude-first-byte', 'claude-initialized', 'claude-response', 'claude-tool-requested',
    'claude-tool-completed', 'claude-permission-denied', 'claude-api-retry', 'claude-result', 'claude-stream-summary',
    'claude-startup-failure'];
  const categories = [...ERROR_CATEGORIES, 'configuration-invalid', 'input-invalid', 'engine-failed',
    'result-write-failed', 'deadline-exceeded', 'result-read-failed', 'result-reset-failed', 'result-empty',
    'result-too-large', 'result-invalid-utf8', 'result-whitespace-only', 'diagnostic-encoding-failed',
    'not-executable', 'not-directory', 'is-directory', 'os-error', 'startup-crash', 'too-many-open-files'];
  if (value.event === 'progress' && stages.includes(value.stage)) {
    result.event = value.event;
    result.stage = value.stage;
    if (typeof value.valid === 'boolean') result.valid = value.valid;
    if (value.stage.startsWith('claude-')) {
      Object.assign(result, fields(value, {
        ...Object.fromEntries(['shellAvailable', 'toolError', 'resultError', 'stdoutObserved',
          'stderrObserved', 'captureTruncated'].map(key => [key, boolean])),
        permissionMode: member(['default', 'auto', 'acceptEdits', 'bypassPermissions', 'unknown']),
        outputState: member(['present', 'empty', 'unavailable']),
        toolClass: member(['shell', 'file-read', 'file-write', 'output-write', 'search', 'unknown']),
        httpStatus: member([null, 400, 401, 403, 404, 408, 429, 500, 502, 503, 504, 529]),
      }));
      if (value.stage === 'claude-startup-failure') {
        Object.assign(result, fields(value, {
          classification: member(['unknown-option', 'invalid-option-value', 'missing-option-value',
            'invalid-settings', 'invalid-mcp-config', 'unknown']),
        }));
      }
    }
  } else if (value.event === 'failure' && categories.includes(value.category)) {
    result.event = value.event;
    result.category = value.category;
  } else if (value.event === 'preflight' && SESSION_PATHS.includes(value.path)) {
    Object.assign(result, { event: value.event, path: value.path }, fields(value, {
      type: member(['file', 'directory', 'missing', 'other', 'forbidden-seed-mount']),
      exists: boolean, executable: boolean, writable: boolean,
    }));
    if (value.path === 'session-log') {
      Object.assign(result, fields(value, {
        uid: value => count(value), gid: value => count(value),
        writerUid: value => count(value), writerGid: value => count(value),
        parentUid: value => count(value), parentGid: value => count(value),
        mode: value => count(value) && value <= 0o7777,
        parentMode: value => count(value) && value <= 0o7777,
        links: value => count(value) && value <= 1_000_000,
        parentTraversable: boolean, mountWritable: boolean,
        failedCheck: member(['session-parent-stat', 'session-mount-statvfs', 'session-log-stat', 'session-log-open']),
        failureCategory: member(categories), failureErrno: boundedErrno,
      }));
      for (const key of ['uid', 'gid', 'writerUid', 'writerGid', 'parentUid', 'parentGid']) {
        if (result[key] !== undefined) result[key] = result[key] === 0 || result[key] === 65534 ? result[key] : 'other';
      }
    }
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
  if (value.claudeStreamSummary !== undefined) {
    check(object(value.claudeStreamSummary) && value.claudeStreamSummary.event === 'progress'
      && value.claudeStreamSummary.stage === 'claude-stream-summary', 'session-schema');
    result.claudeStreamSummary = projectSessionEvent(value.claudeStreamSummary);
  }
  if (value.claudeStartupFailure !== undefined) {
    check(object(value.claudeStartupFailure) && value.claudeStartupFailure.event === 'progress'
      && value.claudeStartupFailure.stage === 'claude-startup-failure', 'session-schema');
    result.claudeStartupFailure = projectSessionEvent(value.claudeStartupFailure);
  }
  if (value.claudeResult !== undefined) {
    check(object(value.claudeResult) && value.claudeResult.event === 'progress'
      && value.claudeResult.stage === 'claude-result', 'session-schema');
    result.claudeResult = projectSessionEvent(value.claudeResult);
  }
  if (value.claudePermissionDenials !== undefined) {
    check(Array.isArray(value.claudePermissionDenials) && value.claudePermissionDenials.length <= 7, 'session-schema');
    result.claudePermissionDenials = value.claudePermissionDenials.map(event => {
      check(object(event) && event.event === 'progress' && event.stage === 'claude-permission-denied', 'session-schema');
      return projectSessionEvent(event);
    });
  }
  if (value.claudeToolErrors !== undefined) {
    check(Array.isArray(value.claudeToolErrors) && value.claudeToolErrors.length <= 7, 'session-schema');
    result.claudeToolErrors = value.claudeToolErrors.map(event => {
      check(object(event) && event.event === 'progress' && event.stage === 'claude-tool-completed'
        && event.toolError === true, 'session-schema');
      return projectSessionEvent(event);
    });
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
  const metadataOnly = identity.runtime === 'docker' && value.workloadStopped === false
    && value.stopProof === 'unavailable' && value.cleanupFailure !== undefined;
  check(typeof value.workloadLaunched === 'boolean'
    && (value.workloadLaunched || (value.exitCode === null
      && ((['setup-failed', 'cancelled', 'timeout'].includes(value.failure) && value.stage === 'setup')
        || (value.failure === 'retention-failed' && value.stage === 'retention'))))
    && (metadataOnly || (value.workloadStopped === true
      && value.stopProof === (value.workloadLaunched ? 'verified' : 'not-launched'))),
  'stop-proof', 'not-stopped');
  check(Array.isArray(value.stages) && value.stages.length <= 64, 'operation-schema');
  check(object(value.streams) && ['stdout', 'stderr', 'session'].every(key =>
    STREAM_STATUSES.includes(value.streams[key])), 'stream-schema');
  const streams = Object.fromEntries(['stdout', 'stderr', 'session'].map(key => [key, value.streams[key]]));
  check(!metadataOnly || (Object.values(streams).every(status => status === 'unavailable')
    && object(value.session) && value.session.status === 'unavailable'
    && Object.keys(value.session).length === 1), 'stop-proof', 'not-stopped');
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
  check(!metadataOnly || (coverage.copilotDiagnostics === 'unavailable'
    && ['stdout', 'stderr'].every(key => streamCoverage[key].agentSession === 'unavailable')),
  'stop-proof', 'not-stopped');
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
    exitCode: value.exitCode, workloadStopped: value.workloadStopped,
    workloadLaunched: value.workloadLaunched, stopProof: value.stopProof,
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

function projectStartupChecklist(value) {
  const schema = STARTUP_CHECKLIST_SCHEMA;
  check(object(value) && value.schemaVersion === 1 && typeof value.ready === 'boolean'
    && object(value.checks), 'startup-schema');
  const checks = {};
  const scopes = new Set();
  for (const [id, outcome] of Object.entries(value.checks)) {
    const [scope, name, extra] = id.split('/');
    check(extra === undefined && Object.hasOwn(schema.scopes, scope)
      && Object.hasOwn(schema.scopes[scope], name)
      && Array.isArray(outcome) && outcome.length === 2
      && ['not-attempted', 'not-required', 'attempted', 'passed', 'failed'].includes(outcome[0])
      && typeof outcome[1] === 'string' && Object.hasOwn(schema.reasons, outcome[1])
      && (outcome[0] === 'failed' ? outcome[1] !== 'none' : outcome[1] === 'none')
      && (outcome[0] !== 'not-required' || schema.optionalChecks.includes(id)), 'startup-schema');
    checks[id] = [...outcome];
    scopes.add(scope);
  }
  for (const scope of scopes) {
    check(Object.keys(schema.scopes[scope]).every(name => Object.hasOwn(checks, `${scope}/${name}`)), 'startup-schema');
  }
  check(!value.ready || (checks['startup/readiness']?.[0] === 'passed'
    && Object.values(checks).every(([result]) => ['passed', 'not-required'].includes(result))), 'startup-schema');
  return { schemaVersion: 1, ready: value.ready, checks };
}

const RESULT_REASONS = ['parser-protocol', 'tool-rejected', 'schema-validation', 'expected-result-mismatch', 'unknown'];
const RESULT_CODES = Object.freeze([
  'unknown', 'canonical-error', 'result-shape', 'probe-mismatch',
  'response-missing', 'jsonrpc-version', 'request-id', 'jsonrpc-error', 'result-missing',
  'tool-is-error', 'structured-content', 'structured-fields', 'content-mismatch',
  'invalid-json', 'http-status', 'response-too-large', 'response-aborted', 'response-failed',
  'request-failed', 'request-timeout',
]);
const EXECUTOR_OUTCOMES = ['success', 'schema-failure', 'executor-failure', 'timeout', 'cancelled'];

function projectResultFailure(value) {
  const result = fields(value, {
    category: member(RESULT_REASONS), code: member(RESULT_CODES),
    executorOutcome: member(['unknown', ...EXECUTOR_OUTCOMES]),
  }, 'result-failure-schema');
  check(Object.keys(result).length === 3, 'result-failure-schema');
  return result;
}

function projectAuditEvidence(value) {
  const result = fields(value, {
    contract: member(['success', 'failure-observation']),
    successInvocations: member(['none', 'one', 'multiple']),
    failureRecords: member(['none', 'one', 'multiple']),
    invocationIdentity: member(['missing', 'valid', 'invalid', 'multiple']),
    repository: member(['not-observed', 'matched', 'mismatch']),
    sensitivity: member(['not-observed', 'public', 'other']),
  }, 'finalization-schema');
  check(Object.keys(result).length === 6, 'finalization-schema');
  return result;
}

function projectStartup(value, backend) {
  check(object(value) && value.backend === backend
    && ['docker', 'cloud-hypervisor'].includes(backend)
    && ['copilot', 'claude', 'codex'].includes(value.agent)
    && ['configuration', 'gateway', 'launch', 'broker', 'gateway-readiness',
      'primary-readiness', 'invocation', 'result'].includes(value.failureStage)
    && object(value.diagnostic) && object(value.evidence)
    && object(value.evidence.record) && object(value.evidence.stderr), 'startup-schema');
  const stages = ['host-bootstrap', 'runtime-preflight', 'configuration', 'enclave-preflight',
    'host-preflight', 'artifact-preflight', 'seed-staging', 'storage-preflight', 'recovery',
    'host-service', 'host-network', 'compose-config', 'containers', 'gateway-attach',
    'github-readiness', 'gateway-contract', 'initialize', 'initialized', 'tools-list',
    'delegation', 'primary-agent'];
  const sizes = [null, 'empty', '<=16KiB', '<=64KiB', '<=1MiB', '<=8MiB', '>8MiB'];
  const inspections = ['not-attempted', 'ok', 'tail', 'missing', 'oversize', 'not-regular',
    'io-error', 'unstable', 'replaced', 'parse', 'shape', 'valid'];
  const diagnostic = fields(value.diagnostic, {
    schemaVersion: member([1, 2]), phase: member(['pre-broker', 'host-startup']),
    stage: member(['initial', 'recovery']),
    reason: member(['exit', 'signal', 'timeout', 'spawn-failure', 'unknown']),
    category: member(['unknown', 'configuration', 'container-runtime', 'host-preflight',
      'artifact', 'host-service', 'recovery-state', 'broker', 'unsupported-host',
      'gateway-auth', 'dns', 'connectivity', 'gateway-readiness', 'gateway-protocol', 'other']),
    exitCode: value => value === null || (count(value) && value <= 255),
    signal: member([null, 'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV', 'SIGBUS']),
    logInspection: member(['unavailable', 'structured', 'bounded']),
  });
  check(Object.keys(diagnostic).length === 8, 'startup-schema');
  if (value.diagnostic.earlyFailure !== undefined) {
    // The protected collector and its sibling modules are root-owned.
    diagnostic.earlyFailure = fields(value.diagnostic.earlyFailure, {
      schemaVersion: member([1]), phase: member(['configuration', 'validation', 'backend-selection']),
      reason: member(['configuration-rejected', 'validation-rejected', 'backend-selection-rejected',
        'cloud-hypervisor-enclave-admission',
        'cloud-hypervisor-enclave-admission-workflow-source',
        'cloud-hypervisor-enclave-admission-configuration-profile',
        'cloud-hypervisor-enclave-admission-token-acquisition',
        'cloud-hypervisor-enclave-admission-signature',
        'cloud-hypervisor-enclave-admission-claims']),
    });
    check(Object.keys(diagnostic.earlyFailure).length === 3, 'startup-schema');
  }
  if (value.diagnostic.enclaveStartup !== undefined) {
    diagnostic.enclaveStartup = fields(value.diagnostic.enclaveStartup, {
      stage: member(stages), readiness: member(['not-attempted', 'attempted', 'ready']),
      code: member(['none', 'unknown', 'dns-not-found', 'dns-temporary', 'connection-refused',
        'connection-timeout', 'request-timeout', 'network-unreachable', 'host-unreachable',
        'connection-reset', 'transport-other', 'http-auth', 'http-status', 'backend-unavailable',
        'response-too-large', 'malformed-json', 'malformed-protocol', 'rpc-error',
        'identity-mismatch', 'tools-mismatch', 'readiness-deadline', 'ready']),
      attempts: value => count(value) && value <= 1200,
      httpStatus: value => value === null || (count(value) && value >= 100 && value <= 599),
    });
    if (value.diagnostic.enclaveStartup.startupChecks !== undefined) {
      diagnostic.enclaveStartup.startupChecks = projectStartupChecklist(value.diagnostic.enclaveStartup.startupChecks);
    }
  }
  const evidence = {
    record: fields(value.evidence.record, {
      final: member(inspections), size: member(sizes), source: member(['none', 'final', 'cached']),
      cachedPolls: value => count(value) && value <= 1_000_000, cachedSize: member(sizes),
    }),
    stderr: fields(value.evidence.stderr, {
      inspection: member(inspections), size: member(sizes), attempts: value => count(value) && value <= 5,
    }),
  };
  if (value.evidence.awfExit !== null && value.evidence.awfExit !== undefined) {
    evidence.awfExit = fields(value.evidence.awfExit, {
      exitCode: value => count(value) && value <= 255,
      path: member(['fatal', 'workflow-return']), stage: member([null, ...stages]),
      containersStarted: boolean, agentStarted: boolean,
      cleanup: member(['pending', 'completed', 'failed']),
      recordAfterCleanup: member(['present', 'missing', 'unknown']),
      recordWrite: member(['written', 'oversize', 'unsafe-target', 'io-error', 'error', 'not-attempted']),
    });
  }
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, component: 'enclave-regression-startup', backend, agent: value.agent,
    failureStage: value.failureStage, diagnostic, evidence,
    ...(value.resultFailure === undefined ? {} : { resultFailure: projectResultFailure(value.resultFailure) }),
  }) + '\n');
}

const FINALIZATION_REASONS = Object.freeze({
  result: ['none', ...RESULT_REASONS],
  'awf-stop': ['none', 'stop-request-failed', 'stop-failed'],
  'awf-exit': ['none', 'nonzero-exit', 'signal', 'not-exited'],
  'audit-presence': ['none', 'missing', 'unsafe', 'io-error'],
  'audit-schema': ['none', 'invalid'],
  'audit-invocation': ['none', 'count', 'identity', 'repository', 'sensitivity', 'failure-record'],
  'awf-cleanup': ['none', 'incomplete-audit', 'work-dir-present', 'io-error'],
  'gateway-cleanup': ['none', 'remove-failed'],
  'stop-file-cleanup': ['none', 'remove-failed'],
  'diagnostic-retention': ['none', 'retention-failed'],
});
const PRIMARY_STAGES = ['configuration', 'gateway', 'launch', 'broker', 'gateway-readiness',
  'primary-readiness', 'invocation', 'result'];

function projectFinalization(value, backend) {
  check(object(value) && value.schemaVersion === 1 && value.backend === backend
    && ['docker', 'cloud-hypervisor'].includes(backend)
    && ['copilot', 'codex', 'claude'].includes(value.agent)
    && boolean(value.resultValidated) && object(value.checks), 'finalization-schema');
  const checks = {};
  for (const [gate, reasons] of Object.entries(FINALIZATION_REASONS)) {
    const entry = value.checks[gate] ?? (gate === 'result' ? ['not-attempted', 'none'] : undefined);
    check(Array.isArray(entry) && entry.length === 2
      && ['passed', 'failed', 'not-attempted', 'not-required'].includes(entry[0])
      && reasons.includes(entry[1]) && (entry[0] === 'failed') === (entry[1] !== 'none'),
    'finalization-schema');
    checks[gate] = [...entry];
  }
  const failure = item => {
    check(object(item) && (item.gate === 'primary'
      ? PRIMARY_STAGES.includes(item.reason)
      : typeof item.gate === 'string' && Object.prototype.hasOwnProperty.call(FINALIZATION_REASONS, item.gate)
        && FINALIZATION_REASONS[item.gate].includes(item.reason) && item.reason !== 'none'),
    'finalization-schema');
    return { gate: item.gate, reason: item.reason };
  };
  check(Array.isArray(value.secondaryFailures)
    && value.secondaryFailures.length <= Object.keys(FINALIZATION_REASONS).length, 'finalization-schema');
  return Buffer.from(JSON.stringify({
    schemaVersion: 1, component: 'enclave-regression-finalization', backend, agent: value.agent,
    resultValidated: value.resultValidated, checks,
    ...(value.resultFailure === undefined ? {} : { resultFailure: projectResultFailure(value.resultFailure) }),
    ...(value.auditEvidence === undefined ? {} : { auditEvidence: projectAuditEvidence(value.auditEvidence) }),
    primaryFailure: value.primaryFailure === null ? null : failure(value.primaryFailure),
    secondaryFailures: value.secondaryFailures.map(failure),
  }) + '\n');
}

const STARTUP_CHECKLIST_SCHEMA = {
  scopes: Object.fromEntries([
    ['vm-launch', 'artifact-preflight,recovery,identity,network,rootfs,run-directory,cgroup,kernel-stage,rootfs-stage,vmm-launch,api-socket,api-ping,confinement,virtiofsd,vm-create,vm-boot,guest-connect'],
    ['enclave-network', 'gateway-identity,network-inspect,network-topology,network-membership,api-proxy-ready,gateway-ready,bridge-ready'],
    ['host-invocation', 'policy,filesystem,export-plan,snapshot,snapshot-digest,workload-profile,input-staging,manager-create,manager-start,instance-start,guest-execute,result-read'],
    ['host-invocation-cleanup', 'pending-work,manager-stop,manager-record,snapshot-remove,filesystem-remove,storage-close,journal-complete'],
    ['startup', 'configuration,enclave-preparation,network-enforcement,compose-configuration,infrastructure,gateway-attachment,github-attachment,github-ready,gateway-ready,delegation,readiness'],
    ['gateway-attachment', 'contract,identity,network-connect,network-membership'],
    ['gateway-handshake', 'contract,initialize,initialized,tools-list'],
    ['enclave-runtime', 'primary-runtime,script-runtime,agent-runtime,host-service'],
    ['enclave-storage', 'private-root-isolation,work-directory,directory-layout,run-identity,seed-catalog,capability-staging,github-identity,delegation-custody'],
    ['host-isolation', 'journal-isolation,invocation-isolation,allocation-isolation,debug-artifact-isolation'],
    ['provider-selection', 'storage-provider'],
    ['storage-admission', 'root,runner-eligibility,ubuntu-distribution,mount-capability,tmpfs-support,kvm-access,kvm-device,kvm-open,cgroup-writable,cgroup-controllers'],
    ['bounded-runtime', 'configured-role,tool-mount,tool-umount,invocation-root,invocation-parent,resource-journal,storage-allocation,storage-ancestor,storage-parent,storage-root,storage-tmpfs,storage-propagation-set,storage-propagation,storage-layout,storage-artifact-mount,storage-run-mounts,invocation-directory,invocation-mount,storage-verification,operator-identity,artifact-configuration,cloud-hypervisor-trust,virtiofsd-trust,tool-getent,tool-getfacl,tool-groupdel,tool-id,tool-ip,tool-nft,tool-sysctl,tool-flock,tool-mke2fs,tool-debugfs,tool-e2fsck,tool-rsync,tool-setfacl,tool-setpriv,tool-useradd,tool-userdel,kernel-trust,rootfs-trust,sbom-trust,supervisor-trust,manifest-trust,bundle-trust,artifact-snapshot,snapshot-journal,tool-gh,manifest-attestation,manifest-contents,cloud-hypervisor-digest,virtiofsd-digest,cloud-hypervisor-version,virtiofsd-version,kernel-digest,rootfs-digest,sbom-digest,sbom-contents,supervisor-digest,platform,architecture,kvm-access,kvm-group,host-policy,root,ipv4-control,ipv6-control,seccomp-control,cgroup-v2,tool-docker,docker-infrastructure,docker-info,docker-compose'],
    ['storage-verification', 'journal-identity,mountinfo-read,mountinfo-observation,allocation-root,invocation-state,run-storage,rootfs-preparation,artifact-parent,sealed-snapshot'],
    ['artifact-snapshot', 'root,directory,identity,vmm-copy,vmm-mode,virtiofsd-copy,virtiofsd-mode,kernel-copy,kernel-mode,rootfs-copy,rootfs-mode,sbom-copy,sbom-mode,supervisor-copy,supervisor-mode,manifest-copy,manifest-mode,bundle-copy,bundle-mode,directory-mode,mount-intent,topology-before,bind,mount-capture,readonly-exec,sealed-storage,partial-remove'],
    ['bounded-cleanup', 'storage-close,directory-release,journal-complete'],
    ['storage-mount-capture', 'canonical-path,mountinfo-read,mountinfo-parse,mountinfo-topology,match-count,filesystem,source,journal-open,journal-write,journal-file-sync,journal-file-close,journal-publish,journal-directory-sync,journal-staging-remove'],
    ['bounded-artifacts', 'configured-role,tool-mount,tool-umount,invocation-root,invocation-parent,resource-journal,storage-allocation,storage-ancestor,storage-parent,storage-root,storage-tmpfs,storage-propagation-set,storage-propagation,storage-layout,storage-artifact-mount,storage-run-mounts,invocation-directory,invocation-mount,storage-verification,operator-identity,tool-gh,tool-rsync,verification-directory,enclave-artifacts,manifest-bundle-path,manifest-trust,bundle-trust,manifest-read,bundle-read,manifest-parse,manifest-attestation,rootfs-configuration,rootfs-trust,rootfs-provenance-trust,rootfs-copy,rootfs-digest,rootfs-attestation,sbom-trust,sbom-digest,sbom-contents'],
  ].map(([scope, names]) => [
    scope, Object.fromEntries(names.split(',').map(name => [name, null])),
  ])),
  optionalChecks: [
    'enclave-network/gateway-identity', 'enclave-network/gateway-ready',
    'storage-verification/sealed-snapshot',
    'startup/github-attachment', 'startup/github-ready', 'startup/delegation',
    'enclave-runtime/script-runtime', 'enclave-runtime/agent-runtime', 'enclave-runtime/host-service',
    'enclave-storage/seed-catalog', 'enclave-storage/github-identity', 'enclave-storage/delegation-custody',
    'artifact-snapshot/manifest-copy', 'artifact-snapshot/manifest-mode',
    'artifact-snapshot/bundle-copy', 'artifact-snapshot/bundle-mode',
    'artifact-snapshot/sbom-copy', 'artifact-snapshot/sbom-mode',
    'artifact-snapshot/rootfs-copy', 'artifact-snapshot/rootfs-mode',
    'bounded-runtime/rootfs-trust', 'bounded-runtime/rootfs-digest',
    'bounded-runtime/sbom-trust', 'bounded-runtime/sbom-digest', 'bounded-runtime/sbom-contents',
    'bounded-artifacts/sbom-contents',
    'artifact-snapshot/partial-remove', 'bounded-cleanup/directory-release',
  ],
  reasons: Object.fromEntries(
    'none,unknown,requirement-not-met,platform-unsupported,architecture-unsupported,github-actions-required,runner-not-github-hosted,ubuntu-image-required,command-failed,guest-disconnected,guest-socket-error,guest-read-timeout,guest-write-timeout,guest-not-writable,guest-output-failed,guest-protocol-error,guest-rejected,invocation-timeout,invocation-cancelled,result-invalid,mount-noexec,storage-mount-options,storage-mount-propagation,storage-path-changed,storage-cap-changed,mountinfo-malformed,storage-mount-missing,storage-mount-multiple,storage-mount-filesystem,storage-mount-source,storage-identity-uncommitted,storage-mount-identity-changed,storage-mount-unrecorded,rsync-file-io,rsync-partial-transfer,rsync-source-vanished,rsync-source-read,rsync-destination-write,path-not-absolute,private-root-overlap,mount-source-invalid,ancestor-symlink,ancestor-writable,ancestor-owner,file-symlink,file-type,file-writable,file-owner,tool-not-found,version-format,version-mismatch,digest-format,digest-empty,digest-mismatch,attestation-failed,artifact-size,ENOENT,EACCES,EPERM,ENOTDIR,ELOOP,ENOEXEC,EISDIR,ENOSPC,EDQUOT,EROFS,EIO,dns-not-found,dns-temporary,connection-refused,connection-timeout,request-timeout,network-unreachable,host-unreachable,connection-reset,transport-other,http-auth,http-status,backend-unavailable,response-too-large,malformed-json,malformed-protocol,rpc-error,identity-mismatch,tools-mismatch,readiness-deadline'
      .split(',').map(reason => [reason, null]),
  ),
};

module.exports = {
  projectOperation, projectRetentionUnavailable, projectSessionEvent, projectSession, projectDiagnostics,
  projectProxyUsage, projectProxyEvents, projectProxyResponse, projectProxyContainerLog,
  projectStartupChecklist, projectResultFailure, projectAuditEvidence, projectStartup, projectFinalization,
  FINALIZATION_REASONS, RESULT_CODES, EXECUTOR_OUTCOMES,
};
