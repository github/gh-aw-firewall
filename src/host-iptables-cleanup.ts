import { logger } from './logger';
import {
  CHAIN_NAME,
  CHAIN_NAME_V6,
  cleanupChain,
  enableIpv6ViaSysctl,
  getNetworkBridgeName,
  isIp6tablesAvailable,
} from './host-iptables-shared';

/**
 * Cleans up host-level iptables rules (both IPv4 and IPv6)
 */
export async function cleanupHostIptables(): Promise<void> {
  logger.debug('Cleaning up host-level iptables rules...');

  try {
    // Get the bridge name
    const bridgeName = await getNetworkBridgeName();

    await cleanupChain('iptables', CHAIN_NAME, {
      removeDockerUserReferences: Boolean(bridgeName),
      matchPredicate: bridgeName
        ? (line: string) => (line.includes(`-i ${bridgeName}`) || line.includes(`-o ${bridgeName}`)) && line.includes(CHAIN_NAME)
        : undefined,
    });

    logger.debug('IPv4 iptables rules cleaned up');

    // Clean up IPv6 rules (only if ip6tables is available)
    const ip6tablesAvailable = await isIp6tablesAvailable();
    if (ip6tablesAvailable) {
      await cleanupChain('ip6tables', CHAIN_NAME_V6, {
        removeDockerUserReferences: Boolean(bridgeName),
      });

      logger.debug('IPv6 ip6tables rules cleaned up');
    } else {
      logger.debug('ip6tables not available, skipping IPv6 cleanup');
    }

    // Re-enable IPv6 if it was disabled via sysctl
    await enableIpv6ViaSysctl();

    logger.debug('Host-level iptables rules cleaned up');
  } catch (error) {
    logger.debug('Error cleaning up iptables rules:', error);
    // Don't throw - cleanup should be best-effort
  }
}
