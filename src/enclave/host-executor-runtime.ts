import * as fs from 'fs';
import * as path from 'path';
import { HostExecutorJournal, hostExecutorJournalDirectory } from './host-executor-journal';
import {
  HostExecutorControlDiagnostics,
  type HostExecutorControlPhase,
} from './host-executor-diagnostics';
import {
  HOST_EXECUTOR_ENTRY_ID_PATTERN,
  HOST_EXECUTOR_ID_PATTERN,
  HOST_EXECUTOR_KINDS,
  generateHostExecutorCapability,
  hostExecutorInvokeHash,
  type HostExecutorError,
  type HostExecutorInvokeRequest,
} from './host-executor-protocol';
import type {
  HostExecutorInvocationPlan,
  HostExecutorRunState,
  HostExecutorServerOptions,
} from './host-executor-server';

export const HOST_EXECUTOR_SOCKET_NAME = 'executor.sock';
export const HOST_EXECUTOR_CAPABILITY_NAME = 'capability';
export const HOST_EXECUTOR_MAX_TIMEOUT_MS = 4_740_000;
export const HOST_EXECUTOR_DEFAULT_STATUS_LEASE_MS = 15_000;

export class RequestRejection extends Error {
  constructor(readonly code: HostExecutorError, readonly diagnosticPhase?: HostExecutorControlPhase) {
    super(code);
  }
}

function assertAbsoluteDirectory(name: string, value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`Host executor run state ${name} must be a normalized absolute path`);
  }
  return value;
}

export function validateRunState(runState: HostExecutorRunState): HostExecutorRunState {
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
    throw new RequestRejection('denied', 'plan-path');
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
  if (request.runId !== runState.runId) throw new RequestRejection('denied', 'plan-run-identity');
  const entry = runState.entries.find(({ entryId }) => entryId === request.entryId);
  if (!entry || entry.executorKind !== request.executorKind) throw new RequestRejection('denied', 'plan-entry-policy');

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
    if (!entry.staticSeedIds.includes(request.seedId)) throw new RequestRejection('denied', 'plan-static-seed');
    plan.seedId = request.seedId;
    plan.seedHostPath = childPath(runState.seedsDir, request.seedId);
  } else {
    if (request.executorKind !== 'agent' || !entry.dynamicAgents || request.selector === undefined) {
      throw new RequestRejection('denied', 'plan-selector-policy');
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

export function prepareHostExecutorRuntime(options: Pick<
  HostExecutorServerOptions, 'runState' | 'runtimeDir' | 'statusLeaseMs'
>) {
  const runState = validateRunState(options.runState);
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
  const diagnostics = new HostExecutorControlDiagnostics(runState);
  const capability = generateHostExecutorCapability();
  writeCapabilityFile(capabilityPath, capability);

  return { runState, socketPath, capabilityPath, statusLeaseMs, journal, diagnostics, capability };
}
