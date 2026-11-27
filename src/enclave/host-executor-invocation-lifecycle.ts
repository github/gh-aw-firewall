import type { HostExecutorJournal } from './host-executor-journal';
import type { HostExecutorControlDiagnostics } from './host-executor-diagnostics';
import {
  HOST_EXECUTOR_TIMEOUT_GRACE_MS,
  type HostExecutorOutcome,
  hostExecutorResultDigest,
  isValidHostExecutorResult,
} from './host-executor-protocol';
import { HostExecutorInvocationRegistry, type InvocationRecord } from './host-executor-invocation-registry';
import type { HostEnclaveExecutorBackend, HostExecutorInvocationPlan } from './host-executor-server';

export class HostExecutorInvocationLifecycle {
  constructor(private readonly options: {
    registry: HostExecutorInvocationRegistry;
    backend: HostEnclaveExecutorBackend;
    statusLeaseMs: number;
    journal: Pick<HostExecutorJournal, 'record'>;
    diagnostics: Pick<HostExecutorControlDiagnostics, 'record'>;
  }) {}

  private finish(
    record: InvocationRecord, outcome: HostExecutorOutcome, result?: string, recoverableFailure = false,
  ): void {
    const { registry, journal, diagnostics } = this.options;
    clearTimeout(record.deadline);
    clearTimeout(record.lease);
    const finalOutcome: HostExecutorOutcome = outcome === 'executor-failure'
      ? 'executor-failure' : record.interruptedOutcome ?? outcome;
    const finalResult = finalOutcome === 'success' ? result : undefined;
    const digest = hostExecutorResultDigest(finalOutcome, finalResult);
    // Never publish terminal until the backend has returned after cleanup and
    // the durable lifecycle transition has committed.
    journal.record({
      entryId: record.plan.entryId, invocationId: record.plan.invocationId,
      state: 'terminal', outcome: finalOutcome, resultDigest: digest,
    });
    record.outcome = finalOutcome;
    record.result = finalResult;
    record.resultDigest = digest;
    record.state = 'terminal';
    if (finalOutcome === 'executor-failure' && !recoverableFailure) {
      diagnostics.record('admissions-closed', undefined, 'closed', record.plan.invocationId,
        undefined, {
          outcome: finalOutcome,
          cleanupComplete: record.backendCleanupComplete ?? 'absent',
          recoverableFailure: record.backendRecoverableFailure ?? 'absent',
        });
      registry.closeAdmissions();
      this.cancelRunning();
    }
  }

  interrupt(record: InvocationRecord, outcome: 'cancelled' | 'timeout'): void {
    const { registry, journal, diagnostics } = this.options;
    if (record.state !== 'running') return;
    diagnostics.record(outcome === 'timeout' ? 'deadline-expired' : 'cancellation',
      undefined, undefined, record.plan.invocationId);
    record.state = 'cancelling';
    record.interruptedOutcome = outcome;
    try {
      journal.record({
        entryId: record.plan.entryId, invocationId: record.plan.invocationId,
        state: 'cancelling', outcome, cancelGeneration: record.cancelGeneration,
      });
    } catch {
      registry.closeAdmissions();
    } finally {
      record.controller.abort();
    }
  }

  renewLease(record: InvocationRecord): void {
    if (record.state !== 'running') return;
    clearTimeout(record.lease);
    record.lease = setTimeout(() => this.interrupt(record, 'cancelled'), this.options.statusLeaseMs);
    record.lease.unref();
  }

  private cleanupFailed(record: InvocationRecord): void {
    const { registry, journal, diagnostics } = this.options;
    diagnostics.record('cleanup-pending', undefined, undefined, record.plan.invocationId);
    clearTimeout(record.deadline);
    clearTimeout(record.lease);
    registry.closeAdmissions();
    record.state = 'cancelling';
    record.controller.abort();
    this.cancelRunning();
    journal.record({
      entryId: record.plan.entryId, invocationId: record.plan.invocationId, state: 'cleanup-pending',
    });
  }

  launch(plan: HostExecutorInvocationPlan): InvocationRecord {
    const { registry, backend, journal, diagnostics } = this.options;
    diagnostics.record('invocation-register', undefined, undefined, plan.invocationId);
    const controller = new AbortController();
    const record: InvocationRecord = {
      plan,
      state: 'running',
      cancelGeneration: 0,
      controller,
      completion: Promise.resolve(),
    };
    // The immutable record exists before the backend is asked to create
    // anything, so a retry can never start a second execution.
    journal.record({
      entryId: plan.entryId, invocationId: plan.invocationId,
      admissionId: plan.admissionId, requestHash: plan.requestHash, state: 'running',
    });
    registry.register(record);
    record.deadline = setTimeout(() => this.interrupt(record, 'timeout'),
      plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS);
    record.deadline.unref();
    this.renewLease(record);
    record.completion = Promise.resolve()
      .then(() => {
        diagnostics.record('backend-start', undefined, undefined, plan.invocationId);
        return backend.execute(plan, controller.signal);
      })
      .then(
        (outcome) => {
          record.backendCleanupComplete = outcome?.cleanupComplete;
          record.backendRecoverableFailure = outcome?.recoverableFailure;
          diagnostics.record('backend-complete', undefined, undefined, plan.invocationId);
          if (outcome?.cleanupComplete === false) {
            this.cleanupFailed(record);
          } else if (outcome && isValidHostExecutorResult(outcome.outcome, outcome.result)) {
            this.finish(record, outcome.outcome, outcome.result,
              outcome.recoverableFailure === true && outcome.cleanupComplete === true);
          } else {
            this.finish(record, 'executor-failure');
          }
        },
        (error: unknown) => {
          diagnostics.record('backend-failed', error, undefined, plan.invocationId);
          this.cleanupFailed(record);
        },
      ).catch(() => {
        // Persistence failure leaves a nonterminal tombstone; no result may
        // escape and this run may admit no more work.
        registry.closeAdmissions();
        clearTimeout(record.deadline);
        clearTimeout(record.lease);
        record.state = 'cancelling';
        record.result = undefined;
        record.controller.abort();
        this.cancelRunning();
      });
    return record;
  }

  cancelRunning(): void {
    for (const record of this.options.registry.values()) this.interrupt(record, 'cancelled');
  }
}
