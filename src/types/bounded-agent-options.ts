/**
 * Bounded-agent enclave configuration types.
 *
 * A bounded agent is the *agentic* sibling of a bounded query (see
 * `./bounded-query-options.ts`): instead of running an agent-authored Python
 * script, a trusted broker runs a configured native coding-agent engine inside
 * a network-isolated enclave whose only reachable peer is the AWF API proxy.
 * The enclave reads one immutable repository seed read-only, may call the
 * configured model route and must reduce its work to a single value conforming
 * to a finite response schema the caller declared up front.
 *
 * Everything the caller can influence is listed in
 * `src/bounded-agent/protocol.ts`; everything else — image, command, mounts,
 * environment, endpoints, network, proxy, credentials, timeouts, resource
 * limits, runtime, and tool definitions — is fixed trusted configuration and
 * is rejected if it appears in a request.
 *
 * This is config-only: there are no `--bounded-agents-*` CLI flags. See
 * docs/awf-config-spec.md §15 and docs/bounded-agents.md.
 */

import {
  BOUNDED_QUERY_SENSITIVITIES,
  BOUNDED_QUERY_SENSITIVITY_RUN_BITS,
  type BoundedQuerySensitivity,
} from './bounded-query-options';

/** Sandbox runtime backends recognized for bounded-agent enclave execution. */
export type BoundedAgentRuntime = 'docker' | 'gvisor' | 'sbx';

/** Native coding-agent runtime baked into the single-use enclave image. */
export type BoundedAgentEngine = 'copilot' | 'claude' | 'codex' | 'gemini';

/** Every engine name accepted by configuration. Unimplemented engines fail closed in preflight. */
export const BOUNDED_AGENT_ENGINES: readonly BoundedAgentEngine[] = [
  'copilot',
  'claude',
  'codex',
  'gemini',
];

/**
 * Trusted provider protocol the enclave speaks to the AWF API proxy.
 *
 * `openai` uses the OpenAI-compatible `POST /v1/chat/completions` shape;
 * `anthropic` uses the Anthropic-compatible `POST /v1/messages` shape. Both
 * are terminated by the API proxy, which injects the real credential — the
 * enclave never holds one.
 */
export type BoundedAgentProfile = 'openai' | 'anthropic';

/** Every supported profile, for schema/validation enumeration. */
export const BOUNDED_AGENT_PROFILES: readonly BoundedAgentProfile[] = ['openai', 'anthropic'];

/** Bounded agents reuse the bounded-query confidentiality categories verbatim. */
export type BoundedAgentSensitivity = BoundedQuerySensitivity;

/** Every supported sensitivity value, for schema/validation enumeration. */
export const BOUNDED_AGENT_SENSITIVITIES: readonly BoundedAgentSensitivity[] = BOUNDED_QUERY_SENSITIVITIES;

/**
 * Immutable per-repository run-budget table.
 *
 * Bounded agents deliberately share the bounded-query budget *table* (so an
 * operator classifies a repository once) but never share a ledger: each
 * subsystem runs its own broker with its own seed map, so a bounded agent can
 * never spend a bounded query's remaining balance or vice versa.
 */
export const BOUNDED_AGENT_SENSITIVITY_RUN_BITS: Readonly<Record<BoundedAgentSensitivity, number | null>> =
  BOUNDED_QUERY_SENSITIVITY_RUN_BITS;

/**
 * A trusted, per-repository descriptor.
 *
 * `sensitivity` is supplied only in AWF configuration (never in an agent
 * request) and flows unmodified into the seed map the broker reads.
 */
export interface BoundedAgentRepository {
  /** Repository slug in `owner/repo` form, exactly as configured. */
  repo: string;
  /** Confidentiality category, which fixes this repository's run budget. */
  sensitivity: BoundedAgentSensitivity;
}

/**
 * Fully-normalized bounded-agent configuration, with every field resolved to
 * an explicit value ({@link BOUNDED_AGENT_DEFAULTS} applied where the AWF
 * config file left a field unset).
 */
export interface BoundedAgentsConfig {
  /**
   * Whether bounded agents are enabled for this run.
   *
   * Only ever `true` when the config file explicitly set `enabled: true`.
   *
   * @default false
   */
  enabled: boolean;

  /**
   * Private repositories a bounded agent may reason about, each with its
   * trusted confidentiality category. Required to be non-empty and unique
   * (case-insensitively, enforced by preflight) whenever `enabled` is `true`.
   *
   * @default []
   */
  privateRepos: BoundedAgentRepository[];

  /**
   * Sandbox runtime backend used to execute the enclave.
   *
   * `docker` and `gvisor` are implemented. `sbx` is accepted by the schema
   * but is capability-gated: preflight probes the installed sbx CLI and
   * blocks before any repository is staged unless every mandatory
   * isolation and API-proxy-only network primitive can be proven. No
   * backend ever downgrades.
   *
   * @default 'docker'
   */
  runtime: BoundedAgentRuntime;

  /**
   * Native coding-agent runtime executed inside each enclave.
   *
   * `copilot` is implemented. Other schema-recognized engines fail closed until
   * their dedicated, pinned enclave images and adapters are available.
   *
   * @default 'copilot'
   */
  engine: BoundedAgentEngine;

  /**
   * Trusted provider protocol the enclave speaks to the API proxy.
   *
   * @default 'openai'
   */
  profile: BoundedAgentProfile;

  /**
   * Model identifier sent on every enclave request. The caller cannot choose
   * or override it.
   *
   * Required whenever `enabled` is `true`.
   *
   * @default ''
   */
  model: string;

  /**
   * Maximum wall-clock time, in seconds, allowed for one enclave invocation.
   *
   * @default 120
   */
  timeout: number;

  /**
   * Docker-style memory limit applied to the enclave (e.g. `"512m"`).
   *
   * @default '512m'
   */
  memoryLimit: string;

  /**
   * Fractional CPU limit applied to the enclave (Docker `--cpus`).
   *
   * @default '1'
   */
  cpuLimit: string;

  /**
   * Maximum number of processes/threads the enclave may create.
   *
   * @default 128
   */
  pidsLimit: number;

  /**
   * Docker-style size limit for each of the enclave's writable tmpfs mounts
   * (`/tmp` and the `/agent` work/result root).
   *
   * @default '64m'
   */
  tmpfsLimit: string;

  /**
   * Maximum size, in bytes, of the enclave's dedicated result file. Also the
   * ceiling the broker reads back; anything larger is a canonical error.
   *
   * @default 8192
   */
  maxOutputBytes: number;

  /**
   * Maximum size, in bytes, of the caller-supplied bounded task text.
   *
   * The task is byte-bounded *trusted-shaped* input: it is never interpreted
   * as configuration, only forwarded verbatim into the enclave prompt.
   *
   * @default 4096
   */
  maxTaskBytes: number;

  /**
   * Maximum number of enclave invocations permitted for the current AWF run.
   *
   * @default 8
   */
  maxInvocations: number;

  /**
   * Maximum number of model requests one enclave invocation may issue.
   *
   * @default 8
   */
  maxModelRequests: number;

  /**
   * Maximum completion tokens requested per model call (`max_tokens`).
   *
   * @default 1024
   */
  maxModelTokens: number;
}

/**
 * Centralized defaults for {@link BoundedAgentsConfig}. Single source of
 * truth for the normalizer (`src/parsers/bounded-agent-parser.ts`), the
 * config schema (`docs/awf-config.schema.json`), and documentation.
 *
 * Every default is deliberately conservative: a bounded agent is a *model*
 * reading confidential source, so the safe posture is a small, short-lived,
 * low-token enclave that an operator must explicitly widen.
 */
export const BOUNDED_AGENT_DEFAULTS: Readonly<
  Omit<BoundedAgentsConfig, 'privateRepos'>
> = {
  enabled: false,
  runtime: 'docker',
  engine: 'copilot',
  profile: 'openai',
  model: '',
  timeout: 120,
  memoryLimit: '512m',
  cpuLimit: '1',
  pidsLimit: 128,
  tmpfsLimit: '64m',
  maxOutputBytes: 8192,
  maxTaskBytes: 4096,
  maxInvocations: 8,
  maxModelRequests: 8,
  maxModelTokens: 1024,
};

/**
 * Transport used between the primary agent and the bounded-agent broker.
 *
 * Compose agents (docker, gvisor) always use `unix`: the broker's socket is
 * bind-mounted directly into the agent container. A primary sbx microVM
 * cannot receive that bind mount, so it uses `unix` only when an executable
 * passthrough probe proves the microVM can reach a host-mounted Unix socket;
 * otherwise it falls back to `sbx-http`, an authenticated loopback-only HTTP
 * transport on a dedicated internal network (see `./ingress.ts`).
 */
export type BoundedAgentIngressTransport = 'unix' | 'sbx-http';

export interface BoundedAgentOptions {
  /**
   * Normalized bounded-agent enclave configuration.
   *
   * `undefined` when the AWF config file did not include a `boundedAgents`
   * section at all. Present (with defaults applied) whenever the section was
   * included, regardless of whether `enabled` is `true`.
   *
   * @default undefined
   */
  boundedAgents?: BoundedAgentsConfig;

  /**
   * Trusted runtime state selected by bounded-agent preflight.
   *
   * This is not a user-configurable field and is never accepted from the AWF
   * config file. Compose agents always use `unix`; sbx uses `unix` only when
   * an executable passthrough probe succeeds, otherwise `sbx-http`.
   *
   * @internal
   */
  boundedAgentIngressTransport?: BoundedAgentIngressTransport;
}
