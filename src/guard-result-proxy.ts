import execa from 'execa';
import { getLocalDockerEnv } from './docker-host';
import { AGENT_CONTAINER_NAME, API_PROXY_CONTAINER_NAME, SQUID_CONTAINER_NAME } from './constants';
import { GuardSnapshot } from './guard-result';

/**
 * Docker-facing helpers for the guard result channel: fetching authoritative
 * snapshots from the still-running API proxy container, and verifying that
 * every AWF-managed container has actually been removed before a result is
 * emitted.
 *
 * Kept separate from `guard-result.ts` so the pure classification logic can
 * be unit tested without a Docker daemon.
 */

/** Delay between the two snapshots captured to prove the proxy is quiescent. */
export const GUARD_SNAPSHOT_INTERVAL_MS = 150;

/**
 * Fetches a single guard-result snapshot from the API proxy's management
 * endpoint via `docker exec`, without requiring host-level network access to
 * the internal proxy network. Returns `null` on any failure (container not
 * running, endpoint unreachable, malformed response) — the caller must treat
 * a missing snapshot as evidence that cannot confirm a budget stop.
 */
export async function fetchProxyGuardSnapshot(
  containerName: string = API_PROXY_CONTAINER_NAME,
): Promise<GuardSnapshot | null> {
  try {
    const { stdout } = await execa(
      'docker',
      ['exec', containerName, 'wget', '-qO-', 'http://127.0.0.1:10000/guard-snapshot'],
      { env: getLocalDockerEnv(), timeout: 5000 },
    );
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed.proxy_id !== 'string') return null;
    return parsed as GuardSnapshot;
  } catch {
    return null;
  }
}

/**
 * Captures two closely-spaced snapshots from the still-running API proxy
 * container, used to prove the proxy was quiescent (no in-flight requests
 * changing the guard state) between the moment the agent exited and the
 * moment the proxy container is torn down.
 *
 * Returns `null` if either fetch fails.
 */
export async function captureGuardSnapshotPair(
  containerName: string = API_PROXY_CONTAINER_NAME,
  intervalMs: number = GUARD_SNAPSHOT_INTERVAL_MS,
): Promise<readonly [GuardSnapshot, GuardSnapshot] | null> {
  const first = await fetchProxyGuardSnapshot(containerName);
  if (!first) return null;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  const second = await fetchProxyGuardSnapshot(containerName);
  if (!second) return null;
  return [first, second] as const;
}

/**
 * Verifies that none of AWF's managed containers are still present after
 * cleanup. Used to confirm that the evidence gathered before teardown
 * reflects a genuinely-finished run, and that no stale container could still
 * be mutating guard state.
 */
export async function areGuardContainersRemoved(): Promise<boolean> {
  try {
    const { stdout } = await execa('docker', ['ps', '-a', '--format', '{{.Names}}'], {
      env: getLocalDockerEnv(),
    });
    const names = new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
    return (
      !names.has(API_PROXY_CONTAINER_NAME) &&
      !names.has(AGENT_CONTAINER_NAME) &&
      !names.has(SQUID_CONTAINER_NAME)
    );
  } catch {
    return false;
  }
}
