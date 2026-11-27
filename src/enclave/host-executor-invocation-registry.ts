import type {
  HostExecutorError,
  HostExecutorInvocationView,
  HostExecutorOutcome,
  HostExecutorRequest,
  HostExecutorState,
} from './host-executor-protocol';
import { RequestRejection } from './host-executor-runtime';
import type { HostExecutorInvocationPlan } from './host-executor-server';

/** Covers 1,024 maximum-duration invocations polled every 10 seconds plus lifecycle requests. */
export const HOST_EXECUTOR_MAX_REQUEST_IDS = 500_000;

/** Extra request IDs reserved for cancel/status/settle once the bound above is hit. */
export const HOST_EXECUTOR_DRAIN_REQUEST_IDS = 8_192;

/** Upper bound on invocations admitted in one run. */
export const HOST_EXECUTOR_MAX_INVOCATIONS = 1_024;

export interface InvocationRecord {
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

const invocationKey = (entryId: string, invocationId: string): string => `${entryId}\u0000${invocationId}`;

export class HostExecutorInvocationRegistry {
  private readonly seenRequestIds = new Set<string>();
  private readonly invocations = new Map<string, InvocationRecord>();
  private readonly admissionIds = new Set<string>();
  private readonly invocationIds = new Set<string>();
  private admissionsOpen = true;

  trackRequest(request: Pick<HostExecutorRequest, 'requestId' | 'type'>): HostExecutorError | undefined {
    if (this.seenRequestIds.has(request.requestId)) return 'replayed';
    if (this.seenRequestIds.size >= HOST_EXECUTOR_MAX_REQUEST_IDS) {
      // Close admissions but keep a bounded reserve so the broker can still
      // cancel, poll, and settle already-admitted invocations.
      this.closeAdmissions();
      if (request.type === 'invoke'
        || this.seenRequestIds.size >= HOST_EXECUTOR_MAX_REQUEST_IDS + HOST_EXECUTOR_DRAIN_REQUEST_IDS) {
        return 'closed';
      }
    }
    this.seenRequestIds.add(request.requestId);
    return undefined;
  }

  assertCanAdmit(admissionId: string, invocationId: string): void {
    if (!this.admissionsOpen) throw new RequestRejection('closed');
    if (this.admissionIds.has(admissionId) || this.invocationIds.has(invocationId)) {
      throw new RequestRejection('conflict');
    }
    if (this.invocations.size >= HOST_EXECUTOR_MAX_INVOCATIONS) {
      this.closeAdmissions();
      throw new RequestRejection('closed');
    }
  }

  get(entryId: string, invocationId: string): InvocationRecord | undefined {
    return this.invocations.get(invocationKey(entryId, invocationId));
  }

  register(record: InvocationRecord): void {
    const { plan } = record;
    this.invocations.set(invocationKey(plan.entryId, plan.invocationId), record);
    this.admissionIds.add(plan.admissionId);
    this.invocationIds.add(plan.invocationId);
  }

  values(): IterableIterator<InvocationRecord> {
    return this.invocations.values();
  }

  closeAdmissions(): void {
    this.admissionsOpen = false;
  }

  view(record: InvocationRecord): HostExecutorInvocationView {
    const current: HostExecutorInvocationView = {
      state: record.state,
      cancelGeneration: record.cancelGeneration,
    };
    if (record.outcome !== undefined) current.outcome = record.outcome;
    if (record.result !== undefined) current.result = record.result;
    if (record.resultDigest !== undefined) current.resultDigest = record.resultDigest;
    return current;
  }
}
