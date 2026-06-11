import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { WrapperConfig, API_PROXY_PORTS } from './types';
import { logger } from './logger';
import { generatePolicyManifest, generateSquidConfig } from './squid-config';
import { generateSessionCa, initSslDb, parseUrlPatterns, isOpenSslAvailable } from './ssl-bump';
import { SslConfig, SQUID_PORT, getSafeHostUid, getSafeHostGid, getRealUserHome } from './host-env';
import { generateDockerCompose, redactDockerComposeSecrets } from './compose-generator';
import { resolveLogPaths } from './log-paths';
import { resolveRunnerToolCachePath } from './runner-tool-cache';

// When bundled with esbuild, this global is replaced at build time with the
// JSON content of containers/agent/seccomp-profile.json.  In normal (tsc)
// builds the identifier remains undeclared, so the typeof check below is safe.
declare const __AWF_SECCOMP_PROFILE__: string | undefined;

interface EnsureDirectoryOptions {
  mode?: number;
  onCreate?: () => void;
  onExists?: () => void;
  onAfterEnsure?: () => void;
}

function ensureDirectory(dirPath: string, options: EnsureDirectoryOptions = {}): boolean {
  const { mode, onCreate, onExists, onAfterEnsure } = options;
  const created = Boolean(
    fs.mkdirSync(dirPath, mode === undefined ? { recursive: true } : { recursive: true, mode })
  );

  const lstat = fs.lstatSync(dirPath);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${dirPath}`);
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${dirPath}`);
  }

  if (created) {
    onCreate?.();
  } else {
    onExists?.();
  }

  onAfterEnsure?.();
  return created;
}

function assertRealDirectory(dirPath: string): void {
  const lstat = fs.lstatSync(dirPath);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${dirPath}`);
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${dirPath}`);
  }
}

function createMissingOwnedDirectorySegments(dirPath: string, uid: number, gid: number): void {
  let currentPath = path.isAbsolute(dirPath)
    ? path.parse(dirPath).root
    : '';
  const segments = dirPath.split(path.sep).filter(Boolean);

  for (const segment of segments) {
    currentPath = currentPath ? path.join(currentPath, segment) : segment;
    let created = false;
    if (!fs.existsSync(currentPath)) {
      fs.mkdirSync(currentPath);
      created = true;
    }

    // Validate the current segment is a directory. Allow root-owned system symlinks
    // (e.g. /var on macOS) but refuse user-controlled symlinks.
    const lstat = fs.lstatSync(currentPath);
    if (lstat.isSymbolicLink() && (created || lstat.uid !== 0)) {
      throw new Error(`Refusing to use symlink as directory: ${currentPath}`);
    }
    const stat = fs.statSync(currentPath);
    if (!stat.isDirectory()) {
      throw new Error(`Expected directory but found non-directory path: ${currentPath}`);
    }

    if (created) {
      fs.chownSync(currentPath, uid, gid);
      fs.chmodSync(currentPath, 0o755);
    }
  }
}

// Prepare a nested bind-mount destination inside the empty chroot home before
// Docker sees it. Without this, Docker may create intermediate parents such as
// `<emptyHome>/work` as root-owned directories with restrictive traversal bits,
// causing the chrooted runner user to get EACCES before reaching the leaf mount.
// This operates only on the chroot-home placeholder path, e.g.
// `<emptyHome>/work/_tool`; it does not chown or chmod the real host source
// `/home/runner/work/_tool`, which Docker will later mount over the placeholder.
function prepareChrootHomeMountpoint(emptyHomeDir: string, relativeMountPath: string, uid: number, gid: number): string {
  let chrootPath = emptyHomeDir;
  const segments = relativeMountPath.split(path.sep).filter(Boolean);

  for (const segment of segments) {
    chrootPath = path.join(chrootPath, segment);
    if (!fs.existsSync(chrootPath)) {
      fs.mkdirSync(chrootPath);
    }

    // The final segment may be the leaf mountpoint (`_tool`). That is okay: this
    // is still only the placeholder inside emptyHomeDir, not the host tool cache.
    assertRealDirectory(chrootPath);
    fs.chownSync(chrootPath, uid, gid);
    fs.chmodSync(chrootPath, 0o755);
  }

  return chrootPath;
}

/**
 * Writes configuration files to disk
 * Uses fixed network configuration (172.30.0.0/24) defined in host-iptables.ts
 */
export async function writeConfigs(config: WrapperConfig): Promise<void> {
  logger.debug('Writing configuration files...');

  // Ensure work directory exists with restricted permissions (owner-only access)
  // Defense-in-depth: even if tmpfs overlay fails, non-root processes on the host
  // cannot read the docker-compose.yml which contains sensitive tokens
  ensureDirectory(config.workDir, {
    mode: 0o700,
    onExists: () => fs.chmodSync(config.workDir, 0o700),
  });

  // Resolve all log/state directory paths from a single source of truth
  const logPaths = resolveLogPaths(config);

  // Create agent logs directory for persistence
  // Chown to host user so Copilot CLI can write logs (AWF runs as root, agent runs as host user)
  ensureDirectory(logPaths.agentLogs, {
    onAfterEnsure: () => {
      try {
        fs.chownSync(logPaths.agentLogs, parseInt(getSafeHostUid()), parseInt(getSafeHostGid()));
      } catch { /* ignore chown failures in non-root context */ }
    },
  });
  logger.debug(`Agent logs directory created at: ${logPaths.agentLogs}`);

  // Create agent session-state directory for persistence (events.jsonl, session data)
  // If sessionStateDir is specified, write directly there (timeout-safe, predictable path)
  // Otherwise, use workDir/agent-session-state (will be moved to /tmp after cleanup)
  // Chown to host user so Copilot CLI can create session subdirs and write events.jsonl
  ensureDirectory(logPaths.sessionState, {
    onAfterEnsure: () => {
      try {
        fs.chownSync(logPaths.sessionState, parseInt(getSafeHostUid()), parseInt(getSafeHostGid()));
      } catch { /* ignore chown failures in non-root context */ }
    },
  });
  logger.debug(`Agent session-state directory created at: ${logPaths.sessionState}`);

  // Create squid logs directory for persistence
  // If proxyLogsDir is specified, write directly there (timeout-safe)
  // Otherwise, use workDir/squid-logs (will be moved to /tmp after cleanup)
  // Note: Squid runs as user 'proxy' (UID 13, GID 13 in ubuntu/squid image)
  // We need to make the directory writable by the proxy user
  // Squid container runs as non-root 'proxy' user (UID 13, GID 13)
  // Set ownership so proxy user can write logs without root privileges
  const SQUID_PROXY_UID = 13;
  const SQUID_PROXY_GID = 13;
  ensureDirectory(logPaths.squidLogs, {
    mode: 0o755,
    onCreate: () => {
      try {
        fs.chownSync(logPaths.squidLogs, SQUID_PROXY_UID, SQUID_PROXY_GID);
      } catch {
        // Fallback to world-writable if chown fails (e.g., non-root context)
        fs.chmodSync(logPaths.squidLogs, 0o777);
      }
    },
  });
  logger.debug(`Squid logs directory created at: ${logPaths.squidLogs}`);

  // Create api-proxy logs directory for persistence
  // If proxyLogsDir is specified, write inside it as a subdirectory (timeout-safe,
  // and included in the firewall-audit-logs artifact upload automatically)
  // Otherwise, write to workDir/api-proxy-logs (will be moved to /tmp after cleanup)
  // Note: API proxy runs as user 'apiproxy' (non-root)
  ensureDirectory(logPaths.apiProxyLogs, {
    mode: 0o777,
    onCreate: () => {
      // Explicitly set permissions to 0o777 (not affected by umask)
      fs.chmodSync(logPaths.apiProxyLogs, 0o777);
    },
  });
  logger.debug(`API proxy logs directory created at: ${logPaths.apiProxyLogs}`);

  // Create CLI proxy logs directory for persistence
  // Note: CLI proxy runs as user 'cliproxy' (non-root)
  ensureDirectory(logPaths.cliProxyLogs, {
    mode: 0o777,
    onCreate: () => fs.chmodSync(logPaths.cliProxyLogs, 0o777),
  });
  logger.debug(`CLI proxy logs directory created at: ${logPaths.cliProxyLogs}`);

  // Create /tmp/gh-aw/mcp-logs directory
  // This directory exists on the HOST for MCP gateway to write logs
  // Inside the AWF container, it's hidden via tmpfs mount (see generateDockerCompose)
  // Uses mode 0o777 to allow GitHub Actions workflows and MCP gateway to create subdirectories
  // even when AWF runs as root (e.g., sudo awf)
  const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
  if (ensureDirectory(mcpLogsDir, { mode: 0o777 })) {
    // Explicitly set permissions to 0o777 (not affected by umask)
    fs.chmodSync(mcpLogsDir, 0o777);
    logger.debug(`MCP logs directory created at: ${mcpLogsDir}`);
  } else {
    // Fix permissions if directory already exists (e.g., created by a previous run)
    fs.chmodSync(mcpLogsDir, 0o777);
    logger.debug(`MCP logs directory permissions fixed at: ${mcpLogsDir}`);
  }

  // Ensure chroot home subdirectories exist with correct ownership before Docker
  // bind-mounts them. If a source directory doesn't exist, Docker creates it as
  // root:root, making it inaccessible to the agent user (e.g., UID 1001).
  // Also create an empty writable home directory that gets mounted as $HOME
  // in the chroot, giving tools a writable home without exposing credentials.
  {
    const effectiveHome = getRealUserHome();
    const uid = parseInt(getSafeHostUid(), 10);
    const gid = parseInt(getSafeHostGid(), 10);

    // Create empty writable home directory for the chroot
    // This is mounted as $HOME inside the container so tools can write to it
    // NOTE: Must be outside workDir to avoid being hidden by the tmpfs overlay
    const emptyHomeDir = `${config.workDir}-chroot-home`;
    if (!fs.existsSync(emptyHomeDir)) {
      fs.mkdirSync(emptyHomeDir, { recursive: true });
    }
    fs.chownSync(emptyHomeDir, uid, gid);
    logger.debug(`Created chroot home directory: ${emptyHomeDir} (${uid}:${gid})`);

    // Ensure source directories for home subdirectory mounts exist with correct ownership.
    const hostHomeMountSourceDirs = [
      '.copilot', '.cache', '.config', '.local',
      '.anthropic', '.claude', '.cargo', '.rustup', '.npm', '.nvm',
      ...(config.geminiApiKey ? ['.gemini'] : []),
    ];
    for (const dir of hostHomeMountSourceDirs) {
      const dirPath = path.join(effectiveHome, dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        fs.chownSync(dirPath, uid, gid);
        logger.debug(`Created host home subdirectory: ${dirPath} (${uid}:${gid})`);
      }
    }

    // Source-side prep: this only applies when the config file explicitly names
    // a runner tool-cache source path that does not exist yet. Create that host
    // source so Docker has something real to bind-mount later.
    if (config.runnerToolCachePath && !fs.existsSync(config.runnerToolCachePath)) {
      const relToHome = path.relative(effectiveHome, config.runnerToolCachePath);
      const isUnderHome = relToHome && !relToHome.startsWith('..') && !path.isAbsolute(relToHome);

      if (isUnderHome) {
        createMissingOwnedDirectorySegments(config.runnerToolCachePath, uid, gid);
        logger.debug(`Created runner tool cache directory: ${config.runnerToolCachePath} (${uid}:${gid})`);
      } else {
        logger.warn(`Runner tool cache path does not exist; refusing to create outside effective home (${effectiveHome}): ${config.runnerToolCachePath}`);
      }
    }

    // Destination-side prep: resolve the same source path that home-strategy.ts
    // will mount. If that source is nested under the empty chroot home, prepare
    // the placeholder mountpoint there so Docker does not create parents as root.
    const runnerToolCachePath = resolveRunnerToolCachePath(config, effectiveHome);
    if (runnerToolCachePath) {
      const relativeToolCachePath = path.relative(effectiveHome, runnerToolCachePath);
      if (relativeToolCachePath && !relativeToolCachePath.startsWith('..') && !path.isAbsolute(relativeToolCachePath)) {
        const chrootToolCachePath = prepareChrootHomeMountpoint(emptyHomeDir, relativeToolCachePath, uid, gid);
        logger.debug(`Prepared chroot runner tool cache mountpoint: ${chrootToolCachePath} (${uid}:${gid})`);
      }
    }
  }

  // Use fixed network configuration (network is created by host-iptables.ts)
  const networkConfig = {
    subnet: '172.30.0.0/24',
    squidIp: '172.30.0.10',
    agentIp: '172.30.0.20',
    proxyIp: '172.30.0.30',  // Envoy API proxy sidecar
    dohProxyIp: '172.30.0.40',  // DoH proxy sidecar
    cliProxyIp: '172.30.0.50',  // CLI proxy sidecar
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
