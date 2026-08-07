/**
 * Runtime descriptors for trusted private-repository staging.
 *
 * The request/result wire protocol lives in `./finite-disclosure.ts`; this module
 * describes the host-side staging output and the seed map the trusted broker
 * consumes.
 */

import type { EnclaveSensitivity } from '../types/enclave-options';

/**
 * Version of the on-disk seed-map document.
 *
 * v2 adds trusted `sensitivity` metadata to every entry (see
 * {@link PrivateRepositorySeedMap}) so the server can derive each repository's
 * per-run information budget without trusting anything the agent sends.
 */
export const PRIVATE_REPOSITORY_SEED_MAP_VERSION = 2;

/** One staged, immutable repository seed. */
export interface PrivateRepositorySeedDescriptor {
  /** Normalized (lowercased) `owner/repo` lookup key. */
  repoKey: string;
  /** Repository slug exactly as configured, used for clone-URL construction. */
  repo: string;
  /** Opaque directory name of the seed under the seeds root. */
  seedId: string;
  /** Absolute host path of the immutable seed directory. */
  seedPath: string;
  /** Commit the seed was materialized at, recorded for protected audit state. */
  commit: string;
  /** Trusted confidentiality category, carried unmodified into the seed map. */
  sensitivity: EnclaveSensitivity;
}

/**
 * The document written to the dedicated broker-private host root and mounted
 * read-only into the broker.
 *
 * It intentionally contains only what the broker needs: the mapping from a
 * normalized repo id to an AWF-chosen opaque seed directory name plus its
 * trusted sensitivity, and the run id used for container labelling/orphan
 * cleanup. No credentials, no absolute host paths, and no caller-controllable
 * fields — in particular, `sensitivity` is trusted AWF configuration state
 * that a query request can never choose or override.
 */
export interface PrivateRepositorySeedMap {
  version: typeof PRIVATE_REPOSITORY_SEED_MAP_VERSION;
  runId: string;
  seeds: Array<{ repo: string; seedId: string; sensitivity: EnclaveSensitivity }>;
}

/** Result of the trusted host staging phase. */
export interface PrivateRepositoryStagingResult {
  runId: string;
  seeds: PrivateRepositorySeedDescriptor[];
}

/** Canonical lookup key shared by staging, admission, and budget accounting. */
export function normalizePrivateRepositoryKey(repo: string): string {
  return repo.trim().toLowerCase();
}

/** Canonically serializes the protected broker seed map. */
export function serializePrivateRepositorySeedMap(seedMap: PrivateRepositorySeedMap): string {
  return JSON.stringify(seedMap, null, 2) + '\n';
}
