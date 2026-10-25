import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import type { HostExecutorInvocationPlan, HostExecutorRunState } from './host-executor-server';
import {
  HOST_EXECUTOR_ID_PATTERN, HOST_EXECUTOR_REJECTION_STAGES,
  type HostExecutorError, type HostExecutorRejectionStage, type HostExecutorOutcome,
} from './host-executor-protocol';
import {
  HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY, hostExecutorJournalDirectory, hostExecutorVmRunId,
  prepareDirectory, persist,
} from './host-executor-journal';
import {
  HostPreflightReporter, hostPreflightReason, HostPreflightCleanupError,
  type HostPreflightCheck, type HostPreflightProgress,
} from '../cloud-hypervisor/host-preflight-progress';
import type { EnclaveStartupChecklist } from './startup-progress';
import { logger } from '../logger';
import type { GuestExecutionDiagnostics } from '../microvm/execution-diagnostics';
import type { EnclaveSessionDiagnostics } from '../cloud-hypervisor/enclave-session-diagnostics';
import {
  projectEnclaveProxyUsage, projectEnclaveProxyResponseDiagnostics,
  type EnclaveProxyUsage, type EnclaveProxyResponseDiagnostics, type EnclaveProxyEvent,
} from './proxy-usage';

/** Run-level evidence also covers failures before an invocation plan exists. */
export type HostExecutorControlPhase =
  | 'request-rejected' | 'invoke-plan' | 'invocation-register' | 'backend-start'
  | 'backend-complete' | 'backend-failed' | 'cleanup-pending' | 'settled' | 'shutdown'
  | 'shutdown-failed'
  | 'deadline-expired' | 'cancellation' | 'admissions-closed'
  | 'plan-run-identity' | 'plan-entry-policy' | 'plan-static-seed' | 'plan-selector-policy' | 'plan-path';

interface HostExecutorControlEvent {
  phase: string;
  elapsedMs: number;
  reason: string;
  errorType: string;
  sequence: number;
  invocationId?: string;
  rejectionStage?: HostExecutorRejectionStage;
  outcome?: HostExecutorOutcome;
  cleanupComplete?: boolean | 'absent';
  recoverableFailure?: boolean | 'absent';
}

export class HostExecutorControlDiagnostics {
  private readonly file: string;
  private readonly started = performance.now();
  private persistenceFailed = false;
  private readonly snapshot: {
    schemaVersion: 1;
    component: 'host-executor-control';
    runId: string;
    sequence: number;
    dropped: number;
    events: HostExecutorControlEvent[];
    failure?: HostExecutorControlEvent;
    cleanupFailure?: HostExecutorControlEvent;
    admissionClosure?: HostExecutorControlEvent;
  };

  constructor(run: HostExecutorRunState) {
    if (!HOST_EXECUTOR_ID_PATTERN.test(run.runId)) throw new Error('Invalid host executor run identity');
    const directory = path.join(hostExecutorJournalDirectory(run), 'diagnostics');
    prepareDirectory(directory);
    const id = createHash('sha256').update(`awf-host-control-v1:${run.runId}`).digest('hex').slice(0, 32);
    this.file = path.join(directory, `${run.runId}-${id}.json`);
    this.snapshot = {
      schemaVersion: 1, component: 'host-executor-control', runId: run.runId,
      sequence: 0, dropped: 0, events: [],
    };
    persist(this.file, this.snapshot, true);
  }

  record(
    phase: HostExecutorControlPhase,
    error?: unknown,
    rejection?: HostExecutorError,
    invocationId?: string,
    rejectionStage?: HostExecutorRejectionStage,
    outcome?: {
      outcome: HostExecutorOutcome;
      cleanupComplete: boolean | 'absent';
      recoverableFailure: boolean | 'absent';
    },
  ): void {
    const event = {
      phase, elapsedMs: Math.max(0, Math.round(performance.now() - this.started)),
      sequence: this.snapshot.sequence + 1,
      ...(typeof invocationId === 'string' && HOST_EXECUTOR_ID_PATTERN.test(invocationId)
        ? { invocationId } : {}),
      ...(rejectionStage !== undefined && HOST_EXECUTOR_REJECTION_STAGES.includes(rejectionStage)
        ? { rejectionStage } : {}),
      ...(outcome === undefined ? {} : {
        outcome: outcome.outcome, cleanupComplete: outcome.cleanupComplete,
        recoverableFailure: outcome.recoverableFailure,
      }),
      reason: rejection ?? (error === undefined ? 'none' : hostPreflightReason(error)),
      errorType: error instanceof TypeError ? 'TypeError'
        : error instanceof RangeError ? 'RangeError'
        : error instanceof SyntaxError ? 'SyntaxError'
        : error instanceof Error ? 'Error' : 'unknown',
    };
    this.snapshot.sequence += 1;
    const firstFailure = !this.snapshot.failure && (error !== undefined || phase === 'cleanup-pending');
    if (firstFailure) this.snapshot.failure = event;
    if (phase === 'shutdown-failed') this.snapshot.cleanupFailure ??= event;
    if (phase === 'admissions-closed') this.snapshot.admissionClosure ??= event;
    if (this.snapshot.events.length < 128) this.snapshot.events.push(event);
    else this.snapshot.dropped += 1;
    if (this.snapshot.dropped > 0 && !firstFailure && phase !== 'shutdown'
      && phase !== 'shutdown-failed' && phase !== 'admissions-closed') return;
    try {
      persist(this.file, this.snapshot);
    } catch {
      if (!this.persistenceFailed) logger.error('Host executor control diagnostic persistence failed; earlier evidence is retained.');
      this.persistenceFailed = true;
    }
  }
}

/** Origin-only, finite evidence outside every invocation mount and cleanup root. */
export class HostExecutorInvocationDiagnostics {
  private readonly file: string;
  private readonly started = performance.now();
  private readonly classifiedFailures = new WeakSet<object>();
  persistenceFailed = false;
  private readonly snapshot: {
    schemaVersion: 1;
    runId: string;
    invocationId: string;
    executorKind: 'script' | 'agent';
    sequence: number;
    elapsedMs: number;
    checks: EnclaveStartupChecklist['checks'];
    milestones: Array<{
      phase: 'guest-complete' | 'work-complete' | 'cleanup-start' | 'cleanup-complete'
        | 'deadline-expired' | 'cancellation' | 'manager-stop-start' | 'manager-stop-complete'
        | 'result-read-start' | 'result-read-complete';
      elapsedMs: number;
      outcome?: 'success' | 'schema-failure' | 'executor-failure' | 'timeout' | 'cancelled';
    }>;
    failure?: { stage: string; reason: string; code: string; errorType: string; sequence: number };
    cleanupFailure?: { stage: string; reason: string; code: string; errorType: string; sequence: number };
    guestExecution?: GuestExecutionDiagnostics;
    guestSession?: EnclaveSessionDiagnostics;
    guestFileOperations?: EnclaveSessionDiagnostics['operationErrors'];
    guestWrapperFailure?: EnclaveSessionDiagnostics['lastEvent'];
    resourcePublication?: {
      status: 'published' | 'failed';
      operation: 'directory-lstat' | 'record-lstat';
      code: string;
      location: 'default' | 'custom';
      ownerPid: number;
      directoryIdentity?: { device: number; inode: number };
      mountNamespace?: string;
      namespaceStatus: 'captured' | 'unavailable';
      recordSafe?: boolean;
      runIdLength: number;
      invocationIdLength: number;
    };
  };

  constructor(run: HostExecutorRunState, plan: HostExecutorInvocationPlan) {
    if (!HOST_EXECUTOR_ID_PATTERN.test(run.runId)
      || !HOST_EXECUTOR_ID_PATTERN.test(plan.invocationId)
      || !['script', 'agent'].includes(plan.executorKind)) {
      throw new Error('Invalid host executor diagnostic identity');
    }
    const directory = path.join(hostExecutorJournalDirectory(run), 'diagnostics');
    prepareDirectory(directory);
    this.file = path.join(directory, `${run.runId}-${hostExecutorVmRunId(plan)}.json`);
    this.snapshot = {
      schemaVersion: 1, runId: run.runId, invocationId: plan.invocationId,
      executorKind: plan.executorKind, sequence: 0, elapsedMs: 0, checks: {}, milestones: [],
    };
    persist(this.file, this.snapshot);
  }

  resourcePublished(run: HostExecutorRunState, plan: HostExecutorInvocationPlan): void {
    const directory = hostExecutorJournalDirectory(run);
    const evidence: NonNullable<typeof this.snapshot.resourcePublication> = {
      status: 'failed', operation: 'directory-lstat', code: 'none',
      location: directory === HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY ? 'default' : 'custom',
      ownerPid: process.pid, namespaceStatus: 'unavailable',
      runIdLength: run.runId.length, invocationIdLength: plan.invocationId.length,
    };
    try {
      const stat = fs.lstatSync(directory);
      evidence.directoryIdentity = { device: stat.dev, inode: stat.ino };
      evidence.operation = 'record-lstat';
      const record = fs.lstatSync(path.join(directory, `${run.runId}-${plan.invocationId}.resources.json`));
      evidence.recordSafe = record.isFile() && !record.isSymbolicLink()
        && record.uid === process.getuid?.() && record.nlink === 1 && (record.mode & 0o077) === 0;
      evidence.status = 'published';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      evidence.code = typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR'].includes(code)
        ? code : 'unknown';
    }
    try {
      evidence.mountNamespace = fs.readlinkSync('/proc/self/ns/mnt');
      evidence.namespaceStatus = 'captured';
    } catch {
      evidence.namespaceStatus = 'unavailable';
    }
    this.snapshot.resourcePublication = evidence;
    this.commit();
  }

  milestone(
    phase: (typeof this.snapshot.milestones)[number]['phase'],
    outcome?: (typeof this.snapshot.milestones)[number]['outcome'],
  ): void {
    if (this.snapshot.milestones.length >= 32) return;
    this.snapshot.milestones.push({
      phase, elapsedMs: Math.max(0, Math.round(performance.now() - this.started)),
      ...(outcome === undefined ? {} : { outcome }),
    });
    this.commit();
  }

  guestExecution = (value: GuestExecutionDiagnostics): void => {
    this.snapshot.guestExecution = { ...value };
    this.commit();
  };

  guestSession(value: EnclaveSessionDiagnostics): void {
    this.snapshot.guestSession = value;
    this.commit();
  }

  guestFileOperations(value: EnclaveSessionDiagnostics): void {
    const failure = value.lastEvent?.event === 'failure' ? value.lastEvent
      : value.failure?.event === 'failure' ? value.failure : undefined;
    if (!value.operationErrors?.length && !failure) return;
    if (value.operationErrors?.length) this.snapshot.guestFileOperations = value.operationErrors;
    if (failure) this.snapshot.guestWrapperFailure = failure;
    this.commit();
  }

  publish = (progress: HostPreflightProgress): void => {
    for (const check of progress.checks) {
      if (check.result === 'not-attempted' && this.snapshot.checks[`${progress.scope}/${check.id}`]) continue;
      this.snapshot.checks[`${progress.scope}/${check.id}`] = [check.result, check.reason];
      if (check.result === 'failed') {
        const slot = progress.scope === 'host-invocation-cleanup' || progress.scope === 'bounded-cleanup'
          ? 'cleanupFailure' : 'failure';
        this.snapshot[slot] ??= {
          stage: `${progress.scope}/${check.id}`, reason: check.reason,
          code: /^E[A-Z]+$/.test(check.reason) ? check.reason : 'unknown',
          errorType: 'unknown', sequence: this.snapshot.sequence + 1,
        };
      }
    }
    this.commit();
  };

  async check<T>(report: HostPreflightReporter, id: HostPreflightCheck, operation: () => Promise<T> | T): Promise<T> {
    try {
      return await report.check(id, operation);
    } catch (error) {
      this.classifyFailure(report, error);
      throw error;
    }
  }

  fail(report: HostPreflightReporter, id: HostPreflightCheck, error: unknown): void {
    report.fail(id, error);
    this.classifyFailure(report, error);
  }

  classifyFailure(report: HostPreflightReporter, error: unknown): void {
    const slot = report.scope === 'host-invocation-cleanup' ? 'cleanupFailure' : 'failure';
    const original = error instanceof HostPreflightCleanupError ? error.cause : error;
    const failure = this.snapshot[slot]!;
    const classify = (value: unknown, target: typeof failure): void => {
      if (this.classifiedFailures.has(target)) return;
      this.classifiedFailures.add(target);
      target.errorType = value instanceof TypeError ? 'TypeError'
        : value instanceof RangeError ? 'RangeError'
        : value instanceof SyntaxError ? 'SyntaxError'
        : value instanceof Error ? 'Error' : 'unknown';
      const code = hostPreflightReason(value);
      if (/^E[A-Z]+$/.test(code)) target.code = code;
    };
    classify(original, failure);
    if (error instanceof HostPreflightCleanupError && this.snapshot.cleanupFailure) {
      classify(error.cleanupError, this.snapshot.cleanupFailure);
    }
    this.commit();
  }

  private commit(): void {
    this.snapshot.sequence += 1;
    this.snapshot.elapsedMs = Math.max(0, Math.round(performance.now() - this.started));
    try {
      persist(this.file, this.snapshot);
    } catch {
      // Never strand resources because a later diagnostic write failed.
      // The initial snapshot is mandatory, before any resources are created.
      if (!this.persistenceFailed) logger.error('Host executor diagnostic persistence failed; earlier evidence is retained.');
      this.persistenceFailed = true;
    }
  }
}

/** One bounded, run-wide proxy summary, separate from per-invocation accounting. */
export function persistHostExecutorProxyUsage(
  run: Pick<HostExecutorRunState, 'runId' | 'journalDir'>,
  usage: EnclaveProxyUsage,
): void {
  if (!HOST_EXECUTOR_ID_PATTERN.test(run.runId)) throw new Error('Invalid host executor run identity');
  const directory = path.join(hostExecutorJournalDirectory(run), 'diagnostics');
  prepareDirectory(directory);
  const id = createHash('sha256').update(`awf-enclave-proxy-usage-v1:${run.runId}`).digest('hex').slice(0, 32);
  persist(path.join(directory, `${run.runId}-${id}.json`), {
    schemaVersion: 1, component: 'enclave-proxy-usage', runId: run.runId,
    usage: projectEnclaveProxyUsage(usage),
  });
}

export function persistHostExecutorProxyResponseDiagnostics(
  run: Pick<HostExecutorRunState, 'runId' | 'journalDir'>,
  diagnostics: EnclaveProxyResponseDiagnostics,
): void {
  if (!HOST_EXECUTOR_ID_PATTERN.test(run.runId)) throw new Error('Invalid host executor run identity');
  const directory = path.join(hostExecutorJournalDirectory(run), 'diagnostics');
  prepareDirectory(directory);
  const id = createHash('sha256').update(`awf-enclave-proxy-response-v1:${run.runId}`).digest('hex').slice(0, 32);
  persist(path.join(directory, `${run.runId}-${id}.json`), {
    schemaVersion: 1, component: 'enclave-proxy-response', runId: run.runId,
    diagnostics: projectEnclaveProxyResponseDiagnostics(diagnostics),
  });
}

export function persistHostExecutorProxyDebugDiagnostics(
  run: Pick<HostExecutorRunState, 'runId' | 'journalDir'>,
  events: readonly EnclaveProxyEvent[],
  containerLog: string,
): void {
  if (!HOST_EXECUTOR_ID_PATTERN.test(run.runId)) throw new Error('Invalid host executor run identity');
  const directory = path.join(hostExecutorJournalDirectory(run), 'diagnostics');
  prepareDirectory(directory);
  const id = createHash('sha256').update(`awf-enclave-proxy-debug-v1:${run.runId}`).digest('hex').slice(0, 32);
  persist(path.join(directory, `${run.runId}-${id}.proxy-debug.json`), {
    schemaVersion: 1, component: 'enclave-proxy-debug', scope: 'run-cumulative', runId: run.runId,
    events: events.map(({ schemaVersion, origin, status }) => ({ schemaVersion, origin, status })),
    containerLog,
  });
}

export function readHostExecutorInvocationDiagnostics(
  run: Pick<HostExecutorRunState, 'runId' | 'journalDir'>,
): Array<{ name: string; contents: string }> {
  if (!HOST_EXECUTOR_ID_PATTERN.test(run.runId)) throw new Error('Invalid host executor diagnostic run identity');
  const directory = path.join(hostExecutorJournalDirectory(run), 'diagnostics');
  if (!fs.existsSync(directory)) return [];
  prepareDirectory(directory);
  return fs.readdirSync(directory).filter((name) =>
    name.startsWith(`${run.runId}-`) && /^[a-f0-9]{32}-[a-f0-9]{32}\.json$/.test(name)).map((name) => {
    const fd = fs.openSync(path.join(directory, name),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1
        || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024) {
        throw new Error('Unsafe host executor invocation diagnostic');
      }
      return { name, contents: fs.readFileSync(fd, 'utf8') };
    } finally { fs.closeSync(fd); }
  });
}
