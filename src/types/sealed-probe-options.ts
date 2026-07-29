/**
 * Sealed-probe sandbox configuration types.
 *
 * This is the configuration/protocol foundation only. It defines the shape
 * of `sealedProbes` config, its normalized runtime representation, and the
 * centralized defaults applied when a field is not explicitly set. No
 * broker or sandbox runtime is implemented yet — see docs/awf-config-spec.md
 * §14 and src/sealed-probe/protocol.ts for the request/result protocol.
 */

/** Sandbox runtime backends supported for sealed-probe execution. */
export type SealedProbeRuntime = 'docker' | 'gvisor';

/** Script interpreters supported for sealed-probe execution. */
export type SealedProbeInterpreter = 'python3';

/**
 * Repository confidentiality categories.
 *
 * Each category has a fixed, immutable maximum number of bits the broker may
 * reveal about that repository across an entire AWF run (not per query — see
 * {@link SEALED_PROBE_SENSITIVITY_RUN_BITS}). Users select a category; they
 * cannot raise its numeric limit. A future release may add a *reducing*
 * numeric override, but no category may ever be granted more than its listed
 * maximum.
 */
export type SealedProbeSensitivity = 'public' | 'internal' | 'confidential' | 'sealed';

/** Every supported sensitivity value, for schema/validation enumeration. */
export const SEALED_PROBE_SENSITIVITIES: readonly SealedProbeSensitivity[] = [
  'public',
  'internal',
  'confidential',
  'sealed',
];

/**
 * Immutable per-repository run-budget table.
 *
 * `null` means "unmetered": `public` still runs through the same finite
 * schema/result validation and operational limits (`maxInvocations`,
 * timeouts, sandboxing) as every other category, but its responses are not
 * debited against a confidentiality ledger. `sealed` is `0`, which — because
 * every accepted query's minimum charge is 4 bits (1 error bit + 3 timing
 * bits) — always exceeds the remaining balance, so a `sealed` repository can
 * never fund a single query and therefore never copies a seed or launches
 * Python.
 *
 * The scope of this budget is one AWF run: the broker has no durable
 * identity or storage across runs, so this is deliberately not a
 * "lifetime" budget.
 */
export const SEALED_PROBE_SENSITIVITY_RUN_BITS: Readonly<Record<SealedProbeSensitivity, number | null>> = {
  public: null,
  internal: 64,
  confidential: 8,
  sealed: 0,
};

/**
 * A trusted, per-repository descriptor.
 *
 * `sensitivity` is supplied only in AWF configuration (never in an agent
 * request) and flows unmodified into the seed map the broker reads — the
 * agent cannot choose or override it.
 */
export interface SealedProbeRepository {
  /** Repository slug in `owner/repo` form, exactly as configured. */
  repo: string;
  /** Confidentiality category, which fixes this repository's run budget. */
  sensitivity: SealedProbeSensitivity;
}

/**
 * Fully-normalized sealed-probe configuration, with every field resolved to
 * an explicit value ({@link SEALED_PROBE_DEFAULTS} applied where the AWF
 * config file left a field unset).
 */
export interface SealedProbesConfig {
  /**
   * Whether sealed probes are enabled for this run.
   *
   * Only ever `true` when the config file explicitly set `enabled: true`;
   * any other value (including omission) normalizes to `false`.
   *
   * @default false
   */
  enabled: boolean;

  /**
   * Private repositories the sealed-probe broker is permitted to fetch
   * source from, each with its trusted confidentiality category. Required to
   * be non-empty and unique (case-insensitively, enforced by preflight)
   * whenever `enabled` is `true`.
   *
   * Legacy bare-string entries in the AWF config file are normalized to
   * `{ repo, sensitivity: 'internal' }` with a warning (one-release
   * compatibility) — by the time a {@link SealedProbesConfig} exists, every
   * entry is already an object.
   *
   * @default []
   */
  privateRepos: SealedProbeRepository[];

  /**
   * Sandbox runtime backend used to execute the probe script.
   *
   * @default 'docker'
   */
  runtime: SealedProbeRuntime;

  /**
   * Maximum wall-clock time, in seconds, allowed for a single probe
   * invocation.
   *
   * @default 30
   */
  timeout: number;

  /**
   * Docker-style memory limit applied to the probe sandbox (e.g. `"512m"`,
   * `"1g"`).
   *
   * @default '512m'
   */
  memoryLimit: string;

  /**
   * Script interpreter used to run the probe. Only `'python3'` is currently
   * supported.
   *
   * @default 'python3'
   */
  interpreter: SealedProbeInterpreter;

  /**
   * Maximum number of probe invocations permitted for the current AWF run.
   *
   * @default 32
   */
  maxInvocations: number;
}

/**
 * Centralized defaults for {@link SealedProbesConfig}. Single source of
 * truth for the normalizer (`src/parsers/sealed-probe-parser.ts`), the
 * config schema (`docs/awf-config.schema.json`), and documentation.
 */
export const SEALED_PROBE_DEFAULTS: Readonly<
  Pick<SealedProbesConfig, 'enabled' | 'runtime' | 'timeout' | 'memoryLimit' | 'interpreter' | 'maxInvocations'>
> = {
  enabled: false,
  runtime: 'docker',
  timeout: 30,
  memoryLimit: '512m',
  interpreter: 'python3',
  maxInvocations: 32,
};

export interface SealedProbeOptions {
  /**
   * Normalized sealed-probe sandbox configuration.
   *
   * `undefined` when the AWF config file did not include a `sealedProbes`
   * section at all. Present (with defaults applied) whenever the section
   * was included, regardless of whether `enabled` is `true`.
   *
   * @default undefined
   */
  sealedProbes?: SealedProbesConfig;
}
