import type { HostExecutorJournal } from './host-executor-journal';
import type { HostExecutorControlDiagnostics } from './host-executor-diagnostics';
import {
  HOST_EXECUTOR_PROTOCOL_VERSION,
  type HostExecutorCancelRequest,
  type HostExecutorError,
  type HostExecutorInvokeRequest,
  type HostExecutorRequest,
  type HostExecutorResponse,
  type HostExecutorSettleRequest,
  hostExecutorInvokeHash,
} from './host-executor-protocol';
import { deriveHostExecutorInvocationPlan, RequestRejection } from './host-executor-runtime';
import { HostExecutorInvocationRegistry, type InvocationRecord } from './host-executor-invocation-registry';
import { HostExecutorInvocationLifecycle } from './host-executor-invocation-lifecycle';
import type {
  HostEnclaveExecutorBackend,
  HostExecutorRunState,
} from './host-executor-server';

export {
  HOST_EXECUTOR_MAX_REQUEST_IDS,
  HOST_EXECUTOR_DRAIN_REQUEST_IDS,
  HOST_EXECUTOR_MAX_INVOCATIONS,
} from './host-executor-invocation-registry';

export function createHostExecutorInvocations(options: {
  runState: HostExecutorRunState;
  backend: HostEnclaveExecutorBackend;
  statusLeaseMs: number;
  journal: Pick<HostExecutorJournal, 'record'>;
  diagnostics: Pick<HostExecutorControlDiagnostics, 'record'>;
}) {
  const { runState, journal, diagnostics } = options;
  const registry = new HostExecutorInvocationRegistry();
  const lifecycle = new HostExecutorInvocationLifecycle({ ...options, registry });

  const handleInvoke = (request: HostExecutorInvokeRequest): InvocationRecord => {
    const existing = registry.get(request.entryId, request.invocationId);
    if (existing) {
      if (existing.plan.requestHash !== hostExecutorInvokeHash(request)) throw new RequestRejection('conflict');
      if (existing.state === 'terminal' || existing.state === 'settled') throw new RequestRejection('invalid-state');
      return existing;
    }
    registry.assertCanAdmit(request.admissionId, request.invocationId);
    diagnostics.record('invoke-plan', undefined, undefined, request.invocationId);
    return lifecycle.launch(deriveHostExecutorInvocationPlan(runState, request));
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
      lifecycle.interrupt(record, 'cancelled');
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
    const requestError = registry.trackRequest(request);
    if (requestError) return fail(requestError);

    try {
      let record: InvocationRecord | undefined;
      if (request.type === 'invoke') {
        record = handleInvoke(request);
      } else {
        record = registry.get(request.entryId, request.invocationId);
        if (!record) return fail('unknown-invocation');
        if (request.type === 'cancel') handleCancel(request, record);
        else if (request.type === 'settle') handleSettle(request, record);
        else lifecycle.renewLease(record);
      }
      return {
        version: HOST_EXECUTOR_PROTOCOL_VERSION,
        ok: true,
        requestId: request.requestId,
        invocationId: request.invocationId,
        ...registry.view(record),
      };
    } catch (error) {
      diagnostics.record(
        error instanceof RequestRejection ? error.diagnosticPhase ?? 'request-rejected' : 'request-rejected',
        error, error instanceof RequestRejection ? error.code : undefined,
        request.invocationId,
      );
      if (!(error instanceof RequestRejection)) {
        registry.closeAdmissions();
        lifecycle.cancelRunning();
      }
      return fail(error instanceof RequestRejection ? error.code : 'denied');
    }
  };

  return {
    handle,
    closeAdmissions(): void {
      registry.closeAdmissions();
    },
    cancelRunning(): void {
      lifecycle.cancelRunning();
    },
    waitForCompletion(): Promise<void[]> {
      return Promise.all([...registry.values()].map((record) => record.completion));
    },
  };
}
