import execa from 'execa';
import { getLocalDockerEnv } from '../docker-host';
import type { WrapperConfig } from '../types';
import { ENCLAVE_MCP_READINESS_TIMEOUT_ENV } from './gateway';
import {
  isEnclaveGithubEnabled,
  resolveEnclaveGithubGatewayContract,
} from './github-gateway-contract';
import {
  DEFAULT_READINESS_TIMEOUT_MS,
  GithubGatewayReadinessError,
  postJsonRpc,
  proveGithubGatewayReadiness,
  RETRY_DELAY_MS,
} from './github-gateway-mcp-client';
import {
  assertAgentNetworkMembership,
  assertSharedGatewayAttachment,
  inspectSharedGateway,
} from './github-gateway-network';
import {
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_AGENT_NETWORK,
  ENCLAVE_GITHUB_MCP_ALIAS,
} from './network';

export {
  ENCLAVE_GITHUB_MCP_INTERNAL_URL,
  ENCLAVE_GITHUB_MCP_SERVER_NAME,
  resolveEnclaveGithubGatewayContract,
} from './github-gateway-contract';
export { ENCLAVE_GITHUB_MCP_PORT } from './network';
export { ENCLAVE_GITHUB_MCP_AGENT_ID_ENV } from './static-github-handoff';

export async function connectEnclaveGithubGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isEnclaveGithubEnabled(config)) return;
  const contract = resolveEnclaveGithubGatewayContract(config, env);
  await inspectSharedGateway(contract);
  const result = await execa(
    'docker',
    [
      'network',
      'connect',
      '--ip',
      ENCLAVE_AGENT_GITHUB_MCP_IP,
      '--alias',
      ENCLAVE_GITHUB_MCP_ALIAS,
      ENCLAVE_AGENT_NETWORK,
      contract.containerName,
    ],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (
    result.exitCode !== 0
    && !/already exists in network|is already attached|already connected/i.test(result.stderr || '')
  ) {
    throw new Error('Failed to attach the shared MCP gateway to the enclave agent network');
  }
  await assertAgentNetworkMembership(contract);
  await assertSharedGatewayAttachment(contract);
}

export async function assertEnclaveGithubGatewayReady(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): Promise<void> {
  if (!isEnclaveGithubEnabled(config)) return;
  const contract = resolveEnclaveGithubGatewayContract(config, env);
  const configuredTimeout = Number(env[ENCLAVE_MCP_READINESS_TIMEOUT_ENV]
    ?? DEFAULT_READINESS_TIMEOUT_MS);
  const readinessTimeout = timeoutMs ?? configuredTimeout;
  if (
    !Number.isSafeInteger(readinessTimeout)
    || readinessTimeout < 1_000
    || readinessTimeout > 600_000
  ) {
    throw new Error(`${ENCLAVE_MCP_READINESS_TIMEOUT_ENV} must be between 1000 and 600000`);
  }
  const deadline = Date.now() + readinessTimeout;
  let lastError: unknown;
  do {
    try {
      await proveGithubGatewayReadiness(config, contract, deadline);
      return;
    } catch (error) {
      if (!(error instanceof GithubGatewayReadinessError) || !error.retryable) throw error;
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, Math.min(RETRY_DELAY_MS, remaining)));
      }
    }
  } while (Date.now() < deadline);
  throw new Error(
    `Enclave GitHub MCP readiness timed out before primary-agent startup: ${
      lastError instanceof Error ? lastError.message : 'unknown readiness failure'
    }`,
  );
}

export async function disconnectEnclaveGithubGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!isEnclaveGithubEnabled(config) || config.keepContainers) return;
  const contract = resolveEnclaveGithubGatewayContract(config, env);
  const result = await execa(
    'docker',
    ['network', 'disconnect', '-f', ENCLAVE_AGENT_NETWORK, contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Failed to disconnect the shared MCP gateway from the enclave agent network');
  }
}

export const enclaveGithubGatewayTestHelpers = {
  assertAgentNetworkMembership,
  assertSharedGatewayAttachment,
  inspectSharedGateway,
  postJsonRpc,
};
