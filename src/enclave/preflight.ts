import type { WrapperConfig } from '../types';
import type { EnclavesConfig } from '../types/enclave-options';
import {
  MAX_RESULT_BYTES,
  MAX_SCRIPT_BYTES,
  MAX_BOUNDED_EXECUTION_TIMEOUT_SECONDS,
  PRIVATE_REPOSITORY_PATTERN,
} from '../bounded-execution';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';

const RUNTIMES = new Set(['docker', 'gvisor', 'sbx']);
const ENGINES = new Set(['copilot', 'claude', 'codex', 'gemini']);

function validateRepositoryList(enclaves: EnclavesConfig, errors: string[]): void {
  if (enclaves.privateRepos.length === 0) {
    errors.push('enclaves.enabled is true but enclaves.privateRepos is empty');
  }
  const seen = new Set<string>();
  for (const repository of enclaves.privateRepos) {
    if (!PRIVATE_REPOSITORY_PATTERN.test(repository.repo)) {
      errors.push(`enclaves.privateRepos entry "${repository.repo}" is not a bare owner/repo slug`);
      continue;
    }
    const key = normalizePrivateRepositoryKey(repository.repo);
    if (seen.has(key)) errors.push(`enclaves.privateRepos contains a duplicate entry: "${repository.repo}"`);
    seen.add(key);
  }
}

/** Static, fail-closed checks for the unified enclave foundation. */
export function validateEnclavesConfig(config: WrapperConfig): string[] {
  const enclaves = config.enclaves;
  if (!enclaves?.enabled) return [];

  const errors: string[] = [];
  if (config.boundedQueries?.enabled || config.boundedAgents?.enabled) {
    errors.push(
      'enclaves cannot be enabled with boundedQueries or boundedAgents; choose the unified enclaves section or the legacy sections',
    );
  }

  validateRepositoryList(enclaves, errors);
  const { script, agent } = enclaves.executors;
  if (!script.enabled && !agent.enabled) {
    errors.push('enclaves.enabled is true but no enclave executor is enabled');
  }

  if (script.enabled) {
    if (!RUNTIMES.has(script.runtime)) errors.push(`enclaves.executors.script.runtime "${script.runtime}" is not supported`);
    if (script.network !== 'none') errors.push('enclaves.executors.script.network must be "none"');
    if (script.interpreter !== 'python3') errors.push('enclaves.executors.script.interpreter must be "python3"');
    if (!Number.isInteger(script.timeout) || script.timeout < 1 || script.timeout > MAX_BOUNDED_EXECUTION_TIMEOUT_SECONDS) {
      errors.push(
        `enclaves.executors.script.timeout must be between 1 and ${MAX_BOUNDED_EXECUTION_TIMEOUT_SECONDS}`,
      );
    }
    validateResourceLimits('enclaves.executors.script', script, errors);
    validatePositiveInteger('enclaves.executors.script.maxScriptBytes', script.maxScriptBytes, errors);
    if (script.maxScriptBytes > MAX_SCRIPT_BYTES) {
      errors.push(`enclaves.executors.script.maxScriptBytes must be at most ${MAX_SCRIPT_BYTES}`);
    }
    if (script.maxOutputBytes > MAX_RESULT_BYTES) {
      errors.push(`enclaves.executors.script.maxOutputBytes must be at most ${MAX_RESULT_BYTES}`);
    }
    validatePositiveInteger('enclaves.executors.script.maxInvocations', script.maxInvocations, errors);
  }

  if (agent.enabled) {
    if (!RUNTIMES.has(agent.runtime)) errors.push(`enclaves.executors.agent.runtime "${agent.runtime}" is not supported`);
    if (!ENGINES.has(agent.engine)) errors.push(`enclaves.executors.agent.engine "${agent.engine}" is not supported`);
    if (agent.network !== 'api-proxy-only') {
      errors.push('enclaves.executors.agent.network must be "api-proxy-only"');
    }
    if (!agent.model) errors.push('enclaves.executors.agent.model is required when the agent executor is enabled');
    if (!config.enableApiProxy) {
      errors.push('enclaves agent executor requires the AWF API proxy');
    }
    if (!Number.isInteger(agent.timeout) || agent.timeout < 1 || agent.timeout > MAX_BOUNDED_EXECUTION_TIMEOUT_SECONDS) {
      errors.push(
        `enclaves.executors.agent.timeout must be between 1 and ${MAX_BOUNDED_EXECUTION_TIMEOUT_SECONDS}`,
      );
    }
    validateResourceLimits('enclaves.executors.agent', agent, errors);
    validatePositiveInteger('enclaves.executors.agent.maxTaskBytes', agent.maxTaskBytes, errors);
    validatePositiveInteger('enclaves.executors.agent.maxInvocations', agent.maxInvocations, errors);
    validatePositiveInteger('enclaves.executors.agent.maxModelRequests', agent.maxModelRequests, errors);
    validatePositiveInteger('enclaves.executors.agent.maxModelTokens', agent.maxModelTokens, errors);
  }

  return errors;
}

function validatePositiveInteger(name: string, value: number, errors: string[]): void {
  if (!Number.isSafeInteger(value) || value < 1) errors.push(`${name} must be a positive integer`);
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
