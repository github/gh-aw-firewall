import type { WrapperConfig } from '../types';
import type {
  EnclaveSensitivity,
  EnclavesConfig,
} from '../types/enclave-options';
import { PRIVATE_REPOSITORY_PATTERN } from '../bounded-execution';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';
import { findDockerSocketExposingMount } from './mount-policy';
import {
  isCloudHypervisorAgentAcceptanceWorkflow,
  isCloudHypervisorScriptAcceptanceWorkflow,
} from './cloud-hypervisor-script-acceptance';
import { validatePublicEnclaveDebug } from './public-debug';
import {
  isCloudHypervisorConformanceAcceptanceWorkflow,
  isCloudHypervisorDailyRegressionWorkflow,
} from './cloud-hypervisor-conformance-acceptance';
import { validateRunSandboxBackend } from './run-backend';
import { validateEnclaveExecutors, type ValidateEnclavesOptions } from './preflight-executors';

export {
  DYNAMIC_ENCLAVE_EXECUTION_UNSUPPORTED_REASON,
  resolveEnclaveAgentApiRoute,
  type ValidateEnclavesOptions,
} from './preflight-executors';

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

export function validateEnclavesConfig(
  config: WrapperConfig,
  options: ValidateEnclavesOptions = {},
): string[] {
  const errors = validateEnclavesStructure(config, options);
  if (config.enclaves) errors.push(...validateRunSandboxBackend(config.containerRuntime, config.enclaves));
  if (
    config.enclaves?.enabled
    && config.containerRuntime === 'cloud-hypervisor'
    && !isCloudHypervisorScriptAcceptanceWorkflow(config)
    && !isCloudHypervisorAgentAcceptanceWorkflow(config)
    && !isCloudHypervisorConformanceAcceptanceWorkflow(config)
    && !isCloudHypervisorDailyRegressionWorkflow(config)
  ) {
    errors.unshift('The primary-agent cloud-hypervisor runtime cannot be combined with enclaves');
  }
  return errors;
}

/** Structural host-executor validation; does not authorize production execution. */
export function validateEnclavesStructure(
  config: WrapperConfig,
  options: ValidateEnclavesOptions = {},
): string[] {
  const enclaves = config.enclaves;
  const debugErrors = validatePublicEnclaveDebug(config);
  if (!enclaves?.enabled) return debugErrors;

  const errors: string[] = [...debugErrors];
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
  validateEnclaveExecutors(config, enclaves, options, errors);
  return errors;
}
