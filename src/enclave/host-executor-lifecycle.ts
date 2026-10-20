import type { HostExecutorServer } from './host-executor-server';

export interface HostExecutorRunLifecycle<Owner, Storage> {
  readonly configuration: Owner;
  readonly runId: string;
  server?: HostExecutorServer;
  storage?: Storage;
  failed?: boolean;
  closePromise?: Promise<void>;
  startPromise?: Promise<void>;
  draining?: boolean;
  publicDebugVerified?: boolean;
}

/** Owns host services, not primary workload managers or persistent guest readiness. */
export class HostExecutorLifecycleRegistry<Owner, Storage> {
  private readonly runs = new Map<string, HostExecutorRunLifecycle<Owner, Storage>>();
  private readonly completedRuns = new Map<string, string>();

  constructor(private readonly label: string) {}

  has(key: string): boolean { return this.runs.has(key); }

  completed(key: string, runId: string): boolean {
    return this.completedRuns.get(key) === runId;
  }

  async start(
    key: string,
    configuration: Owner,
    runId: string,
    start: (run: HostExecutorRunLifecycle<Owner, Storage>) => Promise<void>,
  ): Promise<void> {
    if (this.runs.has(key)) throw new Error(`${this.label} host executor already exists for this run`);
    const run: HostExecutorRunLifecycle<Owner, Storage> = { configuration, runId };
    this.runs.set(key, run);
    // Publish the promise before calling adapter code, including synchronous callbacks.
    let resolveStart!: () => void;
    let rejectStart!: (error: unknown) => void;
    run.startPromise = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    void (async () => {
      try {
        await start(run);
        if (run.draining) run.server?.closeAdmissions();
      } catch (error) {
        run.failed = true;
        throw error;
      }
    })().then(resolveStart, rejectStart);
    await run.startPromise;
  }

  closeAdmissions(key: string, configuration: Owner): void {
    const run = this.runs.get(key);
    if (!run) return;
    this.assertOwner(run, configuration);
    run.draining = true;
    run.server?.closeAdmissions();
  }

  ready(key: string, configuration: Owner): Promise<void> {
    const run = this.runs.get(key);
    return run?.configuration === configuration && run.server
      && !run.failed && !run.draining && !run.closePromise
      ? Promise.resolve()
      : Promise.reject(new Error(`${this.label} trusted full preflight has not completed`));
  }

  async stop(
    key: string,
    configuration: Owner,
    missing: () => void,
    close: (run: HostExecutorRunLifecycle<Owner, Storage>) => Promise<void>,
  ): Promise<void> {
    const run = this.runs.get(key);
    if (!run) return missing();
    this.closeAdmissions(key, configuration);
    run.closePromise ??= Promise.resolve().then(async () => {
      await run.startPromise?.catch(() => undefined);
      await close(run);
      this.completedRuns.set(key, run.runId);
      this.runs.delete(key);
    });
    await run.closePromise;
  }

  private assertOwner(run: HostExecutorRunLifecycle<Owner, Storage>, configuration: Owner): void {
    if (run.configuration !== configuration) {
      throw new Error(`${this.label} lifecycle is owned by another configuration`);
    }
  }
}

export interface HostExecutorDrainHooks {
  preserveEvidence(): Promise<void>;
  /**
   * Must verify recovery journals and reject if cleanup is incomplete or uncertain.
   * The boolean only reports whether a host service was drained.
   */
  drain(): Promise<boolean>;
  collectDiagnostics(drained: boolean): Promise<void>;
  /** Runs only after confirmed cleanup; storage authority stays in the adapter. */
  releaseStorage(): Promise<void>;
  combineErrors(cleanupError: unknown, evidenceError: unknown): Error;
}

/** Preserve evidence on both sides of teardown and retain storage on uncertain cleanup. */
export async function drainHostExecutorLifecycle(hooks: HostExecutorDrainHooks): Promise<void> {
  let cleanupError: unknown;
  let evidenceError: unknown;
  let drained = false;
  try { await hooks.preserveEvidence(); } catch (error) { evidenceError = error; }
  try { drained = await hooks.drain(); } catch (error) { cleanupError = error; }
  try { await hooks.collectDiagnostics(drained); } catch (error) { evidenceError ??= error; }
  if (cleanupError === undefined) {
    try { await hooks.releaseStorage(); } catch (error) { cleanupError = error; }
  }
  try { await hooks.preserveEvidence(); } catch (error) { evidenceError ??= error; }
  if (evidenceError !== undefined) {
    if (cleanupError !== undefined) throw hooks.combineErrors(cleanupError, evidenceError);
    throw evidenceError;
  }
  if (cleanupError !== undefined) throw cleanupError;
}
