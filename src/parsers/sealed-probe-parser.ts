import type { AwfFileConfig } from '../config-file';
import { SEALED_PROBE_DEFAULTS, type SealedProbesConfig } from '../types/sealed-probe-options';

/**
 * Normalizes the raw `sealedProbes` section of an AWF config file into a
 * fully-resolved {@link SealedProbesConfig}, applying
 * {@link SEALED_PROBE_DEFAULTS} for any field left unset.
 *
 * By the time this runs, `raw` has already passed schema validation
 * (`validateAwfFileConfig` / docs/awf-config.schema.json), so bounds,
 * enums, and the "enabled requires non-empty unique privateRepos" rule are
 * assumed to already hold. This function only fills in defaults — it does
 * not re-validate.
 *
 * Returns `undefined` when `raw` is `undefined`, i.e. the config file did
 * not include a `sealedProbes` section at all. When the section is present
 * (even as `{}`), a fully-defaulted config is always returned.
 */
export function normalizeSealedProbesConfig(
  raw: AwfFileConfig['sealedProbes'] | undefined,
): SealedProbesConfig | undefined {
  if (!raw) return undefined;

  return {
    // Only an explicit `true` enables sealed probes; anything else (including
    // omission) normalizes to disabled.
    enabled: raw.enabled === true,
    privateRepos: raw.privateRepos ? [...new Set(raw.privateRepos)] : [],
    runtime: raw.runtime ?? SEALED_PROBE_DEFAULTS.runtime,
    timeout: raw.timeout ?? SEALED_PROBE_DEFAULTS.timeout,
    memoryLimit: raw.memoryLimit ?? SEALED_PROBE_DEFAULTS.memoryLimit,
    interpreter: raw.interpreter ?? SEALED_PROBE_DEFAULTS.interpreter,
    maxInvocations: raw.maxInvocations ?? SEALED_PROBE_DEFAULTS.maxInvocations,
  };
}
