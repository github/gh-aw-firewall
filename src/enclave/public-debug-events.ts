import { TextDecoder } from 'util';
import {
  ENCLAVE_SESSION_OPERATIONS, projectEnclaveSessionDiagnostics, type EnclaveSessionDiagnostics,
} from '../cloud-hypervisor/enclave-session-diagnostics';
import type { PublicEnclaveStream } from './public-debug-artifacts';
import { PUBLIC_ENCLAVE_CAPTURE_BYTES, redactPublicEnclaveText } from './public-debug-redaction';

export const PUBLIC_ENCLAVE_OPERATION_STAGES = [
  'storage-preparation', 'storage-probe', 'network-isolation', 'authority-handoff', 'workload-create',
  'workload-start', 'entrypoint-initialization', 'workload-exit', 'output-validation', 'cleanup',
] as const;
export const PUBLIC_ENCLAVE_ERROR_CATEGORIES = [
  'host-exception', 'not-found', 'permission-denied', 'operation-not-permitted',
  'symlink-loop', 'no-space', 'quota-exceeded', 'file-too-large', 'io-error',
  'read-only-filesystem', 'cancelled', 'timeout', 'workload-exit', 'result-invalid',
  'cleanup-failed', 'retention-failed',
] as const;
export const PUBLIC_ENCLAVE_ENTRYPOINT_OPERATIONS = ENCLAVE_SESSION_OPERATIONS.filter(operation =>
  operation.startsWith('preflight-') || operation.startsWith('runtime-path-creation-')
  || operation.startsWith('session-log-') || operation === 'engine-launch'
  || /^(?:task-input-read|schema-input-read|github-agent-id-read|github-bearer-read|github-mcp-config-(?:write|chmod))(?:-open|-close)?$/.test(operation));
export type PublicEnclaveOperationStage = typeof PUBLIC_ENCLAVE_OPERATION_STAGES[number];
export type PublicEnclaveErrorCategory = typeof PUBLIC_ENCLAVE_ERROR_CATEGORIES[number];
export interface PublicEnclaveOperationEvent {
  stage: PublicEnclaveOperationStage;
  status: 'started' | 'succeeded' | 'failed' | 'unavailable' | 'not-applicable';
  category?: PublicEnclaveErrorCategory;
  errno?: number;
  operation?: string;
}
export interface PublicEnclaveOperationFailure {
  stage: PublicEnclaveOperationStage;
  category: PublicEnclaveErrorCategory;
  errno?: number;
  operation?: string;
}
const ERRORS: Record<string, { category: PublicEnclaveErrorCategory; errno: number }> = {
  ENOENT: { category: 'not-found', errno: 2 },
  EACCES: { category: 'permission-denied', errno: 13 },
  EPERM: { category: 'operation-not-permitted', errno: 1 },
  ELOOP: { category: 'symlink-loop', errno: 40 },
  ENOSPC: { category: 'no-space', errno: 28 },
  EDQUOT: { category: 'quota-exceeded', errno: 122 },
  EFBIG: { category: 'file-too-large', errno: 27 },
  EIO: { category: 'io-error', errno: 5 },
  EROFS: { category: 'read-only-filesystem', errno: 30 },
};

export function projectPublicEnclaveOperationEvent(value: PublicEnclaveOperationEvent): PublicEnclaveOperationEvent {
  if (!PUBLIC_ENCLAVE_OPERATION_STAGES.includes(value.stage)
    || !['started', 'succeeded', 'failed', 'unavailable', 'not-applicable'].includes(value.status)
    || (value.category !== undefined && !PUBLIC_ENCLAVE_ERROR_CATEGORIES.includes(value.category))
    || (value.errno !== undefined && !Object.values(ERRORS).some(error => error.errno === value.errno))
    || (value.operation !== undefined && (value.stage !== 'entrypoint-initialization' || value.status !== 'failed'
      || !PUBLIC_ENCLAVE_ENTRYPOINT_OPERATIONS.includes(value.operation)))) {
    throw new Error('Invalid public enclave operation evidence');
  }
  return {
    stage: value.stage, status: value.status,
    ...(value.category ? { category: value.category } : {}),
    ...(value.errno !== undefined ? { errno: value.errno } : {}),
    ...(value.operation !== undefined ? { operation: value.operation } : {}),
  };
}

/** Inputs must already have passed public eligibility, stop proof and workload-file identity checks. */
export function projectPublicEnclaveEntrypointEvent(options: {
  sessionMetadata?: EnclaveSessionDiagnostics;
  session: PublicEnclaveStream;
  stderr: PublicEnclaveStream;
  secrets: readonly string[];
}): PublicEnclaveOperationEvent {
  const projectStream = (stream: PublicEnclaveStream): EnclaveSessionDiagnostics | undefined => {
    if (stream.status !== 'captured' || !stream.contents || stream.contents.length > PUBLIC_ENCLAVE_CAPTURE_BYTES) {
      return undefined;
    }
    // Redaction decodes text permissively; do not repair an invalid diagnostic stream into evidence.
    try { new TextDecoder('utf-8', { fatal: true }).decode(stream.contents); }
    catch { return undefined; }
    return projectEnclaveSessionDiagnostics(redactPublicEnclaveText(stream.contents, options.secrets));
  };
  const sessions = [options.sessionMetadata ?? projectStream(options.session), projectStream(options.stderr)];
  for (const session of sessions) {
    const errors = [
      ...(session?.failure?.event === 'operation-error' ? [session.failure] : []),
      ...(session?.operationErrors ?? []),
    ];
    for (const error of errors) {
      const operation = error.operation;
      if (error.event !== 'operation-error' || error.fatal === false || typeof operation !== 'string'
        || !PUBLIC_ENCLAVE_ENTRYPOINT_OPERATIONS.includes(operation)) continue;
      const category = typeof error.category === 'string'
        && PUBLIC_ENCLAVE_ERROR_CATEGORIES.includes(error.category as PublicEnclaveErrorCategory)
        ? error.category as PublicEnclaveErrorCategory : 'host-exception';
      return {
        stage: 'entrypoint-initialization', status: 'failed', category, operation,
        ...(Object.values(ERRORS).some(value => value.errno === error.errno) ? { errno: error.errno as number } : {}),
      };
    }
  }
  return {
    stage: 'entrypoint-initialization',
    status: sessions.some(session => session?.events?.some(event =>
      event.event === 'progress' && ['runtime-paths-ready', 'preflight-completed', 'engine-started'].includes(String(event.stage))))
      ? 'succeeded' : 'unavailable',
  };
}

/** Finite host evidence only: never retain exception text, payloads or credentials. */
export class PublicEnclaveOperationRecorder {
  readonly events: PublicEnclaveOperationEvent[] = [];
  primaryFailure?: PublicEnclaveOperationFailure;
  cleanupFailure?: PublicEnclaveOperationFailure;
  private entrypointEvent?: PublicEnclaveOperationEvent;

  event(stage: PublicEnclaveOperationStage, status: PublicEnclaveOperationEvent['status']): void {
    if (this.events.length < 64) this.events.push({ stage, status });
  }

  record(value: PublicEnclaveOperationEvent): void {
    const event = projectPublicEnclaveOperationEvent(value);
    if (event.stage === 'entrypoint-initialization') this.entrypointEvent = event;
    if (event.status === 'failed' && event.category) {
      const failure = {
        stage: event.stage, category: event.category,
        ...(event.errno !== undefined ? { errno: event.errno } : {}),
        ...(event.operation !== undefined ? { operation: event.operation } : {}),
      };
      if (!this.primaryFailure || (event.stage === 'entrypoint-initialization'
        && this.primaryFailure.stage === 'workload-exit' && this.primaryFailure.category === 'workload-exit')) {
        this.primaryFailure = failure;
      }
    }
    if (this.events.length < 64) this.events.push(event);
  }

  fail(stage: PublicEnclaveOperationStage, error: unknown, cleanup = false,
    category?: PublicEnclaveErrorCategory): void {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code : '';
    const name = error && typeof error === 'object' && 'name' in error ? error.name : '';
    const classified = Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : {
      category: category ?? (name === 'AbortError' ? 'cancelled' : name === 'TimeoutError' ? 'timeout' : 'host-exception'),
    };
    const failure: PublicEnclaveOperationFailure = { stage, ...classified };
    if (cleanup) this.cleanupFailure ??= failure;
    else this.primaryFailure ??= failure;
    if (this.events.length < 64) this.events.push({ ...failure, status: 'failed' });
  }

  async check<T>(stage: PublicEnclaveOperationStage, operation: () => Promise<T> | T, cleanup = false): Promise<T> {
    this.event(stage, 'started');
    try {
      const value = await operation();
      this.event(stage, 'succeeded');
      return value;
    } catch (error) {
      this.fail(stage, error, cleanup);
      throw error;
    }
  }

  snapshot(): {
    stages: PublicEnclaveOperationEvent[];
    primaryFailure?: PublicEnclaveOperationFailure;
    cleanupFailure?: PublicEnclaveOperationFailure;
  } {
    const events = this.events.slice(0, 64 - PUBLIC_ENCLAVE_OPERATION_STAGES.length);
    if (this.entrypointEvent && !events.includes(this.entrypointEvent)) {
      if (events.length === 64 - PUBLIC_ENCLAVE_OPERATION_STAGES.length) events.pop();
      events.push(this.entrypointEvent);
    }
    return {
      stages: [
        ...events.map(projectPublicEnclaveOperationEvent),
        ...PUBLIC_ENCLAVE_OPERATION_STAGES.filter(stage => !events.some(event => event.stage === stage))
          .map(stage => ({ stage, status: 'unavailable' as const })),
      ].slice(0, 64),
      ...(this.primaryFailure ? { primaryFailure: { ...this.primaryFailure } } : {}),
      ...(this.cleanupFailure ? { cleanupFailure: { ...this.cleanupFailure } } : {}),
    };
  }
}
