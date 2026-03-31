import * as fs from 'fs';
import { logger as defaultLogger } from './logger';

type Logger = typeof defaultLogger;

/** Docker's embedded DNS resolver — always allowed but never used as upstream */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DOCKER_EMBEDDED_DNS = '127.0.0.11';

/** Local stub resolvers (systemd-resolved, dnsmasq) that can't be used inside containers */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const LOCAL_STUB_RESOLVERS = ['127.0.0.1', '127.0.0.53'];

/** Fallback when no usable resolvers are detected on the host */
export const DEFAULT_DNS_SERVERS = ['8.8.8.8', '8.8.4.4'];

/**
 * Paths to try for resolv.conf, in priority order.
 * systemd-resolved's upstream config first (has real upstream servers),
 * then the standard resolv.conf (may contain 127.0.0.53 stub).
 */
const RESOLV_CONF_PATHS = ['/run/systemd/resolve/resolv.conf', '/etc/resolv.conf'];

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

function isValidIp(ip: string): boolean {
  return IPV4_REGEX.test(ip) || ip.includes(':');
}

function isLoopback(ip: string): boolean {
  // 127.0.0.0/8 for IPv4
  if (ip.startsWith('127.')) return true;
  // ::1 for IPv6
  if (ip === '::1') return true;
  return false;
}

/**
 * Parse nameserver entries from resolv.conf content.
 * Pure function — no I/O.
 */
export function parseResolvConf(content: string): string[] {
  const servers: string[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^nameserver\s+(\S+)/);
    if (match) {
      const ip = match[1];
      if (isValidIp(ip)) {
        servers.push(ip);
      }
    }
  }
  return servers;
}

/**
 * Detect usable DNS servers from the host's resolv.conf files.
 * Filters out loopback addresses (127.0.0.0/8, ::1) since those point to
 * local stub resolvers that won't be reachable from inside a container.
 * Falls back to DEFAULT_DNS_SERVERS if no usable servers are found.
 */
export function detectHostDnsServers(logger?: Logger): string[] {
  const log = logger ?? defaultLogger;

  for (const filePath of RESOLV_CONF_PATHS) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      log.debug(`DNS auto-detect: could not read ${filePath}, trying next`);
      continue;
    }

    const allServers = parseResolvConf(content);
    const usable = allServers.filter(ip => !isLoopback(ip));

    if (usable.length > 0) {
      log.info(`Auto-detected DNS servers from ${filePath}: ${usable.join(', ')}`);
      return usable;
    }

    log.debug(`DNS auto-detect: ${filePath} had no usable servers after filtering loopback addresses`);
  }

  log.warn(`Could not detect host DNS servers; falling back to ${DEFAULT_DNS_SERVERS.join(', ')}`);
  return DEFAULT_DNS_SERVERS;
}

/**
 * Return the effective DNS server list.
 * If the user explicitly passed --dns-servers, use those.
 * Otherwise, auto-detect from the host.
 */
export function getEffectiveDnsServers(explicit: string[] | undefined, logger?: Logger): string[] {
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  return detectHostDnsServers(logger);
}
