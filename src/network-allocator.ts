import execa from 'execa';
import { logger } from './logger';
import { getLocalDockerEnv, subnetsOverlap } from './host-env';

export async function getExistingDockerSubnets(): Promise<string[]> {
  try {
    // Get all network IDs
    const { stdout: networkIds } = await execa('docker', ['network', 'ls', '-q'], { env: getLocalDockerEnv() });
    if (!networkIds.trim()) {
      return [];
    }

    // Get subnet information for each network
    const { stdout } = await execa('docker', [
      'network',
      'inspect',
      '--format={{range .IPAM.Config}}{{.Subnet}} {{end}}',
      ...networkIds.trim().split('\n'),
    ], { env: getLocalDockerEnv() });

    // Parse subnets from output (format: "172.17.0.0/16 172.18.0.0/16 ")
    const subnets = stdout
      .split(/\s+/)
      .filter((s) => s.includes('/'))
      .map((s) => s.trim());

    logger.debug(`Found existing Docker subnets: ${subnets.join(', ')}`);
    return subnets;
  } catch {
    logger.debug('Failed to query Docker networks, proceeding with random subnet');
    return [];
  }
}

/**
 * Generates a random subnet in Docker's private IP range that doesn't conflict with existing networks
 * Uses 172.16-31.x.0/24 range (Docker's default bridge network range)
 * @internal
 */
export async function generateRandomSubnet(): Promise<{ subnet: string; squidIp: string; agentIp: string }> {
  const existingSubnets = await getExistingDockerSubnets();
  const MAX_RETRIES = 50;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Use 172.16-31.x.0/24 range
    const secondOctet = Math.floor(Math.random() * 16) + 16; // 16-31
    const thirdOctet = Math.floor(Math.random() * 256); // 0-255
    const subnet = `172.${secondOctet}.${thirdOctet}.0/24`;

    // Check for conflicts with existing subnets
    const hasConflict = existingSubnets.some((existingSubnet) =>
      subnetsOverlap(subnet, existingSubnet)
    );

    if (!hasConflict) {
      const squidIp = `172.${secondOctet}.${thirdOctet}.10`;
      const agentIp = `172.${secondOctet}.${thirdOctet}.20`;
      return { subnet, squidIp, agentIp };
    }

    logger.debug(`Subnet ${subnet} conflicts with existing network, retrying... (attempt ${attempt + 1}/${MAX_RETRIES})`);
  }

  throw new Error(
    `Failed to generate non-conflicting subnet after ${MAX_RETRIES} attempts. ` +
    `Existing subnets: ${existingSubnets.join(', ')}`
  );
}
