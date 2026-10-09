import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { ENCLAVE_MCP_SERVER_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../docker-host';
import { logger } from '../logger';

const MAX_BYTES = 16 * 1024;
const MAX_SNAPSHOTS = 8;
const stages = new Set([
  'server-config', 'audit', 'seed-map', 'executors', 'script-config',
  'script-available', 'script-reconcile', 'agent-config', 'agent-available',
  'agent-reconcile', 'tool-budget', 'listen', 'ready-file',
]);
const errorTypes = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError']);
const errorCodes = new Set([
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EROFS', 'EADDRINUSE',
  'EADDRNOTAVAIL', 'ECONNREFUSED', 'ETIMEDOUT', 'MODULE_NOT_FOUND',
]);
const modules = new Set([
  'mcp-server/server.js', 'mcp-server/config.js', 'mcp-server/host-executor-runner.js',
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

function classifyLogs(text: string) {
  const bounded = text.slice(-MAX_BYTES);
  for (const line of bounded.split('\n').reverse().slice(0, 50)) {
    let parsed: Record<string, unknown>;
    try {
      parsed = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (parsed.component !== 'enclave-mcp-server' || parsed.kind !== 'startup-error') continue;
    const frames = Array.isArray(parsed.frames) ? parsed.frames.slice(0, 8).flatMap(frame => {
      const value = record(frame);
      return typeof value.module === 'string' && modules.has(value.module)
        && Number.isSafeInteger(value.line) && Number(value.line) > 0 && Number(value.line) <= 999999
        && Number.isSafeInteger(value.column) && Number(value.column) > 0 && Number(value.column) <= 999999
        ? [{ module: value.module, line: value.line, column: value.column }] : [];
    }) : [];
    return {
      source: 'origin' as const,
      stage: finiteString(parsed.stage, stages),
      errorType: finiteString(parsed.errorType, errorTypes),
      code: finiteString(parsed.code, errorCodes),
      frames,
    };
  }
  // Older published servers only emit a free-form error message. Retain
  // classifications, never the message, paths, repository names or payload.
  return {
    source: 'docker-log-classification' as const,
    stage: 'unknown',
    errorType: [...errorTypes].find(type => new RegExp(`\\b${type}:`).test(bounded)) ?? 'unknown',
    code: [...errorCodes].find(code => new RegExp(`\\b${code}\\b`).test(bounded)) ?? 'unknown',
    frames: [],
  };
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
    try {
      const result = await execa('docker', [
        'inspect', '--format',
        '{"status":{{json .State.Status}},"running":{{.State.Running}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},"hasError":{{ne .State.Error ""}}}',
        ENCLAVE_MCP_SERVER_CONTAINER_NAME,
      ], options);
      if (result.exitCode === 0) {
        state = safeState(result.stdout);
        inspectStatus = 'captured';
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
    const snapshotDir = fs.mkdtempSync(path.join(directory, 'attempt-'));
    fs.chmodSync(snapshotDir, 0o755);
    const descriptor = fs.openSync(path.join(snapshotDir, 'diagnostic.json'),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify({
        schemaVersion: 1, component: 'enclave-mcp-server', reason,
        timestamp: new Date().toISOString(), inspectStatus, state, logsStatus, logs,
      }) + '\n');
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
export const enclaveStartupDiagnosticTestHelpers = { classifyLogs, safeState };
