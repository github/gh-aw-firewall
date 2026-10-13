'use strict';

const crypto = require('crypto');

const STAGES = [
  'environment-probes', 'server-config', 'audit', 'seed-map', 'executors', 'executor-state',
  'script-config', 'script-selection', 'script-available', 'script-reconcile',
  'script-handler', 'agent-config', 'agent-selection', 'agent-available',
  'agent-reconcile', 'agent-handler', 'backend-consistency', 'tool-budget',
  'listener-binding', 'ready-file',
];
const ERROR_TYPES = ['Error', 'TypeError', 'SyntaxError', 'RangeError'];
const ERROR_CODES = [
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS', 'EADDRINUSE',
  'EADDRNOTAVAIL', 'ECONNREFUSED', 'ETIMEDOUT', 'MODULE_NOT_FOUND', 'EIO',
  'EISDIR', 'EBADF', 'ENOSPC', 'EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN', 'EEXIST',
  'ELOOP', 'ENAMETOOLONG', 'ENOTEMPTY', 'EPIPE', 'ECONNRESET', 'ENETUNREACH',
  'EHOSTUNREACH', 'ECONNABORTED', 'EFBIG', 'EXDEV',
];
const REASONS = [
  'environment-probe-failed', 'server-config-invalid', 'audit-initialization-failed',
  'seed-catalog-invalid', 'executor-selection-invalid', 'executor-state-initialization-failed',
  'script-config-invalid',
  'script-runner-initialization-failed', 'script-availability-failed',
  'script-reconciliation-failed', 'script-handler-construction-failed',
  'agent-config-invalid', 'agent-runner-initialization-failed',
  'agent-availability-failed', 'agent-reconciliation-failed',
  'agent-handler-construction-failed', 'backend-consistency-failed',
  'tool-budget-initialization-failed', 'listener-binding-failed',
  'ready-file-publication-failed', 'startup-operation-failed',
];
const MODULES = [
  'mcp-server/server.js', 'mcp-server/config.js', 'mcp-server/host-executor-runner.js',
  'mcp-server/tool-call-budget.js', 'script-executor/script-runner.js',
  'bounded-execution/protected-audit.js',
];

function safeBackend(value) {
  return ['docker', 'gvisor', 'sbx', 'cloud-hypervisor', 'mixed'].includes(value) ? value : 'unknown';
}

function safeExecutorKind(value) {
  return ['script', 'agent', 'both', 'none'].includes(value) ? value : 'unknown';
}

function startupDiagnostic(error, stage, context = {}) {
  const frames = [];
  const stack = typeof error?.stack === 'string' ? error.stack.slice(0, 16384) : '';
  for (const line of stack.split('\n').slice(1, 50)) {
    const match = line.match(/^\s+at .*?(\/opt\/awf\/[^ ()]+):(\d{1,6}):(\d{1,6})\)?$/);
    if (!match) continue;
    const module = MODULES.find(name => match[1] === `/opt/awf/enclave/${name}`
      || match[1] === `/opt/awf/${name}`);
    if (module) frames.push({ module, line: Number(match[2]), column: Number(match[3]) });
    if (frames.length === 8) break;
  }
  return {
    schemaVersion: 1,
    component: 'enclave-mcp-server',
    kind: 'startup-error',
    stage: STAGES.includes(stage) ? stage : 'unknown',
    state: 'failed',
    attemptId: /^[0-9a-f-]{36}$/.test(context.attemptId || '') ? context.attemptId : 'unavailable',
    sequence: Number.isSafeInteger(context.sequence) ? context.sequence : 0,
    elapsedMs: Number.isSafeInteger(context.elapsedMs) && context.elapsedMs >= 0 ? context.elapsedMs : 0,
    primaryBackend: safeBackend(context.primaryBackend),
    executorBackend: safeBackend(context.executorBackend),
    executorKind: safeExecutorKind(context.executorKind),
    reasonId: REASONS.includes(context.reasonId) ? context.reasonId : 'startup-operation-failed',
    errorType: ERROR_TYPES.includes(error?.name) ? error.name : 'unknown',
    code: ERROR_CODES.includes(error?.code) ? error.code : 'unknown',
    ...(Array.isArray(context.probes) ? { probes: context.probes.slice(0, 12) } : {}),
    unattempted: Array.isArray(context.unattempted) ? context.unattempted.filter(stageId =>
      STAGES.includes(stageId)).slice(0, STAGES.length) : [],
    frames,
  };
}

function createStartupReporter(write = line => process.stderr.write(`${line}\n`)) {
  const startedAt = process.hrtime.bigint();
  const attemptId = crypto.randomUUID();
  let sequence = 0;
  let primaryBackend = 'unknown';
  let executorBackend = 'unknown';
  let executorKind = 'none';
  let plannedStages = [];
  let completedStages = new Set();
  let currentStage = 'server-config';
  let currentReason = 'startup-operation-failed';
  let latestProbes;

  function elapsedMs() {
    return Math.max(0, Number((process.hrtime.bigint() - startedAt) / 1_000_000n));
  }

  function record(stage, status, details = {}) {
    const event = {
      schemaVersion: 1,
      component: 'enclave-mcp-server',
      kind: 'startup-progress',
      attemptId,
      sequence: ++sequence,
      elapsedMs: elapsedMs(),
      stage: STAGES.includes(stage) ? stage : 'unknown',
      status: ['started', 'passed', 'failed'].includes(status) ? status : 'failed',
      primaryBackend,
      executorBackend,
      executorKind: safeExecutorKind(details.executorKind || executorKind),
      ...(Number.isSafeInteger(details.effectiveUid) ? { effectiveUid: details.effectiveUid } : {}),
      ...(Number.isSafeInteger(details.effectiveGid) ? { effectiveGid: details.effectiveGid } : {}),
      ...(details.reasonId && REASONS.includes(details.reasonId) ? { reasonId: details.reasonId } : {}),
      ...(details.probes ? { probes: details.probes.slice(0, 12) } : {}),
    };
    if (details.probes) latestProbes = details.probes.slice(0, 12);
    try {
      write(JSON.stringify(event));
    } catch {
      // Progress publication must not change startup behavior.
    }
    if (status === 'passed') completedStages.add(stage);
    if (status === 'failed') {
      currentStage = stage;
      currentReason = REASONS.includes(details.reasonId) ? details.reasonId : 'startup-operation-failed';
    }
    return event;
  }

  return {
    attemptId,
    record,
    configure(values = {}) {
      if (Object.prototype.hasOwnProperty.call(values, 'primaryBackend')) {
        primaryBackend = safeBackend(values.primaryBackend);
      }
      if (Object.prototype.hasOwnProperty.call(values, 'executorBackend')) {
        executorBackend = safeBackend(values.executorBackend);
      }
      if (Object.prototype.hasOwnProperty.call(values, 'executorKind')) {
        executorKind = safeExecutorKind(values.executorKind);
      }
    },
    plan(stages) {
      plannedStages = stages.filter(stage => STAGES.includes(stage));
    },
    start(stage, reasonId, details = {}) {
      currentStage = stage;
      currentReason = reasonId;
      return record(stage, 'started', details);
    },
    passed(stage, details) {
      return record(stage, 'passed', details);
    },
    failed(stage, reasonId, details = {}) {
      return record(stage, 'failed', { ...details, reasonId });
    },
    failureContext() {
      return {
        attemptId,
        sequence: sequence + 1,
        elapsedMs: elapsedMs(),
        primaryBackend,
        executorBackend,
        executorKind,
        reasonId: currentReason,
        probes: latestProbes,
        unattempted: plannedStages.filter(stage => !completedStages.has(stage) && stage !== currentStage),
      };
    },
    get currentStage() { return currentStage; },
    get sequence() { return sequence; },
  };
}

async function runStartupStage(reporter, stage, reasonId, operation, details = {}) {
  reporter.start(stage, reasonId, details);
  try {
    const result = await operation();
    reporter.passed(stage, details);
    return result;
  } catch (error) {
    reporter.failed(stage, reasonId, details);
    throw error;
  }
}

module.exports = { createStartupReporter, runStartupStage, startupDiagnostic, STAGES };
