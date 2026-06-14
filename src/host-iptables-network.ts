import execa from 'execa';
import { logger } from './logger';
import { getLocalDockerEnv } from './docker-manager';
import { AGENT_IP, API_PROXY_IP, NETWORK_NAME, NETWORK_SUBNET, SQUID_IP } from './host-iptables-shared';

/**
 * Creates the dedicated firewall network if it doesn't exist
 * Returns the firewall subnet and reserved container IPs (squid/agent/proxy)
 */
export async function ensureFirewallNetwork(): Promise<{
  subnet: string;
  squidIp: string;
  agentIp: string;
  proxyIp: string;
}> {
  logger.debug(`Ensuring firewall network '${NETWORK_NAME}' exists...`);

  // Check if network already exists
  let networkExists = false;
  try {
    await execa('docker', ['network', 'inspect', NETWORK_NAME], { env: getLocalDockerEnv() });
    networkExists = true;
    logger.debug(`Network '${NETWORK_NAME}' already exists`);
  } catch {
    // Network doesn't exist
  }

  if (!networkExists) {
    // Network doesn't exist, create it with explicit bridge name
    logger.debug(`Creating network '${NETWORK_NAME}' with subnet ${NETWORK_SUBNET}...`);
    await execa('docker', [
      'network',
      'create',
      NETWORK_NAME,
      '--subnet',
      NETWORK_SUBNET,
      '--opt',
      'com.docker.network.bridge.name=fw-bridge',
    ], { env: getLocalDockerEnv() });
    logger.success(`Created network '${NETWORK_NAME}' with bridge 'fw-bridge'`);
  }

  return {
    subnet: NETWORK_SUBNET,
    squidIp: SQUID_IP,
    agentIp: AGENT_IP,
    proxyIp: API_PROXY_IP,
  };
}
