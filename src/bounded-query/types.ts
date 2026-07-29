/**
 * Runtime (non-protocol) types for the bounded-query subsystem.
 *
 * The request/result wire protocol lives in `./protocol.ts`; this module
 * describes the host-side staging output and the seed map the trusted broker
 * consumes.
 */

import type { BoundedQuerySensitivity } from '../types/bounded-query-options';

/**
 * Version of the on-disk seed-map document.
 *
 * v2 adds trusted `sensitivity` metadata to every entry (see
 * {@link BoundedQuerySeedMap}) so the broker can derive each repository's
 * per-run information budget without trusting anything the agent sends.
 */
export const BOUNDED_QUERY_SEED_MAP_VERSION = 2;

/** One staged, immutable repository seed. */
export interface BoundedQuerySeed {
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
  sensitivity: BoundedQuerySensitivity;
}

/**
 * The document written to `<workDir>/bounded-queries/seed-map.json` and mounted
 * read-only into the broker.
 *
 * It intentionally contains only what the broker needs: the mapping from a
 * normalized repo id to an AWF-chosen opaque seed directory name plus its
 * trusted sensitivity, and the run id used for container labelling/orphan
 * cleanup. No credentials, no absolute host paths, and no caller-controllable
 * fields — in particular, `sensitivity` is trusted AWF configuration state
 * that a query request can never choose or override.
 */
export interface BoundedQuerySeedMap {
  version: typeof BOUNDED_QUERY_SEED_MAP_VERSION;
  runId: string;
  seeds: Array<{ repo: string; seedId: string; sensitivity: BoundedQuerySensitivity }>;
}

/** Result of the trusted host staging phase. */
export interface BoundedQueryStagingResult {
  runId: string;
  seeds: BoundedQuerySeed[];
}
