/**
 * Runtime (non-protocol) types for the sealed-probe subsystem.
 *
 * The request/result wire protocol lives in `./protocol.ts`; this module
 * describes the host-side staging output and the seed map the trusted broker
 * consumes.
 */

/** Version of the on-disk seed-map document. */
export const SEALED_PROBE_SEED_MAP_VERSION = 1;

/** One staged, immutable repository seed. */
export interface SealedProbeSeed {
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
}

/**
 * The document written to `<workDir>/sealed-probes/seed-map.json` and mounted
 * read-only into the broker.
 *
 * It intentionally contains only what the broker needs: the mapping from a
 * normalized repo id to an AWF-chosen opaque seed directory name, plus the
 * run id used for container labelling/orphan cleanup. No credentials, no
 * absolute host paths, and no caller-controllable fields.
 */
export interface SealedProbeSeedMap {
  version: typeof SEALED_PROBE_SEED_MAP_VERSION;
  runId: string;
  seeds: Array<{ repo: string; seedId: string }>;
}

/** Result of the trusted host staging phase. */
export interface SealedProbeStagingResult {
  runId: string;
  seeds: SealedProbeSeed[];
}
