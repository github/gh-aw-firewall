import execa from 'execa';
import { logger } from '../logger';

const IPV4_REGEX = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Resolves the IP address that Docker will use for the `host-gateway` special
 * string (i.e., what `host.docker.internal` maps to inside containers with
 * `extra_hosts: ['host.docker.internal:host-gateway']`).
 *
 * This is needed because the iptables-init container shares the agent's network
 * namespace (`network_mode: service:agent`) but NOT its mount namespace, so it
 * has no `/etc/hosts` entry for `host.docker.internal`. Without this value,
 * `setup-iptables.sh` cannot create the NAT bypass rules for the correct host IP,
 * causing MCP gateway traffic to be DNAT'd to Squid where it fails.
 *
 * Detection order:
 *   1. Default bridge network gateway (`docker network inspect bridge`)
 *   2. Host default-route source IP (`ip route get 1.1.1.1`)
 *
 * Returns the resolved IPv4 address, or undefined if detection fails.
 */
export function resolveDockerHostGateway(): string | undefined {
  // Method 1: Docker bridge network gateway (matches most Docker setups)
  try {
    const { stdout } = execa.sync('docker', [
      'network', 'inspect', 'bridge',
      '-f', '{{(index .IPAM.Config 0).Gateway}}',
    ], { timeout: 5000, maxBuffer: 1024 });
    const ip = stdout.trim();
    if (ip && IPV4_REGEX.test(ip)) {
      logger.debug(`Resolved Docker host-gateway IP via bridge network: ${ip}`);
      return ip;
    }
  } catch (err) {
    logger.debug(`Could not inspect Docker bridge network: ${err}`);
  }

  // Method 2: Host default-route source IP (Linux fallback)
  try {
    const { stdout } = execa.sync('ip', [
      'route', 'get', '1.1.1.1',
    ], { timeout: 5000, maxBuffer: 1024 });
    const match = stdout.match(/src\s+(\d+\.\d+\.\d+\.\d+)/);
    if (match?.[1] && IPV4_REGEX.test(match[1])) {
      logger.debug(`Resolved Docker host-gateway IP via default route: ${match[1]}`);
      return match[1];
    }
  } catch (err) {
    logger.debug(`Could not detect host default-route source IP: ${err}`);
  }

  logger.debug('Could not resolve Docker host-gateway IP');
  return undefined;
}
