import type { AwfFileConfig } from '../config-file';
import { logger } from '../logger';
import {
  BOUNDED_QUERY_DEFAULTS,
  type BoundedQueryRepository,
  type BoundedQueriesConfig,
} from '../types/bounded-query-options';

/** Sensitivity legacy bare-string `privateRepos` entries are normalized to. */
const LEGACY_REPO_DEFAULT_SENSITIVITY = 'internal';

type RawPrivateRepoEntry = NonNullable<AwfFileConfig['boundedQueries']>['privateRepos'] extends
  | Array<infer T>
  | undefined
  ? T
  : never;

/**
 * Normalizes one `privateRepos` entry to a {@link BoundedQueryRepository}.
 *
 * A bare string is a one-release compatibility path: it is accepted and
 * normalized to `{ repo, sensitivity: 'internal' }`, with a warning, so
 * existing configs keep working for one release while they migrate to the
 * explicit object form. `warn` is injectable so callers (and tests) can
 * observe/suppress it without depending on the process-wide logger.
 */
function normalizePrivateRepoEntry(
  entry: RawPrivateRepoEntry,
  warn: (message: string) => void,
): BoundedQueryRepository {
  if (typeof entry === 'string') {
    warn(
      `boundedQueries.privateRepos entry "${entry}" is a legacy bare string. It is being normalized to ` +
      `{ repo: "${entry}", sensitivity: "${LEGACY_REPO_DEFAULT_SENSITIVITY}" } for this release only. ` +
      'Update your AWF configuration to the explicit object form before the next release, when this ' +
      'compatibility path is removed.',
    );
    return { repo: entry, sensitivity: LEGACY_REPO_DEFAULT_SENSITIVITY };
  }
  return { repo: entry.repo, sensitivity: entry.sensitivity };
}

export interface NormalizeBoundedQueriesConfigOptions {
  /** Overrides how legacy-string-entry warnings are emitted. Defaults to `logger.warn`. */
  warn?: (message: string) => void;
}

/**
 * Normalizes the raw `boundedQueries` section of an AWF config file into a
 * fully-resolved {@link BoundedQueriesConfig}, applying
 * {@link BOUNDED_QUERY_DEFAULTS} for any field left unset.
 *
 * By the time this runs, `raw` has already passed schema validation
 * (`validateAwfFileConfig` / docs/awf-config.schema.json), so bounds,
 * enums, and the "enabled requires non-empty privateRepos" rule are assumed
 * to already hold. This function only fills in defaults and normalizes the
 * legacy-string `privateRepos` compatibility path — it does not re-validate
 * repository shape, uniqueness, or sensitivity (see
 * `src/bounded-query/preflight.ts` for the fail-closed checks that require
 * comparing multiple entries at once).
 *
 * Returns `undefined` when `raw` is `undefined`, i.e. the config file did
 * not include a `boundedQueries` section at all. When the section is present
 * (even as `{}`), a fully-defaulted config is always returned.
 */
export function normalizeBoundedQueriesConfig(
  raw: AwfFileConfig['boundedQueries'] | undefined,
  options: NormalizeBoundedQueriesConfigOptions = {},
): BoundedQueriesConfig | undefined {
  if (!raw) return undefined;

  const warn = options.warn ?? ((message: string) => logger.warn(message));
  const privateRepos: BoundedQueryRepository[] = (raw.privateRepos ?? []).map((entry) =>
    normalizePrivateRepoEntry(entry, warn),
  );

  return {
    // Only an explicit `true` enables bounded queries; anything else (including
    // omission) normalizes to disabled.
    enabled: raw.enabled === true,
    privateRepos,
    runtime: raw.runtime ?? BOUNDED_QUERY_DEFAULTS.runtime,
    timeout: raw.timeout ?? BOUNDED_QUERY_DEFAULTS.timeout,
    memoryLimit: raw.memoryLimit ?? BOUNDED_QUERY_DEFAULTS.memoryLimit,
    interpreter: raw.interpreter ?? BOUNDED_QUERY_DEFAULTS.interpreter,
    maxInvocations: raw.maxInvocations ?? BOUNDED_QUERY_DEFAULTS.maxInvocations,
  };
}
