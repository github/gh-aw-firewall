import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { WrapperConfig, API_PROXY_PORTS } from './types';
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

/**
 * Writes configuration files to disk
 * Uses fixed network configuration defined in host-iptables-shared.ts
 */
export async function writeConfigs(config: WrapperConfig): Promise<void> {
  logger.debug('Writing configuration files...');

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

  // Resolve all log/state directory paths from a single source of truth
  const logPaths = resolveLogPaths(config);

  // Prepare all working directories (log/state dirs and chroot home bind-mounts)
  prepareWorkDirectories(config, logPaths);

  // Use fixed network configuration (network is created by host-iptables.ts)
  const networkConfig = {
    subnet: NETWORK_SUBNET,
    squidIp: SQUID_IP,
    agentIp: AGENT_IP,
    proxyIp: API_PROXY_IP,  // Envoy API proxy sidecar
    dohProxyIp: DOH_PROXY_IP,  // DoH proxy sidecar
    cliProxyIp: CLI_PROXY_IP,  // CLI proxy sidecar
  };
  logger.debug(`Using network config: ${networkConfig.subnet} (squid: ${networkConfig.squidIp}, agent: ${networkConfig.agentIp}, api-proxy: ${networkConfig.proxyIp})`);


  // Copy seccomp profile to work directory for container security
  const seccompDestPath = path.join(config.workDir, 'seccomp-profile.json');

  // Try embedded profile first (available in esbuild bundle)
  if (typeof __AWF_SECCOMP_PROFILE__ !== 'undefined') {
    fs.writeFileSync(seccompDestPath, __AWF_SECCOMP_PROFILE__);
    logger.debug(`Seccomp profile written from embedded data to: ${seccompDestPath}`);
  } else {
    const seccompSourcePath = path.join(__dirname, '..', 'containers', 'agent', 'seccomp-profile.json');
    if (fs.existsSync(seccompSourcePath)) {
      fs.copyFileSync(seccompSourcePath, seccompDestPath);
      logger.debug(`Seccomp profile written to: ${seccompDestPath}`);
    } else {
      // If running from dist, try relative to dist
      const altSeccompPath = path.join(__dirname, '..', '..', 'containers', 'agent', 'seccomp-profile.json');
      if (fs.existsSync(altSeccompPath)) {
        fs.copyFileSync(altSeccompPath, seccompDestPath);
        logger.debug(`Seccomp profile written to: ${seccompDestPath}`);
      } else {
        const message = `Seccomp profile not found at ${seccompSourcePath} or ${altSeccompPath}. Container security hardening requires the seccomp profile.`;
        logger.error(message);
        throw new Error(message);
      }
    }
  }

  // Generate SSL Bump certificates if enabled
  let sslConfig: SslConfig | undefined;
  if (config.sslBump) {
    logger.info('SSL Bump enabled - generating per-session CA certificate...');
    try {
      if (!(await isOpenSslAvailable())) {
        throw new Error('openssl is not available on this system');
      }
      const caFiles = await generateSessionCa({ workDir: config.workDir });
      const sslDbPath = await initSslDb(config.workDir);
      sslConfig = { caFiles, sslDbPath };
      logger.info('SSL Bump CA certificate generated successfully');
      logger.warn('⚠️  SSL Bump mode: HTTPS traffic will be intercepted for URL inspection');
      logger.warn('   A per-session CA certificate has been generated (valid for 1 day)');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to generate SSL Bump CA: ${message}`);
      throw new Error(`SSL Bump initialization failed: ${message}`);
    }
  }

  // Transform user URL patterns to regex patterns for Squid ACLs
  let urlPatterns: string[] | undefined;
  if (config.allowedUrls && config.allowedUrls.length > 0) {
    urlPatterns = parseUrlPatterns(config.allowedUrls);
    logger.debug(`Parsed ${urlPatterns.length} URL pattern(s) for SSL Bump filtering`);
  }

  // Write Squid config
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

  // Write Docker Compose config
  // Uses mode 0o600 (owner-only read/write) because this file contains sensitive
  // environment variables (tokens, API keys) in plaintext
  const dockerCompose = generateDockerCompose(config, networkConfig, sslConfig, squidConfig);
  const dockerComposePath = path.join(config.workDir, 'docker-compose.yml');
  // lineWidth: -1 disables line wrapping to prevent base64-encoded values
  // (like AWF_SQUID_CONFIG_B64) from being split across multiple lines
  fs.writeFileSync(dockerComposePath, yaml.dump(dockerCompose, { lineWidth: -1 }), { mode: 0o600 });
  logger.debug(`Docker Compose config written to: ${dockerComposePath}`);

  // Write audit artifacts (config snapshots for post-run forensics)
  // These files contain no secrets (redacted compose, domain ACLs, policy rules)
  // and are made world-readable so the gh-aw post-run audit step (running as
  // non-root runner user) can stat/read them even if AWF cleanup is interrupted.
  const auditDir = config.auditDir || path.join(config.workDir, 'audit');
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o755 });
  }

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
