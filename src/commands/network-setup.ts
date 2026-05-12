import { logger } from '../logger';
import { detectHostDnsServers } from '../dns-resolver';
import { detectUpstreamProxy, parseProxyUrl, parseNoProxy } from '../upstream-proxy';
import { parseDnsServers, parseDnsOverHttps } from '../option-parsers';
import { UpstreamProxyConfig } from '../types';

/**
 * The resolved network configuration produced by {@link resolveNetworkConfig}.
 */
interface NetworkSetupResult {
  upstreamProxy: UpstreamProxyConfig | undefined;
  dnsServers: string[];
  dnsOverHttps: string | undefined;
}

/**
 * Resolves upstream proxy, DNS servers, and DNS-over-HTTPS configuration
 * from CLI options and the host environment.
 *
 * - DNS servers are auto-detected from the host when `--dns-servers` is absent.
 * - Upstream proxy is auto-detected from `http_proxy`/`HTTPS_PROXY` env vars
 *   when `--upstream-proxy` is absent.
 *
 * Calls `process.exit(1)` on any validation or detection failure.
 */
export function resolveNetworkConfig(options: Record<string, unknown>): NetworkSetupResult {
  // Parse and validate DNS servers (auto-detect if not explicitly provided)
  let dnsServers: string[];
  if (options.dnsServers) {
    try {
      dnsServers = parseDnsServers(options.dnsServers as string);
    } catch (error) {
      logger.error(`Invalid DNS servers: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  } else {
    dnsServers = detectHostDnsServers(logger);
  }

  // Parse and validate --dns-over-https
  let dnsOverHttps: string | undefined;
  const dohResult = parseDnsOverHttps(options.dnsOverHttps as string | boolean | undefined);
  if (dohResult && 'error' in dohResult) {
    logger.error(dohResult.error);
    process.exit(1);
  } else if (dohResult) {
    dnsOverHttps = dohResult.url;
    logger.info(`DNS-over-HTTPS enabled: ${dnsOverHttps}`);
  }

  // Detect or parse upstream proxy configuration
  let upstreamProxy: UpstreamProxyConfig | undefined;
  if (options.upstreamProxy) {
    // Explicit --upstream-proxy flag
    try {
      const { host, port } = parseProxyUrl(options.upstreamProxy as string);
      // Parse no_proxy from environment even when --upstream-proxy is explicit
      const noProxyStr = (process.env.no_proxy || process.env.NO_PROXY || '').trim();
      const noProxy = noProxyStr ? parseNoProxy(noProxyStr) : [];
      upstreamProxy = { host, port, ...(noProxy.length > 0 ? { noProxy } : {}) };
      logger.info(`Upstream proxy (explicit): ${host}:${port}`);
    } catch (error) {
      logger.error(`Invalid --upstream-proxy: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  } else {
    // Auto-detect from host environment variables
    try {
      upstreamProxy = detectUpstreamProxy();
    } catch (error) {
      logger.error(`Upstream proxy auto-detection failed: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  }

  return { upstreamProxy, dnsServers, dnsOverHttps };
}
