import * as fs from 'fs';
import * as path from 'path';
import { deriveSensitiveEndpointForms, redactSecrets, redactSensitiveValues } from '../redact-secrets';
import { assertRealDirectory, writeFileNoFollow } from '../fs-utils';
import { getStartupDiagnosticPath } from '../logs/startup-diagnostics';
import { getEnclaveStartupProgress } from '../enclave/startup-progress';
import type { WrapperConfig } from '../types';

// Large enough for the full cumulative checklist plus late-stage gateway
// evidence; the CI reader uses the same bound.
const STARTUP_DIAGNOSTIC_MAX_BYTES = 64 * 1024;

export type StartupDiagnosticWriteOutcome =
  | 'written' | 'oversize' | 'unsafe-target' | 'io-error' | 'error' | 'not-attempted';
export type StartupDiagnosticWriteReason =
  | 'record-too-large' | 'unsafe-directory' | 'unsafe-symlink' | 'unsafe-type'
  | 'unsafe-link-count' | 'unsafe-owner' | 'permission-denied' | 'io-error' | 'unknown';

export function writeStartupFailureDiagnostic(
  config: WrapperConfig,
  error: unknown,
  phase = 'startup',
  onRejected?: (reason: StartupDiagnosticWriteReason) => void,
): StartupDiagnosticWriteOutcome {
  const rejected = (
    outcome: StartupDiagnosticWriteOutcome,
    reason: StartupDiagnosticWriteReason,
  ): StartupDiagnosticWriteOutcome => {
    onRejected?.(reason);
    return outcome;
  };
  try {
    const proxyLogsDir = config.proxyLogsDir || path.join(config.workDir, 'squid-logs');
    fs.mkdirSync(proxyLogsDir, { recursive: true, mode: 0o700 });
    try {
      assertRealDirectory(proxyLogsDir);
    } catch {
      return rejected('unsafe-target', 'unsafe-directory');
    }
    let enclaveStartup = getEnclaveStartupProgress(config);
    const redactedMessage = redactSensitiveValues(
      redactSecrets(error instanceof Error ? error.message : String(error)),
      deriveSensitiveEndpointForms(config.sensitiveAllowedDomains),
    );
    const messageBound = enclaveStartup?.hostPreflight ? 1024 : 8 * 1024;
    let message = enclaveStartup && Buffer.byteLength(JSON.stringify(redactedMessage), 'utf8') > messageBound
      ? 'Enclave startup failure exceeded diagnostic message bound'
      : redactedMessage;
    const timestamp = new Date().toISOString();
    const serialize = (): string => JSON.stringify({
      timestamp, phase, message,
      ...(enclaveStartup ? { enclaveStartup } : {}),
    }, null, enclaveStartup?.startupChecks ? undefined : 2) + '\n';
    let record = serialize();
    if (enclaveStartup?.startupChecks && Buffer.byteLength(record, 'utf8') > STARTUP_DIAGNOSTIC_MAX_BYTES) {
      // The cumulative checklist already retains every active-scope check.
      enclaveStartup = { ...enclaveStartup, hostPreflight: undefined };
      record = serialize();
    }
    if (enclaveStartup?.startupChecks && Buffer.byteLength(record, 'utf8') > STARTUP_DIAGNOSTIC_MAX_BYTES) {
      message = 'Enclave startup failure exceeded diagnostic message bound';
      record = serialize();
    }
    if (enclaveStartup && Buffer.byteLength(record, 'utf8') > STARTUP_DIAGNOSTIC_MAX_BYTES) {
      return rejected('oversize', 'record-too-large');
    }
    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_NONBLOCK |
      (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(getStartupDiagnosticPath(proxyLogsDir), flags, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return rejected('unsafe-target', 'unsafe-type');
      if (stat.nlink !== 1) return rejected('unsafe-target', 'unsafe-link-count');
      if (stat.uid !== process.getuid?.()) return rejected('unsafe-target', 'unsafe-owner');
      fs.fchmodSync(fd, 0o600);
      fs.ftruncateSync(fd, 0);
      fs.writeFileSync(fd, record);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o644);
    } finally {
      fs.closeSync(fd);
    }
    return 'written';
  } catch (diagnosticError) {
    const code = (diagnosticError as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ELOOP') return rejected('unsafe-target', 'unsafe-symlink');
    if (code === 'EACCES' || code === 'EPERM') return rejected('io-error', 'permission-denied');
    if (typeof code === 'string') return rejected('io-error', 'io-error');
    return rejected('error', 'unknown');
  }
}

export interface StartupExitState {
  startedAt: number;
  lastProgressWrite: StartupDiagnosticWriteOutcome;
  progressWriteFailures: number;
  firstProgressWriteFailure?: StartupDiagnosticWriteReason;
  lastProgressWriteFailure?: StartupDiagnosticWriteReason;
}

export function startupElapsedBucket(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const buckets: Array<[number, string]> = [
    [60_000, '<1m'], [3 * 60_000, '<3m'], [5 * 60_000, '<5m'], [8 * 60_000, '<8m'],
    [10 * 60_000, '<10m'], [15 * 60_000, '<15m'],
  ];
  return buckets.find(([limit]) => ms < limit)?.[1] ?? '>=15m';
}

/**
 * Emits one fixed-code enclave startup exit marker on stderr. It carries no
 * messages, paths or identifiers, so CI can read it even when the structured
 * record is missing and AWF runs with `--log-level error`.
 */
export function emitStartupExitMarker(
  config: WrapperConfig,
  state: StartupExitState,
  marker: {
    path: 'fatal' | 'workflow-return';
    exitCode: number;
    containersStarted: boolean;
    agentStarted: boolean;
    recordWrite: StartupDiagnosticWriteOutcome;
    recordWriteReason?: StartupDiagnosticWriteReason | null;
    cleanup: 'pending' | 'completed' | 'failed';
  },
): void {
  if (!config.enclaves?.enabled) return;
  try {
    const progress = getEnclaveStartupProgress(config);
    const failedCheck = Object.entries(progress?.startupChecks?.checks ?? {})
      .find(([, [result]]) => result === 'failed')?.[0] ?? null;
    let recordAfterCleanup: 'present' | 'missing' | 'unknown' = 'unknown';
    if (marker.cleanup !== 'pending') {
      const proxyLogsDir = config.proxyLogsDir || path.join(config.workDir, 'squid-logs');
      recordAfterCleanup = fs.existsSync(getStartupDiagnosticPath(proxyLogsDir)) ? 'present' : 'missing';
    }
    process.stderr.write(`AWF_STARTUP_EXIT ${JSON.stringify({
      schemaVersion: 1,
      path: marker.path,
      exitCode: Number.isInteger(marker.exitCode) && marker.exitCode >= 0 && marker.exitCode <= 255
        ? marker.exitCode : 255,
      stage: progress?.stage ?? null,
      failedCheck,
      containersStarted: marker.containersStarted,
      agentStarted: marker.agentStarted,
      recordWrite: marker.recordWrite,
      recordWriteReason: marker.recordWriteReason ?? null,
      lastProgressWrite: state.lastProgressWrite,
      progressWriteFailures: state.progressWriteFailures,
      firstProgressWriteFailure: state.firstProgressWriteFailure ?? null,
      lastProgressWriteFailure: state.lastProgressWriteFailure ?? null,
      cleanup: marker.cleanup,
      recordAfterCleanup,
      elapsed: startupElapsedBucket(Date.now() - state.startedAt),
    })}\n`);
  } catch {
    // Diagnostics must never change the exit path.
  }
}

export function writeIncompleteEnclaveAuditMarker(targetAuditDir: string): void {
  fs.mkdirSync(targetAuditDir, { recursive: true, mode: 0o755 });
  assertRealDirectory(targetAuditDir);
  writeFileNoFollow(
    path.join(targetAuditDir, 'enclave-audit-incomplete.txt'),
    'Enclave shutdown or protected audit preservation was not confirmed; enclave audit artifacts may be incomplete.\n',
    0o644,
  );
}
