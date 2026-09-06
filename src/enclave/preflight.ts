import type { WrapperConfig } from '../types';
import type {
  EnclaveAgentExecutorConfig,
  EnclaveAgentGithubToolsConfig,
  EnclaveDynamicPolicy,
  EnclaveRepository,
  EnclaveSensitivity,
  EnclavesConfig,
} from '../types/enclave-options';
import {
  CANONICAL_DYNAMIC_OWNER_PATTERN,
  CANONICAL_DYNAMIC_REPOSITORY_PATTERN,
  ENCLAVE_AGENT_GITHUB_MIN_INTEGRITIES,
  ENCLAVE_AGENT_GITHUB_TOOLS,
  ENCLAVE_SENSITIVITIES,
} from '../types/enclave-options';
import {
  MAX_RESULT_BYTES,
  MAX_SCRIPT_BYTES,
  MAX_ENCLAVE_TIMEOUT_SECONDS,
  PRIVATE_REPOSITORY_PATTERN,
} from '../bounded-execution';
import { ENCLAVE_AGENT_MAX_TASK_BYTES } from './protocol';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';
import { findDockerSocketExposingMount } from './mount-policy';

const RUNTIMES = new Set(['docker', 'gvisor', 'sbx']);
const ENGINES = new Set(['copilot', 'claude', 'codex', 'gemini']);
const GITHUB_CLI_PROFILES = new Set(['issues-read-v1']);
const DYNAMIC_GITHUB_POLICY_VERSIONS = new Set(['github-repository-read-v1']);

/** AWF-enforceable upper bound on the number of repositories one dynamic envelope may admit. */
const MAX_DYNAMIC_REPOSITORIES = 64;
/** AWF-enforceable upper bound on the number of owner/repository selectors listed in one envelope. */
const MAX_DYNAMIC_SELECTOR_LIST_LENGTH = 256;
const MAX_DYNAMIC_AUDIT_LABELS = 32;
const MAX_DYNAMIC_AUDIT_LABEL_LENGTH = 200;

/** Engines with a published, audited enclave image and a fixed AWF model loop. */
const IMPLEMENTED_AGENT_ENGINES = new Set(['copilot']);

/**
 * Resolves whether the configured agent profile has a usable API-proxy route.
 *
 * An agent enclave holds no credentials: it can only reach a model through the
 * dedicated AWF API proxy, which injects the real key. If the profile's
 * provider is not routed for this run the enclave would sit on an internal
 * network with nothing to talk to, so the run is rejected rather than started
 * in a state where every invocation returns the canonical error.
 */
export function resolveEnclaveAgentApiRoute(
  config: WrapperConfig,
  agent: Pick<EnclaveAgentExecutorConfig, 'engine' | 'profile'>,
): { routed: boolean; detail: string } {
  if (agent.engine === 'copilot') {
    return {
      routed: Boolean(
        config.copilotGithubToken
        || config.copilotProviderApiKey,
      ),
      detail: 'apiProxy.targets.copilot (COPILOT_GITHUB_TOKEN or Copilot BYOK route) is not configured',
    };
  }
  if (agent.profile === 'anthropic') {
    return {
      routed: Boolean(config.anthropicApiKey),
      detail: 'apiProxy.targets.anthropic (ANTHROPIC_API_KEY) is not configured',
    };
  }
  return {
    routed: Boolean(config.openaiApiKey),
    detail: 'apiProxy.targets.openai (OPENAI_API_KEY) is not configured',
  };
}

function validateRepositoryList(enclaves: EnclavesConfig, errors: string[]): void {
  const hasDynamic = enclaves.executors.agent.dynamic !== undefined;
  if (enclaves.privateRepos.length === 0 && !hasDynamic) {
    errors.push('enclaves entries declare no repos');
  }
  const seen = new Map<string, EnclaveSensitivity>();
  for (const repository of enclaves.privateRepos) {
    if (!PRIVATE_REPOSITORY_PATTERN.test(repository.repo)) {
      errors.push(`enclaves[].repos entry "${repository.repo}" is not a bare owner/repo slug`);
      continue;
    }
    const key = normalizePrivateRepositoryKey(repository.repo);
    const previous = seen.get(key);
    if (previous !== undefined) {
      errors.push(
        previous === repository.sensitivity
          ? `enclaves[].repos contains a duplicate entry: "${repository.repo}"`
          : `enclaves[].repos declares conflicting sensitivities for "${repository.repo}": `
            + `"${previous}" and "${repository.sensitivity}" cannot share one information budget`,
      );
    }
    seen.set(key, repository.sensitivity);
  }
}

/** Static, fail-closed checks for the unified enclave foundation. */
export function validateEnclavesConfig(config: WrapperConfig): string[] {
  const enclaves = config.enclaves;
  if (!enclaves?.enabled) return [];

  const errors: string[] = [];
  if (config.enableDind) {
    errors.push(
      'enclaves cannot be combined with enableDind: exposing the Docker socket to the primary ' +
      'agent would allow it to inspect the gateway capability, private seeds, control network, ' +
      'and ledger state',
    );
  }
  const socketMount = findDockerSocketExposingMount(config);
  if (socketMount) {
    errors.push(
      `enclaves cannot expose the Docker socket to the primary agent through custom volume "${socketMount}": ` +
      'that would allow direct access to enclave capability and private state',
    );
  }

  validateRepositoryList(enclaves, errors);
  const { script, agent } = enclaves.executors;
  if (!script.enabled && !agent.enabled) {
    errors.push('enclaves is enabled but no enclave executor entry is configured');
  }

  if (script.enabled) {
    if (!RUNTIMES.has(script.runtime)) errors.push(`enclaves[].runtime "${script.runtime}" is not supported`);
    if (script.network !== 'none') errors.push('enclaves[].script.network must be "none"');
    if (script.interpreter !== 'python3') errors.push('enclaves[].script.interpreter must be "python3"');
    if (!Number.isInteger(script.timeout) || script.timeout < 1 || script.timeout > MAX_ENCLAVE_TIMEOUT_SECONDS) {
      errors.push(
        `enclaves[].timeout must be between 1 and ${MAX_ENCLAVE_TIMEOUT_SECONDS}`,
      );
    }
    validateResourceLimits('enclaves[]', script, errors);
    validatePositiveInteger('enclaves[].script.maxScriptBytes', script.maxScriptBytes, errors);
    if (script.maxScriptBytes > MAX_SCRIPT_BYTES) {
      errors.push(`enclaves[].script.maxScriptBytes must be at most ${MAX_SCRIPT_BYTES}`);
    }
    if (script.maxOutputBytes > MAX_RESULT_BYTES) {
      errors.push(`enclaves[].maxOutputBytes must be at most ${MAX_RESULT_BYTES}`);
    }
    validatePositiveInteger('enclaves[].maxInvocations', script.maxInvocations, errors);
  }

  if (agent.enabled) {
    if (!RUNTIMES.has(agent.runtime)) errors.push(`enclaves[].runtime "${agent.runtime}" is not supported`);
    if (!ENGINES.has(agent.engine)) {
      errors.push(`enclaves[].agent.engine "${agent.engine}" is not supported`);
    } else if (!IMPLEMENTED_AGENT_ENGINES.has(agent.engine)) {
      errors.push(
        `enclaves[].agent.engine "${agent.engine}" is not implemented. Only "copilot" has a ` +
        'pinned native enclave image and an AWF-authored model loop; enclaves never fall back to a ' +
        'different engine.',
      );
    }
    if (agent.network !== 'api-proxy-only') {
      errors.push('enclaves[].agent.network must be "api-proxy-only"');
    }
    if (!agent.model) errors.push('enclaves[].agent.model is required when the agent executor is enabled');
    if (agent.dynamic !== undefined && agent.repos.length > 0) {
      errors.push(
        'enclaves[].dynamic and enclaves[].repos are mutually exclusive: an entry declares a static '
        + 'seed catalog or a dynamic policy, never both',
      );
    } else if (agent.dynamic === undefined && agent.repos.length === 0) {
      errors.push('enclaves[].agent requires either a non-empty "repos" list or a "dynamic" policy');
    } else if (agent.dynamic !== undefined) {
      validateEnclaveDynamicPolicy(agent.dynamic, errors);
    }
    if (!config.enableApiProxy) {
      errors.push('enclaves agent executor requires the AWF API proxy');
    } else {
      const route = resolveEnclaveAgentApiRoute(config, agent);
      if (!route.routed) {
        errors.push(
          `enclaves agent executor requires a configured API target for engine "${agent.engine}": ` +
          `${route.detail}`,
        );
      }
    }
    if (!Number.isInteger(agent.timeout) || agent.timeout < 1 || agent.timeout > MAX_ENCLAVE_TIMEOUT_SECONDS) {
      errors.push(
        `enclaves[].timeout must be between 1 and ${MAX_ENCLAVE_TIMEOUT_SECONDS}`,
      );
    }
    validateResourceLimits('enclaves[]', agent, errors);
    validatePositiveInteger('enclaves[].agent.maxTaskBytes', agent.maxTaskBytes, errors);
    if (agent.maxTaskBytes > ENCLAVE_AGENT_MAX_TASK_BYTES) {
      errors.push(`enclaves[].agent.maxTaskBytes must be at most ${ENCLAVE_AGENT_MAX_TASK_BYTES}`);
    }
    if (agent.maxOutputBytes > MAX_RESULT_BYTES) {
      errors.push(`enclaves[].maxOutputBytes must be at most ${MAX_RESULT_BYTES}`);
    }
    validatePositiveInteger('enclaves[].maxInvocations', agent.maxInvocations, errors);
    if (agent.maxModelRequests !== undefined) {
      validatePositiveInteger('enclaves[].agent.maxModelRequests', agent.maxModelRequests, errors);
    }
    if (agent.maxModelTokens !== undefined) {
      validatePositiveInteger('enclaves[].agent.maxModelTokens', agent.maxModelTokens, errors);
    }
    if (agent.github !== undefined && agent.tools?.github !== undefined) {
      errors.push(
        'enclaves[].agent.github and enclaves[].agent.tools.github cannot both be set; ' +
        'migrate to enclaves[].agent.tools.github',
      );
    } else if (agent.github !== undefined) {
      if (
        typeof agent.github !== 'object'
        || agent.github === null
        || !GITHUB_CLI_PROFILES.has(agent.github.cli)
      ) {
        errors.push('enclaves[].agent.github.cli must be "issues-read-v1"');
      }
    } else if (agent.tools?.github !== undefined) {
      validateEnclaveAgentGithubTools(agent.tools.github, agent.repos, errors);
    }
  }

  return errors;
}

function validatePositiveInteger(name: string, value: number, errors: string[]): void {
  if (!Number.isSafeInteger(value) || value < 1) errors.push(`${name} must be a positive integer`);
}

/**
 * Validates the closed `enclaves[].dynamic` policy envelope per ADR 0001.
 * AWF rejects any field it does not understand, any policy version other
 * than the closed v1 GitHub tool set, and any bound it cannot enforce. The
 * invocation-time selector is validated separately by the dynamic registry
 * against this already-validated envelope.
 */
function validateEnclaveDynamicPolicy(dynamic: EnclaveDynamicPolicy, errors: string[]): void {
  if (typeof dynamic !== 'object' || dynamic === null) {
    errors.push('enclaves[].dynamic must be an object');
    return;
  }
  if (dynamic.executor !== 'agent') {
    errors.push('enclaves[].dynamic.executor must be "agent"');
  }
  const owners = dynamic.allowedOwners;
  const repositories = dynamic.allowedRepositories;
  if (!Array.isArray(owners) || !Array.isArray(repositories)) {
    errors.push('enclaves[].dynamic.allowedOwners and allowedRepositories must be arrays');
  } else {
    if (owners.length === 0 && repositories.length === 0) {
      errors.push('enclaves[].dynamic must declare at least one allowed owner or repository');
    }
    if (owners.length > MAX_DYNAMIC_SELECTOR_LIST_LENGTH || repositories.length > MAX_DYNAMIC_SELECTOR_LIST_LENGTH) {
      errors.push(
        `enclaves[].dynamic.allowedOwners and allowedRepositories must each have at most ` +
        `${MAX_DYNAMIC_SELECTOR_LIST_LENGTH} entries`,
      );
    }
    for (const owner of owners) {
      if (typeof owner !== 'string' || !CANONICAL_DYNAMIC_OWNER_PATTERN.test(owner)) {
        errors.push(`enclaves[].dynamic.allowedOwners entry "${owner}" is not a canonical lowercase owner`);
      }
    }
    for (const repo of repositories) {
      if (typeof repo !== 'string' || !CANONICAL_DYNAMIC_REPOSITORY_PATTERN.test(repo)) {
        errors.push(
          `enclaves[].dynamic.allowedRepositories entry "${repo}" is not a canonical lowercase "owner/repository"`,
        );
      }
    }
  }
  if (!ENCLAVE_SENSITIVITIES.includes(dynamic.sensitivity)) {
    errors.push(`enclaves[].dynamic.sensitivity "${dynamic.sensitivity}" is not supported`);
  }
  validatePositiveInteger('enclaves[].dynamic.maxRepositories', dynamic.maxRepositories, errors);
  if (dynamic.maxRepositories > MAX_DYNAMIC_REPOSITORIES) {
    errors.push(`enclaves[].dynamic.maxRepositories must be at most ${MAX_DYNAMIC_REPOSITORIES}`);
  }
  const githubPolicy = dynamic.githubPolicy;
  if (typeof githubPolicy !== 'object' || githubPolicy === null) {
    errors.push('enclaves[].dynamic.githubPolicy must be an object');
  } else {
    if (!DYNAMIC_GITHUB_POLICY_VERSIONS.has(githubPolicy.version)) {
      errors.push(
        `enclaves[].dynamic.githubPolicy.version "${githubPolicy.version}" is not supported; ` +
        `only ${JSON.stringify([...DYNAMIC_GITHUB_POLICY_VERSIONS])} is accepted`,
      );
    }
    const tools = githubPolicy.tools;
    if (
      !Array.isArray(tools)
      || tools.length !== ENCLAVE_AGENT_GITHUB_TOOLS.length
      || new Set(tools).size !== ENCLAVE_AGENT_GITHUB_TOOLS.length
      || !ENCLAVE_AGENT_GITHUB_TOOLS.every(tool => tools.includes(tool))
    ) {
      errors.push(
        'enclaves[].dynamic.githubPolicy.tools must be exactly '
        + JSON.stringify(ENCLAVE_AGENT_GITHUB_TOOLS),
      );
    }
  }
  const limits = dynamic.limits;
  if (typeof limits !== 'object' || limits === null) {
    errors.push('enclaves[].dynamic.limits must be an object');
  } else {
    validateResourceLimits('enclaves[].dynamic.limits', limits, errors);
    if (!Number.isInteger(limits.timeout) || limits.timeout < 1 || limits.timeout > MAX_ENCLAVE_TIMEOUT_SECONDS) {
      errors.push(`enclaves[].dynamic.limits.timeout must be between 1 and ${MAX_ENCLAVE_TIMEOUT_SECONDS}`);
    }
    validatePositiveInteger('enclaves[].dynamic.limits.maxTaskBytes', limits.maxTaskBytes, errors);
    if (limits.maxTaskBytes > ENCLAVE_AGENT_MAX_TASK_BYTES) {
      errors.push(`enclaves[].dynamic.limits.maxTaskBytes must be at most ${ENCLAVE_AGENT_MAX_TASK_BYTES}`);
    }
    if (limits.maxOutputBytes > MAX_RESULT_BYTES) {
      errors.push(`enclaves[].dynamic.limits.maxOutputBytes must be at most ${MAX_RESULT_BYTES}`);
    }
    if (limits.maxModelRequests !== undefined) {
      validatePositiveInteger('enclaves[].dynamic.limits.maxModelRequests', limits.maxModelRequests, errors);
    }
    if (limits.maxModelTokens !== undefined) {
      validatePositiveInteger('enclaves[].dynamic.limits.maxModelTokens', limits.maxModelTokens, errors);
    }
  }
  const quotas = dynamic.quotas;
  if (typeof quotas !== 'object' || quotas === null) {
    errors.push('enclaves[].dynamic.quotas must be an object');
  } else {
    validatePositiveInteger('enclaves[].dynamic.quotas.totalInvocations', quotas.totalInvocations, errors);
    validatePositiveInteger('enclaves[].dynamic.quotas.totalBytes', quotas.totalBytes, errors);
    validatePositiveInteger('enclaves[].dynamic.quotas.totalSeconds', quotas.totalSeconds, errors);
  }
  const auditLabels = dynamic.auditLabels;
  if (typeof auditLabels !== 'object' || auditLabels === null || Array.isArray(auditLabels)) {
    errors.push('enclaves[].dynamic.auditLabels must be an object');
  } else {
    const entries = Object.entries(auditLabels);
    if (entries.length > MAX_DYNAMIC_AUDIT_LABELS) {
      errors.push(`enclaves[].dynamic.auditLabels must have at most ${MAX_DYNAMIC_AUDIT_LABELS} entries`);
    }
    for (const [key, value] of entries) {
      if (
        typeof value !== 'string'
        || key.length > MAX_DYNAMIC_AUDIT_LABEL_LENGTH
        || value.length > MAX_DYNAMIC_AUDIT_LABEL_LENGTH
      ) {
        errors.push(
          `enclaves[].dynamic.auditLabels entry "${key}" must be a string of at most `
          + `${MAX_DYNAMIC_AUDIT_LABEL_LENGTH} characters`,
        );
      }
    }
  }
  if (typeof dynamic.expiresAt !== 'string' || Number.isNaN(Date.parse(dynamic.expiresAt))) {
    errors.push('enclaves[].dynamic.expiresAt must be a valid ISO-8601 timestamp');
  } else if (Date.parse(dynamic.expiresAt) <= Date.now()) {
    errors.push('enclaves[].dynamic.expiresAt must be in the future');
  }
}

/**
 * Validates the closed `enclaves[].agent.tools.github` contract. Repository
 * and integrity enforcement live in the compiler-created, enclave-specific
 * MCP gateway identity; this only rejects malformed or out-of-catalog input
 * so AWF never widens what that identity already restricts.
 */
function validateEnclaveAgentGithubTools(
  githubTools: EnclaveAgentGithubToolsConfig,
  agentRepos: EnclaveRepository[],
  errors: string[],
): void {
  if (typeof githubTools !== 'object' || githubTools === null) {
    errors.push('enclaves[].agent.tools.github must be an object');
    return;
  }
  if (
    !Array.isArray(githubTools.allowed)
    || githubTools.allowed.length === 0
    || !githubTools.allowed.every(tool => ENCLAVE_AGENT_GITHUB_TOOLS.includes(tool))
    || new Set(githubTools.allowed).size !== githubTools.allowed.length
  ) {
    errors.push(
      'enclaves[].agent.tools.github.allowed must be a non-empty, duplicate-free subset of '
      + JSON.stringify(ENCLAVE_AGENT_GITHUB_TOOLS),
    );
  }
  if (!Array.isArray(githubTools.allowedRepos) || githubTools.allowedRepos.length === 0) {
    errors.push(
      'enclaves[].agent.tools.github.allowedRepos must be a non-empty array of "owner/repository" slugs',
    );
  } else {
    const known = new Set(agentRepos.map(repository => normalizePrivateRepositoryKey(repository.repo)));
    for (const repo of githubTools.allowedRepos) {
      if (typeof repo !== 'string' || !PRIVATE_REPOSITORY_PATTERN.test(repo)) {
        errors.push(
          `enclaves[].agent.tools.github.allowedRepos entry "${repo}" is not a bare owner/repository slug`,
        );
        continue;
      }
      if (!known.has(normalizePrivateRepositoryKey(repo))) {
        errors.push(
          `enclaves[].agent.tools.github.allowedRepos entry "${repo}" is not declared in the agent entry's own enclaves[].repos`,
        );
      }
    }
  }
  if (
    githubTools.minIntegrity !== undefined
    && !ENCLAVE_AGENT_GITHUB_MIN_INTEGRITIES.includes(githubTools.minIntegrity)
  ) {
    errors.push(
      'enclaves[].agent.tools.github.minIntegrity must be one of '
      + JSON.stringify(ENCLAVE_AGENT_GITHUB_MIN_INTEGRITIES),
    );
  }
}

function validateResourceLimits(
  name: string,
  executor: {
    memoryLimit: string;
    cpuLimit: string;
    pidsLimit: number;
    tmpfsLimit: string;
    maxOutputBytes: number;
  },
  errors: string[],
): void {
  const dockerSize = /^[1-9][0-9]*[bkmgBKMG]$/;
  if (!dockerSize.test(executor.memoryLimit)) errors.push(`${name}.memoryLimit is not a Docker size`);
  if (!dockerSize.test(executor.tmpfsLimit)) errors.push(`${name}.tmpfsLimit is not a Docker size`);
  if (!/^(?:[0-9]{1,2})(?:\.[0-9]{1,3})?$/.test(executor.cpuLimit) || Number(executor.cpuLimit) <= 0) {
    errors.push(`${name}.cpuLimit must be a positive Docker --cpus value`);
  }
  validatePositiveInteger(`${name}.pidsLimit`, executor.pidsLimit, errors);
  validatePositiveInteger(`${name}.maxOutputBytes`, executor.maxOutputBytes, errors);
}
