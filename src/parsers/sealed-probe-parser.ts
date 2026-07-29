import type { AwfFileConfig } from '../config-file';
import { logger } from '../logger';
import {
  SEALED_PROBE_DEFAULTS,
  type SealedProbeRepository,
  type SealedProbesConfig,
} from '../types/sealed-probe-options';

/** Sensitivity legacy bare-string `privateRepos` entries are normalized to. */
const LEGACY_REPO_DEFAULT_SENSITIVITY = 'internal';

type RawPrivateRepoEntry = NonNullable<AwfFileConfig['sealedProbes']>['privateRepos'] extends
  | Array<infer T>
  | undefined
  ? T
  : never;

/**
 * Normalizes one `privateRepos` entry to a {@link SealedProbeRepository}.
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
): SealedProbeRepository {
  if (typeof entry === 'string') {
    warn(
      `sealedProbes.privateRepos entry "${entry}" is a legacy bare string. It is being normalized to ` +
      `{ repo: "${entry}", sensitivity: "${LEGACY_REPO_DEFAULT_SENSITIVITY}" } for this release only. ` +
      'Update your AWF configuration to the explicit object form before the next release, when this ' +
      'compatibility path is removed.',
    );
    return { repo: entry, sensitivity: LEGACY_REPO_DEFAULT_SENSITIVITY };
  }
  return { repo: entry.repo, sensitivity: entry.sensitivity };
}

export interface NormalizeSealedProbesConfigOptions {
  /** Overrides how legacy-string-entry warnings are emitted. Defaults to `logger.warn`. */
  warn?: (message: string) => void;
}

/**
 * Normalizes the raw `sealedProbes` section of an AWF config file into a
 * fully-resolved {@link SealedProbesConfig}, applying
 * {@link SEALED_PROBE_DEFAULTS} for any field left unset.
 *
 * By the time this runs, `raw` has already passed schema validation
 * (`validateAwfFileConfig` / docs/awf-config.schema.json), so bounds,
 * enums, and the "enabled requires non-empty privateRepos" rule are assumed
 * to already hold. This function only fills in defaults and normalizes the
 * legacy-string `privateRepos` compatibility path — it does not re-validate
 * repository shape, uniqueness, or sensitivity (see
 * `src/sealed-probe/preflight.ts` for the fail-closed checks that require
 * comparing multiple entries at once).
 *
 * Returns `undefined` when `raw` is `undefined`, i.e. the config file did
 * not include a `sealedProbes` section at all. When the section is present
 * (even as `{}`), a fully-defaulted config is always returned.
 */
export function normalizeSealedProbesConfig(
  raw: AwfFileConfig['sealedProbes'] | undefined,
  options: NormalizeSealedProbesConfigOptions = {},
): SealedProbesConfig | undefined {
  if (!raw) return undefined;

  const warn = options.warn ?? ((message: string) => logger.warn(message));
  const privateRepos: SealedProbeRepository[] = (raw.privateRepos ?? []).map((entry) =>
    normalizePrivateRepoEntry(entry, warn),
  );

  return {
    // Only an explicit `true` enables sealed probes; anything else (including
    // omission) normalizes to disabled.
    enabled: raw.enabled === true,
    privateRepos,
    runtime: raw.runtime ?? SEALED_PROBE_DEFAULTS.runtime,
    timeout: raw.timeout ?? SEALED_PROBE_DEFAULTS.timeout,
    memoryLimit: raw.memoryLimit ?? SEALED_PROBE_DEFAULTS.memoryLimit,
    interpreter: raw.interpreter ?? SEALED_PROBE_DEFAULTS.interpreter,
    maxInvocations: raw.maxInvocations ?? SEALED_PROBE_DEFAULTS.maxInvocations,
  };
}
