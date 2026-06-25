import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { WrapperConfig, API_PROXY_PORTS, DockerComposeConfig } from './types';
import { logger } from './logger';
import { generatePolicyManifest, generateSquidConfig } from './squid-config';
import { generateSessionCa, initSslDb, isOpenSslAvailable } from './ssl-bump';
import { parseUrlPatterns } from './domain-matchers';
import { SslConfig, SQUID_PORT } from './host-env';
import { generateDockerCompose, redactDockerComposeSecrets } from './compose-generator';
import { resolveLogPaths } from './log-paths';
import {
  AGENT_IP,
  API_PROXY_IP,
  CLI_PROXY_IP,
  DOH_PROXY_IP,
  NETWORK_SUBNET,
  SQUID_IP,
} from './host-iptables-shared';
import { prepareWorkDirectories } from './workdir-setup';

// When bundled with esbuild, this global is replaced at build time with the
// JSON content of containers/agent/seccomp-profile.json.  In normal (tsc)
// builds the identifier remains undeclared, so the typeof check below is safe.
declare const __AWF_SECCOMP_PROFILE__: string | undefined;

/** Resolved network topology passed between setup phases. */
interface NetworkConfig {
  subnet: string;
  squidIp: string;
  agentIp: string;
  proxyIp?: string;
  dohProxyIp?: string;
  cliProxyIp?: string;
}

/**
 * Phase 1 — Validates and hardens the work directory.
 *
 * Creates the directory with restrictive `0o700` permissions, guards against
 * symlink injection, and re-applies the permission mask on pre-existing dirs.
 * Security-critical: docker-compose.yml (which contains plaintext secrets) is
 * written here, so non-root host processes must not be able to read it.
 */
function validateAndPrepareWorkDir(config: WrapperConfig): void {
  // Ensure work directory exists with restricted permissions (owner-only access)
  // Defense-in-depth: even if tmpfs overlay fails, non-root processes on the host
  // cannot read the docker-compose.yml which contains sensitive tokens
  const workDirCreated = Boolean(
    fs.mkdirSync(config.workDir, { recursive: true, mode: 0o700 })
  );
  const workDirLstat = fs.lstatSync(config.workDir);
  if (workDirLstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${config.workDir}`);
  }
  const workDirStat = fs.statSync(config.workDir);
  if (!workDirStat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${config.workDir}`);
  }
  if (!workDirCreated) {
    fs.chmodSync(config.workDir, 0o700);
  }
}

/**
 * Phase 2 — Copies the seccomp profile into the work directory.
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
 * Phase 3 — Initialises SSL Bump if enabled.
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
 * Phase 7 — Writes audit artifacts to the audit directory.
 *
 * Artifacts are world-readable snapshots that contain no secrets:
 * - `squid.conf`                  — domain ACLs and proxy config
 * - `docker-compose.redacted.yml` — compose file with secrets stripped
 * - `policy-manifest.json`        — structured firewall policy description
 *
 * World-readable so the gh-aw post-run audit step (running as the non-root
 * runner user) can stat/read them even if AWF cleanup is interrupted.
 */
function writeAuditArtifacts(
  config: WrapperConfig,
  networkConfig: NetworkConfig,
  dockerCompose: DockerComposeConfig,
  squidConfig: string
): void {
  const auditDir = config.auditDir || path.join(config.workDir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o755 });
  const auditDirLstat = fs.lstatSync(auditDir);
  if (auditDirLstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${auditDir}`);
  }
  const auditDirStat = fs.statSync(auditDir);
  if (!auditDirStat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${auditDir}`);
  }
  fs.chmodSync(auditDir, 0o755);

  // Save squid.conf for audit (no secrets — just domain ACLs and proxy config)
  fs.writeFileSync(path.join(auditDir, 'squid.conf'), squidConfig, { mode: 0o644 });

  // Save redacted docker-compose.yml (strip env vars that may contain secrets)
  const redactedCompose = redactDockerComposeSecrets(dockerCompose);
  fs.writeFileSync(
    path.join(auditDir, 'docker-compose.redacted.yml'),
    yaml.dump(redactedCompose, { lineWidth: -1 }),
    { mode: 0o644 }
  );

  // Generate and save policy manifest (structured description of all firewall rules)
  const policyManifest = generatePolicyManifest({
    domains: config.allowedDomains,
    blockedDomains: config.blockedDomains,
    port: SQUID_PORT,
    sslBump: config.sslBump,
    enableHostAccess: config.enableHostAccess,
    allowHostPorts: config.allowHostPorts,
    enableDlp: config.enableDlp,
    dnsServers: config.dnsServers,
    ...(config.enableApiProxy && networkConfig.proxyIp ? {
      apiProxyIp: networkConfig.proxyIp,
    } : {}),
  });
  fs.writeFileSync(
    path.join(auditDir, 'policy-manifest.json'),
    JSON.stringify(policyManifest, null, 2),
    { mode: 0o644 }
  );

  logger.debug(`Audit artifacts written to: ${auditDir}`);
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

  // Use fixed network configuration (network is created by host-iptables.ts)
  const networkConfig: NetworkConfig = {
    subnet: NETWORK_SUBNET,
    squidIp: SQUID_IP,
    agentIp: AGENT_IP,
    proxyIp: API_PROXY_IP,  // Envoy API proxy sidecar
    dohProxyIp: DOH_PROXY_IP,  // DoH proxy sidecar
    cliProxyIp: CLI_PROXY_IP,  // CLI proxy sidecar
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

  // Note: Use container path for SSL database since it's mounted at /var/spool/squid_ssl_db
  const squidConfig = generateSquidConfig({
    domains: config.allowedDomains,
    blockedDomains: config.blockedDomains,
    port: SQUID_PORT,
    sslBump: config.sslBump,
    caFiles: sslConfig?.caFiles,
    sslDbPath: sslConfig ? '/var/spool/squid_ssl_db' : undefined,
    urlPatterns,
    enableHostAccess: config.enableHostAccess,
    allowHostPorts: config.allowHostPorts,
    enableDlp: config.enableDlp,
    dnsServers: config.dnsServers,
    upstreamProxy: config.upstreamProxy,
    // Allow the api-proxy sidecar IP through Squid before the raw-IP deny rule.
    // Some HTTP clients (e.g., Node.js fetch / undici ProxyAgent) route requests
    // to the api-proxy via HTTP_PROXY without honouring NO_PROXY for raw IPs.
    ...(config.enableApiProxy && networkConfig.proxyIp ? {
      apiProxyIp: networkConfig.proxyIp,
      apiProxyPorts: Object.values(API_PROXY_PORTS),
    } : {}),
  });
  const squidConfigPath = path.join(config.workDir, 'squid.conf');
  fs.writeFileSync(squidConfigPath, squidConfig, { mode: 0o644 });
  logger.debug(`Squid config written to: ${squidConfigPath}`);

  // Phase 6: Docker Compose generation and write
  // Uses mode 0o600 (owner-only read/write) because this file contains sensitive
  // environment variables (tokens, API keys) in plaintext
  const dockerCompose = generateDockerCompose(config, networkConfig, sslConfig, squidConfig);
  const dockerComposePath = path.join(config.workDir, 'docker-compose.yml');
  // lineWidth: -1 disables line wrapping to prevent base64-encoded values
  // (like AWF_SQUID_CONFIG_B64) from being split across multiple lines
  fs.writeFileSync(dockerComposePath, yaml.dump(dockerCompose, { lineWidth: -1 }), { mode: 0o600 });
  logger.debug(`Docker Compose config written to: ${dockerComposePath}`);

  // Phase 7: Audit artifact writing
  // These files contain no secrets (redacted compose, domain ACLs, policy rules)
  // and are made world-readable so the gh-aw post-run audit step (running as
  // non-root runner user) can stat/read them even if AWF cleanup is interrupted.
  writeAuditArtifacts(config, networkConfig, dockerCompose, squidConfig);
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const configWriterTestHelpers = {
  validateAndPrepareWorkDir,
  copySeccompProfile,
  initializeSslBump,
  writeAuditArtifacts,
};
