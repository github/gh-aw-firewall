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
   * Private repositories (in `owner/repo` form) the sealed-probe broker is
   * permitted to fetch source from. Required to be non-empty and unique
   * (enforced by the schema) whenever `enabled` is `true`.
   *
   * @default []
   */
  privateRepos: string[];

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
