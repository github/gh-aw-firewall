import type { HostExecutorJournal } from './host-executor-journal';
import type { HostExecutorControlDiagnostics } from './host-executor-diagnostics';
import {
  HOST_EXECUTOR_PROTOCOL_VERSION,
  HOST_EXECUTOR_TIMEOUT_GRACE_MS,
  type HostExecutorCancelRequest,
  type HostExecutorError,
  type HostExecutorInvocationView,
  type HostExecutorInvokeRequest,
  type HostExecutorOutcome,
  type HostExecutorRequest,
  type HostExecutorResponse,
  type HostExecutorSettleRequest,
  type HostExecutorState,
  hostExecutorInvokeHash,
  hostExecutorResultDigest,
  isValidHostExecutorResult,
} from './host-executor-protocol';
import { deriveHostExecutorInvocationPlan, RequestRejection } from './host-executor-runtime';
import type {
  HostEnclaveExecutorBackend,
  HostExecutorInvocationPlan,
  HostExecutorRunState,
} from './host-executor-server';

/** Covers 1,024 maximum-duration invocations polled every 10 seconds plus lifecycle requests. */
export const HOST_EXECUTOR_MAX_REQUEST_IDS = 500_000;

/** Extra request IDs reserved for cancel/status/settle once the bound above is hit. */
export const HOST_EXECUTOR_DRAIN_REQUEST_IDS = 8_192;

/** Upper bound on invocations admitted in one run. */
export const HOST_EXECUTOR_MAX_INVOCATIONS = 1_024;

interface InvocationRecord {
  plan: HostExecutorInvocationPlan;
  state: HostExecutorState;
  cancelGeneration: number;
  controller: AbortController;
  completion: Promise<void>;
  outcome?: HostExecutorOutcome;
  result?: string;
  resultDigest?: string;
  interruptedOutcome?: 'cancelled' | 'timeout';
  deadline?: NodeJS.Timeout;
  lease?: NodeJS.Timeout;
  backendCleanupComplete?: boolean;
  backendRecoverableFailure?: boolean;
}

export function createHostExecutorInvocations(options: {
  runState: HostExecutorRunState;
  backend: HostEnclaveExecutorBackend;
  statusLeaseMs: number;
  journal: Pick<HostExecutorJournal, 'record'>;
  diagnostics: Pick<HostExecutorControlDiagnostics, 'record'>;
}) {
  const { runState, backend, statusLeaseMs, journal, diagnostics } = options;
  const seenRequestIds = new Set<string>();
  const invocations = new Map<string, InvocationRecord>();
  const admissionIds = new Set<string>();
  const invocationIds = new Set<string>();
  let admissionsOpen = true;

  const invocationKey = (entryId: string, invocationId: string): string => `${entryId}\u0000${invocationId}`;

  const view = (record: InvocationRecord): HostExecutorInvocationView => {
    const current: HostExecutorInvocationView = {
      state: record.state,
      cancelGeneration: record.cancelGeneration,
    };
    if (record.outcome !== undefined) current.outcome = record.outcome;
    if (record.result !== undefined) current.result = record.result;
    if (record.resultDigest !== undefined) current.resultDigest = record.resultDigest;
    return current;
  };

  const finish = (
    record: InvocationRecord, outcome: HostExecutorOutcome, result?: string, recoverableFailure = false,
  ): void => {
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
      admissionsOpen = false;
      for (const other of invocations.values()) interrupt(other, 'cancelled');
    }
  };

  const interrupt = (record: InvocationRecord, outcome: 'cancelled' | 'timeout'): void => {
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
      admissionsOpen = false;
    } finally {
      record.controller.abort();
    }
  };
  const renewLease = (record: InvocationRecord): void => {
    if (record.state !== 'running') return;
    clearTimeout(record.lease);
    record.lease = setTimeout(() => interrupt(record, 'cancelled'), statusLeaseMs);
    record.lease.unref();
  };

  const launch = (plan: HostExecutorInvocationPlan): InvocationRecord => {
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
    invocations.set(invocationKey(plan.entryId, plan.invocationId), record);
    admissionIds.add(plan.admissionId);
    invocationIds.add(plan.invocationId);
    record.deadline = setTimeout(() => interrupt(record, 'timeout'),
      plan.timeoutMs + HOST_EXECUTOR_TIMEOUT_GRACE_MS);
    record.deadline.unref();
    renewLease(record);
    const cleanupFailed = (): void => {
      diagnostics.record('cleanup-pending', undefined, undefined, plan.invocationId);
      clearTimeout(record.deadline);
      clearTimeout(record.lease);
      admissionsOpen = false;
      record.state = 'cancelling';
      record.controller.abort();
      for (const other of invocations.values()) interrupt(other, 'cancelled');
      journal.record({
        entryId: plan.entryId, invocationId: plan.invocationId, state: 'cleanup-pending',
      });
    };
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
            cleanupFailed();
          } else if (outcome && isValidHostExecutorResult(outcome.outcome, outcome.result)) {
            finish(record, outcome.outcome, outcome.result,
              outcome.recoverableFailure === true && outcome.cleanupComplete === true);
          } else {
            finish(record, 'executor-failure');
          }
        },
        (error: unknown) => {
          diagnostics.record('backend-failed', error, undefined, plan.invocationId);
          cleanupFailed();
        },
      ).catch(() => {
        // Persistence failure leaves a nonterminal tombstone; no result may
        // escape and this run may admit no more work.
        admissionsOpen = false;
        clearTimeout(record.deadline);
        clearTimeout(record.lease);
        record.state = 'cancelling';
        record.result = undefined;
        record.controller.abort();
        for (const other of invocations.values()) interrupt(other, 'cancelled');
      });
    return record;
  };

  const handleInvoke = (request: HostExecutorInvokeRequest): InvocationRecord => {
    const existing = invocations.get(invocationKey(request.entryId, request.invocationId));
    if (existing) {
      if (existing.plan.requestHash !== hostExecutorInvokeHash(request)) throw new RequestRejection('conflict');
      if (existing.state === 'terminal' || existing.state === 'settled') throw new RequestRejection('invalid-state');
      return existing;
    }
    if (!admissionsOpen) throw new RequestRejection('closed');
    if (admissionIds.has(request.admissionId) || invocationIds.has(request.invocationId)) {
      throw new RequestRejection('conflict');
    }
    if (invocations.size >= HOST_EXECUTOR_MAX_INVOCATIONS) {
      admissionsOpen = false;
      throw new RequestRejection('closed');
    }
    diagnostics.record('invoke-plan', undefined, undefined, request.invocationId);
    return launch(deriveHostExecutorInvocationPlan(runState, request));
  };

  const handleCancel = (request: HostExecutorCancelRequest, record: InvocationRecord): void => {
    if (request.cancelGeneration <= record.cancelGeneration) throw new RequestRejection('replayed');
    record.cancelGeneration = request.cancelGeneration;
    try {
      journal.record({
        entryId: record.plan.entryId, invocationId: record.plan.invocationId,
        state: record.state, cancelGeneration: record.cancelGeneration,
      });
    } finally {
      interrupt(record, 'cancelled');
    }
  };

  const handleSettle = (request: HostExecutorSettleRequest, record: InvocationRecord): void => {
    if (record.state === 'running' || record.state === 'cancelling') throw new RequestRejection('invalid-state');
    if (request.resultDigest !== record.resultDigest) throw new RequestRejection('conflict');
    if (record.state === 'terminal') {
      journal.record({
        entryId: record.plan.entryId, invocationId: record.plan.invocationId,
        state: 'settled', resultDigest: record.resultDigest,
      });
      record.state = 'settled';
      // Settlement is the broker's acknowledgement; the host no longer
      // retains the result payload afterwards.
      record.result = undefined;
      diagnostics.record('settled', undefined, undefined, request.invocationId);
    }
  };

  const handle = (request: HostExecutorRequest): HostExecutorResponse => {
    const fail = (code: HostExecutorError): HostExecutorResponse => ({
      version: HOST_EXECUTOR_PROTOCOL_VERSION,
      ok: false,
      requestId: request.requestId,
      error: code,
    });
    if (seenRequestIds.has(request.requestId)) return fail('replayed');
    if (seenRequestIds.size >= HOST_EXECUTOR_MAX_REQUEST_IDS) {
      // Close admissions but keep a bounded reserve so the broker can still
      // cancel, poll, and settle already-admitted invocations.
      admissionsOpen = false;
      if (request.type === 'invoke'
        || seenRequestIds.size >= HOST_EXECUTOR_MAX_REQUEST_IDS + HOST_EXECUTOR_DRAIN_REQUEST_IDS) {
        return fail('closed');
      }
    }
    seenRequestIds.add(request.requestId);

    try {
      let record: InvocationRecord | undefined;
      if (request.type === 'invoke') {
        record = handleInvoke(request);
      } else {
        record = invocations.get(invocationKey(request.entryId, request.invocationId));
        if (!record) return fail('unknown-invocation');
        if (request.type === 'cancel') handleCancel(request, record);
        else if (request.type === 'settle') handleSettle(request, record);
        else renewLease(record);
      }
      return {
        version: HOST_EXECUTOR_PROTOCOL_VERSION,
        ok: true,
        requestId: request.requestId,
        invocationId: request.invocationId,
        ...view(record),
      };
    } catch (error) {
      diagnostics.record(
        error instanceof RequestRejection ? error.diagnosticPhase ?? 'request-rejected' : 'request-rejected',
        error, error instanceof RequestRejection ? error.code : undefined,
        request.invocationId,
      );
      if (!(error instanceof RequestRejection)) {
        admissionsOpen = false;
        for (const record of invocations.values()) interrupt(record, 'cancelled');
      }
      return fail(error instanceof RequestRejection ? error.code : 'denied');
    }
  };

  return {
    handle,
    closeAdmissions(): void {
      admissionsOpen = false;
    },
    cancelRunning(): void {
      for (const record of invocations.values()) interrupt(record, 'cancelled');
    },
    waitForCompletion(): Promise<void[]> {
      return Promise.all([...invocations.values()].map((record) => record.completion));
    },
  };
}
