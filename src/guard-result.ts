import * as fs from 'fs';

/**
 * AWF Guard Result Channel — types and pure logic for the authoritative
 * post-run guard result delivered to a trusted caller over an anonymous pipe.
 *
 * See docs: the caller creates a pipe, passes the write-end file descriptor
 * number via `AWF_GUARD_RESULT_FD`, and keeps the read end. AWF validates the
 * descriptor before starting the agent, gathers evidence from the API proxy
 * after the agent exits but before the proxy container is removed, and writes
 * one JSON result to the pipe after cleanup has been verified.
 *
 * There is no result *file* — nothing the agent can forge, redirect, or
 * replace with a symlink. If the environment variable is absent, AWF behaves
 * exactly as it does without this feature. If it is present but invalid, AWF
 * fails before the agent starts.
 */

/** Bumped whenever the shape of {@link GuardResult} changes in an incompatible way. */
export const GUARD_RESULT_SCHEMA_VERSION = 1;

/** Name of the environment variable carrying the write-end file descriptor number. */
export const GUARD_RESULT_FD_ENV_VAR = 'AWF_GUARD_RESULT_FD';

/** Classification of the final guard-relevant event observed by the API proxy. */
export type GuardFinalEvent = 'local_ai_credits_limit' | 'upstream_403' | null;

/**
 * A single point-in-time snapshot of the API proxy's guard-result state,
 * as returned by the `/guard-snapshot` management endpoint.
 */
export interface GuardSnapshot {
  proxy_id: string;
  generated_at: number;
  /** Number of in-flight requests at the moment this snapshot was taken. */
  active_requests: number;
  local_ai_credits_limit_rejections: number;
  upstream_403_count: number;
  final_event: GuardFinalEvent;
  final_event_at: number | null;
  ai_credits_total: number;
  ai_credits_max: number | null;
}

/** Overall classification of the run written to the guard result pipe. */
export type GuardResultClassification = 'confirmed_budget_stop' | 'unconfirmed';

/** The single JSON object written to the caller-owned result pipe. */
export interface GuardResult {
  schema_version: number;
  awf_invocation_id: string;
  proxy_id: string | null;
  classification: GuardResultClassification;
  reason: string;
  agent_exit_code: number | null;
  cleanup_succeeded: boolean;
  ai_credits_total: number | null;
  ai_credits_max: number | null;
  final_event: GuardFinalEvent;
  local_ai_credits_limit_rejections: number | null;
  upstream_403_count: number | null;
  generated_at: number;
}

/**
 * Resolves the guard-result pipe file descriptor from the environment.
 *
 * Returns `undefined` when the variable is unset (existing behavior is
 * preserved). Throws when it is set but is not a valid non-negative integer,
 * so the caller can fail fast before starting the agent.
 */
export function resolveGuardResultFd(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[GUARD_RESULT_FD_ENV_VAR];
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${GUARD_RESULT_FD_ENV_VAR}="${raw}" is not a valid non-negative integer file descriptor`,
    );
  }
  const fd = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(fd)) {
    throw new Error(`${GUARD_RESULT_FD_ENV_VAR}="${raw}" is out of range`);
  }
  return fd;
}

/** Standard descriptors that must never be accepted as the guard result channel. */
const STANDARD_FDS = new Set([0, 1, 2]);

/** POSIX file status access-mode mask (low two bits of the open flags). */
const O_ACCMODE = 0o3;
/** POSIX `O_WRONLY` / `O_RDWR` values: both grant write access. */
const O_WRONLY = 0o1;
const O_RDWR = 0o2;

/**
 * Validates that the given file descriptor refers to a pipe (FIFO) that is
 * open for writing. Throws a descriptive error otherwise.
 *
 * This must be called — and must succeed — before the agent container
 * starts. A regular file, a symlink target, a directory, or a closed
 * descriptor are all rejected: only the write end of a pipe held by the
 * trusted caller is accepted.
 *
 * Standard descriptors (0/1/2) are rejected outright: `fstat().isFIFO()`
 * alone cannot rule out stdout/stderr being piped by the caller's shell,
 * which would let agent-controlled output share the alleged result
 * channel. The open file's access mode is also verified via
 * `/proc/self/fdinfo`, since `isFIFO()` is equally true for a FIFO's read
 * end — without this check, a caller mistake supplying the read end would
 * only be discovered after the run, once delivery silently fails.
 */
export function validateGuardResultFd(fd: number): void {
  if (STANDARD_FDS.has(fd)) {
    throw new Error(
      `${GUARD_RESULT_FD_ENV_VAR}=${fd} must not be a standard descriptor (stdin/stdout/stderr); ` +
        'supply a dedicated pipe file descriptor',
    );
  }

  let stats: fs.Stats;
  try {
    stats = fs.fstatSync(fd);
  } catch (err) {
    throw new Error(
      `${GUARD_RESULT_FD_ENV_VAR}=${fd} does not refer to an open file descriptor: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!stats.isFIFO()) {
    throw new Error(
      `${GUARD_RESULT_FD_ENV_VAR}=${fd} must be an anonymous pipe (FIFO); refusing to use a regular file, ` +
        'directory, or other descriptor type as the guard result channel',
    );
  }

  let accessMode: number;
  try {
    const fdinfo = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
    const match = /^flags:\s*(\d+)/m.exec(fdinfo);
    if (!match) throw new Error('flags field not found in fdinfo');
    accessMode = Number.parseInt(match[1], 8) & O_ACCMODE;
  } catch (err) {
    throw new Error(
      `${GUARD_RESULT_FD_ENV_VAR}=${fd} write access could not be verified: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (accessMode !== O_WRONLY && accessMode !== O_RDWR) {
    throw new Error(
      `${GUARD_RESULT_FD_ENV_VAR}=${fd} is not open for writing; the write end of the pipe must be ` +
        'supplied, not the read end',
    );
  }
}

/** Inputs needed to classify a run's outcome for the guard result. */
export interface ClassifyGuardResultInput {
  awfInvocationId: string;
  agentExitCode: number | null;
  snapshots: readonly [GuardSnapshot, GuardSnapshot] | null;
  cleanupSucceeded: boolean;
  containersRemoved: boolean;
  apiProxyEnabled: boolean;
  interrupted: boolean;
  /**
   * True when the agent container was given access to the Docker daemon
   * (`--enable-dind`). In that case the agent could tamper with the very
   * containers and snapshots this classification relies on, so the
   * evidence can never be trusted regardless of what it shows.
   */
  dockerAccessExposedToAgent: boolean;
}

/**
 * Builds the final {@link GuardResult}, applying the strict confirmation
 * rules described in the design: a budget stop is confirmed only when every
 * piece of evidence agrees and is fresh, complete, and quiescent. Anything
 * stale, malformed, incomplete, conflicting, still active, or
 * cleanup-failed remains unconfirmed.
 */
export function classifyGuardResult(input: ClassifyGuardResultInput): GuardResult {
  const generatedAt = Date.now();
  const base: Omit<GuardResult, 'classification' | 'reason' | 'proxy_id' | 'final_event' |
    'ai_credits_total' | 'ai_credits_max' | 'local_ai_credits_limit_rejections' | 'upstream_403_count'> = {
    schema_version: GUARD_RESULT_SCHEMA_VERSION,
    awf_invocation_id: input.awfInvocationId,
    agent_exit_code: input.agentExitCode,
    cleanup_succeeded: input.cleanupSucceeded,
    generated_at: generatedAt,
  };

  const unconfirmed = (reason: string): GuardResult => ({
    ...base,
    proxy_id: input.snapshots ? input.snapshots[0].proxy_id : null,
    classification: 'unconfirmed',
    reason,
    final_event: input.snapshots ? input.snapshots[1].final_event : null,
    ai_credits_total: input.snapshots ? input.snapshots[1].ai_credits_total : null,
    ai_credits_max: input.snapshots ? input.snapshots[1].ai_credits_max : null,
    local_ai_credits_limit_rejections: input.snapshots
      ? input.snapshots[1].local_ai_credits_limit_rejections
      : null,
    upstream_403_count: input.snapshots ? input.snapshots[1].upstream_403_count : null,
  });

  if (!input.apiProxyEnabled) return unconfirmed('api_proxy_not_enabled');
  if (input.interrupted) return unconfirmed('interrupted_by_signal');
  // Reject before even looking at any snapshot: if the agent had Docker
  // access, none of the evidence gathered via `docker exec`/`docker ps` can
  // be trusted, since the agent could have manipulated the containers or
  // their observed state.
  if (input.dockerAccessExposedToAgent) return unconfirmed('docker_access_exposed_to_agent');
  if (!input.snapshots) return unconfirmed('no_proxy_snapshot_available');

  const [a, b] = input.snapshots;

  if (a.proxy_id !== b.proxy_id) return unconfirmed('proxy_id_mismatch');
  // Snapshots must be genuinely time-ordered: an equal or reversed pair
  // proves nothing about the interval between them (e.g. a cached or
  // replayed response), so it cannot be used as evidence of quiescence.
  if (!(b.generated_at > a.generated_at)) return unconfirmed('snapshots_not_time_ordered');
  // Both snapshots must show zero in-flight requests: a request that is
  // still active could still change the credit total or final event after
  // this evidence was gathered.
  if (a.active_requests !== 0 || b.active_requests !== 0) {
    return unconfirmed('active_requests_not_quiescent');
  }
  if (
    a.local_ai_credits_limit_rejections !== b.local_ai_credits_limit_rejections ||
    a.upstream_403_count !== b.upstream_403_count ||
    a.final_event !== b.final_event ||
    a.final_event_at !== b.final_event_at ||
    a.ai_credits_total !== b.ai_credits_total
  ) {
    return unconfirmed('snapshots_not_quiescent');
  }
  if (!input.cleanupSucceeded) return unconfirmed('cleanup_failed');
  if (!input.containersRemoved) return unconfirmed('containers_not_removed');
  if (input.agentExitCode === null || input.agentExitCode === 0) {
    return unconfirmed('agent_exit_code_not_nonzero');
  }
  if (b.final_event !== 'local_ai_credits_limit') return unconfirmed('final_event_not_local_limit');
  // The final event's own timestamp must be internally consistent: it can
  // never postdate the snapshot that observed it, and it must be present
  // whenever a final event is reported.
  if (b.final_event_at === null || b.final_event_at > b.generated_at) {
    return unconfirmed('final_event_timestamp_invalid');
  }
  if (b.ai_credits_max === null || b.ai_credits_total < b.ai_credits_max) {
    return unconfirmed('ai_credits_below_configured_limit');
  }

  return {
    ...base,
    proxy_id: b.proxy_id,
    classification: 'confirmed_budget_stop',
    reason: 'local_ai_credits_limit_confirmed',
    final_event: b.final_event,
    ai_credits_total: b.ai_credits_total,
    ai_credits_max: b.ai_credits_max,
    local_ai_credits_limit_rejections: b.local_ai_credits_limit_rejections,
    upstream_403_count: b.upstream_403_count,
  };
}

/**
 * Serializes a {@link GuardResult} as a single JSON line (newline-terminated)
 * ready to be written to the result pipe.
 */
export function serializeGuardResult(result: GuardResult): string {
  return JSON.stringify(result) + '\n';
}

/**
 * Maximum size, in bytes, of the serialized guard result. POSIX guarantees
 * that writes of up to `PIPE_BUF` (4096 bytes on Linux) to a pipe are
 * atomic, so a payload larger than this could be interleaved with other
 * writers or observed as a partial record by the reader. The channel
 * contract is exactly one write, no larger than this limit.
 */
export const GUARD_RESULT_MAX_BYTES = 4096;

/**
 * Writes the guard result to the given file descriptor and closes it.
 *
 * Validates the serialized size against {@link GUARD_RESULT_MAX_BYTES} and
 * issues exactly one write; a short write (the pipe accepted fewer bytes
 * than requested) is treated as delivery failure rather than retried, since
 * a retry could produce two concatenated fragments the reader cannot frame.
 * Never throws — a failure to deliver the result must not crash AWF's own
 * exit path; the caller simply never receives a result and must treat that
 * as unconfirmed, per the documented trust rules.
 */
export function writeGuardResult(fd: number, result: GuardResult): void {
  try {
    const buffer = Buffer.from(serializeGuardResult(result), 'utf8');
    if (buffer.length > GUARD_RESULT_MAX_BYTES) {
      throw new Error(
        `Serialized guard result is ${buffer.length} bytes, exceeding the ${GUARD_RESULT_MAX_BYTES}-byte ` +
          'atomic-write limit for the guard result channel',
      );
    }
    const written = fs.writeSync(fd, buffer, 0, buffer.length);
    if (written !== buffer.length) {
      throw new Error(`Short write to guard result pipe: wrote ${written} of ${buffer.length} bytes`);
    }
  } catch {
    // Best-effort delivery only; see doc comment above.
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed or invalid; nothing more to do.
    }
  }
}
