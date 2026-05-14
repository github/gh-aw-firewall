import { isValidIPv4, isValidIPv6 } from '../domain-utils';

const DEFAULT_DOH_RESOLVER = 'https://dns.google/dns-query';

interface LocalhostProcessingResult {
  allowedDomains: string[];
  localhostDetected: boolean;
  shouldEnableHostAccess: boolean;
  defaultPorts?: string;
}

/**
 * Parses and validates DNS servers from a comma-separated string
 */
export function parseDnsServers(input: string): string[] {
  const servers = input
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (servers.length === 0) {
    throw new Error('At least one DNS server must be specified');
  }

  for (const server of servers) {
    if (!isValidIPv4(server) && !isValidIPv6(server)) {
      throw new Error(`Invalid DNS server IP address: ${server}`);
    }
  }

  return servers;
}

/**
 * Parses and validates the --dns-over-https option value.
 */
export function parseDnsOverHttps(
  value: boolean | string | undefined
): { url: string } | { error: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const resolvedUrl: string = value === true ? DEFAULT_DOH_RESOLVER : String(value);
  if (!resolvedUrl.startsWith('https://')) {
    return { error: '--dns-over-https resolver URL must start with https://' };
  }
  return { url: resolvedUrl };
}

/**
 * Processes the localhost keyword in the allowed domains list.
 */
export function processLocalhostKeyword(
  allowedDomains: string[],
  enableHostAccess: boolean,
  allowHostPorts: string | undefined
): LocalhostProcessingResult {
  const localhostIndex = allowedDomains.findIndex(d =>
    d === 'localhost' || d === 'http://localhost' || d === 'https://localhost'
  );

  if (localhostIndex === -1) {
    return {
      allowedDomains,
      localhostDetected: false,
      shouldEnableHostAccess: false,
    };
  }

  // Remove localhost and replace with host.docker.internal
  const localhostValue = allowedDomains[localhostIndex];
  const updatedDomains = [...allowedDomains];
  updatedDomains.splice(localhostIndex, 1);

  // Preserve protocol if specified
  if (localhostValue.startsWith('http://')) {
    updatedDomains.push('http://host.docker.internal');
  } else if (localhostValue.startsWith('https://')) {
    updatedDomains.push('https://host.docker.internal');
  } else {
    updatedDomains.push('host.docker.internal');
  }

  return {
    allowedDomains: updatedDomains,
    localhostDetected: true,
    shouldEnableHostAccess: !enableHostAccess,
    defaultPorts: allowHostPorts ? undefined : '3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090',
  };
}
