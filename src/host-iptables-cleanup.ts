import execa from 'execa';
import { logger } from './logger';
import {
  CHAIN_NAME,
  CHAIN_NAME_V6,
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

    // Clean up IPv4 rules
    if (bridgeName) {
      // Find and remove the rule that jumps to our chain
      const { stdout } = await execa('iptables', [
        '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
      ], { reject: false });

      // Parse line numbers for rules that reference our bridge
      const lines = stdout.split('\n');
      const lineNumbers: number[] = [];
      for (const line of lines) {
        if ((line.includes(`-i ${bridgeName}`) || line.includes(`-o ${bridgeName}`)) && line.includes(CHAIN_NAME)) {
          const match = line.match(/^(\d+)/);
          if (match) {
            lineNumbers.push(parseInt(match[1], 10));
          }
        }
      }

      // Delete rules in reverse order (to maintain line numbers)
      for (const lineNum of lineNumbers.reverse()) {
        logger.debug(`Removing rule ${lineNum} from DOCKER-USER (IPv4)`);
        await execa('iptables', [
          '-t', 'filter', '-D', 'DOCKER-USER', lineNum.toString(),
        ], { reject: false });
      }
    }

    // Flush and delete our custom IPv4 chain
    await execa('iptables', ['-t', 'filter', '-F', CHAIN_NAME], { reject: false });
    await execa('iptables', ['-t', 'filter', '-X', CHAIN_NAME], { reject: false });

    logger.debug('IPv4 iptables rules cleaned up');

    // Clean up IPv6 rules (only if ip6tables is available)
    const ip6tablesAvailable = await isIp6tablesAvailable();
    if (ip6tablesAvailable) {
      if (bridgeName) {
        const { stdout: stdout6 } = await execa('ip6tables', [
          '-t', 'filter', '-L', 'DOCKER-USER', '-n', '--line-numbers',
        ], { reject: false });

        const lines6 = stdout6.split('\n');
        const lineNumbers6: number[] = [];
        for (const line of lines6) {
          if (line.includes(CHAIN_NAME_V6)) {
            const match = line.match(/^(\d+)/);
            if (match) {
              lineNumbers6.push(parseInt(match[1], 10));
            }
          }
        }

        for (const lineNum of lineNumbers6.reverse()) {
          logger.debug(`Removing rule ${lineNum} from DOCKER-USER (IPv6)`);
          await execa('ip6tables', [
            '-t', 'filter', '-D', 'DOCKER-USER', lineNum.toString(),
          ], { reject: false });
        }
      }

      // Flush and delete our custom IPv6 chain
      await execa('ip6tables', ['-t', 'filter', '-F', CHAIN_NAME_V6], { reject: false });
      await execa('ip6tables', ['-t', 'filter', '-X', CHAIN_NAME_V6], { reject: false });

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
