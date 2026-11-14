/**
 * Host side of the broker-to-host enclave executor protocol (ADR 0002).
 *
 * The AWF control process owns one listener per run. It authenticates every
 * request with the run capability, records the immutable request before any
 * execution, derives every host path from trusted run state, and hands the
 * resulting closed invocation plan to a trusted backend. The backend (the
 * later Cloud Hypervisor host executor) is the only component that turns a
 * plan into runtime settings; nothing in a request can choose a command,
 * executable, path, mount, environment, network, or runtime profile.
 *
 * This module does not launch anything by itself and is not wired into any
 * runtime yet: Cloud Hypervisor enclave execution stays fail-closed until the
 * remaining ADR 0002 gates are implemented.
 */

import * as fs from 'fs';
import type { HostExecutorKind, HostExecutorOutcome } from './host-executor-protocol';
import { prepareHostExecutorRuntime } from './host-executor-runtime';
import { createHostExecutorInvocations } from './host-executor-invocations';
import { createHostExecutorSocket } from './host-executor-socket';

export {
  HOST_EXECUTOR_SOCKET_NAME,
  HOST_EXECUTOR_CAPABILITY_NAME,
  HOST_EXECUTOR_MAX_TIMEOUT_MS,
  HOST_EXECUTOR_DEFAULT_STATUS_LEASE_MS,
  deriveHostExecutorInvocationPlan,
} from './host-executor-runtime';
export {
  HOST_EXECUTOR_MAX_REQUEST_IDS,
  HOST_EXECUTOR_DRAIN_REQUEST_IDS,
  HOST_EXECUTOR_MAX_INVOCATIONS,
} from './host-executor-invocations';

/**
 * Trusted, host-derived state for one run. Built by the AWF control process
 * from the validated enclave configuration and staging results — never from
 * a broker request.
 */
export interface HostExecutorRunState {
  runId: string;
  /** Absolute host directory containing staged immutable seeds, one per seed ID. */
  seedsDir: string;
  /** Absolute host directory under which per-invocation directories are derived. */
  invocationsDir: string;
  /** Durable private storage; must survive runtime-directory cleanup/restart. */
  journalDir?: string;
  /** Entry-specific executor policy from the validated enclave configuration. */
  entries: readonly HostExecutorEntryPolicy[];
}

export interface HostExecutorEntryPolicy {
  entryId: string;
  executorKind: HostExecutorKind;
  /** Trusted wall-clock budget for one invocation; never supplied by the broker. */
  timeoutMs: number;
  /** Static seed IDs admitted by this entry. */
  staticSeedIds: readonly string[];
  /** Whether selector-based agent admission is enabled for this entry. */
  dynamicAgents: boolean;
}

/**
 * The closed, host-derived plan handed to the backend. Host paths are joined
 * from trusted directories and pattern-validated identifiers only.
 */
export interface HostExecutorInvocationPlan {
  readonly runId: string;
  readonly entryId: string;
  readonly invocationId: string;
  readonly executorKind: HostExecutorKind;
  readonly timeoutMs: number;
  readonly requestHash: string;
  readonly admissionId: string;
  readonly schemaHash: string;
  readonly schema: import('../bounded-execution/finite-schema').FiniteSchemaNode;
  readonly payload: string;
  readonly invocationHostDir: string;
  readonly seedId?: string;
  readonly seedHostPath?: string;
  readonly selector?: string;
}

export interface HostExecutorBackendResult {
  outcome: HostExecutorOutcome;
  /** False retains a nonterminal recovery tombstone; no result is released. */
  cleanupComplete?: boolean;
  /**
   * Only a completed guest workload's nonzero exit/signal, with verified resource
   * cleanup and durable diagnostics, may preserve admissions. Never set for
   * startup, transport or infrastructure failures; requires cleanupComplete: true.
   * Host-only classification: the public result remains the canonical error.
   */
  recoverableFailure?: true;
  /** Bounded, schema-valid result. Only carried for `success`. */
  result?: string;
}

/** Trusted executor backend. Receives only closed plans, never raw requests. */
export interface HostEnclaveExecutorBackend {
  execute(plan: HostExecutorInvocationPlan, signal: AbortSignal): Promise<HostExecutorBackendResult>;
  close?(): Promise<void>;
}

export interface HostExecutorServerOptions {
  /** Private runtime directory for the socket and capability. Created `0700`. */
  runtimeDir: string;
  runState: HostExecutorRunState;
  backend: HostEnclaveExecutorBackend;
  connectionTimeoutMs?: number;
  maxConnections?: number;
  /** Trusted broker-liveness budget, renewed only by fresh authenticated status. */
  statusLeaseMs?: number;
}

export interface HostExecutorServer {
  readonly socketPath: string;
  readonly capabilityPath: string;
  /** Rejects further `invoke` requests; `cancel`, `status`, and `settle` keep working. */
  closeAdmissions(): void;
  /** Cancels running invocations, stops listening, and destroys the capability. */
  close(): Promise<void>;
}

/**
 * Starts the per-run host executor listener. Fails closed if the socket or
 * capability file already exists instead of reusing or replacing them.
 */
export async function startHostExecutorServer(options: HostExecutorServerOptions): Promise<HostExecutorServer> {
  const runtime = prepareHostExecutorRuntime(options);
  const { runState, socketPath, capabilityPath, capability, journal, diagnostics, statusLeaseMs } = runtime;
  const { backend } = options;
  const invocations = createHostExecutorInvocations({ runState, backend, journal, diagnostics, statusLeaseMs });
  const socket = createHostExecutorSocket({
    socketPath, capability, runId: runState.runId, diagnostics, handle: invocations.handle,
    connectionTimeoutMs: options.connectionTimeoutMs, maxConnections: options.maxConnections,
  });
  let closePromise: Promise<void> | undefined;
  try {
    await socket.listen();
  } catch (error) {
    capability.fill(0);
    fs.rmSync(capabilityPath, { force: true });
    socket.closeAfterListenFailure();
    throw error;
  }

  return {
    socketPath,
    capabilityPath,
    closeAdmissions: invocations.closeAdmissions,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      diagnostics.record('shutdown');
      socket.stopRequests();
      invocations.closeAdmissions();
      invocations.cancelRunning();
      closePromise = (async () => {
        await socket.close();
        await invocations.waitForCompletion();
        try {
          await backend.close?.();
          journal.record({ state: 'closed' });
        } catch (error) {
          diagnostics.record('shutdown-failed', error);
          throw error;
        } finally {
          capability.fill(0);
          fs.rmSync(capabilityPath, { force: true });
          fs.rmSync(socketPath, { force: true });
        }
      })();
      return closePromise;
    },
  };
}
