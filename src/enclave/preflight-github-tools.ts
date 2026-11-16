import type {
  EnclaveAgentExecutorConfig,
  EnclaveAgentGithubToolsConfig,
  EnclaveRepository,
} from '../types/enclave-options';
import {
  ENCLAVE_AGENT_GITHUB_MIN_INTEGRITIES,
  ENCLAVE_AGENT_GITHUB_TOOLS,
} from '../types/enclave-options';
import { PRIVATE_REPOSITORY_PATTERN } from '../bounded-execution';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';

const GITHUB_CLI_PROFILES = new Set(['issues-read-v1']);

export function validateEnclaveAgentGithubConfig(agent: EnclaveAgentExecutorConfig, errors: string[]): void {
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
