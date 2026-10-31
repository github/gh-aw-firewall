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
export type PublicEnclaveOperationStage = typeof PUBLIC_ENCLAVE_OPERATION_STAGES[number];
export type PublicEnclaveErrorCategory = typeof PUBLIC_ENCLAVE_ERROR_CATEGORIES[number];
export interface PublicEnclaveOperationEvent {
  stage: PublicEnclaveOperationStage;
  status: 'started' | 'succeeded' | 'failed' | 'unavailable' | 'not-applicable';
  category?: PublicEnclaveErrorCategory;
  errno?: number;
}
export interface PublicEnclaveOperationFailure {
  stage: PublicEnclaveOperationStage;
  category: PublicEnclaveErrorCategory;
  errno?: number;
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
    || (value.errno !== undefined && !Object.values(ERRORS).some(error => error.errno === value.errno))) {
    throw new Error('Invalid public enclave operation evidence');
  }
  return {
    stage: value.stage, status: value.status,
    ...(value.category ? { category: value.category } : {}),
    ...(value.errno !== undefined ? { errno: value.errno } : {}),
  };
}

/** Finite host evidence only: never retain exception text, payloads or credentials. */
export class PublicEnclaveOperationRecorder {
  readonly events: PublicEnclaveOperationEvent[] = [];
  primaryFailure?: PublicEnclaveOperationFailure;
  cleanupFailure?: PublicEnclaveOperationFailure;

  event(stage: PublicEnclaveOperationStage, status: PublicEnclaveOperationEvent['status']): void {
    if (this.events.length < 64) this.events.push({ stage, status });
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
