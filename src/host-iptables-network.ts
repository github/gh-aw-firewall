import execa from 'execa';
import { logger } from './logger';
import { getLocalDockerEnv } from './docker-manager';
import { NETWORK_NAME } from './host-iptables-shared';
import { resolveNetworkAddressing } from './network-subnet';

/**
 * Creates the dedicated firewall network if it doesn't exist
 * Returns the firewall subnet and reserved container IPs (squid/agent/proxy)
 *
 * @param subnetOverride Optional `--network-subnet` CIDR replacing the default.
 */
export async function ensureFirewallNetwork(subnetOverride?: string): Promise<{
  subnet: string;
  squidIp: string;
  agentIp: string;
  proxyIp: string;
}> {
  const addressing = resolveNetworkAddressing(subnetOverride);
  logger.debug(`Ensuring firewall network '${NETWORK_NAME}' exists...`);

  // Check if network already exists
  let networkExists = false;
  let existingSubnet: string | undefined;
  try {
    const { stdout } = await execa(
      'docker',
      [
        'network',
        'inspect',
        NETWORK_NAME,
        '--format',
        '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
      ],
      { env: getLocalDockerEnv() },
    );
    networkExists = true;
    existingSubnet = stdout.trim().split(/\s+/).filter(Boolean)[0];
    logger.debug(`Network '${NETWORK_NAME}' already exists (subnet: ${existingSubnet ?? 'unknown'})`);
  } catch {
    // Network doesn't exist
  }

  // A pre-existing network with a different subnet cannot host the addresses we
  // are about to program into iptables and Compose, so fail loudly instead of
  // silently using IPs that do not exist on it.
  if (networkExists && existingSubnet && existingSubnet !== addressing.subnet) {
    throw new Error(
      `Docker network '${NETWORK_NAME}' already exists with subnet ${existingSubnet}, ` +
      `but ${addressing.subnet} was requested. Remove the stale network ` +
      `(docker network rm ${NETWORK_NAME}) or drop the --network-subnet override.`,
    );
  }

  if (!networkExists) {
    // Network doesn't exist, create it with explicit bridge name
    logger.debug(`Creating network '${NETWORK_NAME}' with subnet ${addressing.subnet}...`);
    await execa('docker', [
      'network',
      'create',
      NETWORK_NAME,
      '--subnet',
      addressing.subnet,
      '--opt',
      'com.docker.network.bridge.name=fw-bridge',
    ], { env: getLocalDockerEnv() });
    logger.success(`Created network '${NETWORK_NAME}' with bridge 'fw-bridge'`);
  }

  return {
    subnet: addressing.subnet,
    squidIp: addressing.squidIp,
    agentIp: addressing.agentIp,
    proxyIp: addressing.proxyIp,
  };
}
