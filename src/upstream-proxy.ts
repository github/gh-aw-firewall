/**
 * Upstream proxy auto-detection and validation.
 *
 * Reads host http_proxy/https_proxy/no_proxy environment variables and
 * produces a validated UpstreamProxyConfig for Squid cache_peer chaining.
 */

import { UpstreamProxyConfig } from './types';
import { logger } from './logger';

/**
 * All proxy-related environment variable names that should be excluded
 * from container passthrough to prevent conflicts with AWF's internal routing.
 */
export const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

/**
 * Parses a proxy URL into host and port. Rejects unsupported features.
 *
 * @param url - Proxy URL (e.g., "http://proxy.corp.com:3128")
 * @returns Parsed host and port
 * @throws Error if the URL contains credentials, is malformed, or uses an unsupported scheme
 */
export function parseProxyUrl(url: string): { host: string; port: number } {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error('Upstream proxy URL is empty');
  }

  // Normalize: add scheme if missing (common for proxy env vars like "proxy:3128")
  let normalized = trimmed;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid upstream proxy URL: ${trimmed}`);
  }

  // Reject credentials — they would leak into audit artifacts (squid.conf is not redacted)
  if (parsed.username || parsed.password) {
    throw new Error(
      'Upstream proxy URL contains credentials (user:pass@), which are not supported in v1. ' +
      'Configure proxy authentication on the proxy server itself, or use a proxy that does not require auth.'
    );
  }

  // Only HTTP scheme is supported for cache_peer (Squid uses HTTP CONNECT for HTTPS tunnels)
  if (parsed.protocol !== 'http:') {
    throw new Error(
      `Upstream proxy URL uses unsupported scheme "${parsed.protocol}". ` +
      'Only HTTP proxies are supported (Squid uses HTTP CONNECT for HTTPS tunnels).'
    );
  }

  const host = parsed.hostname;
  if (!host) {
    throw new Error(`Upstream proxy URL has no hostname: ${trimmed}`);
  }

  // Sanitize: reject values that could inject into squid.conf
  if (/[\s#;'"\\]/.test(host)) {
    throw new Error(`Upstream proxy hostname contains invalid characters: ${host}`);
  }

  // Reject loopback addresses — Squid runs in a container and localhost != host localhost
  const loopbackPatterns = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
  if (loopbackPatterns.includes(host.toLowerCase())) {
    throw new Error(
      `Upstream proxy "${host}" is a loopback address. Squid runs in a Docker container ` +
      'where localhost refers to the container, not the host. ' +
      'Use the host machine\'s network IP or configure --enable-host-access with host.docker.internal.'
    );
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : 3128;
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid upstream proxy port: ${parsed.port}`);
  }

  return { host, port };
}

/**
 * Parses a no_proxy string into validated domain suffixes.
 * Non-domain entries (IPs, CIDRs, wildcards, ports) are logged as warnings.
 *
 * @param noProxy - Comma-separated no_proxy value (e.g., "localhost,.corp.com,10.0.0.0/8")
 * @returns Array of validated domain suffixes
 */
export function parseNoProxy(noProxy: string): string[] {
  if (!noProxy.trim()) return [];

  const entries = noProxy.split(',').map(e => e.trim()).filter(e => e.length > 0);
  const domains: string[] = [];

  for (const entry of entries) {
    // Skip loopback (irrelevant for Squid upstream bypass)
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(entry.toLowerCase())) {
      continue;
    }

    // Skip wildcard '*' (means "bypass everything" — contradicts having an upstream proxy)
    if (entry === '*') {
      logger.warn('Ignoring no_proxy wildcard "*" — it would bypass the upstream proxy for all traffic');
      continue;
    }

    // Skip IP addresses (v4)
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\/\d{1,2})?$/.test(entry)) {
      logger.warn(`Ignoring no_proxy IP/CIDR "${entry}" — only domain suffixes are supported for upstream proxy bypass`);
      continue;
    }

    // Skip IPv6 addresses
    if (entry.includes(':') || entry.startsWith('[')) {
      logger.warn(`Ignoring no_proxy IPv6 entry "${entry}" — only domain suffixes are supported for upstream proxy bypass`);
      continue;
    }

    // Skip entries with ports (e.g., "host:8080")
    if (/:\d+$/.test(entry)) {
      logger.warn(`Ignoring no_proxy entry with port "${entry}" — port-based bypass is not supported for upstream proxy`);
      continue;
    }

    // Sanitize: reject values that could inject into squid.conf
    if (/[\s#;'"\\]/.test(entry)) {
      logger.warn(`Ignoring no_proxy entry with invalid characters: "${entry}"`);
      continue;
    }

    // Valid domain suffix (e.g., ".corp.com" or "internal.example.com")
    domains.push(entry);
  }

  return domains;
}

/**
 * Auto-detects upstream proxy configuration from host environment variables.
 *
 * Reads https_proxy/HTTPS_PROXY (preferred) or http_proxy/HTTP_PROXY.
 * If both are set and differ, throws an error requiring --upstream-proxy.
 *
 * @param env - Environment variables to inspect (defaults to process.env)
 * @returns Upstream proxy config, or undefined if no proxy is detected
 */
export function detectUpstreamProxy(env: Record<string, string | undefined> = process.env): UpstreamProxyConfig | undefined {
  // Read proxy URLs (prefer lowercase per convention, then uppercase)
  const httpsProxy = (env.https_proxy || env.HTTPS_PROXY || '').trim();
  const httpProxy = (env.http_proxy || env.HTTP_PROXY || '').trim();

  // No proxy configured
  if (!httpsProxy && !httpProxy) {
    return undefined;
  }

  // If both are set and differ, we can't determine which to use
  if (httpsProxy && httpProxy && httpsProxy !== httpProxy) {
    throw new Error(
      'Host has different http_proxy and https_proxy values. ' +
      'AWF cannot determine which upstream proxy to use. ' +
      `Use --upstream-proxy to specify explicitly.\n` +
      `  http_proxy:  ${httpProxy}\n` +
      `  https_proxy: ${httpsProxy}`
    );
  }

  const proxyUrl = httpsProxy || httpProxy;
  const { host, port } = parseProxyUrl(proxyUrl);

  // Parse no_proxy
  const noProxyStr = (env.no_proxy || env.NO_PROXY || '').trim();
  const noProxy = parseNoProxy(noProxyStr);

  logger.info(`Detected upstream proxy: ${host}:${port}`);
  if (noProxy.length > 0) {
    logger.debug(`Upstream proxy bypass domains: ${noProxy.join(', ')}`);
  }

  return { host, port, ...(noProxy.length > 0 ? { noProxy } : {}) };
}
