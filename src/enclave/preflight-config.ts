import type { WrapperConfig } from '../types';
import type {
  EnclaveAgentExecutorConfig,
  EnclaveScriptExecutorConfig,
} from '../types/enclave-options';
import { isEnclaveAgentGithubToolsEnabled } from '../types/enclave-options';
import { ProductionTrustedCloudHypervisorEnclaveStorageProvider } from '../cloud-hypervisor/trusted-enclave-storage';
import type { GitRunner } from './staging';
import { resolveStagingToken } from './staging';
import type { assertPrimaryRuntimeAvailable } from './runtime-preflight';
import { validateEnclavesConfig } from './preflight';
import { resolveEnclaveGatewayContract } from './gateway';
import {
  ENCLAVE_GITHUB_MCP_AGENT_ID_ENV,
  resolveEnclaveGithubGatewayContract,
} from './github-gateway';
import {
  resolveEnclaveDynamicDelegationHandoff,
  takeEnclaveDynamicDelegationHandoff,
} from './dynamic-delegation-handoff';
import {
  isCloudHypervisorEnclaveSelected,
  type TrustedCloudHypervisorEnclaveStorageProvider,
} from './cloud-hypervisor-lifecycle';
import {
  type assertDockerEnclaveHostPrerequisites,
  isDockerEnclaveSelected,
} from './docker-lifecycle';
import {
  getStaticGithubExecutorCapability,
  takeStaticGithubExecutorCapability,
} from './static-github-handoff';

export function isEnclaveScriptEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true && config.enclaves.executors.script.enabled === true;
}

export function isEnclaveAgentEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true && config.enclaves.executors.agent.enabled === true;
}

export function isEnclavesEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true;
}

/** Whether this run's agent entry declares a dynamic repository policy. */
export function isEnclaveDynamicPolicyDeclared(config: WrapperConfig): boolean {
  return isEnclaveAgentEnabled(config) && config.enclaves?.executors.agent.dynamic !== undefined;
}

/**
 * Whether this run stages immutable seeds at all.
 *
 * A dynamic-only entry reads live GitHub through a per-invocation delegated
 * identity, so it needs no staging credential, no clone, no seed catalog, and
 * no `/awf/seed` mount. Mixed runs (a static entry beside a separate dynamic
 * entry) still stage the static catalog.
 */
export function isEnclaveSeedStagingRequired(config: WrapperConfig): boolean {
  return isEnclavesEnabled(config) && (config.enclaves?.privateRepos.length ?? 0) > 0;
}

export function isEnclaveGithubEnabled(config: WrapperConfig): boolean {
  return (
    isEnclaveAgentEnabled(config)
    && isEnclaveAgentGithubToolsEnabled(config.enclaves?.executors.agent)
  );
}

export interface PrepareEnclavesDeps {
  gitRunner?: GitRunner;
  env?: NodeJS.ProcessEnv;
  assertScriptRuntimeAvailable?: (config: EnclaveScriptExecutorConfig) => Promise<void>;
  assertAgentRuntimeAvailable?: (config: EnclaveAgentExecutorConfig) => Promise<void>;
  assertPrimaryAvailable?: typeof assertPrimaryRuntimeAvailable;
  assertCloudHypervisorPrimaryPreflight?: (config: WrapperConfig) => Promise<void>;
  assertDockerHostPrerequisites?: typeof assertDockerEnclaveHostPrerequisites;
  /** Trusted host integration only. No CLI/config/env switch can supply this provider. */
  cloudHypervisorStorageProvider?: TrustedCloudHypervisorEnclaveStorageProvider;
}

export function preflightEnclaveConfig(config: WrapperConfig, deps: PrepareEnclavesDeps) {
  const enclaves = config.enclaves!;
  const env = deps.env ?? process.env;
  takeStaticGithubExecutorCapability(config, env);
  const staticGithubCapability = getStaticGithubExecutorCapability(config);
  const storageProvider = deps.cloudHypervisorStorageProvider ??
    new ProductionTrustedCloudHypervisorEnclaveStorageProvider();
  // Take custody of the compiler's AWF-only delegation handoff before anything
  // else can inherit this environment, on every run — including static-only
  // runs, where the values must simply be discarded.
  const delegationHandoff = resolveEnclaveDynamicDelegationHandoff(
    takeEnclaveDynamicDelegationHandoff(env),
  );
  const dynamicDeclared = isEnclaveDynamicPolicyDeclared(config);
  const errors = validateEnclavesConfig(config, {
    delegationHandoff,
    requireDelegationHandoff: dynamicDeclared,
  });
  try {
    const gateway = resolveEnclaveGatewayContract(config, env);
    if (!config.networkIsolation) {
      errors.push('enclaves require networkIsolation so the externally launched gateway is attachable');
    }
    if (!config.topologyAttach?.includes(gateway.containerName)) {
      errors.push(
        `enclaves require topologyAttach to include the trusted gateway container "${gateway.containerName}"`,
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'enclave gateway handoff is invalid');
  }
  if (enclaves.executors.script.enabled && enclaves.executors.script.runtime === 'sbx') {
    errors.push('enclaves.executors.script.runtime "sbx" is not implemented and never falls back');
  }
  if (enclaves.executors.agent.enabled && enclaves.executors.agent.runtime === 'sbx') {
    errors.push(
      'enclaves.executors.agent.runtime "sbx" is not implemented: the installed sbx runtime cannot ' +
      'prove every mandatory enclave-isolation control, and enclaves never fall back to Docker or gVisor',
    );
  }
  const dockerHost = config.awfDockerHost ?? env.DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    errors.push(
      'enclave execution requires a Unix-socket Docker host because the enclave MCP server has no network',
    );
  }
  const token = resolveStagingToken(env);
  const seedStagingRequired = isEnclaveSeedStagingRequired(config);
  if (seedStagingRequired && !token) {
    errors.push('enclaves require a staging credential in GH_TOKEN or GITHUB_TOKEN on the AWF host');
  }
  const githubAgentId = staticGithubCapability?.agentId ?? env[ENCLAVE_GITHUB_MCP_AGENT_ID_ENV] ?? '';
  if (isEnclaveGithubEnabled(config)) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(githubAgentId)) {
      errors.push(
        `${ENCLAVE_GITHUB_MCP_AGENT_ID_ENV} must contain the compiler-issued enclave gateway identity`,
      );
    }
  }
  if (isEnclaveGithubEnabled(config) || dynamicDeclared) {
    try {
      resolveEnclaveGithubGatewayContract(config, env);
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : 'enclave GitHub gateway handoff is invalid',
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Enclave configuration is invalid:\n  - ${errors.join('\n  - ')}`);
  }
  if (seedStagingRequired && !token) {
    throw new Error('Enclave staging credential disappeared during preflight');
  }

  const cloudHypervisorSelected = isCloudHypervisorEnclaveSelected(config);
  const dockerSelected = isDockerEnclaveSelected(config);
  return {
    env, storageProvider, delegationHandoff, dynamicDeclared, token, seedStagingRequired,
    staticGithubCapability, githubAgentId, cloudHypervisorSelected, dockerSelected,
  };
}

export type EnclavePreparation = ReturnType<typeof preflightEnclaveConfig>;
