'use strict';

const fs = require('fs');
const path = require('path');
const collector = require('./collect-enclave-smoke-debug.cjs');
const { normalizeEnclavesConfig } = require('../../dist/parsers/enclave-parser');
const { resolvePublicEnclaveDebugConfig, validatePublicEnclaveDebug } = require('../../dist/enclave/public-debug');
const { projectEnclaveSessionDiagnostics } = require('../../dist/cloud-hypervisor/enclave-session-diagnostics');
const { schema } = require('../../dist/cloud-hypervisor/host-preflight-schema');
const { HOST_EXECUTOR_ERRORS, HOST_EXECUTOR_OUTCOMES } = require('../../dist/enclave/host-executor-protocol');
const { ENCLAVE_PRIVATE_BASE_DIR } = require('../../dist/enclave/paths');

const EXPORT_ROOT = '/var/lib/awf-enclave-conformance-export';
const ROOTS = {
  journal: '/var/lib/awf-cloud-hypervisor/host-executor-journal',
  debug: '/var/lib/awf-cloud-hypervisor/debug-artifacts/cloud-hypervisor',
};
const DIAGNOSTIC_NAME = /^([a-f0-9]{32})-([a-f0-9]{32})(?:\.proxy-debug)?\.json$/;
const INVOCATION_ID = /^[a-f0-9]{16,64}$/;
const UPLOAD_NAME = /^(?:acceptance|invocation-[0-9]+|session-[0-9]+|proxy-[0-9]+)\.json$/;
const MAX_RECORDS = 128;

const CHECK_STEPS = ['guest-failure', 'guest-timeout', 'guest-cancellation',
  'agent-enospc', 'script-enospc', 'guest-oom', 'crash-recovery', 'script-only', 'agent-only'];
const CHECK_PHASES = ['request', 'result-validation', 'cleanup', 'resource-baseline', 'resource-discovery',
  'marker-wait', 'resource-refresh', 'disconnect-validation', 'execution-validation',
  'request-start', 'vmm-discovery', 'vmm-kill', 'host-kill',
  'stdout-read', 'stderr-read', 'container-logs', 'compose-stop', 'recovery-config', 'recovery-launch',
  'broker-readiness', 'gateway-readiness', 'primary-readiness', 'tools-list', 'resource-read',
  'recovery-validation', 'interrupted-response', 'request-abort', 'host-cleanup', 'compose-cleanup',
  'stop-marker', 'host-stop', 'host-stop-validation', 'stop-marker-remove', 'profile-config', 'profile-launch',
  'initialize', 'initialize-validation', 'tools-validation', 'output-redaction'];
const CHECK_REASONS = ['operation-failed', 'response-missing', 'jsonrpc-version', 'request-id',
  'jsonrpc-error', 'result-missing', 'tool-is-error', 'structured-content', 'structured-fields',
  'content-mismatch', 'expected-error-status', 'expected-ok-status', 'result-mismatch',
  'http-status', 'invalid-json', 'response-too-large',
  'request-timeout', 'request-failed', 'response-aborted', 'response-failed', 'disconnect-not-cancelled',
  'resource-discovery-timeout', 'resource-inventory-failed', 'invocation-evidence-invalid',
  'invocation-evidence-timeout', 'invocation-outcome-mismatch', 'admission-evidence-failed',
  'vmm-not-found', 'host-already-exited', 'host-kill-failed', 'host-exit-timeout',
  'recovery-tools-invalid', 'recovery-record-missing', 'recovery-validation-failed', 'interrupted-success',
  'crash-baseline-invalid', 'profile-stop-invalid', 'profile-initialize-invalid', 'profile-tools-invalid'];
const RESPONSE_FLAGS = ['present', 'jsonrpcValid', 'idMatches', 'rpcError', 'resultPresent',
  'toolIsError', 'structuredPresent', 'contentMatches'];
const RESOURCE_FLAGS = ['newRecords', 'pending', 'ownerMatches', 'directoryReady',
  'identityReady', 'snapshotReady', 'eligible'];
const RESOURCE_OPERATIONS = ['directory-lstat', 'directory-trust', 'directory-readdir',
  'record-open', 'record-fstat', 'record-validate', 'record-read', 'record-close',
  'record-parse', 'record-identity', 'record-lstat', 'complete'];
const RESOURCE_CODES = ['none', 'ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR', 'ELOOP', 'unknown'];
const RECOVERY_FLAGS = ['uniqueRecord', 'cleaned', 'runMatches', 'invocationMatches',
  'directoryIdentityPresent', 'storageDirectoryIdentityPresent', 'storageMountedIdentityPresent', 'snapshotPresent',
  'directoryMatches', 'directoryIdentityMatches', 'ancestorsMatch', 'mountMatches', 'snapshotMatches',
  'storageDirectoryMatches', 'storageParentIdentityMatches', 'storageAncestorsMatch',
  'storageDirectoryIdentityMatches', 'storageMountedIdentityMatches', 'storageMountsMatch'];
const RECOVERY_CODES = [...RESOURCE_CODES, 'ESRCH', 'EBUSY', 'ETIMEDOUT', 'ENOSPC'];
const BASELINE_FLAGS = ['uniqueRecord', 'pending', 'ownerMatches', 'identityMatches',
  'mountsRetained', 'mountsCommitted', 'snapshotMounted'];
const PROFILE_FLAGS = ['serverMatches', 'toolsArray', 'scriptPresent', 'agentPresent', 'toolsMatch'];

function projectResourceInventory(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  for (const key of ['entries', 'regularFiles', 'resourceSuffix', 'nameMatches', 'rejectedNames', 'producerMatches']) {
    if (['zero', 'one', 'many'].includes(value[key])) result[key] = value[key];
  }
  for (const key of ['operation', 'producerOperation']) {
    if (RESOURCE_OPERATIONS.includes(value[key])) result[key] = value[key];
  }
  for (const key of ['code', 'producerCode', 'namespaceCode']) {
    if (RESOURCE_CODES.includes(value[key])) result[key] = value[key];
  }
  for (const key of ['location', 'producerLocation']) {
    if (['default', 'custom'].includes(value[key])) result[key] = value[key];
  }
  for (const key of ['mountNamespace', 'producerDirectory', 'producerNamespace']) {
    if (['same', 'different', 'unavailable'].includes(value[key])) result[key] = value[key];
  }
  if (['observer-readlink', 'host-readlink', 'complete'].includes(value.namespaceOperation)) {
    result.namespaceOperation = value.namespaceOperation;
  }
  if (['ready', 'missing', 'not-directory', 'symlink', 'unavailable'].includes(value.directory)) {
    result.directory = value.directory;
  }
  if (['missing', 'published', 'failed', 'read-failed'].includes(value.producer)) result.producer = value.producer;
  for (const key of ['producerActive', 'producerRecordSafe']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  return result;
}

function projectResourcePublication(value) {
  if (!value || !['published', 'failed'].includes(value.status)) return undefined;
  const result = { status: value.status };
  if (RESOURCE_OPERATIONS.includes(value.operation)) result.operation = value.operation;
  if (RESOURCE_CODES.includes(value.code)) result.code = value.code;
  if (['default', 'custom'].includes(value.location)) result.location = value.location;
  if (['captured', 'unavailable'].includes(value.namespaceStatus)) result.namespaceStatus = value.namespaceStatus;
  if (typeof value.recordSafe === 'boolean') result.recordSafe = value.recordSafe;
  for (const key of ['runIdLength', 'invocationIdLength']) {
    if (Number.isInteger(value[key]) && value[key] >= 16 && value[key] <= 64) result[key] = value[key];
  }
  return result;
}
const ADMISSION_PHASES = ['admission', 'socket', 'exchange', 'response', 'availability',
  'reconcile', 'invoke', 'status', 'cancel', 'cancel-confirmation', 'terminal', 'digest', 'schema',
  'settle', 'work-start', 'runner-start', 'work-complete', 'cleanup-start', 'cleanup-complete',
  'cleanup-failed', 'request-rejected', 'invoke-plan', 'invocation-register', 'backend-start',
  'backend-complete', 'backend-failed', 'cleanup-pending', 'settled', 'shutdown', 'shutdown-failed',
  'deadline-expired', 'cancellation', 'admissions-closed', 'tool-admission', 'failure'];
const ADMISSION_REASONS = ['none', 'unknown', 'admissions-closed', 'invocation-count-exhausted',
  'bit-budget-exhausted', 'invalid-request', 'repo-not-allowed', 'trusted-schema-required',
  'dynamic-admission-denied', 'dynamic-sensitivity-invalid', 'tool-call-cap', 'busy',
  'cancelled', 'timeout', 'unavailable', 'oversized', 'truncated', 'malformed', 'rejected',
  'launch-failed', 'non-zero-exit', 'cleanup-failed', 'unexpected-error', 'digest-mismatch',
  'schema-mismatch', 'settlement-unresolved', 'terminal-unavailable', 'lifecycle-regressed',
  'cancel-unresolved', 'cancel-drain-timeout', 'deadline-drain-timeout', 'timing-bucket-overflow',
  ...HOST_EXECUTOR_ERRORS];

function projectAdmissionEvent(value) {
  if (!value || !ADMISSION_PHASES.includes(value.phase)) return undefined;
  const result = { phase: value.phase };
  if (['started', 'passed', 'failed', 'admitted', 'rejected', 'parsed', 'connected',
    'confirmed', 'ok', 'error'].includes(value.status)) result.status = value.status;
  if (ADMISSION_REASONS.includes(value.reason)) result.reason = value.reason;
  if (HOST_EXECUTOR_OUTCOMES.includes(value.outcome)) result.outcome = value.outcome;
  if (['running', 'cancelling', 'terminal', 'settled'].includes(value.state)) result.state = value.state;
  for (const key of ['accepting', 'laneClosed', 'aborted', 'registered', 'invoked', 'timedOut', 'oversized']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  for (const key of ['cleanupComplete', 'recoverableFailure']) {
    if (typeof value[key] === 'boolean' || value[key] === 'absent') result[key] = value[key];
  }
  if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EACCES', 'EPERM', 'EPIPE', 'unknown'].includes(value.code)) {
    result.code = value.code;
  }
  return result;
}

function projectAdmissionEvidence(value) {
  const result = {};
  for (const key of ['broker', 'hostControl']) {
    const source = value?.[key];
    if (!source || !['captured', 'missing', 'read-failed', 'invalid', 'unavailable'].includes(source.status)) continue;
    result[key] = { status: source.status };
    if (Array.isArray(source.events)) {
      result[key].events = source.events.slice(-32).map(projectAdmissionEvent).filter(Boolean);
    }
    if (Array.isArray(source.failures)) {
      result[key].failures = source.failures.slice(-16).map(projectAdmissionEvent).filter(Boolean);
    }
  }
  return result;
}

function captureAdmissionEvidence(context, auditDirectory) {
  if (!context) return {};
  const { runDirectory, roots, uid, trustedRoot } = context;
  const capture = (read) => {
    try {
      const events = read().map(projectAdmissionEvent).filter(Boolean);
      return { status: 'captured', events: events.slice(-32),
        failures: events.filter(event => event.status === 'failed' || event.status === 'rejected'
          || event.phase === 'admissions-closed' || event.phase === 'failure').slice(-16) };
    } catch (error) {
      return { status: error.code === 'ENOENT' ? 'missing'
        : error instanceof SyntaxError ? 'invalid' : 'read-failed' };
    }
  };
  return {
    broker: capture(() => {
      collector.directory(auditDirectory, uid, trustedRoot, ENCLAVE_PRIVATE_BASE_DIR);
      return ['enclave.jsonl', 'enclave-host-executor.jsonl'].flatMap(name => {
        const bytes = collector.readRegular(path.join(auditDirectory, name), 1024 * 1024, uid);
        return bytes.toString('utf8').split('\n').filter(Boolean).map(line => {
          const record = JSON.parse(line);
          if (record.kind === 'failure') return { phase: 'failure', reason: record.reason };
          if (record.kind === 'lifecycle' && ['host-executor', 'invocation-timing', 'tool-admission'].includes(record.event)) {
            return record.event === 'tool-admission' ? { ...record.detail, phase: 'tool-admission' } : record.detail;
          }
          return undefined;
        });
      });
    }),
    hostControl: capture(() => {
      collector.directory(runDirectory, uid, trustedRoot);
      const baseline = JSON.parse(collector.readRegular(path.join(runDirectory, 'baseline.json'), 1024 * 1024, uid));
      const runs = collector.inventory(roots.journal, uid, trustedRoot)
        .filter(name => /^[a-f0-9]{32}\.journal$/.test(name) && !baseline.journals.includes(name))
        .map(name => name.slice(0, 32));
      if (runs.length > 8) throw new Error('Conformance control run count exceeds bound');
      const directory = path.join(roots.journal, 'diagnostics');
      const names = collector.inventory(directory, uid, trustedRoot).filter(name =>
        DIAGNOSTIC_NAME.test(name) && runs.includes(name.slice(0, 32)));
      if (names.length > MAX_RECORDS) throw new Error('Conformance control count exceeds bound');
      return names.flatMap(name => {
        const value = JSON.parse(collector.readRegular(path.join(directory, name), 320 * 1024, uid));
        if (value.component !== 'host-executor-control') return [];
        if (value.runId !== name.slice(0, 32) || value.schemaVersion !== 1
            || !Array.isArray(value.events) || value.events.length > 128) {
          throw new Error('Invalid conformance control identity');
        }
        return [...value.events, value.failure, value.cleanupFailure, value.admissionClosure];
      });
    }),
  };
}

function projectAcceptanceCheck(value) {
  if (!value || !CHECK_STEPS.includes(value.step) || !CHECK_PHASES.includes(value.phase)
      || !['started', 'passed', 'failed'].includes(value.status)) return undefined;
  const result = { step: value.step, phase: value.phase, status: value.status };
  if (CHECK_REASONS.includes(value.reason)) result.reason = value.reason;
  if (['script-only', 'agent-only'].includes(value.step)) {
    if (RECOVERY_CODES.includes(value.code)) result.code = value.code;
    if (value.profile && typeof value.profile === 'object') {
      result.profile = {};
      for (const key of PROFILE_FLAGS) {
        if (typeof value.profile[key] === 'boolean') result.profile[key] = value.profile[key];
      }
    }
  }
  if (value.step === 'crash-recovery') {
    if (RECOVERY_CODES.includes(value.code)) result.code = value.code;
    if (['disconnected', 'returned'].includes(value.interrupted)) result.interrupted = value.interrupted;
    if (value.recovery && typeof value.recovery === 'object') {
      result.recovery = {};
      for (const key of RECOVERY_FLAGS) {
        if (typeof value.recovery[key] === 'boolean') result.recovery[key] = value.recovery[key];
      }
    }
    if (value.baseline && typeof value.baseline === 'object') {
      result.baseline = {};
      for (const key of BASELINE_FLAGS) {
        if (typeof value.baseline[key] === 'boolean') result.baseline[key] = value.baseline[key];
      }
    }
  }
  if (value.resources && typeof value.resources === 'object') {
    result.resources = {};
    for (const key of RESOURCE_FLAGS) {
      if (['zero', 'one', 'many'].includes(value.resources[key])) result.resources[key] = value.resources[key];
    }
  }
  const inventory = projectResourceInventory(value.inventory);
  if (inventory) result.inventory = inventory;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) {
    result.httpStatus = value.httpStatus;
  }
  if (value.response && typeof value.response === 'object') {
    result.response = {};
    for (const key of RESPONSE_FLAGS) {
      if (typeof value.response[key] === 'boolean') result.response[key] = value.response[key];
    }
    if (['ok', 'error', 'invalid', 'absent'].includes(value.response.structuredStatus)) {
      result.response.structuredStatus = value.response.structuredStatus;
    }
    if (['parse-error', 'invalid-request', 'method-not-found', 'invalid-params',
      'internal-error', 'server-error', 'other', 'absent'].includes(value.response.rpcErrorClass)) {
      result.response.rpcErrorClass = value.response.rpcErrorClass;
    }
  }
  return result;
}

function exportDirectory(kind, environment = process.env) {
  if (!['live', 'environment-probe'].includes(kind)
      || !/^[0-9]+$/.test(environment.GITHUB_RUN_ID || '')
      || !/^[0-9]+$/.test(environment.GITHUB_RUN_ATTEMPT || '')) {
    throw new Error('Conformance diagnostics require a fixed job and Actions run identity');
  }
  return path.join(EXPORT_ROOT, `${environment.GITHUB_RUN_ID}-${environment.GITHUB_RUN_ATTEMPT}`, kind);
}

function prepare(config, runDirectory, { roots = ROOTS, uid = 0, trustedRoot = '/' } = {}) {
  const resolved = resolvePublicEnclaveDebugConfig({
    cloudHypervisor: config.cloudHypervisor,
    enclaves: normalizeEnclavesConfig(config.enclaves),
  });
  if (!resolved.cloudHypervisor?.enclaveDebugPublic || validatePublicEnclaveDebug(resolved).length) {
    return undefined;
  }
  collector.directory(path.dirname(runDirectory), uid, trustedRoot);
  collector.prepare(runDirectory, roots, uid, trustedRoot);
  return { runDirectory, roots, uid, trustedRoot };
}

function prepareForJob(config, kind) {
  const target = exportDirectory(kind);
  for (const directory of [EXPORT_ROOT, path.dirname(target)]) {
    collector.directory(path.dirname(directory), 0);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    collector.directory(directory, 0);
  }
  return prepare(config, target);
}

function projectInvocation(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0;
  if (value?.schemaVersion !== 1 || !['script', 'agent'].includes(value.executorKind)
      || !count(value.sequence) || !count(value.elapsedMs)
      || !value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)
      || !Array.isArray(value.milestones) || value.milestones.length > 32) {
    throw new Error('Invalid conformance invocation diagnostic');
  }
  const checks = {};
  for (const [id, outcome] of Object.entries(value.checks)) {
    const parts = id.split('/');
    const [scope, check] = parts;
    if (parts.length !== 2 || !Object.hasOwn(schema.scopes, scope) || !Object.hasOwn(schema.scopes[scope], check)
        || !Array.isArray(outcome) || outcome.length !== 2
        || !['not-attempted', 'not-required', 'attempted', 'passed', 'failed'].includes(outcome[0])
        || !Object.hasOwn(schema.reasons, outcome[1])) {
      throw new Error('Invalid conformance invocation check');
    }
    checks[id] = [...outcome];
  }
  const milestones = value.milestones.map(item => {
    if (!['guest-complete', 'work-complete', 'cleanup-start', 'cleanup-complete',
      'deadline-expired', 'cancellation', 'manager-stop-start', 'manager-stop-complete',
      'result-read-start', 'result-read-complete'].includes(item?.phase) || !count(item.elapsedMs)
        || (item.outcome !== undefined && !['success', 'schema-failure', 'executor-failure',
          'timeout', 'cancelled'].includes(item.outcome))) {
      throw new Error('Invalid conformance invocation milestone');
    }
    return { phase: item.phase, elapsedMs: item.elapsedMs,
      ...(item.outcome === undefined ? {} : { outcome: item.outcome }) };
  });
  // Never copy the journal's free-form fields, resource records, paths or IDs.
  const session = value.guestSession;
  let guestSession;
  if (session && ['empty', 'missing', 'unsafe', 'oversized', 'read-failed', 'invalid', 'not-stopped'].includes(session.status)) {
    guestSession = { status: session.status };
  } else if (session?.status === 'captured' && Array.isArray(session.events) && session.events.length <= 32) {
    if (!count(session.bytes) || session.bytes > 1024 * 1024
        || !count(session.rejected) || session.rejected > session.bytes
        || !count(session.dropped) || session.dropped > session.bytes) {
      throw new Error('Invalid conformance session counters');
    }
    const events = [...session.events];
    if (session.failure) events.push(session.failure);
    if (session.output) events.push({ ...session.output, event: 'output-snapshot' });
    if (session.storageProbe) events.push({ ...session.storageProbe, event: 'storage-probe' });
    if (session.normalization) events.push({ ...session.normalization, event: 'output-normalization' });
    if (Array.isArray(session.outputVerification)) {
      events.push(...session.outputVerification.slice(-2).map(value => ({ ...value, event: 'output-verification' })));
    }
    if (session.resources) {
      events.push({
        ...session.resources, event: 'resource-snapshot',
        memory: { ...session.resources.memory, events: session.resources.memory },
      });
    }
    const projected = projectEnclaveSessionDiagnostics(
      Buffer.from(events.map(event => JSON.stringify(event) + '\n').join('')),
    );
    const operationErrors = Array.isArray(session.operationErrors)
      ? projectEnclaveSessionDiagnostics(Buffer.from(
        session.operationErrors.slice(-16).map(event => JSON.stringify(event) + '\n').join(''),
      )).operationErrors ?? []
      : [];
    const lastEvent = session.lastEvent
      ? projectEnclaveSessionDiagnostics(Buffer.from(JSON.stringify(session.lastEvent))).lastEvent : undefined;
    guestSession = { ...projected, bytes: session.bytes, rejected: session.rejected, dropped: session.dropped };
    guestSession.operationErrors = operationErrors;
    delete guestSession.lastEvent;
    if (lastEvent) guestSession.lastEvent = lastEvent;
  } else if (session !== undefined) {
    throw new Error('Invalid conformance session diagnostic');
  }
  const wrapperFailure = value.guestWrapperFailure
    ? projectEnclaveSessionDiagnostics(Buffer.from(JSON.stringify(value.guestWrapperFailure))).lastEvent
    : undefined;
  return { schemaVersion: 1, executorKind: value.executorKind,
    sequence: value.sequence, elapsedMs: value.elapsedMs, checks, milestones,
    ...(projectResourcePublication(value.resourcePublication)
      ? { resourcePublication: projectResourcePublication(value.resourcePublication) } : {}),
    ...(Array.isArray(value.guestFileOperations) ? {
      guestFileOperations: projectEnclaveSessionDiagnostics(Buffer.from(
        value.guestFileOperations.slice(-16).map(event => JSON.stringify(event) + '\n').join(''),
      )).operationErrors ?? [],
    } : {}),
    ...(wrapperFailure?.event === 'failure' ? { guestWrapperFailure: wrapperFailure } : {}),
    ...(guestSession ? { guestSession } : {}) };
}

function collect(context, acceptance) {
  if (!context) return;
  const { runDirectory, roots, uid, trustedRoot } = context;
  collector.directory(runDirectory, uid, trustedRoot);
  const baseline = JSON.parse(collector.readRegular(path.join(runDirectory, 'baseline.json'), 1024 * 1024, uid));
  const journals = collector.inventory(roots.journal, uid, trustedRoot)
    .filter(name => /^[a-f0-9]{32}\.journal$/.test(name) && !baseline.journals.includes(name));
  const diagnostics = path.join(roots.journal, 'diagnostics');
  const names = collector.inventory(diagnostics, uid, trustedRoot);
  const proxyDebug = names.filter(name => DIAGNOSTIC_NAME.test(name)
    && name.endsWith('.proxy-debug.json') && !baseline.proxyDebug.includes(name));
  const runIds = new Set([...journals.map(name => name.slice(0, 32)), ...proxyDebug.map(name => name.slice(0, 32))]);
  if (runIds.size > 8) throw new Error('Conformance diagnostic run count exceeds bound');
  const { check, checks, admissionEvidence, ...acceptanceSummary } = acceptance;
  const projectedCheck = projectAcceptanceCheck(check);
  const files = [['acceptance.json', { ...acceptanceSummary,
    ...(Array.isArray(checks) ? { checks: checks.slice(-16).map(projectAcceptanceCheck).filter(Boolean) } : {}),
    ...(admissionEvidence ? { admissionEvidence: projectAdmissionEvidence(admissionEvidence) } : {}),
    ...(projectedCheck ? { check: projectedCheck } : {}) }]];
  let invocations = 0;
  let proxies = 0;
  let sessions = 0;
  for (const name of names) {
    const match = DIAGNOSTIC_NAME.exec(name);
    if (!match || !runIds.has(match[1])) continue;
    if (files.length >= MAX_RECORDS) throw new Error('Conformance diagnostic count exceeds bound');
    const value = JSON.parse(collector.readRegular(path.join(diagnostics, name), 320 * 1024, uid));
    if (value?.schemaVersion !== 1 || value.runId !== match[1]) {
      throw new Error('Conformance diagnostic run identity mismatch');
    }
    if (value.executorKind !== undefined) {
      if (typeof value.invocationId !== 'string' || !INVOCATION_ID.test(value.invocationId)) {
        throw new Error('Conformance diagnostic invocation identity mismatch');
      }
      files.push([`invocation-${++invocations}.json`, projectInvocation(value)]);
    } else if (value.component === 'enclave-proxy-usage') {
      files.push([`proxy-${++proxies}.json`, {
        component: value.component, usage: collector.projectProxyUsage(value.usage),
      }]);
    } else if (value.component === 'enclave-proxy-response') {
      files.push([`proxy-${++proxies}.json`, collector.projectProxyResponse({
        ...value.diagnostics, schemaVersion: 1, component: value.component,
      })]);
    } else if (value.component === 'enclave-proxy-debug') {
      if (value.scope !== 'run-cumulative' || !Array.isArray(value.events)
          || value.events.length > 4096 || typeof value.containerLog !== 'string') {
        throw new Error('Invalid conformance proxy projection');
      }
      files.push([`proxy-${++proxies}.json`, {
        events: collector.projectProxyEvents(Buffer.from(value.events.map(event => JSON.stringify(event) + '\n').join(''))).toString(),
        containerLog: collector.projectProxyContainerLog(Buffer.from(value.containerLog)).toString(),
      }]);
    }
    // Only production's host-authorized public debug directory can supply a session.
    // Project it again: even credential-redacted free-form text is not upload-safe.
    if (value.executorKind === 'agent' && !baseline.debug.includes(match[1])) {
      const debugDirectory = path.join(roots.debug, match[1], value.invocationId);
      try {
        collector.directory(debugDirectory, uid, trustedRoot);
        const bytes = collector.readRegular(path.join(debugDirectory, 'enclave-session.log'), collector.MAX_STREAM_BYTES, uid);
        files.push([`session-${++sessions}.json`, projectEnclaveSessionDiagnostics(bytes)]);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  if (files.length > MAX_RECORDS) throw new Error('Conformance diagnostic count exceeds bound');
  // Nothing reaches the upload directory unless the complete bounded projection succeeds.
  const staging = path.join(runDirectory, 'pending-upload');
  fs.mkdirSync(staging, { mode: 0o700 });
  for (const [name, contents] of files) {
    fs.writeFileSync(path.join(staging, name), JSON.stringify(contents) + '\n', { mode: 0o600, flag: 'wx' });
  }
  fs.renameSync(staging, path.join(runDirectory, 'upload'));
}

function publish(runDirectory, runnerUid, runnerGid, uid = 0, trustedRoot = '/') {
  const upload = path.join(runDirectory, 'upload');
  const names = collector.inventory(upload, uid, trustedRoot);
  if (!names.length) {
    const ancestors = [path.dirname(path.dirname(runDirectory)), path.dirname(runDirectory), runDirectory];
    for (const directory of ancestors) {
      try {
        collector.directory(directory, uid, trustedRoot);
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
      fs.chmodSync(directory, 0o711);
    }
    try {
      fs.chownSync(upload, runnerUid, runnerGid);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    console.error('No public conformance diagnostics were retained; no raw files will be uploaded.');
    return;
  }
  if (names.length > MAX_RECORDS || names.some(name => !UPLOAD_NAME.test(name))) {
    throw new Error('Unexpected conformance upload file');
  }
  for (const name of names) collector.readRegular(path.join(upload, name), 1024 * 1024, uid);
  for (const name of names) fs.chownSync(path.join(upload, name), runnerUid, runnerGid);
  fs.chownSync(upload, runnerUid, runnerGid);
  for (const directory of [runDirectory, path.dirname(runDirectory), path.dirname(path.dirname(runDirectory))]) {
    fs.chmodSync(directory, 0o711);
  }
}

module.exports = { prepare, prepareForJob, collect, publish, exportDirectory, projectInvocation,
  projectAcceptanceCheck, projectAdmissionEvidence, captureAdmissionEvidence };

if (require.main === module) {
  const [kind, runnerUid, runnerGid] = process.argv.slice(2);
  if (process.getuid() !== 0 || !/^[0-9]+$/.test(runnerUid || '') || !/^[0-9]+$/.test(runnerGid || '')) {
    throw new Error('Conformance diagnostic publication requires root and numeric runner ownership');
  }
  publish(exportDirectory(kind), Number(runnerUid), Number(runnerGid));
}
