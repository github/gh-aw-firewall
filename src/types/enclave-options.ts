/**
 * Unified trusted configuration for private-repository enclaves.
 *
 * Executors are exposed only through an AWF-owned MCP server behind the trusted
 * gateway. Executor controls are trusted AWF configuration and are never
 * accepted from an invocation request.
 */

export type EnclaveSensitivity = 'trusted' | 'public' | 'internal' | 'confidential' | 'sealed';

export const ENCLAVE_SENSITIVITIES: readonly EnclaveSensitivity[] = [
  'trusted',
  'public',
  'internal',
  'confidential',
  'sealed',
];

/** Shared per-repository budget for every executor in one AWF run. */
export const ENCLAVE_SENSITIVITY_RUN_BITS: Readonly<Record<EnclaveSensitivity, number | null>> = {
  trusted: null,
  public: null,
  internal: 64,
  confidential: 8,
  sealed: 0,
};

export interface EnclaveRepository {
  repo: string;
  sensitivity: EnclaveSensitivity;
}

export type EnclaveRuntime = 'docker' | 'gvisor' | 'sbx';
export type EnclaveScriptInterpreter = 'python3';
export type EnclaveAgentEngine = 'copilot' | 'claude' | 'codex' | 'gemini';
export type EnclaveAgentProfile = 'openai' | 'anthropic';
export type EnclaveAgentGithubCliProfile = 'issues-read-v1';

/** @deprecated legacy marker shape; use {@link EnclaveAgentGithubToolsConfig} instead. */
export interface EnclaveAgentGithubConfig {
  cli: EnclaveAgentGithubCliProfile;
}

/** Closed set of GitHub MCP tools the enclave-only shared gateway may expose. */
export type EnclaveAgentGithubTool = 'list_issues' | 'issue_read';

export const ENCLAVE_AGENT_GITHUB_TOOLS: readonly EnclaveAgentGithubTool[] = [
  'list_issues',
  'issue_read',
];

export type EnclaveAgentGithubMinIntegrity = 'none' | 'unapproved' | 'approved' | 'merged';

export const ENCLAVE_AGENT_GITHUB_MIN_INTEGRITIES: readonly EnclaveAgentGithubMinIntegrity[] = [
  'none',
  'unapproved',
  'approved',
  'merged',
];

/**
 * AWF-facing camelCase shape emitted by the gh-aw compiler for
 * `enclaves[].agent.tools.github`. Repository and integrity restrictions are
 * enforced by the compiler-created, enclave-specific MCP gateway identity;
 * AWF only validates this contract and wires the gateway connection.
 */
export interface EnclaveAgentGithubToolsConfig {
  allowed: EnclaveAgentGithubTool[];
  allowedRepos: string[];
  minIntegrity?: EnclaveAgentGithubMinIntegrity;
}

export interface EnclaveAgentToolsConfig {
  github?: EnclaveAgentGithubToolsConfig;
}

export interface EnclaveScriptExecutorConfig {
  enabled: boolean;
  runtime: EnclaveRuntime;
  /** Optional trusted image override; omission uses AWF's pinned script image. */
  image?: string;
  network: 'none';
  interpreter: EnclaveScriptInterpreter;
  timeout: number;
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
  tmpfsLimit: string;
  maxOutputBytes: number;
  maxScriptBytes: number;
  maxInvocations: number;
}

export interface EnclaveAgentExecutorConfig {
  enabled: boolean;
  runtime: EnclaveRuntime;
  /** Optional trusted image override; omission uses AWF's pinned engine image. */
  image?: string;
  network: 'api-proxy-only';
  engine: EnclaveAgentEngine;
  profile: EnclaveAgentProfile;
  model: string;
  timeout: number;
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
  tmpfsLimit: string;
  maxOutputBytes: number;
  maxTaskBytes: number;
  maxInvocations: number;
  maxModelRequests?: number;
  maxModelTokens?: number;
  /** @deprecated legacy marker shape; use `tools.github` instead. Mutually exclusive with it. */
  github?: EnclaveAgentGithubConfig;
  tools?: EnclaveAgentToolsConfig;
  /**
   * This entry's own `repos` list, preserved unmerged. `tools.github.allowedRepos`
   * MUST be validated against this list rather than the run-wide merged catalog,
   * so a repository declared only for the script executor cannot be referenced here.
   */
  repos: EnclaveRepository[];
  /**
   * Agent-only dynamic GitHub-MCP-backed repository policy per ADR 0001.
   * Mutually exclusive with `repos`: an entry declares a static seed catalog
   * or a dynamic policy, never both.
   */
  dynamic?: EnclaveDynamicPolicy;
}

/**
 * Canonical dynamic repository selector, per ADR 0001: exact lowercase ASCII
 * `owner/repository`, no trimming, case folding, Unicode normalization, URL
 * decoding, or alternate syntax before policy matching.
 */
export const CANONICAL_DYNAMIC_REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,38})\/(?!\.\.?$)(?!.*\.\.)[a-z0-9._-]{1,100}$/;

/** Canonical dynamic owner scope: the owner half of the selector above. */
export const CANONICAL_DYNAMIC_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;

/** Closed GitHub tool policy version accepted for dynamic admission. */
export type EnclaveDynamicGithubPolicyVersion = 'github-repository-read-v1';

/**
 * Compiler-emitted, closed dynamic GitHub tool policy. Exactly `list_issues`
 * and `issue_read` are supported; AWF rejects any other version or tool set.
 */
export interface EnclaveDynamicGithubPolicy {
  version: EnclaveDynamicGithubPolicyVersion;
  tools: EnclaveAgentGithubTool[];
}

/**
 * Per-invocation trusted bounds for a dynamically admitted repository.
 * Mirrors the static agent executor's resource/response controls; the
 * invocation selector can never widen any of these.
 */
export interface EnclaveDynamicLimits {
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
  tmpfsLimit: string;
  timeout: number;
  maxOutputBytes: number;
  maxTaskBytes: number;
  maxModelRequests?: number;
  maxModelTokens?: number;
}

/** Total, run-wide quotas debited across every dynamic admission. */
export interface EnclaveDynamicQuotas {
  totalInvocations: number;
  totalBytes: number;
  totalSeconds: number;
}

/**
 * Closed compiler-to-AWF dynamic policy envelope for `enclaves[].dynamic`.
 * Structurally identical to the concrete shape emitted by gh-aw#58880: the
 * invocation selector may only choose within this envelope and can never
 * alter any of its fields.
 */
export interface EnclaveDynamicPolicy {
  allowedOwners: string[];
  allowedRepositories: string[];
  sensitivity: EnclaveSensitivity;
  executor: 'agent';
  githubPolicy: EnclaveDynamicGithubPolicy;
  maxRepositories: number;
  limits: EnclaveDynamicLimits;
  quotas: EnclaveDynamicQuotas;
  auditLabels: Record<string, string>;
  /** Absolute ISO-8601 expiry, never later than the workflow job lifetime. */
  expiresAt: string;
}

export interface EnclavesConfig {
  enabled: boolean;
  privateRepos: EnclaveRepository[];
  executors: {
    script: EnclaveScriptExecutorConfig;
    agent: EnclaveAgentExecutorConfig;
  };
}

export interface EnclaveOptions {
  /** Present only when the config file contains an `enclaves` section. */
  enclaves?: EnclavesConfig;
}

/**
 * Raw configuration mirrors the gh-aw compiler frontmatter exactly: `enclaves`
 * is a keyed array where every entry carries exactly one `script` or `agent`
 * key, its own `repos` list, and an optional entry-level `timeout`.
 */
type RawEnclaveCommonConfig = Pick<
  Partial<EnclaveScriptExecutorConfig>,
  'runtime' | 'image' | 'memoryLimit' | 'cpuLimit' | 'pidsLimit' | 'tmpfsLimit'
  | 'maxOutputBytes' | 'maxInvocations'
>;

export type RawEnclaveScriptExecutorConfig = Pick<
  Partial<EnclaveScriptExecutorConfig>,
  'maxScriptBytes'
>;
export type RawEnclaveAgentExecutorConfig = Pick<
  Partial<EnclaveAgentExecutorConfig>,
  'engine' | 'profile' | 'maxTaskBytes' | 'maxModelRequests' | 'maxModelTokens' | 'github' | 'tools'
> & { model: string };

interface RawEnclaveEntryBase extends RawEnclaveCommonConfig {
  repos?: EnclaveRepository[];
  timeout?: number;
  /**
   * Agent-only dynamic policy. Present as a sibling of `repos`/`agent` on the
   * raw entry, matching the exact shape gh-aw#58880 emits; mutually
   * exclusive with `repos` and rejected on `script` entries.
   */
  dynamic?: EnclaveDynamicPolicy;
}

export interface RawEnclaveScriptEntry extends RawEnclaveEntryBase {
  script: RawEnclaveScriptExecutorConfig;
  agent?: never;
}

export interface RawEnclaveAgentEntry extends RawEnclaveEntryBase {
  agent: RawEnclaveAgentExecutorConfig;
  script?: never;
}

export type RawEnclaveEntry = RawEnclaveScriptEntry | RawEnclaveAgentEntry;

export type RawEnclavesConfig = RawEnclaveEntry[];

export const ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS: Readonly<
  Omit<EnclaveScriptExecutorConfig, 'image'>
> = {
  enabled: false,
  runtime: 'docker',
  network: 'none',
  interpreter: 'python3',
  timeout: 30,
  memoryLimit: '512m',
  cpuLimit: '1',
  pidsLimit: 128,
  tmpfsLimit: '64m',
  maxOutputBytes: 8192,
  maxScriptBytes: 64 * 1024,
  maxInvocations: 32,
};

export const ENCLAVE_AGENT_EXECUTOR_DEFAULTS: Readonly<
  Omit<EnclaveAgentExecutorConfig, 'image'>
> = {
  enabled: false,
  runtime: 'docker',
  network: 'api-proxy-only',
  engine: 'copilot',
  profile: 'openai',
  model: '',
  timeout: 120,
  // Leave headroom for the agent plus bounded /tmp and shared-memory mounts.
  memoryLimit: '1g',
  cpuLimit: '1',
  pidsLimit: 128,
  // Bounds /tmp and shared memory; /agent is invocation-private disk storage.
  tmpfsLimit: '256m',
  maxOutputBytes: 8192,
  maxTaskBytes: 4096,
  maxInvocations: 8,
  repos: [],
};

export const ENCLAVES_DEFAULTS: Readonly<EnclavesConfig> = {
  enabled: false,
  privateRepos: [],
  executors: {
    script: ENCLAVE_SCRIPT_EXECUTOR_DEFAULTS,
    agent: ENCLAVE_AGENT_EXECUTOR_DEFAULTS,
  },
};

/**
 * Whether the enclave-only shared GitHub MCP gateway is requested, under
 * either the legacy `agent.github.cli: issues-read-v1` marker or the current
 * `agent.tools.github` shape. Callers must pair this with
 * {@link EnclavesConfig.executors.agent.enabled} where relevant.
 */
export function isEnclaveAgentGithubToolsEnabled(
  agent: Pick<EnclaveAgentExecutorConfig, 'github' | 'tools'> | undefined,
): boolean {
  return agent?.github?.cli === 'issues-read-v1' || agent?.tools?.github !== undefined;
}

/**
 * Resolves the closed set of GitHub MCP tools configured for this enclave
 * agent, normalizing the legacy marker to its fixed pair. Returns `undefined`
 * when the GitHub gateway is not requested.
 */
export function resolveEnclaveAgentGithubAllowedTools(
  agent: Pick<EnclaveAgentExecutorConfig, 'github' | 'tools'> | undefined,
): EnclaveAgentGithubTool[] | undefined {
  if (agent?.tools?.github) return [...agent.tools.github.allowed];
  if (agent?.github?.cli === 'issues-read-v1') return [...ENCLAVE_AGENT_GITHUB_TOOLS];
  return undefined;
}
