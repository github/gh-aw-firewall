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

/**
 * Validates that the given file descriptor refers to a pipe (FIFO) that is
 * open for writing. Throws a descriptive error otherwise.
 *
 * This must be called — and must succeed — before the agent container
 * starts. A regular file, a symlink target, a directory, or a closed
 * descriptor are all rejected: only an anonymous pipe held by the trusted
 * caller is accepted.
 */
export function validateGuardResultFd(fd: number): void {
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
  if (!input.snapshots) return unconfirmed('no_proxy_snapshot_available');

  const [a, b] = input.snapshots;

  if (a.proxy_id !== b.proxy_id) return unconfirmed('proxy_id_mismatch');
  if (
    a.local_ai_credits_limit_rejections !== b.local_ai_credits_limit_rejections ||
    a.upstream_403_count !== b.upstream_403_count ||
    a.final_event !== b.final_event ||
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
 * Writes the guard result to the given file descriptor and closes it.
 *
 * Handles partial writes (pipes can accept less than the full buffer in a
 * single write) by looping until the whole payload has been written. Never
 * throws — a failure to deliver the result must not crash AWF's own exit
 * path; the caller simply never receives a result and must treat that as
 * unconfirmed, per the documented trust rules.
 */
export function writeGuardResult(fd: number, result: GuardResult): void {
  try {
    const buffer = Buffer.from(serializeGuardResult(result), 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
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
