import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import execa from 'execa';
import { WrapperConfig, BlockedTarget, API_PROXY_HEALTH_PORT } from './types';
import { logger } from './logger';
import { generateSquidConfig, generatePolicyManifest } from './squid-config';
import { generateSessionCa, initSslDb, parseUrlPatterns } from './ssl-bump';
import {
  SQUID_PORT,
  AGENT_CONTAINER_NAME,
  SQUID_CONTAINER_NAME,
  IPTABLES_INIT_CONTAINER_NAME,
  API_PROXY_CONTAINER_NAME,
  CLI_PROXY_CONTAINER_NAME,
  SslConfig,
  getLocalDockerEnv,
  getSafeHostUid,
  getSafeHostGid,
  getRealUserHome,
} from './host-env';
import { generateDockerCompose, redactDockerComposeSecrets } from './compose-generator';

// When bundled with esbuild, this global is replaced at build time with the
// JSON content of containers/agent/seccomp-profile.json.  In normal (tsc)
// builds the identifier remains undeclared, so the typeof check below is safe.
declare const __AWF_SECCOMP_PROFILE__: string | undefined;

/**
 * Flag set by fastKillAgentContainer() to signal runAgentCommand() that
 * the container was externally stopped. When true, runAgentCommand() skips
 * its own docker wait / log collection to avoid racing with the signal handler.
 */
let agentExternallyKilled = false;

/**
 * Writes configuration files to disk
 * Uses fixed network configuration (172.30.0.0/24) defined in host-iptables.ts
 */
export async function writeConfigs(config: WrapperConfig): Promise<void> {
  logger.debug('Writing configuration files...');

  // Ensure work directory exists with restricted permissions (owner-only access)
  // Defense-in-depth: even if tmpfs overlay fails, non-root processes on the host
  // cannot read the docker-compose.yml which contains sensitive tokens
  if (!fs.existsSync(config.workDir)) {
    fs.mkdirSync(config.workDir, { recursive: true, mode: 0o700 });
  } else {
    fs.chmodSync(config.workDir, 0o700);
  }

  // Create agent logs directory for persistence
  // Chown to host user so Copilot CLI can write logs (AWF runs as root, agent runs as host user)
  const agentLogsDir = path.join(config.workDir, 'agent-logs');
  if (!fs.existsSync(agentLogsDir)) {
    fs.mkdirSync(agentLogsDir, { recursive: true });
  }
  try {
    fs.chownSync(agentLogsDir, parseInt(getSafeHostUid()), parseInt(getSafeHostGid()));
  } catch { /* ignore chown failures in non-root context */ }
  logger.debug(`Agent logs directory created at: ${agentLogsDir}`);

  // Create agent session-state directory for persistence (events.jsonl, session data)
  // If sessionStateDir is specified, write directly there (timeout-safe, predictable path)
  // Otherwise, use workDir/agent-session-state (will be moved to /tmp after cleanup)
  // Chown to host user so Copilot CLI can create session subdirs and write events.jsonl
  const agentSessionStateDir = config.sessionStateDir || path.join(config.workDir, 'agent-session-state');
  if (!fs.existsSync(agentSessionStateDir)) {
    fs.mkdirSync(agentSessionStateDir, { recursive: true });
  }
  try {
    fs.chownSync(agentSessionStateDir, parseInt(getSafeHostUid()), parseInt(getSafeHostGid()));
  } catch { /* ignore chown failures in non-root context */ }
  logger.debug(`Agent session-state directory created at: ${agentSessionStateDir}`);

  // Create squid logs directory for persistence
  // If proxyLogsDir is specified, write directly there (timeout-safe)
  // Otherwise, use workDir/squid-logs (will be moved to /tmp after cleanup)
  // Note: Squid runs as user 'proxy' (UID 13, GID 13 in ubuntu/squid image)
  // We need to make the directory writable by the proxy user
  // Squid container runs as non-root 'proxy' user (UID 13, GID 13)
  // Set ownership so proxy user can write logs without root privileges
  const SQUID_PROXY_UID = 13;
  const SQUID_PROXY_GID = 13;
  const squidLogsDir = config.proxyLogsDir || path.join(config.workDir, 'squid-logs');
  if (!fs.existsSync(squidLogsDir)) {
    fs.mkdirSync(squidLogsDir, { recursive: true, mode: 0o755 });
    try {
      fs.chownSync(squidLogsDir, SQUID_PROXY_UID, SQUID_PROXY_GID);
    } catch {
      // Fallback to world-writable if chown fails (e.g., non-root context)
      fs.chmodSync(squidLogsDir, 0o777);
    }
  }
  logger.debug(`Squid logs directory created at: ${squidLogsDir}`);

  // Create api-proxy logs directory for persistence
  // If proxyLogsDir is specified, write inside it as a subdirectory (timeout-safe,
  // and included in the firewall-audit-logs artifact upload automatically)
  // Otherwise, write to workDir/api-proxy-logs (will be moved to /tmp after cleanup)
  // Note: API proxy runs as user 'apiproxy' (non-root)
  const apiProxyLogsDir = config.proxyLogsDir
    ? path.join(config.proxyLogsDir, 'api-proxy-logs')
    : path.join(config.workDir, 'api-proxy-logs');
  if (!fs.existsSync(apiProxyLogsDir)) {
    fs.mkdirSync(apiProxyLogsDir, { recursive: true, mode: 0o777 });
    // Explicitly set permissions to 0o777 (not affected by umask)
    fs.chmodSync(apiProxyLogsDir, 0o777);
  }
  logger.debug(`API proxy logs directory created at: ${apiProxyLogsDir}`);

  // Create CLI proxy logs directory for persistence
  // Note: CLI proxy runs as user 'cliproxy' (non-root)
  const cliProxyLogsDir = config.proxyLogsDir
    ? path.join(config.proxyLogsDir, 'cli-proxy-logs')
    : path.join(config.workDir, 'cli-proxy-logs');
  if (!fs.existsSync(cliProxyLogsDir)) {
    fs.mkdirSync(cliProxyLogsDir, { recursive: true, mode: 0o777 });
    fs.chmodSync(cliProxyLogsDir, 0o777);
  }
  logger.debug(`CLI proxy logs directory created at: ${cliProxyLogsDir}`);

  // Create /tmp/gh-aw/mcp-logs directory
  // This directory exists on the HOST for MCP gateway to write logs
  // Inside the AWF container, it's hidden via tmpfs mount (see generateDockerCompose)
  // Uses mode 0o777 to allow GitHub Actions workflows and MCP gateway to create subdirectories
  // even when AWF runs as root (e.g., sudo awf)
  const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
  if (!fs.existsSync(mcpLogsDir)) {
    fs.mkdirSync(mcpLogsDir, { recursive: true, mode: 0o777 });
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

    // Ensure source directories for subdirectory mounts exist with correct ownership
    const chrootHomeDirs = [
      '.copilot', '.cache', '.config', '.local',
      '.anthropic', '.claude', '.cargo', '.rustup', '.npm', '.nvm',
      ...(config.geminiApiKey ? ['.gemini'] : []),
    ];
    for (const dir of chrootHomeDirs) {
      const dirPath = path.join(effectiveHome, dir);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        fs.chownSync(dirPath, uid, gid);
        logger.debug(`Created host home subdirectory: ${dirPath} (${uid}:${gid})`);
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
  const auditDir = config.auditDir || path.join(config.workDir, 'audit');
  if (!fs.existsSync(auditDir)) {
    // Restrictive permissions initially; made readable during cleanup (chmod a+rX)
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  }

  // Save squid.conf for audit (no secrets — just domain ACLs and proxy config)
  fs.writeFileSync(path.join(auditDir, 'squid.conf'), squidConfig, { mode: 0o600 });

  // Save redacted docker-compose.yml (strip env vars that may contain secrets)
  const redactedCompose = redactDockerComposeSecrets(dockerCompose);
  fs.writeFileSync(
    path.join(auditDir, 'docker-compose.redacted.yml'),
    yaml.dump(redactedCompose, { lineWidth: -1 }),
    { mode: 0o600 }
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
  });
  fs.writeFileSync(
    path.join(auditDir, 'policy-manifest.json'),
    JSON.stringify(policyManifest, null, 2),
    { mode: 0o600 }
  );

  logger.debug(`Audit artifacts written to: ${auditDir}`);
}

/**
 * Checks Squid logs for access denials to provide better error context
 * @param workDir - Working directory containing configs
 * @param proxyLogsDir - Optional custom directory where proxy logs are written
 */
async function checkSquidLogs(workDir: string, proxyLogsDir?: string): Promise<{ hasDenials: boolean; blockedTargets: BlockedTarget[] }> {
  try {
    // Read from the access.log file (Squid doesn't write access logs to stdout)
    // If proxyLogsDir is specified, logs are written directly there
    const squidLogsDir = proxyLogsDir || path.join(workDir, 'squid-logs');
    const accessLogPath = path.join(squidLogsDir, 'access.log');
    let logContent = '';

    if (fs.existsSync(accessLogPath)) {
      logContent = fs.readFileSync(accessLogPath, 'utf-8');
    } else {
      logger.debug(`Squid access log not found at: ${accessLogPath}`);
      return { hasDenials: false, blockedTargets: [] };
    }

    const blockedTargets: BlockedTarget[] = [];
    const seenTargets = new Set<string>();
    const lines = logContent.split('\n');

    for (const line of lines) {
      // Look for TCP_DENIED entries in Squid logs
      // Format: timestamp IP domain:port dest:port version method status TCP_DENIED:HIER_NONE domain:port "user-agent"
      if (line.includes('TCP_DENIED')) {
        // Extract the domain:port which appears after the method
        // Example: "1760994429.358 172.30.0.20:36274 github.com:8443 -:- 1.1 CONNECT 403 TCP_DENIED:HIER_NONE github.com:8443 "curl/7.81.0""
        const match = line.match(/(?:GET|POST|CONNECT|PUT|DELETE|HEAD)\s+\d+\s+TCP_DENIED:\S+\s+([^\s]+)/);
        if (match && match[1]) {
          const target = match[1]; // Full target with port (e.g., "github.com:8443")

          if (!seenTargets.has(target)) {
            seenTargets.add(target);

            // Parse domain and port
            const colonIndex = target.lastIndexOf(':');
            let domain: string;
            let port: string | undefined;

            if (colonIndex !== -1) {
              domain = target.substring(0, colonIndex);
              port = target.substring(colonIndex + 1);

              // Validate that port is actually a number (to handle IPv6 addresses correctly)
              if (!/^\d+$/.test(port)) {
                domain = target;
                port = undefined;
              }
            } else {
              domain = target;
            }

            blockedTargets.push({ target, domain, port });
          }
        }
      }
    }
    return { hasDenials: blockedTargets.length > 0, blockedTargets };
  } catch (error) {
    logger.debug('Could not check Squid logs:', error);
    return { hasDenials: false, blockedTargets: [] };
  }
}

/**
 * Returns true when the Docker Compose error message indicates that the
 * api-proxy container specifically failed its health check.
 * Docker emits "dependency failed to start: container <name> is unhealthy"
 * when a dependent container's health check does not pass.
 */
function isApiProxyUnhealthyError(errorMsg: string): boolean {
  return errorMsg.includes('is unhealthy') &&
    errorMsg.includes(API_PROXY_CONTAINER_NAME);
}

/**
 * Dumps the tail of a container's logs to stderr for diagnosis.
 * Silently skips if the container does not exist or logs are unavailable.
 */
async function logContainerLogsToStderr(containerName: string): Promise<void> {
  try {
    const result = await execa('docker', ['logs', '--tail', '50', containerName], {
      reject: false,
      env: getLocalDockerEnv(),
    });
    // Only emit stdout/stderr from a successful docker logs invocation.
    // When the container does not exist, docker logs exits non-zero and writes
    // "No such container" to stderr — skip that noise entirely.
    if (result.exitCode === 0) {
      const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (combined) {
        logger.error(`${containerName} container logs (last 50 lines):\n${combined}`);
      }
    } else {
      logger.debug(`docker logs exited with ${result.exitCode} for container ${containerName} — container may not exist`);
    }
  } catch (error) {
    logger.debug(`Could not retrieve logs for container ${containerName}:`, error);
  }
}

/**
 * Starts Docker Compose services
 * @param workDir - Working directory containing Docker Compose config
 * @param allowedDomains - List of allowed domains for error reporting
 * @param proxyLogsDir - Optional custom directory for proxy logs
 * @param skipPull - If true, use local images without pulling from registry
 */
export async function startContainers(workDir: string, allowedDomains: string[], proxyLogsDir?: string, skipPull?: boolean): Promise<void> {
  logger.info('Starting containers...');

  // Force remove any existing containers with these names to avoid conflicts
  // This handles orphaned containers from failed/interrupted previous runs
  logger.debug('Removing any existing containers with conflicting names...');
  try {
    await execa('docker', ['rm', '-f', SQUID_CONTAINER_NAME, AGENT_CONTAINER_NAME, IPTABLES_INIT_CONTAINER_NAME, API_PROXY_CONTAINER_NAME, CLI_PROXY_CONTAINER_NAME], {
      reject: false,
      env: getLocalDockerEnv(),
    });
  } catch {
    // Ignore errors if containers don't exist
    logger.debug('No existing containers to remove (this is normal)');
  }

  const composeArgs = ['compose', 'up', '-d'];
  if (skipPull) {
    composeArgs.push('--pull', 'never');
    logger.debug('Using --pull never (skip-pull mode)');
  }

  const runDockerComposeUp = async (): Promise<void> => {
    // Redirect Docker Compose stdout to stderr so it doesn't pollute the
    // agent command's stdout. Docker Compose outputs build progress and
    // container creation status to stdout, which would be captured by test
    // runners and break assertions that check for agent command output.
    // All AWF informational output goes to stderr (via logger), so this
    // keeps the output consistent. Users still see progress in their terminal.
    await execa('docker', composeArgs, {
      cwd: workDir,
      stdout: process.stderr,
      stderr: 'inherit',
      env: getLocalDockerEnv(),
    });
  };

  try {
    await runDockerComposeUp();
    logger.success('Containers started successfully');
  } catch (firstError) {
    const firstErrorMsg = firstError instanceof Error ? firstError.message : String(firstError);

    // When api-proxy specifically fails its health check, retry once.
    // Transient failures are common on slow or busy runners (e.g. Azure-hosted runners)
    // where the Node.js process inside the container takes longer to bind its port.
    if (isApiProxyUnhealthyError(firstErrorMsg)) {
      logger.warn(`${API_PROXY_CONTAINER_NAME} failed its health check — this may be a transient startup failure, retrying once...`);
      await logContainerLogsToStderr(API_PROXY_CONTAINER_NAME);

      // Tear down before retry so Docker Compose starts fresh
      try {
        await execa('docker', ['compose', 'down', '-v', '-t', '1'], {
          cwd: workDir,
          stdout: process.stderr,
          stderr: 'inherit',
          env: getLocalDockerEnv(),
          reject: false,
        });
      } catch (cleanupError) {
        // Best-effort cleanup — proceed with retry regardless
        logger.debug('Cleanup before retry failed (proceeding anyway):', cleanupError);
      }

      try {
        await runDockerComposeUp();
        logger.success('Containers started successfully (retry succeeded)');
        return;
      } catch (retryError) {
        const retryErrorMsg = retryError instanceof Error ? retryError.message : String(retryError);
        if (isApiProxyUnhealthyError(retryErrorMsg)) {
          // Surface api-proxy logs and emit a clear, unambiguous error so
          // downstream parse steps don't blame the model for never running.
          await logContainerLogsToStderr(API_PROXY_CONTAINER_NAME);
          throw new Error(
            `AWF firewall failed to start: ${API_PROXY_CONTAINER_NAME} failed its health check on both attempts. ` +
            `The agent was never invoked. ` +
            `See ${API_PROXY_CONTAINER_NAME} container logs above for details.`
          );
        }
        // Any other retry error (e.g. squid healthcheck or domain blockage) falls
        // through to the Squid log diagnostic path below as if it were the first error.
        // Re-assign so the shared handler at the end of the catch block can process it.
        return await handleHealthcheckError(retryErrorMsg, retryError as Error, workDir, proxyLogsDir, allowedDomains);
      }
    }

    return await handleHealthcheckError(firstErrorMsg, firstError as Error, workDir, proxyLogsDir, allowedDomains);
  }
}

/**
 * Runs the Squid-log diagnostic check and re-throws with a user-friendly message
 * when blocked domains are found, or rethrows the original error otherwise.
 */
async function handleHealthcheckError(
  errorMsg: string,
  error: Error,
  workDir: string,
  proxyLogsDir: string | undefined,
  allowedDomains: string[]
): Promise<never> {
  if (errorMsg.includes('is unhealthy') || errorMsg.includes('dependency failed')) {
    const { hasDenials, blockedTargets } = await checkSquidLogs(workDir, proxyLogsDir);

    if (hasDenials) {
      logger.error('Firewall blocked domains during startup:');

      const missingDomains: string[] = [];
      const portIssues: BlockedTarget[] = [];

      blockedTargets.forEach(blocked => {
        const isAllowed = allowedDomains.some(allowed =>
          blocked.domain === allowed || blocked.domain.endsWith('.' + allowed)
        );

        if (!isAllowed) {
          // Domain not in allowlist
          logger.error(`  - Blocked: ${blocked.target} (domain not in allowlist)`);
          missingDomains.push(blocked.domain);
        } else if (blocked.port && blocked.port !== '80' && blocked.port !== '443') {
          // Domain is allowed but port is not
          logger.error(`  - Blocked: ${blocked.target} (port ${blocked.port} not allowed, only 80 and 443 are permitted)`);
          portIssues.push(blocked);
        } else {
          // Other reason (shouldn't happen often)
          logger.error(`  - Blocked: ${blocked.target}`);
        }
      });

      logger.error('Allowed domains:');
      allowedDomains.forEach(domain => {
        logger.error(`  - Allowed: ${domain}`);
      });

      if (missingDomains.length > 0) {
        logger.error(`To fix domain issues: --allow-domains "${[...allowedDomains, ...missingDomains].join(',')}"`);
      }
      if (portIssues.length > 0) {
        logger.error('To fix port issues: Use standard ports 80 (HTTP) or 443 (HTTPS)');
      }

      // Create a more user-friendly error
      const blockedList = blockedTargets.map(b => `"${b.target}"`).join(', ');
      throw new Error(
        `Firewall blocked access to: ${blockedList}. ` +
        `Check error messages above for details.`
      );
    }
  }

  logger.error('Failed to start containers:', error);
  throw error;
}

/**
 * Runs the agent command in the container and reports any blocked domains
 */
export async function runAgentCommand(workDir: string, allowedDomains: string[], proxyLogsDir?: string, agentTimeoutMinutes?: number): Promise<{ exitCode: number; blockedDomains: string[] }> {
  logger.info('Executing agent command...');

  try {
    // Stream logs in real-time using docker logs -f (follow mode)
    // Run this in the background and wait for the container to exit separately
    const logsProcess = execa('docker', ['logs', '-f', AGENT_CONTAINER_NAME], {
      stdio: 'inherit',
      reject: false,
      env: getLocalDockerEnv(),
    });

    let exitCode: number;

    if (agentTimeoutMinutes) {
      const timeoutMs = agentTimeoutMinutes * 60 * 1000;
      logger.info(`Agent timeout: ${agentTimeoutMinutes} minutes`);

      // Race docker wait against a timeout
      const waitPromise = execa('docker', ['wait', AGENT_CONTAINER_NAME], { env: getLocalDockerEnv() }).then(result => ({
        type: 'completed' as const,
        exitCodeStr: result.stdout,
      }));

      let timeoutTimer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<{ type: 'timeout' }>(resolve => {
        timeoutTimer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
      });

      const raceResult = await Promise.race([waitPromise, timeoutPromise]);

      if (raceResult.type === 'timeout') {
        logger.warn(`Agent command timed out after ${agentTimeoutMinutes} minutes, stopping container...`);
        // Stop the container gracefully (10 second grace period before SIGKILL)
        await execa('docker', ['stop', '-t', '10', AGENT_CONTAINER_NAME], { reject: false, env: getLocalDockerEnv() });
        exitCode = 124; // Standard timeout exit code (same as coreutils timeout)
      } else {
        // Clear the timeout timer so it doesn't keep the event loop alive
        clearTimeout(timeoutTimer!);
        exitCode = parseInt(raceResult.exitCodeStr.trim(), 10);
      }
    } else {
      // No timeout - wait indefinitely
      const { stdout: exitCodeStr } = await execa('docker', ['wait', AGENT_CONTAINER_NAME], { env: getLocalDockerEnv() });
      exitCode = parseInt(exitCodeStr.trim(), 10);
    }

    // Wait for the logs process to finish (it should exit automatically when container stops)
    await logsProcess;

    // If the container was killed externally (e.g. by fastKillAgentContainer in a
    // signal handler), skip the remaining log analysis — the container state is
    // unreliable and the signal handler will drive the rest of the shutdown.
    if (agentExternallyKilled) {
      logger.debug('Agent was externally killed, skipping post-run analysis');
      return { exitCode: exitCode || 143, blockedDomains: [] };
    }

    logger.debug(`Agent exit code: ${exitCode}`);

    // Small delay to ensure Squid logs are flushed to disk
    await new Promise(resolve => setTimeout(resolve, 200));

    // Check Squid logs to see if any domains were blocked (do this BEFORE cleanup)
    const { hasDenials, blockedTargets } = await checkSquidLogs(workDir, proxyLogsDir);

    // If command failed (non-zero exit) and domains were blocked, show a warning
    if (exitCode !== 0 && hasDenials) {
      logger.warn('Firewall blocked domains:');

      const missingDomains: string[] = [];
      const portIssues: BlockedTarget[] = [];

      blockedTargets.forEach(blocked => {
        const isAllowed = allowedDomains.some(allowed =>
          blocked.domain === allowed || blocked.domain.endsWith('.' + allowed)
        );

        if (!isAllowed) {
          // Domain not in allowlist
          logger.warn(`  - Blocked: ${blocked.target} (domain not in allowlist)`);
          missingDomains.push(blocked.domain);
        } else if (blocked.port && blocked.port !== '80' && blocked.port !== '443') {
          // Domain is allowed but port is not
          logger.warn(`  - Blocked: ${blocked.target} (port ${blocked.port} not allowed, only 80 and 443 are permitted)`);
          portIssues.push(blocked);
        } else {
          // Other reason (shouldn't happen often)
          logger.warn(`  - Blocked: ${blocked.target}`);
        }
      });

      logger.warn('Allowed domains:');
      allowedDomains.forEach(domain => {
        logger.warn(`  - Allowed: ${domain}`);
      });

      if (missingDomains.length > 0) {
        logger.warn(`To fix domain issues: --allow-domains "${[...allowedDomains, ...missingDomains].join(',')}"`);
      }
      if (portIssues.length > 0) {
        logger.warn('To fix port issues: Use standard ports 80 (HTTP) or 443 (HTTPS)');
      }
    }

    return { exitCode, blockedDomains: blockedTargets.map(b => b.domain) };
  } catch (error) {
    logger.error('Failed to run agent command:', error);
    throw error;
  }
}

/**
 * Fast-kills the agent container with a short grace period.
 * Used in signal handlers (SIGTERM/SIGINT) to ensure the agent cannot outlive
 * the awf process — e.g. when GH Actions sends SIGTERM followed by SIGKILL
 * after ~10 seconds. The full `docker compose down -v` in stopContainers() is
 * too slow to reliably complete in that window.
 *
 * @param stopTimeoutSeconds - Grace period before SIGKILL (default: 3)
 */
export async function fastKillAgentContainer(stopTimeoutSeconds = 3): Promise<void> {
  agentExternallyKilled = true;
  try {
    await execa('docker', ['stop', '-t', String(stopTimeoutSeconds), AGENT_CONTAINER_NAME], {
      reject: false,
      timeout: (stopTimeoutSeconds + 5) * 1000, // hard deadline on the stop command itself
      env: getLocalDockerEnv(),
    });
  } catch {
    // Best-effort — if docker CLI is unavailable or hangs, we still proceed
    // to performCleanup which will attempt docker compose down.
  }
}

/**
 * Returns whether the agent was externally killed via fastKillAgentContainer().
 * @internal Exported for testing.
 */
export function isAgentExternallyKilled(): boolean {
  return agentExternallyKilled;
}

/**
 * Resets the externally-killed flag. Only used in tests.
 * @internal Exported for testing.
 */
export function resetAgentExternallyKilled(): void {
  agentExternallyKilled = false;
}
