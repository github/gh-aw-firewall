import execa from 'execa';
import { ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../docker-host';
import { ENCLAVE_MCP_GATEWAY_RUN_LABEL } from './gateway';
import type { EnclaveGithubGatewayContract } from './github-gateway-contract';
import {
  ENCLAVE_AGENT_GITHUB_MCP_IP,
  ENCLAVE_AGENT_NETWORK,
  ENCLAVE_AGENT_SUBNET,
  ENCLAVE_GITHUB_MCP_ALIAS,
} from './network';

export async function inspectSharedGateway(contract: EnclaveGithubGatewayContract): Promise<void> {
  const result = await execa(
    'docker',
    ['inspect', '--format', '{{json .}}', contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Trusted shared MCP gateway container is unavailable');
  }
  let inspected: {
    Name?: string;
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> };
    HostConfig?: { NetworkMode?: string };
  };
  try {
    inspected = JSON.parse(result.stdout);
  } catch {
    throw new Error('Trusted shared MCP gateway identity could not be inspected');
  }
  if (
    inspected.Name !== `/${contract.containerName}`
    || inspected.State?.Running !== true
    || inspected.Config?.Labels?.[ENCLAVE_MCP_GATEWAY_RUN_LABEL] !== contract.identity
    || inspected.HostConfig?.NetworkMode !== 'bridge'
  ) {
    throw new Error('Trusted shared MCP gateway did not match the compiler handoff');
  }
}

export async function assertAgentNetworkMembership(
  contract: EnclaveGithubGatewayContract,
): Promise<void> {
  const result = await execa(
    'docker',
    ['network', 'inspect', '--format', '{{json .}}', ENCLAVE_AGENT_NETWORK],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Enclave agent network is unavailable');
  }
  let network: {
    Internal?: boolean;
    Driver?: string;
    IPAM?: { Config?: Array<{ Subnet?: string }> };
    Containers?: Record<string, { Name?: string }>;
  };
  try {
    network = JSON.parse(result.stdout);
  } catch {
    throw new Error('Enclave agent network membership could not be inspected');
  }
  const subnetConfig = network.IPAM?.Config ?? [];
  if (
    network.Internal !== true
    || network.Driver !== 'bridge'
    || subnetConfig.length !== 1
    || subnetConfig[0]?.Subnet !== ENCLAVE_AGENT_SUBNET
  ) {
    throw new Error('Enclave agent network is not the fixed isolated bridge');
  }
  const names = Object.values(network.Containers ?? {})
    .map((entry) => entry.Name)
    .filter(Boolean)
    .sort();
  const expected = [ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME, contract.containerName].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error('Enclave agent network contains an unexpected steady-state member');
  }
}

export async function assertSharedGatewayAttachment(
  contract: EnclaveGithubGatewayContract,
): Promise<void> {
  const result = await execa(
    'docker',
    ['inspect', '--format', '{{json .}}', contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Shared MCP gateway network attachment is unavailable');
  }
  let inspected: {
    NetworkSettings?: {
      Networks?: Record<string, { Aliases?: string[] | null; IPAddress?: string }>;
    };
  };
  try {
    inspected = JSON.parse(result.stdout);
  } catch {
    throw new Error('Shared MCP gateway network attachment could not be inspected');
  }
  const attachment = inspected.NetworkSettings?.Networks?.[ENCLAVE_AGENT_NETWORK];
  if (
    !Array.isArray(attachment?.Aliases)
    || !attachment.Aliases.includes(ENCLAVE_GITHUB_MCP_ALIAS)
    || attachment.IPAddress !== ENCLAVE_AGENT_GITHUB_MCP_IP
  ) {
    throw new Error('Shared MCP gateway is missing its fixed enclave attachment');
  }
}
