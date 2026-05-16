import type { CaFiles } from './ssl-bump';

// Re-export from focused modules for backward compatibility.
export {
  SQUID_PORT,
  AGENT_CONTAINER_NAME,
  SQUID_CONTAINER_NAME,
  IPTABLES_INIT_CONTAINER_NAME,
  API_PROXY_CONTAINER_NAME,
  DOH_PROXY_CONTAINER_NAME,
  CLI_PROXY_CONTAINER_NAME,
  MAX_ENV_VALUE_SIZE,
  ENV_SIZE_WARNING_THRESHOLD,
} from './constants';

export {
  setAwfDockerHost,
  getLocalDockerEnv,
} from './docker-host';

export {
  ACT_PRESET_BASE_IMAGE,
  MIN_REGULAR_UID,
  validateIdNotInSystemRange,
  getSafeHostUid,
  getSafeHostGid,
  getRealUserHome,
} from './host-identity';

export {
  extractGhHostFromServerUrl,
  readGitHubPathEntries,
  readGitHubEnvEntries,
  parseGitHubEnvFile,
  TOOLCHAIN_ENV_VARS,
  mergeGitHubPathEntries,
  readEnvFile,
} from './github-env';

/**
 * Checks if two subnets overlap
 * Returns true if the new subnet conflicts with an existing subnet
 */
function subnetsOverlap(subnet1: string, subnet2: string): boolean {
  // Parse CIDR notation: "172.17.0.0/16" -> ["172.17.0.0", "16"]
  const [ip1, cidr1] = subnet1.split('/');
  const [ip2, cidr2] = subnet2.split('/');

  // Convert IP to number
  const ipToNumber = (ip: string): number => {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
  };

  // Calculate network address and broadcast address for a subnet
  const getNetworkRange = (ip: string, cidr: string): [number, number] => {
    const ipNum = ipToNumber(ip);
    const maskBits = parseInt(cidr, 10);
    const mask = (0xffffffff << (32 - maskBits)) >>> 0;
    const networkAddr = (ipNum & mask) >>> 0;
    const broadcastAddr = (networkAddr | ~mask) >>> 0;
    return [networkAddr, broadcastAddr];
  };

  const [start1, end1] = getNetworkRange(ip1, cidr1);
  const [start2, end2] = getNetworkRange(ip2, cidr2);

  // Check if ranges overlap
  return (start1 <= end2 && end1 >= start2);
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const testHelpers = { subnetsOverlap };

/**
 * SSL configuration for Docker Compose (when SSL Bump is enabled)
 */
export interface SslConfig {
  caFiles: CaFiles;
  sslDbPath: string;
}

/**
 * Normalizes an API target value to a bare hostname.
 * API target values should be bare hostnames (e.g., "api.openai.com"), but
 * may arrive with a scheme or path when set via GitHub Actions expressions
 * that are resolved at runtime (see github/gh-aw#25137).
 * Discards any scheme, path, query, fragment, credentials, or port —
 * path prefixes must use the separate *_API_BASE_PATH settings.
 */
export function stripScheme(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    return new URL(candidate).hostname || trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Parses a host:port string into separate host and port components.
 * Supports IPv6 bracketed notation (e.g., [::1]:18443), plain host:port,
 * and optional scheme prefixes.
 * Defaults to host.docker.internal:18443 for empty/missing values.
 */
export function parseDifcProxyHost(value: string): { host: string; port: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { host: 'host.docker.internal', port: '18443' };
  }
  // Use URL to parse host:port correctly (handles IPv6 brackets).
  // Always normalise to tcp:// so the WHATWG URL parser never drops a port
  // that happens to be the default for a scheme (e.g. 443 for https://).
  const hostPart = trimmed.replace(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//, '');
  const candidate = `tcp://${hostPart}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid --difc-proxy-host value: "${value}". Expected host:port format.`);
  }
  // URL.hostname returns IPv6 addresses with surrounding brackets; strip them.
  const rawHost = parsed.hostname || 'host.docker.internal';
  const host = rawHost.replace(/^\[(.+)\]$/, '$1');
  const port = parsed.port || '18443';
  if (!/^\d+$/.test(port)) {
    throw new Error(`Invalid --difc-proxy-host port: "${port}". Must be a number.`);
  }
  const portNum = Number(port);
  if (portNum < 1 || portNum > 65535) {
    throw new Error(`Invalid --difc-proxy-host port: ${portNum}. Must be between 1 and 65535.`);
  }
  return { host, port: String(portNum) };
}
