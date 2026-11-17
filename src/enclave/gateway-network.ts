import execa from 'execa';
import { isIPv4 } from 'node:net';
import { ENCLAVE_MCP_SERVER_CONTAINER_NAME } from '../constants';
import { getLocalDockerEnv } from '../docker-host';
import type { WrapperConfig } from '../types';
import { updateEnclaveStartupProgress } from './startup-progress';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import {
  ENCLAVE_MCP_CONTROL_ALIAS,
  ENCLAVE_MCP_CONTROL_NETWORK,
} from './network';
import {
  ENCLAVE_MCP_GATEWAY_RUN_LABEL,
  resolveEnclaveGatewayContract,
  type EnclaveGatewayContract,
} from './gateway-contract';

export async function inspectGateway(contract: EnclaveGatewayContract): Promise<void> {
  const result = await execa(
    'docker',
    ['inspect', '--format', '{{json .}}', contract.containerName],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Trusted enclave MCP gateway container is unavailable');
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
    throw new Error('Trusted enclave MCP gateway identity could not be inspected');
  }
  if (
    inspected.Name !== `/${contract.containerName}`
    || inspected.State?.Running !== true
    || inspected.Config?.Labels?.[ENCLAVE_MCP_GATEWAY_RUN_LABEL] !== contract.identity
    || inspected.HostConfig?.NetworkMode !== 'bridge'
  ) {
    throw new Error('Trusted enclave MCP gateway identity did not match the compiler handoff');
  }
}

async function assertControlNetworkMembership(contract: EnclaveGatewayContract): Promise<string> {
  const result = await execa(
    'docker',
    ['network', 'inspect', '--format', '{{json .Containers}}', ENCLAVE_MCP_CONTROL_NETWORK],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Enclave MCP control network is unavailable');
  }
  let containers: Record<string, { Name?: string; IPv4Address?: string }>;
  try {
    containers = JSON.parse(result.stdout);
  } catch {
    throw new Error('Enclave MCP control network membership could not be inspected');
  }
  const names = Object.values(containers).map((entry) => entry.Name).filter(Boolean).sort();
  const expected = [ENCLAVE_MCP_SERVER_CONTAINER_NAME, contract.containerName].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `Enclave MCP control network contains unexpected members `
      + `(expected: ${expected.join(', ')}; actual: ${names.join(', ') || '<none>'})`,
    );
  }
  const server = Object.values(containers).find(
    (entry) => entry.Name === ENCLAVE_MCP_SERVER_CONTAINER_NAME,
  );
  const serverIp = server?.IPv4Address?.split('/')[0];
  if (!serverIp || !isIPv4(serverIp)) {
    throw new Error('Enclave MCP server address could not be verified');
  }
  return serverIp;
}

// mcpg starts on Docker's default bridge, so later network attachment does not
// give its resolver Docker's private-network service discovery.
async function configureGatewayHostResolution(
  contract: EnclaveGatewayContract,
  serverIp: string,
): Promise<void> {
  const result = await execa(
    'docker',
    [
      'exec',
      '--user',
      '0',
      contract.containerName,
      '/bin/sh',
      '-c',
      // Docker bind-mounts /etc/hosts, so rewrite its contents without renaming it.
      `hosts=$(sed -e "/[[:space:]]$2[[:space:]]/d" -e "/[[:space:]]$2$/d" /etc/hosts) && printf "%s\\n%s %s\\n" "$hosts" "$1" "$2" > /etc/hosts`,
      'awf-enclave-hosts',
      serverIp,
      ENCLAVE_MCP_CONTROL_ALIAS,
    ],
    { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error('Failed to configure private enclave service resolution for the trusted gateway');
  }
}

export async function connectEnclaveGateway(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const report = new HostPreflightReporter('gateway-attachment', (hostPreflight) =>
    updateEnclaveStartupProgress(config, { hostPreflight }));
  const contract = await report.check('contract', () => resolveEnclaveGatewayContract(config, env));
  await report.check('identity', () => inspectGateway(contract));
  await report.check('network-connect', async () => {
    const connected = await execa(
      'docker',
      ['network', 'connect', ENCLAVE_MCP_CONTROL_NETWORK, contract.containerName],
      { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
    );
    if (
      connected.exitCode !== 0
      && !/already exists in network|is already attached|already connected/i.test(connected.stderr || '')
    ) {
      throw new Error('Failed to attach the trusted enclave MCP gateway to its private control network');
    }
  });
  try {
    await report.check('network-membership', async () => {
      const serverIp = await assertControlNetworkMembership(contract);
      await configureGatewayHostResolution(contract, serverIp);
    });
  } catch (error) {
    // Leave the fixed-name control network reusable by startup retries.
    await execa(
      'docker',
      ['network', 'disconnect', '-f', ENCLAVE_MCP_CONTROL_NETWORK, contract.containerName],
      { env: getLocalDockerEnv(), reject: false, timeout: 10_000 },
    );
    throw error;
  }
}
