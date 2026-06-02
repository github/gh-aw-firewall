import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { BlockedTarget } from './types';
import { logger } from './logger';
import { parseDomainWithProtocol, isWildcardPattern, wildcardToRegex } from './domain-patterns';
import { runComposeDown } from './container-stop';
import {
  AGENT_CONTAINER_NAME,
  SQUID_CONTAINER_NAME,
  IPTABLES_INIT_CONTAINER_NAME,
  API_PROXY_CONTAINER_NAME,
  CLI_PROXY_CONTAINER_NAME,
} from './constants';
import { getLocalDockerEnv } from './docker-host';
import { isAgentExternallyKilled, markAgentExternallyKilled } from './container-lifecycle-state';

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
 * api-proxy container specifically failed to start.
 * Docker emits "dependency failed to start: container <name> is unhealthy"
 * for healthcheck failures, and may emit "dependency failed to start:
 * container <name> exited (1)" for startup-time process exits.
 */
function isApiProxyStartupFailureError(errorMsg: string): boolean {
  if (!errorMsg.includes(API_PROXY_CONTAINER_NAME)) {
    return false;
  }
  return errorMsg.includes('is unhealthy') || errorMsg.includes('exited (1)');
}

/**
 * Some docker compose failures surface only as a generic execa error message
 * while the actionable api-proxy state is visible only via container inspect.
 */
async function didApiProxyFailStartup(errorMsg: string): Promise<boolean> {
  if (isApiProxyStartupFailureError(errorMsg)) {
    return true;
  }

  try {
    const result = await execa(
      'docker',
      ['inspect', API_PROXY_CONTAINER_NAME, '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}'],
      {
        reject: false,
        env: getLocalDockerEnv(),
      }
    );

    if (result.exitCode !== 0) {
      return false;
    }

    const [containerStatus = '', healthStatus = ''] = result.stdout.trim().split('|');
    return containerStatus === 'exited' || healthStatus === 'unhealthy';
  } catch (error) {
    logger.debug(`Could not inspect ${API_PROXY_CONTAINER_NAME} after startup failure:`, error);
    return false;
  }
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
    const firstAttemptApiProxyStartupFailure = await didApiProxyFailStartup(firstErrorMsg);

    // When api-proxy specifically fails to start, retry once.
    // Transient failures are common on slow or busy runners (e.g. Azure-hosted runners)
    // where the Node.js process inside the container takes longer to bind its port.
    if (firstAttemptApiProxyStartupFailure) {
      logger.warn(`${API_PROXY_CONTAINER_NAME} failed to start — this may be a transient startup failure, retrying once...`);
      await logContainerLogsToStderr(API_PROXY_CONTAINER_NAME);

      // Tear down before retry so Docker Compose starts fresh
      try {
        await runComposeDown(workDir, { reject: false });
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
        if (await didApiProxyFailStartup(retryErrorMsg)) {
          // Surface api-proxy logs and emit a clear, unambiguous error so
          // downstream parse steps don't blame the model for never running.
          await logContainerLogsToStderr(API_PROXY_CONTAINER_NAME);
          throw new Error(
            `AWF firewall failed to start: ${API_PROXY_CONTAINER_NAME} failed to start on both attempts. ` +
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
 * Classifies and logs each blocked target, then emits actionable fix suggestions.
 * Extracted to avoid duplicating this logic between the startup-error path
 * (which uses `logger.error`) and the post-run warning path (which uses `logger.warn`).
 *
 * @param blockedTargets - Targets that were denied by the firewall
 * @param allowedDomains - Domains currently in the allowlist
 * @param log - Logging function to use (e.g. `logger.error` or `logger.warn`)
 * @returns The categorized lists so callers can decide on further action
 */
function reportBlockedDomains(
  blockedTargets: BlockedTarget[],
  allowedDomains: string[],
  log: (msg: string) => void,
): { missingDomains: string[]; portIssues: BlockedTarget[] } {
  const uniqueMissingDomains = new Set<string>();
  const portIssues: BlockedTarget[] = [];

  blockedTargets.forEach(blocked => {
    const isAllowed = allowedDomains.some(allowed => {
      // Strip any protocol prefix (e.g. "https://github.com" -> "github.com")
      const normalizedAllowed = parseDomainWithProtocol(allowed).domain;
      if (isWildcardPattern(normalizedAllowed)) {
        // Wildcard pattern match (e.g. "*.github.com")
        try {
          return new RegExp(wildcardToRegex(normalizedAllowed), 'i').test(blocked.domain);
        } catch {
          return false;
        }
      }
      // Exact match or subdomain match
      return blocked.domain === normalizedAllowed || blocked.domain.endsWith('.' + normalizedAllowed);
    });

    if (!isAllowed) {
      // Domain not in allowlist
      log(`  - Blocked: ${blocked.target} (domain not in allowlist)`);
      uniqueMissingDomains.add(blocked.domain);
    } else if (blocked.port && blocked.port !== '80' && blocked.port !== '443') {
      // Domain is allowed but port is not
      log(`  - Blocked: ${blocked.target} (port ${blocked.port} not allowed, only 80 and 443 are permitted)`);
      portIssues.push(blocked);
    } else {
      // Other reason (shouldn't happen often)
      log(`  - Blocked: ${blocked.target}`);
    }
  });

  log('Allowed domains:');
  allowedDomains.forEach(domain => { log(`  - Allowed: ${domain}`); });

  const missingDomains = [...uniqueMissingDomains];
  if (missingDomains.length > 0) {
    log(`To fix domain issues: --allow-domains "${[...allowedDomains, ...missingDomains].join(',')}"`);
  }
  if (portIssues.length > 0) {
    log('To fix port issues: Use standard ports 80 (HTTP) or 443 (HTTPS)');
  }

  return { missingDomains, portIssues };
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
      reportBlockedDomains(blockedTargets, allowedDomains, msg => logger.error(msg));

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
    if (isAgentExternallyKilled()) {
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
      reportBlockedDomains(blockedTargets, allowedDomains, msg => logger.warn(msg));
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
  markAgentExternallyKilled();
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
