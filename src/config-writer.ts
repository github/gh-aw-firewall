import * as fs from 'fs';
import * as path from 'path';
import { WrapperConfig, API_PROXY_PORTS } from './types';
import { logger } from './logger';
import { generateSquidConfig } from './squid-config';
import { resolveTopologyPeerHosts } from './topology-peers';
import { generateSessionCa, initSslDb, isOpenSslAvailable } from './ssl-bump';
import { parseUrlPatterns } from './domain-matchers';
import { SslConfig, SQUID_PORT } from './host-env';
import { generateDockerCompose } from './compose-generator';
import { renderDockerCompose } from './compose-renderer';
import { resolveLogPaths } from './log-paths';
import { DEFAULT_DNS_SERVERS, filterForNetworkIsolation } from './dns-resolver';
import {
  repairContainerWorkDirOwnership,
  repairRunnerTempGhAwOwnership,
  validateAndPrepareWorkDir,
} from './config-writer-ownership';
import { resolveNetworkAddressing } from './network-subnet';
import { readEnvFile } from './github-env';
import { extractOtlpEndpointsFromEnv, resolveOtlpEndpointEnv } from './api-proxy-config-domains';
import { prepareWorkDirectories } from './workdir-setup';
import { writeAuditArtifacts } from './config-writer-audit';
import type { NetworkConfig } from './services/squid-service';
import { resolveApiProxyUpstreams } from './services/api-proxy-env-config';
import { resolveCopilotBrokerUpstreams } from './copilot-token-broker';
import { prepareHarnessObservation } from './harness-observation';

// When bundled with esbuild, this global is replaced at build time with the
// JSON content of containers/agent/seccomp-profile.json.  In normal (tsc)
// builds the identifier remains undeclared, so the typeof check below is safe.
declare const __AWF_SECCOMP_PROFILE__: string | undefined;

/**
 * Phase 3 — Copies the seccomp profile into the work directory.
 *
 * Uses a three-path fallback strategy:
 * 1. Embedded profile (esbuild bundle — `__AWF_SECCOMP_PROFILE__` global)
 * 2. Source tree path: `<root>/containers/agent/seccomp-profile.json`
 * 3. Dist tree path:   `<root>/dist/../containers/agent/seccomp-profile.json`
 *
 * Throws if no profile is found — the container cannot start safely without it.
 */
function copySeccompProfile(config: WrapperConfig): void {
  const seccompDestPath = path.join(config.workDir, 'seccomp-profile.json');

  // Try embedded profile first (available in esbuild bundle)
  if (typeof __AWF_SECCOMP_PROFILE__ !== 'undefined') {
    fs.writeFileSync(seccompDestPath, __AWF_SECCOMP_PROFILE__);
    logger.debug(`Seccomp profile written from embedded data to: ${seccompDestPath}`);
    return;
  }

  const seccompSourcePath = path.join(__dirname, '..', 'containers', 'agent', 'seccomp-profile.json');
  if (fs.existsSync(seccompSourcePath)) {
    fs.copyFileSync(seccompSourcePath, seccompDestPath);
    logger.debug(`Seccomp profile written to: ${seccompDestPath}`);
    return;
  }

  // If running from dist, try relative to dist
  const altSeccompPath = path.join(__dirname, '..', '..', 'containers', 'agent', 'seccomp-profile.json');
  if (fs.existsSync(altSeccompPath)) {
    fs.copyFileSync(altSeccompPath, seccompDestPath);
    logger.debug(`Seccomp profile written to: ${seccompDestPath}`);
    return;
  }

  const message = `Seccomp profile not found at ${seccompSourcePath} or ${altSeccompPath}. Container security hardening requires the seccomp profile.`;
  logger.error(message);
  throw new Error(message);
}

/**
 * Phase 4 — Initialises SSL Bump if enabled.
 *
 * Generates a per-session CA certificate and an SSL database for Squid's
 * SSL-Bump intercept mode. Returns `undefined` when SSL Bump is disabled.
 * Security-critical: the generated CA can sign arbitrary certificates for
 * intercepted HTTPS connections.
 */
async function initializeSslBump(config: WrapperConfig): Promise<SslConfig | undefined> {
  if (!config.sslBump) {
    return undefined;
  }

  logger.info('SSL Bump enabled - generating per-session CA certificate...');
  try {
    if (!(await isOpenSslAvailable())) {
      throw new Error('openssl is not available on this system');
    }
    const caFiles = await generateSessionCa({ workDir: config.workDir });
    const sslDbPath = await initSslDb(config.workDir);
    const sslConfig: SslConfig = { caFiles, sslDbPath };
    logger.info('SSL Bump CA certificate generated successfully');
    logger.warn('⚠️  SSL Bump mode: HTTPS traffic will be intercepted for URL inspection');
    logger.warn('   A per-session CA certificate has been generated (valid for 1 day)');
    return sslConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to generate SSL Bump CA: ${message}`);
    throw new Error(`SSL Bump initialization failed: ${message}`);
  }
}

/**
 * Writes all configuration files to disk.
 *
 * Orchestrates the seven sequential setup phases:
 * 1. Work-directory security hardening ({@link validateAndPrepareWorkDir})
 * 2. Log-path resolution and directory preparation
 * 3. Seccomp profile copy ({@link copySeccompProfile})
 * 4. SSL-Bump initialisation ({@link initializeSslBump})
 * 5. Squid ACL config generation and write
 * 6. Docker Compose generation and write
 * 7. Audit artifact writing ({@link writeAuditArtifacts})
 *
 * Uses fixed network configuration defined in host-iptables-shared.ts
 */
export async function writeConfigs(config: WrapperConfig): Promise<void> {
  logger.debug('Writing configuration files...');

  // Phase 1: Work-directory security hardening
  validateAndPrepareWorkDir(config);

  // Phase 2: Log-path resolution and directory preparation
  const logPaths = resolveLogPaths(config);
  prepareWorkDirectories(config, logPaths);
  prepareHarnessObservation(config);
  repairRunnerTempGhAwOwnership();
  repairContainerWorkDirOwnership(config);

  // Network addressing: policy defaults unless relocated with --network-subnet
  // (the network itself is created by compose, or by host-iptables.ts in the
  // legacy path).
  const addressing = resolveNetworkAddressing(config.networkSubnet);
  const networkConfig: NetworkConfig = {
    subnet: addressing.subnet,
    squidIp: addressing.squidIp,
    agentIp: addressing.agentIp,
    proxyIp: addressing.proxyIp,  // Envoy API proxy sidecar
    dohProxyIp: addressing.dohProxyIp,  // DoH proxy sidecar
    cliProxyIp: addressing.cliProxyIp,  // CLI proxy sidecar
  };
  logger.debug(`Using network config: ${networkConfig.subnet} (squid: ${networkConfig.squidIp}, agent: ${networkConfig.agentIp}, api-proxy: ${networkConfig.proxyIp})`);

  // Phase 3: Seccomp profile copy (security-critical)
  copySeccompProfile(config);

  // Phase 4: SSL-Bump initialisation (security-critical)
  const sslConfig = await initializeSslBump(config);

  // Phase 5: Squid ACL config generation and write (security-critical)
  // Transform user URL patterns to regex patterns for Squid ACLs
  let urlPatterns: string[] | undefined;
  if (config.allowedUrls && config.allowedUrls.length > 0) {
    urlPatterns = parseUrlPatterns(config.allowedUrls);
    logger.debug(`Parsed ${urlPatterns.length} URL pattern(s) for SSL Bump filtering`);
  }

  // In network-isolation (topology) mode, preserve auto-detected DNS resolvers
  // as operator-controlled runner network settings. Enterprise and cloud
  // resolvers may be private or virtual-network-specific, and replacing them
  // with public defaults can break environments where public DNS is blocked.
  // Explicitly-specified servers are also trusted as-is.
  const resolvedDnsServers = config.dnsServers ?? DEFAULT_DNS_SERVERS;
  const squidDnsServers = config.networkIsolation && !config.dnsServersExplicit
    ? await filterForNetworkIsolation(resolvedDnsServers, logger)
    : resolvedDnsServers;

  const envFileValues = config.envFile ? readEnvFile(config.envFile) : {};
  const otlpEnv = resolveOtlpEndpointEnv(config.additionalEnv, envFileValues);
  const otlpEndpoints = extractOtlpEndpointsFromEnv(otlpEnv);
  if (otlpEndpoints.length > 0) {
    logger.debug(`Auto-allowing OTLP collector endpoint(s): ${otlpEndpoints.map(({ hostname, port }) => `${hostname}:${port}`).join(', ')}`);
  }

  // Note: Use container path for SSL database since it's mounted at /var/spool/squid_ssl_db
  const squidConfig = generateSquidConfig({
    // Combine non-sensitive and sensitive (secret-derived) domains so Squid allows
    // all necessary egress without exposing the sensitive hostnames in logs or
    // the audit artifact (where only config.allowedDomains is serialised).
    domains: [...config.allowedDomains, ...(config.sensitiveAllowedDomains ?? [])],
    sensitiveDomains: [
      ...(config.sensitiveAllowedDomains ?? []),
      ...(config.copilotTokenBroker
        ? (resolveCopilotBrokerUpstreams(config).slice(0, 2).map(endpoint => endpoint.hostname))
        : []),
    ],
    blockedDomains: config.blockedDomains,
    port: SQUID_PORT,
    sslBump: config.sslBump,
    caFiles: sslConfig?.caFiles,
    sslDbPath: sslConfig ? '/var/spool/squid_ssl_db' : undefined,
    urlPatterns,
    enableHostAccess: config.enableHostAccess,
    allowHostPorts: config.allowHostPorts,
    enableDlp: config.enableDlp,
    dnsServers: squidDnsServers,
    upstreamProxy: config.upstreamProxy,
    // Allow the api-proxy sidecar IP through Squid before the raw-IP deny rule.
    // Some HTTP clients (e.g., Node.js fetch / undici ProxyAgent) route requests
    // to the api-proxy via HTTP_PROXY without honouring NO_PROXY for raw IPs.
    ...(config.enableApiProxy && networkConfig.proxyIp ? {
      apiProxyIp: networkConfig.proxyIp,
      apiProxyUpstreams: resolveApiProxyUpstreams(config),
      apiProxyBrokerUpstreams: resolveCopilotBrokerUpstreams(config),
      apiProxyPorts: Object.values(API_PROXY_PORTS),
    } : {}),
    ...(config.difcProxyHost && networkConfig.cliProxyIp ? {
      cliProxyIp: networkConfig.cliProxyIp,
    } : {}),
    // Allow trusted topology peers (MCP gateway, DIFC/cli-proxy) on any port in
    // network-isolation mode, for proxy clients that ignore NO_PROXY. DNS for
    // these Docker-only names is provided via the squid-proxy extra_hosts patch
    // (see patchComposeWithTopologyHosts in topology.ts).
    topologyPeers: resolveTopologyPeerHosts(config),
    otlpEndpoints,
  });
  const squidConfigPath = path.join(config.workDir, 'squid.conf');
  fs.writeFileSync(squidConfigPath, squidConfig, { mode: 0o644 });
  logger.debug(`Squid config written to: ${squidConfigPath}`);

  // Phase 6: Docker Compose generation and write
  // Uses mode 0o600 (owner-only read/write) because this file contains sensitive
  // environment variables (tokens, API keys) in plaintext
  const dockerCompose = generateDockerCompose(config, networkConfig, sslConfig, squidConfig);
  const dockerComposePath = path.join(config.workDir, 'docker-compose.yml');
  fs.writeFileSync(dockerComposePath, renderDockerCompose(dockerCompose), { mode: 0o600 });
  logger.debug(`Docker Compose config written to: ${dockerComposePath}`);

  // Phase 7: Audit artifact writing
  // These files contain no secrets (redacted compose, domain ACLs, policy rules)
  // and are made world-readable so the gh-aw post-run audit step (running as
  // non-root runner user) can stat/read them even if AWF cleanup is interrupted.
  writeAuditArtifacts(config, networkConfig, dockerCompose, squidConfig, squidDnsServers);
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const configWriterTestHelpers = {
  validateAndPrepareWorkDir,
  copySeccompProfile,
  initializeSslBump,
  writeAuditArtifacts,
};
