import {
  ENCLAVE_SENSITIVITIES,
  ENCLAVE_SENSITIVITY_RUN_BITS,
  type EnclaveRepository,
  type EnclaveSensitivity,
} from './enclave-options';

/**
 * Bounded-query sandbox configuration types.
 *
 * This is the configuration/protocol foundation only. It defines the shape
 * of `boundedQueries` config, its normalized runtime representation, and the
 * centralized defaults applied when a field is not explicitly set. No
 * broker or sandbox runtime is implemented yet — see docs/awf-config-spec.md
 * §14 and src/bounded-execution/finite-disclosure.ts for the request/result protocol.
 */

/** Sandbox runtime backends supported for bounded-query execution. */
export type BoundedQueryRuntime = 'docker' | 'gvisor' | 'sbx';

/** Primary-agent transport selected by trusted preflight. */
export type BoundedQueryIngressTransport = 'unix' | 'sbx-http';

/** Script interpreters supported for bounded-query execution. */
export type BoundedQueryInterpreter = 'python3';

/**
 * Repository confidentiality categories.
 *
 * Each category has a fixed, immutable maximum number of bits the broker may
 * reveal about that repository across an entire AWF run (not per query — see
 * {@link BOUNDED_QUERY_SENSITIVITY_RUN_BITS}). Users select a category; they
 * cannot raise its numeric limit. A future release may add a *reducing*
 * numeric override, but no category may ever be granted more than its listed
 * maximum.
 */
export type BoundedQuerySensitivity = EnclaveSensitivity;

/** Every supported sensitivity value, for schema/validation enumeration. */
export const BOUNDED_QUERY_SENSITIVITIES: readonly BoundedQuerySensitivity[] = ENCLAVE_SENSITIVITIES;

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
export const BOUNDED_QUERY_SENSITIVITY_RUN_BITS = ENCLAVE_SENSITIVITY_RUN_BITS;

/**
 * A trusted, per-repository descriptor.
 *
 * `sensitivity` is supplied only in AWF configuration (never in an agent
 * request) and flows unmodified into the seed map the broker reads — the
 * agent cannot choose or override it.
 */
export type BoundedQueryRepository = EnclaveRepository;

/**
 * Fully-normalized bounded-query configuration, with every field resolved to
 * an explicit value ({@link BOUNDED_QUERY_DEFAULTS} applied where the AWF
 * config file left a field unset).
 */
export interface BoundedQueriesConfig {
  /**
   * Whether bounded queries are enabled for this run.
   *
   * Only ever `true` when the config file explicitly set `enabled: true`;
   * any other value (including omission) normalizes to `false`.
   *
   * @default false
   */
  enabled: boolean;

  /**
   * Private repositories the bounded-query broker is permitted to fetch
   * source from, each with its trusted confidentiality category. Required to
   * be non-empty and unique (case-insensitively, enforced by preflight)
   * whenever `enabled` is `true`.
   *
   * Legacy bare-string entries in the AWF config file are normalized to
   * `{ repo, sensitivity: 'internal' }` with a warning (one-release
   * compatibility) — by the time a {@link BoundedQueriesConfig} exists, every
   * entry is already an object.
   *
   * @default []
   */
  privateRepos: BoundedQueryRepository[];

  /**
   * Sandbox runtime backend used to execute the query script.
   *
   * @default 'docker'
   */
  runtime: BoundedQueryRuntime;

  /**
   * Maximum wall-clock time, in seconds, allowed for a single query
   * invocation.
   *
   * @default 30
   */
  timeout: number;

  /**
   * Docker-style memory limit applied to the query sandbox (e.g. `"512m"`,
   * `"1g"`).
   *
   * @default '512m'
   */
  memoryLimit: string;

  /**
   * Script interpreter used to run the query. Only `'python3'` is currently
   * supported.
   *
   * @default 'python3'
   */
  interpreter: BoundedQueryInterpreter;

  /**
   * Maximum number of query invocations permitted for the current AWF run.
   *
   * @default 32
   */
  maxInvocations: number;
}

/**
 * Centralized defaults for {@link BoundedQueriesConfig}. Single source of
 * truth for the normalizer (`src/parsers/bounded-query-parser.ts`), the
 * config schema (`docs/awf-config.schema.json`), and documentation.
 */
export const BOUNDED_QUERY_DEFAULTS: Readonly<
  Pick<BoundedQueriesConfig, 'enabled' | 'runtime' | 'timeout' | 'memoryLimit' | 'interpreter' | 'maxInvocations'>
> = {
  enabled: false,
  runtime: 'docker',
  timeout: 30,
  memoryLimit: '512m',
  interpreter: 'python3',
  maxInvocations: 32,
};

export interface BoundedQueryOptions {
  /**
   * Normalized bounded-query sandbox configuration.
   *
   * `undefined` when the AWF config file did not include a `boundedQueries`
   * section at all. Present (with defaults applied) whenever the section
   * was included, regardless of whether `enabled` is `true`.
   *
   * @default undefined
   */
  boundedQueries?: BoundedQueriesConfig;

  /**
   * Trusted runtime state selected by bounded-query preflight.
   *
   * This is not a user-configurable field and is never accepted from the AWF
   * config file. Compose agents always use `unix`; sbx uses `unix` only when
   * an executable passthrough probe succeeds, otherwise `sbx-http`.
   *
   * @internal
   */
  boundedQueryIngressTransport?: BoundedQueryIngressTransport;
}
