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
import * as net from 'net';
import * as path from 'path';
import { HostExecutorJournal, hostExecutorJournalDirectory } from './host-executor-journal';
import {
  HOST_EXECUTOR_FRAME_HEADER_BYTES,
  HOST_EXECUTOR_ENTRY_ID_PATTERN,
  HOST_EXECUTOR_ID_PATTERN,
  HOST_EXECUTOR_KINDS,
  HOST_EXECUTOR_MAX_REQUEST_BYTES,
  HOST_EXECUTOR_PROTOCOL_VERSION,
  type HostExecutorCancelRequest,
  type HostExecutorError,
  type HostExecutorInvocationView,
  type HostExecutorInvokeRequest,
  type HostExecutorKind,
  type HostExecutorOutcome,
  type HostExecutorRequest,
  type HostExecutorResponse,
  type HostExecutorSettleRequest,
  type HostExecutorState,
  canonicalDeniedResponse,
  decodeHostExecutorRequest,
  encodeHostExecutorResponse,
  frameHostExecutorMessage,
  generateHostExecutorCapability,
  hostExecutorInvokeHash,
  hostExecutorResultDigest,
  isValidHostExecutorResult,
} from './host-executor-protocol';

export const HOST_EXECUTOR_SOCKET_NAME = 'executor.sock';
export const HOST_EXECUTOR_CAPABILITY_NAME = 'capability';

/** Covers 1,024 maximum-duration invocations polled every 10 seconds plus lifecycle requests. */
export const HOST_EXECUTOR_MAX_REQUEST_IDS = 500_000;

/** Extra request IDs reserved for cancel/status/settle once the bound above is hit. */
export const HOST_EXECUTOR_DRAIN_REQUEST_IDS = 8_192;

/** Upper bound on invocations admitted in one run. */
export const HOST_EXECUTOR_MAX_INVOCATIONS = 1_024;
export const HOST_EXECUTOR_MAX_TIMEOUT_MS = 4_740_000;

const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONNECTIONS = 16;
export const HOST_EXECUTOR_DEFAULT_STATUS_LEASE_MS = 15_000;

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
}

class RequestRejection extends Error {
  constructor(readonly code: HostExecutorError) {
    super(code);
  }
}

function assertAbsoluteDirectory(name: string, value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`Host executor run state ${name} must be a normalized absolute path`);
  }
  return value;
}

function validateRunState(runState: HostExecutorRunState): HostExecutorRunState {
  if (!HOST_EXECUTOR_ID_PATTERN.test(runState.runId)) {
    throw new Error('Host executor run state has an invalid run ID');
  }
  const seedsDir = assertAbsoluteDirectory('seedsDir', runState.seedsDir);
  const invocationsDir = assertAbsoluteDirectory('invocationsDir', runState.invocationsDir);
  const entryIds = new Set<string>();
  const entries = runState.entries.map((entry) => {
    if (!HOST_EXECUTOR_ENTRY_ID_PATTERN.test(entry.entryId) || entryIds.has(entry.entryId)) {
      throw new Error('Host executor run state has an invalid or duplicate entry ID');
    }
    entryIds.add(entry.entryId);
    if (!(HOST_EXECUTOR_KINDS as readonly string[]).includes(entry.executorKind)
      || (entry.dynamicAgents && entry.executorKind !== 'agent')
      || !Number.isSafeInteger(entry.timeoutMs)
      || entry.timeoutMs < 1
      || entry.timeoutMs > HOST_EXECUTOR_MAX_TIMEOUT_MS) {
      throw new Error('Host executor run state has an unsupported entry policy');
    }
    for (const seedId of entry.staticSeedIds) {
      if (!HOST_EXECUTOR_ID_PATTERN.test(seedId)) {
        throw new Error('Host executor run state has an invalid seed ID');
      }
    }
    return Object.freeze({
      entryId: entry.entryId,
      executorKind: entry.executorKind,
      timeoutMs: entry.timeoutMs,
      staticSeedIds: Object.freeze([...entry.staticSeedIds]),
      dynamicAgents: entry.dynamicAgents === true,
    });
  });
  return Object.freeze({
    runId: runState.runId,
    seedsDir,
    invocationsDir,
    ...(runState.journalDir === undefined ? {} : {
      journalDir: assertAbsoluteDirectory('journalDir', runState.journalDir),
    }),
    entries: Object.freeze(entries),
  });
}

function childPath(parent: string, name: string): string {
  const joined = path.join(parent, name);
  if (path.dirname(joined) !== parent || path.basename(joined) !== name) {
    throw new RequestRejection('denied');
  }
  return joined;
}

/**
 * Derives the closed invocation plan from trusted run state. Returns a
 * `denied` rejection for any request the trusted policy does not admit.
 */
export function deriveHostExecutorInvocationPlan(
  runState: HostExecutorRunState,
  request: HostExecutorInvokeRequest,
): HostExecutorInvocationPlan {
  if (request.runId !== runState.runId) throw new RequestRejection('denied');
  const entry = runState.entries.find(({ entryId }) => entryId === request.entryId);
  if (!entry || entry.executorKind !== request.executorKind) throw new RequestRejection('denied');

  const plan: {
    -readonly [K in keyof HostExecutorInvocationPlan]: HostExecutorInvocationPlan[K];
  } = {
    runId: runState.runId,
    entryId: entry.entryId,
    invocationId: request.invocationId,
    executorKind: request.executorKind,
    timeoutMs: entry.timeoutMs,
    requestHash: hostExecutorInvokeHash(request),
    admissionId: request.admissionId,
    schemaHash: request.schemaHash,
    schema: request.schema,
    payload: request.payload,
    invocationHostDir: childPath(
      childPath(runState.invocationsDir, entry.entryId),
      request.invocationId,
    ),
  };
  if (request.seedId !== undefined) {
    if (!entry.staticSeedIds.includes(request.seedId)) throw new RequestRejection('denied');
    plan.seedId = request.seedId;
    plan.seedHostPath = childPath(runState.seedsDir, request.seedId);
  } else {
    if (request.executorKind !== 'agent' || !entry.dynamicAgents || request.selector === undefined) {
      throw new RequestRejection('denied');
    }
    plan.selector = request.selector;
  }
  return Object.freeze(plan);
}

function prepareRuntimeDir(runtimeDir: string): void {
  assertAbsoluteDirectory('runtimeDir', runtimeDir);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(runtimeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Host executor runtime directory must be a real directory');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Host executor runtime directory must be owned by the AWF control process');
  }
  fs.chmodSync(runtimeDir, 0o700);
}

function writeCapabilityFile(target: string, capability: Buffer): void {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(target, flags, 0o600);
  try {
    fs.writeSync(fd, capability.toString('hex'));
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Starts the per-run host executor listener. Fails closed if the socket or
 * capability file already exists instead of reusing or replacing them.
 */
export async function startHostExecutorServer(options: HostExecutorServerOptions): Promise<HostExecutorServer> {
  const runState = validateRunState(options.runState);
  const { backend } = options;
  const runtimeDir = options.runtimeDir;
  prepareRuntimeDir(runtimeDir);
  const socketPath = path.join(runtimeDir, HOST_EXECUTOR_SOCKET_NAME);
  const capabilityPath = path.join(runtimeDir, HOST_EXECUTOR_CAPABILITY_NAME);
  if (fs.existsSync(socketPath) || fs.existsSync(capabilityPath)) {
    throw new Error('Host executor socket or capability already exists for this run');
  }
  const statusLeaseMs = options.statusLeaseMs ?? HOST_EXECUTOR_DEFAULT_STATUS_LEASE_MS;
  if (!Number.isSafeInteger(statusLeaseMs) || statusLeaseMs < 1 || statusLeaseMs > 60_000) {
    throw new Error('Host executor status lease must be between 1 and 60000 milliseconds');
  }
  const journalDir = hostExecutorJournalDirectory(runState);
  const resolvedRuntimeDir = fs.realpathSync(runtimeDir);
  if (journalDir === resolvedRuntimeDir ||
    journalDir.startsWith(`${resolvedRuntimeDir}${path.sep}`) ||
    resolvedRuntimeDir.startsWith(`${journalDir}${path.sep}`)) {
    throw new Error('Host executor journal must be separate from the broker runtime directory');
  }
  const journal = new HostExecutorJournal(runState);

  const capability = generateHostExecutorCapability();
  writeCapabilityFile(capabilityPath, capability);

  const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  const seenRequestIds = new Set<string>();
  const invocations = new Map<string, InvocationRecord>();
  const admissionIds = new Set<string>();
  const invocationIds = new Set<string>();
  const sockets = new Set<net.Socket>();
  let admissionsOpen = true;
  let closing = false;
  let closePromise: Promise<void> | undefined;

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

  const finish = (record: InvocationRecord, outcome: HostExecutorOutcome, result?: string): void => {
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
    if (finalOutcome === 'executor-failure') {
      admissionsOpen = false;
      for (const other of invocations.values()) interrupt(other, 'cancelled');
    }
  };

  const interrupt = (record: InvocationRecord, outcome: 'cancelled' | 'timeout'): void => {
    if (record.state !== 'running') return;
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
    record.deadline = setTimeout(() => interrupt(record, 'timeout'), plan.timeoutMs);
    record.deadline.unref();
    renewLease(record);
    const cleanupFailed = (): void => {
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
      .then(() => backend.execute(plan, controller.signal))
      .then(
        (outcome) => {
          if (outcome?.cleanupComplete === false) {
            cleanupFailed();
          } else if (outcome && isValidHostExecutorResult(outcome.outcome, outcome.result)) {
            finish(record, outcome.outcome, outcome.result);
          } else {
            finish(record, 'executor-failure');
          }
        },
        cleanupFailed,
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
      if (!(error instanceof RequestRejection)) {
        admissionsOpen = false;
        for (const record of invocations.values()) interrupt(record, 'cancelled');
      }
      return fail(error instanceof RequestRejection ? error.code : 'denied');
    }
  };

  const processFrame = (payload: Buffer): Buffer => {
    if (closing) return canonicalDeniedResponse();
    const decoded = decodeHostExecutorRequest(payload, { capability, runId: runState.runId });
    if (!decoded.ok) return canonicalDeniedResponse();
    return encodeHostExecutorResponse(handle(decoded.request));
  };

  const onConnection = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setTimeout(connectionTimeoutMs, () => socket.destroy());

    const chunks: Buffer[] = [];
    let received = 0;
    let expected = -1;
    let answered = false;

    const respond = (payload: Buffer): void => {
      if (answered) return;
      answered = true;
      socket.removeListener('data', onData);
      socket.end(frameHostExecutorMessage(payload), () => socket.destroy());
    };

    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      chunks.push(chunk);
      if (expected < 0 && received >= HOST_EXECUTOR_FRAME_HEADER_BYTES) {
        expected = Buffer.concat(chunks).readUInt32BE(0);
        if (expected === 0 || expected > HOST_EXECUTOR_MAX_REQUEST_BYTES) {
          respond(canonicalDeniedResponse());
          return;
        }
      }
      if (expected < 0) return;
      const total = HOST_EXECUTOR_FRAME_HEADER_BYTES + expected;
      if (received > total) {
        // Exactly one request per connection; trailing bytes are a violation.
        respond(canonicalDeniedResponse());
        return;
      }
    };

    const onEnd = (): void => {
      if (answered) return;
      if (expected < 0 || received !== HOST_EXECUTOR_FRAME_HEADER_BYTES + expected) {
        respond(canonicalDeniedResponse());
        return;
      }
      const frame = Buffer.concat(chunks);
      respond(processFrame(frame.subarray(HOST_EXECUTOR_FRAME_HEADER_BYTES)));
    };

    socket.on('data', onData);
    socket.on('end', onEnd);
  };

  const server = net.createServer({ allowHalfOpen: true }, onConnection);
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
  } catch (error) {
    capability.fill(0);
    fs.rmSync(capabilityPath, { force: true });
    server.close();
    throw error;
  }

  return {
    socketPath,
    capabilityPath,
    closeAdmissions(): void {
      admissionsOpen = false;
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      admissionsOpen = false;
      for (const record of invocations.values()) {
        interrupt(record, 'cancelled');
      }
      closePromise = (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        });
        await Promise.all([...invocations.values()].map((record) => record.completion));
        try {
          await backend.close?.();
          journal.record({ state: 'closed' });
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
