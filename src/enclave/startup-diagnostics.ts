import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import execa from 'execa';
import { ENCLAVE_MCP_SERVER_CONTAINER_NAME } from '../constants';
import { ENCLAVE_MCP_CONTROL_NETWORK } from './network';
import { getLocalDockerEnv } from '../docker-host';
import { logger } from '../logger';

const MAX_BYTES = 16 * 1024;
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const MAX_SNAPSHOTS = 8;
const stages = new Set([
  'environment-probes', 'server-config', 'audit', 'seed-map', 'executors', 'executor-state',
  'script-config', 'script-selection', 'script-available', 'script-reconcile',
  'script-handler', 'agent-config', 'agent-selection', 'agent-available',
  'agent-reconcile', 'agent-handler', 'backend-consistency', 'tool-budget',
  'listener-binding', 'ready-file',
]);
const errorTypes = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError']);
const errorCodes = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS', 'EADDRINUSE',
  'EADDRNOTAVAIL', 'ECONNREFUSED', 'ETIMEDOUT', 'MODULE_NOT_FOUND', 'EIO',
  'EISDIR', 'EBADF', 'ENOSPC', 'EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN', 'EEXIST',
  'ELOOP', 'ENAMETOOLONG', 'ENOTEMPTY', 'EPIPE', 'ECONNRESET', 'ENETUNREACH',
  'EHOSTUNREACH', 'ECONNABORTED', 'EFBIG', 'EXDEV',
]);
const reasons = new Set([
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
]);
const modules = new Set([
  'mcp-server/server.js', 'mcp-server/config.js', 'mcp-server/environment-probes.js',
  'mcp-server/host-executor-runner.js',
  'mcp-server/tool-call-budget.js', 'script-executor/script-runner.js',
  'bounded-execution/protected-audit.js',
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function finiteString(value: unknown, allowed: Set<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'unknown';
}

const probeIds = new Set([
  'capability', 'audit-directory', 'control-directory', 'ready-file-parent',
  'seed-map', 'seed-directory', 'agent-id', 'host-executor-socket',
  'host-executor-capability', 'delegation-channel', 'node-executable', 'docker-executable',
]);

function safeProbes(value: unknown) {
  return Array.isArray(value) ? value.slice(0, 12).flatMap(probe => {
    const item = record(probe);
    if (!probeIds.has(String(item.id))) return [];
    return [{
      id: item.id,
      presence: finiteString(item.presence, new Set(['present', 'absent', 'unknown'])),
      observedType: finiteString(item.observedType,
        new Set(['file', 'directory', 'socket', 'symlink', 'other', 'unknown'])),
      expectedType: finiteString(item.expectedType, new Set(['file', 'directory', 'socket'])),
      owner: finiteString(item.owner, new Set(['root', 'effective-user', 'other', 'unknown'])),
      mode: finiteString(item.mode,
        new Set(['owner-only', 'group-accessible', 'world-accessible', 'unknown'])),
      access: finiteString(item.access, new Set(['allowed', 'denied', 'missing', 'not-applicable', 'unknown'])),
      shape: finiteString(item.shape, new Set(['expected', 'unexpected', 'unknown'])),
      ...(item.reason === 'missing' || item.reason === 'timeout' || item.reason === 'unavailable'
        || item.reason === 'denied' || item.reason === 'symlink'
        ? { reason: item.reason } : {}),
    }];
  }) : [];
}

function classifyLogs(text: string) {
  const bounded = text.slice(-MAX_BYTES);
  const progress = [];
  let failure;
  for (const line of bounded.split('\n').reverse().slice(0, 50)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (parsed.component !== 'enclave-mcp-server') continue;
    if (parsed.kind === 'startup-progress') {
      const eventStage = finiteString(parsed.stage, stages);
      const status = ['started', 'passed', 'failed'].includes(String(parsed.status)) ? parsed.status : 'unknown';
      const executorKind = ['script', 'agent', 'both', 'none'].includes(String(parsed.executorKind))
        ? parsed.executorKind : 'unknown';
      const primaryBackend = ['docker', 'gvisor', 'sbx', 'cloud-hypervisor', 'mixed']
        .includes(String(parsed.primaryBackend)) ? parsed.primaryBackend : 'unknown';
      const executorBackend = ['docker', 'gvisor', 'sbx', 'cloud-hypervisor', 'mixed']
        .includes(String(parsed.executorBackend)) ? parsed.executorBackend : 'unknown';
      const probes = safeProbes(parsed.probes);
      progress.unshift({
        sequence: Number.isSafeInteger(parsed.sequence) && Number(parsed.sequence) > 0
          ? Number(parsed.sequence) : 0,
        elapsedMs: Number.isSafeInteger(parsed.elapsedMs) && Number(parsed.elapsedMs) >= 0
          ? Number(parsed.elapsedMs) : 0,
        attemptId: typeof parsed.attemptId === 'string' && /^[0-9a-f-]{36}$/.test(parsed.attemptId)
          ? parsed.attemptId : 'unavailable',
        stage: eventStage,
        status,
        primaryBackend,
        executorBackend,
        executorKind,
        ...(typeof parsed.effectiveUid === 'number'
          && Number.isSafeInteger(parsed.effectiveUid) && parsed.effectiveUid >= 0
          ? { effectiveUid: parsed.effectiveUid } : {}),
        ...(typeof parsed.effectiveGid === 'number'
          && Number.isSafeInteger(parsed.effectiveGid) && parsed.effectiveGid >= 0
          ? { effectiveGid: parsed.effectiveGid } : {}),
        ...(reasons.has(String(parsed.reasonId)) ? { reasonId: parsed.reasonId } : {}),
        ...(probes.length ? { probes } : {}),
      });
      continue;
    }
    if (parsed.kind !== 'startup-error') continue;
    const frames = Array.isArray(parsed.frames) ? parsed.frames.slice(0, 8).flatMap(frame => {
      const value = record(frame);
      return typeof value.module === 'string' && modules.has(value.module)
        && Number.isSafeInteger(value.line) && Number(value.line) > 0 && Number(value.line) <= 999999
        && Number.isSafeInteger(value.column) && Number(value.column) > 0 && Number(value.column) <= 999999
        ? [{ module: value.module, line: value.line, column: value.column }] : [];
    }) : [];
    if (!failure) failure = {
      source: 'origin' as const,
      stage: finiteString(parsed.stage, stages),
      state: parsed.state === 'failed' ? 'failed' : 'unknown',
      attemptId: typeof parsed.attemptId === 'string' && /^[0-9a-f-]{36}$/.test(parsed.attemptId)
        ? parsed.attemptId : 'unavailable',
      sequence: Number.isSafeInteger(parsed.sequence) && Number(parsed.sequence) >= 0 ? parsed.sequence : 0,
      elapsedMs: Number.isSafeInteger(parsed.elapsedMs) && Number(parsed.elapsedMs) >= 0 ? parsed.elapsedMs : 0,
      primaryBackend: ['docker', 'gvisor', 'sbx', 'cloud-hypervisor', 'mixed']
        .includes(String(parsed.primaryBackend)) ? parsed.primaryBackend : 'unknown',
      executorBackend: ['docker', 'gvisor', 'sbx', 'cloud-hypervisor', 'mixed']
        .includes(String(parsed.executorBackend)) ? parsed.executorBackend : 'unknown',
      executorKind: ['script', 'agent', 'both', 'none'].includes(String(parsed.executorKind))
        ? parsed.executorKind : 'unknown',
      reasonId: reasons.has(String(parsed.reasonId)) ? parsed.reasonId : 'startup-operation-failed',
      errorType: finiteString(parsed.errorType, errorTypes),
      code: finiteString(parsed.code, errorCodes),
      probes: safeProbes(parsed.probes),
      unattempted: Array.isArray(parsed.unattempted)
        ? parsed.unattempted.filter(stageId => stages.has(stageId)).slice(0, stages.size) : [],
      frames,
    };
  }
  if (failure) return { ...failure, ...(progress.length ? { progress: progress.slice(-40) } : {}) };
  // Older published servers only emit a free-form error message. Retain
  // classifications, never the message, paths, repository names or payload.
  const legacy = {
    source: 'docker-log-classification' as const,
    stage: 'unknown',
    errorType: [...errorTypes].find(type => new RegExp(`\\b${type}:`).test(bounded)) ?? 'unknown',
    code: [...errorCodes].find(code => new RegExp(`\\b${code}\\b`).test(bounded)) ?? 'unknown',
    frames: [],
  };
  return { ...legacy, ...(progress.length ? { progress: progress.slice(-40) } : {}) };
}

function safeState(text: string) {
  const parsed = record(JSON.parse(text));
  return {
    status: finiteString(parsed.status, new Set([
      'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead',
    ])),
    running: parsed.running === true,
    exitCode: Number.isSafeInteger(parsed.exitCode)
      && Number(parsed.exitCode) >= 0 && Number(parsed.exitCode) <= 255 ? parsed.exitCode : null,
    oomKilled: parsed.oomKilled === true,
    hasError: parsed.hasError === true,
  };
}

function safeImageIdentity(containerText: string, imageText?: string) {
  let container;
  let image;
  try {
    container = record(JSON.parse(containerText));
    image = imageText ? record(JSON.parse(imageText)) : {};
  } catch {
    container = {};
    image = {};
  }
  const containerImageId = typeof container.imageId === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(container.imageId) ? container.imageId : null;
  const inspectedImageId = typeof image.imageId === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(image.imageId) ? image.imageId : null;
  const sourceRevision = typeof image.sourceRevision === 'string'
    && /^[a-f0-9]{40,64}$/i.test(image.sourceRevision) ? image.sourceRevision.toLowerCase() : null;
  const repoDigests = Array.isArray(image.repoDigests) ? image.repoDigests.flatMap(value => {
    if (typeof value !== 'string') return [];
    const match = value.match(/@sha256:([a-f0-9]{64})$/);
    return match ? [`sha256:${match[1]}`] : [];
  }).slice(0, 4) : [];
  const identityStatus = !containerImageId || !inspectedImageId
    ? 'unavailable' : containerImageId === inspectedImageId ? 'matched' : 'mismatch';
  return {
    identityStatus,
    containerImageId,
    inspectedImageId,
    repoDigests,
    sourceRevision,
    sourceRevisionStatus: sourceRevision ? 'captured' : 'unavailable',
  };
}

function safeControlNetworkMembership(text: string) {
  const observed = text.split('\n').map(name => name.trim()).filter(Boolean);
  if (observed.length === 0) {
    return { status: 'unavailable', networks: [], unexpectedNetworkCount: 0 };
  }
  const networks = observed.filter(name => name === ENCLAVE_MCP_CONTROL_NETWORK);
  const unexpectedNetworkCount = observed.length - networks.length;
  return {
    status: networks.length === 1 && unexpectedNetworkCount === 0 ? 'matched' : 'mismatch',
    networks,
    unexpectedNetworkCount,
  };
}

export async function captureEnclaveStartupDiagnostics(
  workDir: string,
  proxyLogsDir: string | undefined,
  reason: 'startup-failure' | 'shutdown-failure',
): Promise<void> {
  const directory = path.join(proxyLogsDir || path.join(workDir, 'squid-logs'), 'enclave-startup');
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('Enclave startup diagnostic directory is not a real directory');
    }
    fs.chmodSync(directory, 0o755);
    if (fs.readdirSync(directory).length >= MAX_SNAPSHOTS) {
      logger.warn('Enclave startup diagnostic retention limit reached; earlier snapshots retained.');
      return;
    }
    const options = {
      env: getLocalDockerEnv(), reject: false, timeout: 5_000, maxBuffer: MAX_BYTES,
    };
    let state = null;
    let inspectStatus = 'unavailable';
    let containerInspectText = '';
    let imageInspectStatus = 'unavailable';
    let imageInspectText = '';
    let networkInspectStatus = 'unavailable';
    let networkInspectText = '';
    try {
      const result = await execa('docker', [
        'inspect', '--format',
        '{"status":{{json .State.Status}},"running":{{.State.Running}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"hasError":{{ne .State.Error ""}},"imageId":{{json .Image}}}',
        ENCLAVE_MCP_SERVER_CONTAINER_NAME,
      ], options);
      if (result.exitCode === 0) {
        containerInspectText = result.stdout;
        state = safeState(containerInspectText);
        inspectStatus = 'captured';
        const imageId = record(JSON.parse(containerInspectText)).imageId;
        if (typeof imageId === 'string' && /^sha256:[a-f0-9]{64}$/.test(imageId)) {
          try {
            const imageResult = await execa('docker', [
              'image', 'inspect', '--format',
              '{"imageId":{{json .Id}},"repoDigests":{{json .RepoDigests}},'
                + '"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}',
              imageId,
            ], options);
            if (imageResult.exitCode === 0) {
              imageInspectText = imageResult.stdout;
              imageInspectStatus = 'captured';
            }
          } catch {
            logger.warn('Enclave startup image identity could not be captured; raw Docker errors withheld.');
          }
        }
        try {
          const networkResult = await execa('docker', [
            'inspect', '--format',
            '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}',
            ENCLAVE_MCP_SERVER_CONTAINER_NAME,
          ], options);
          if (networkResult.exitCode === 0) {
            networkInspectText = networkResult.stdout;
            networkInspectStatus = 'captured';
          }
        } catch {
          logger.warn('Enclave startup network membership could not be captured; raw Docker errors withheld.');
        }
      }
    } catch {
      logger.warn('Enclave startup container state could not be captured; raw Docker errors withheld.');
    }
    let logs = null;
    let logsStatus = 'unavailable';
    try {
      const result = await execa('docker', ['logs', '--tail', '50', ENCLAVE_MCP_SERVER_CONTAINER_NAME], options);
      if (result.exitCode === 0) {
        logs = classifyLogs(`${result.stdout}\n${result.stderr}`);
        logsStatus = 'classified';
      }
    } catch {
      logger.warn('Enclave startup log capture failed or exceeded its bound; raw Docker errors withheld.');
    }
    const imageIdentity = safeImageIdentity(containerInspectText, imageInspectText);
    const controlNetworkMembership = safeControlNetworkMembership(networkInspectText);
    const serverAttemptId = logs?.source === 'origin' && 'attemptId' in logs
      ? logs.attemptId
      : logs?.progress?.[logs.progress.length - 1]?.attemptId ?? 'unavailable';
    const snapshot = {
      schemaVersion: 1, component: 'enclave-mcp-server', reason,
      snapshotId: crypto.randomUUID(), serverAttemptId,
      timestamp: new Date().toISOString(), inspectStatus, state,
      imageInspectStatus, imageIdentity, networkInspectStatus,
      controlNetworkMembership, logsStatus, logs,
    };
    let serializedSnapshot = JSON.stringify(snapshot) + '\n';
    if (Buffer.byteLength(serializedSnapshot, 'utf8') > MAX_SNAPSHOT_BYTES) {
      snapshot.logs = null;
      snapshot.logsStatus = 'oversized';
      serializedSnapshot = JSON.stringify(snapshot) + '\n';
    }
    if (Buffer.byteLength(serializedSnapshot, 'utf8') > MAX_SNAPSHOT_BYTES) {
      throw new Error('Enclave startup snapshot exceeded its fixed record bound');
    }
    const snapshotDir = fs.mkdtempSync(path.join(directory, 'attempt-'));
    fs.chmodSync(snapshotDir, 0o755);
    const descriptor = fs.openSync(path.join(snapshotDir, 'diagnostic.json'),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fs.writeFileSync(descriptor, serializedSnapshot);
      fs.fchmodSync(descriptor, 0o644);
    } finally {
      fs.closeSync(descriptor);
    }
    logger.warn('Enclave startup diagnostic retained in firewall logs (enclave-startup); raw logs withheld.');
  } catch {
    logger.warn('Failed to retain enclave startup diagnostics; continuing cleanup without raw error output.');
  }
}

/** @internal */
export const enclaveStartupDiagnosticTestHelpers = {
  classifyLogs, safeState, safeImageIdentity, safeControlNetworkMembership,
};
