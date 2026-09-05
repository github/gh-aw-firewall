import type { WrapperConfig } from '../types';
import type {
  EnclaveAgentExecutorConfig,
  EnclaveAgentGithubToolsConfig,
  EnclaveRepository,
  EnclaveSensitivity,
  EnclavesConfig,
} from '../types/enclave-options';
import {
  ENCLAVE_AGENT_GITHUB_MIN_INTEGRITIES,
  ENCLAVE_AGENT_GITHUB_TOOLS,
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
  if (enclaves.privateRepos.length === 0) {
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
