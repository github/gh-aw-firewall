import schema from './host-preflight-schema.json';

export type HostPreflightScope = keyof typeof schema.scopes;
export type HostPreflightCheck = {
  [Scope in HostPreflightScope]: keyof typeof schema.scopes[Scope];
}[HostPreflightScope];
export type HostPreflightReason = keyof typeof schema.reasons;
export type CheckResult = 'not-attempted' | 'not-required' | 'attempted' | 'passed' | 'failed';
export interface HostPreflightProgress {
  schemaVersion: 1;
  scope: HostPreflightScope;
  checks: { id: HostPreflightCheck; result: CheckResult; reason: HostPreflightReason }[];
}

// Keep classification out of error messages, which may contain private paths.
const reasons = new WeakMap<object, HostPreflightReason>();
export function markHostPreflightError<T>(error: T, reason: HostPreflightReason): T {
  if (error && typeof error === 'object') reasons.set(error, reason);
  return error;
}

export function hostPreflightReason(error: unknown): HostPreflightReason {
  if (!error || typeof error !== 'object') return 'unknown';
  const classified = reasons.get(error);
  if (classified) return classified;
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' && code !== 'none'
    && Object.prototype.hasOwnProperty.call(schema.reasons, code) ? code as HostPreflightReason : 'unknown';
}

export class HostPreflightCleanupError extends Error {
  readonly cause: unknown;
  readonly cleanupError: unknown;

  constructor(cause: unknown, cleanupError: unknown) {
    super('Host preflight failed and cleanup failed');
    this.cause = cause;
    this.cleanupError = cleanupError;
    markHostPreflightError(this, hostPreflightReason(cause));
  }
}

/** Reports only executed gates; constructing a plan does not pass any check. */
export class HostPreflightReporter {
  private readonly progress: HostPreflightProgress;

  constructor(scope: HostPreflightScope, private readonly publish?: (value: HostPreflightProgress) => void) {
    this.progress = {
      schemaVersion: 1, scope,
      checks: (Object.keys(schema.scopes[scope]) as HostPreflightCheck[])
        .map((id) => ({ id, result: 'not-attempted', reason: 'none' })),
    };
    this.emit();
  }

  private emit(): void {
    this.publish?.({
      ...this.progress, checks: this.progress.checks.map((check) => ({ ...check })),
    });
  }

  fork(scope: HostPreflightScope): HostPreflightReporter {
    return new HostPreflightReporter(scope, this.publish);
  }

  notRequired(id: HostPreflightCheck): void {
    if (!schema.optionalChecks.includes(`${this.progress.scope}/${id}`)) {
      throw new Error('Required startup check cannot be skipped');
    }
    const check = this.progress.checks.find((candidate) => candidate.id === id)!;
    check.result = 'not-required';
    check.reason = 'none';
    this.emit();
  }

  attempt(id: HostPreflightCheck): void {
    const check = this.progress.checks.find((candidate) => candidate.id === id);
    if (!check) throw new Error('Unknown host preflight check');
    check.result = 'attempted';
    check.reason = 'none';
    this.emit();
  }

  fail(id: HostPreflightCheck, error: unknown): void {
    const check = this.progress.checks.find((candidate) => candidate.id === id);
    if (!check) throw new Error('Unknown host preflight check');
    check.result = 'failed';
    check.reason = hostPreflightReason(error);
    this.emit();
  }

  async check<T>(id: HostPreflightCheck, operation: () => Promise<T> | T): Promise<T> {
    const check = this.progress.checks.find((candidate) => candidate.id === id);
    if (!check) throw new Error('Unknown host preflight check');
    this.attempt(id);
    try {
      const result = await operation();
      check.result = 'passed';
      this.emit();
      return result;
    } catch (error) {
      this.fail(id, error);
      throw error;
    }
  }
}
