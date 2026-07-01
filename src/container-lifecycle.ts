import execa from 'execa';
import { logger } from './logger';
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
import {
  didContainerFailStartup,
  handleHealthcheckError,
  logContainerLogsToStderr,
  reportBlockedDomains,
} from './container-startup-diagnostics';
import { checkSquidLogs } from './squid-log-reader';

function getComposeUpArgs(skipPull?: boolean): string[] {
  const composeArgs = ['compose', 'up', '-d'];
  if (skipPull) {
    composeArgs.push('--pull', 'never');
    logger.debug('Using --pull never (skip-pull mode)');
  }
  return composeArgs;
}

async function runDockerComposeUp(workDir: string, composeArgs: string[]): Promise<void> {
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
}

async function attemptContainerStartup(
  workDir: string,
  composeArgs: string[],
  skipPull?: boolean,
  onNetworkReady?: () => Promise<void>,
): Promise<Error | undefined> {
  // Phase 1 (topology mode only): start squid-proxy alone so the compose-managed
  // awf-net is created before any health-gated dependents (cli-proxy, agent) start.
  // Then invoke onNetworkReady() so external peer containers are attached to awf-net,
  // breaking the ordering deadlock where the cli-proxy liveness probe fired before
  // the DIFC peer had been joined to the internal network (EAI_AGAIN → fail-fast).
  // Phase 3 is the normal full bring-up below (runDockerComposeUp).
  if (onNetworkReady) {
    logger.info('Topology mode: starting squid-proxy first to create awf-net...');
    const squidOnlyArgs = ['compose', 'up', '-d', '--no-deps'];
    if (skipPull) {
      squidOnlyArgs.push('--pull', 'never');
    }
    squidOnlyArgs.push('squid-proxy');
    await execa('docker', squidOnlyArgs, {
      cwd: workDir,
      stdout: process.stderr,
      stderr: 'inherit',
      env: getLocalDockerEnv(),
    });
    logger.info('squid-proxy started; attaching topology peers before full bring-up...');
    await onNetworkReady();
    logger.info('Topology peers attached; continuing with full container bring-up...');
  }

  try {
    await runDockerComposeUp(workDir, composeArgs);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function createCliProxyStartupError(): Error {
  return new Error(
    `AWF firewall failed to start: ${CLI_PROXY_CONTAINER_NAME} could not connect to the external DIFC proxy (or exited before establishing a connection). ` +
    `Failing fast to avoid repeated in-agent retries. ` +
    `The agent was never invoked. ` +
    `See ${CLI_PROXY_CONTAINER_NAME} container logs above for details.`
  );
}

function createRepeatedApiProxyStartupError(): Error {
  return new Error(
    `AWF firewall failed to start: ${API_PROXY_CONTAINER_NAME} failed to start on both attempts. ` +
    `The agent was never invoked. ` +
    `See ${API_PROXY_CONTAINER_NAME} container logs above for details.`
  );
}

async function handleRetryStartupFailure(
  retryError: Error,
  workDir: string,
  proxyLogsDir: string | undefined,
  allowedDomains: string[],
): Promise<void> {
  const retryErrorMsg = retryError.message;
  if (await didContainerFailStartup(retryErrorMsg, API_PROXY_CONTAINER_NAME)) {
    // Surface api-proxy logs and emit a clear, unambiguous error so
    // downstream parse steps don't blame the model for never running.
    await logContainerLogsToStderr(API_PROXY_CONTAINER_NAME);
    throw createRepeatedApiProxyStartupError();
  }
  // Dump squid container logs before falling through to the domain-blockage
  // diagnostic path, so that persistent squid failures are diagnosable.
  if (await didContainerFailStartup(retryErrorMsg, SQUID_CONTAINER_NAME)) {
    await logContainerLogsToStderr(SQUID_CONTAINER_NAME);
  }
  if (await didContainerFailStartup(retryErrorMsg, CLI_PROXY_CONTAINER_NAME)) {
    await logContainerLogsToStderr(CLI_PROXY_CONTAINER_NAME);
    throw createCliProxyStartupError();
  }
  // Any remaining retry error (e.g. squid healthcheck or domain blockage) falls
  // through to the Squid log diagnostic path below as if it were the first error.
  await handleHealthcheckError(retryErrorMsg, retryError, workDir, proxyLogsDir, allowedDomains);
}

async function handleStartupFailure(
  error: Error,
  workDir: string,
  proxyLogsDir: string | undefined,
  allowedDomains: string[],
  runComposeUp: () => Promise<void>,
): Promise<void> {
  const errorMsg = error.message;
  const firstAttemptApiProxyStartupFailure = await didContainerFailStartup(errorMsg, API_PROXY_CONTAINER_NAME);
  // Only check squid if api-proxy didn't already claim the failure, so we
  // don't fire two inspect calls when api-proxy is the root cause.
  const firstAttemptSquidStartupFailure = !firstAttemptApiProxyStartupFailure
    && await didContainerFailStartup(errorMsg, SQUID_CONTAINER_NAME);
  // CLI proxy startup failures are non-retriable because they usually mean
  // the external DIFC proxy is unavailable (connection refused) and retries
  // only delay failure while the agent repeatedly burns tokens.
  const firstAttemptCliProxyStartupFailure = !firstAttemptApiProxyStartupFailure
    && !firstAttemptSquidStartupFailure
    && await didContainerFailStartup(errorMsg, CLI_PROXY_CONTAINER_NAME);

  // When api-proxy or squid specifically fails to start, retry once.
  // Both containers are occasionally flaky on slow or busy CI runners:
  // - api-proxy: the Node.js process inside the container takes longer to bind its port
  // - squid: the squid proxy is slow to open its listen socket on resource-constrained hosts
  if (firstAttemptApiProxyStartupFailure || firstAttemptSquidStartupFailure) {
    const failingContainer = firstAttemptApiProxyStartupFailure ? API_PROXY_CONTAINER_NAME : SQUID_CONTAINER_NAME;
    logger.warn(`${failingContainer} failed to start — this may be a transient startup failure, retrying once...`);
    await logContainerLogsToStderr(failingContainer);

    // Tear down before retry so Docker Compose starts fresh
    try {
      await runComposeDown(workDir, { reject: false });
    } catch (cleanupError) {
      // Best-effort cleanup — proceed with retry regardless
      logger.debug('Cleanup before retry failed (proceeding anyway):', cleanupError);
    }

    try {
      await runComposeUp();
      logger.success('Containers started successfully (retry succeeded)');
      return;
    } catch (retryError) {
      await handleRetryStartupFailure(
        retryError instanceof Error ? retryError : new Error(String(retryError)),
        workDir,
        proxyLogsDir,
        allowedDomains,
      );
      return;
    }
  }

  if (firstAttemptCliProxyStartupFailure) {
    await logContainerLogsToStderr(CLI_PROXY_CONTAINER_NAME);
    throw createCliProxyStartupError();
  }

  await handleHealthcheckError(errorMsg, error, workDir, proxyLogsDir, allowedDomains);
}

/**
 * Starts Docker Compose services
 * @param workDir - Working directory containing Docker Compose config
 * @param allowedDomains - List of allowed domains for error reporting
 * @param proxyLogsDir - Optional custom directory for proxy logs
 * @param skipPull - If true, use local images without pulling from registry
 * @param onNetworkReady - Optional callback invoked after squid-proxy has started
 *   (and created the compose-managed network) but before the remaining health-gated
 *   services are brought up. Used in network-isolation (topology) mode to attach
 *   external peer containers to `awf-net` before the cli-proxy liveness probe runs,
 *   preventing the ordering deadlock where the cli-proxy probe cannot resolve a peer
 *   that has not yet been joined to the internal network.
 *
 *   When this callback is provided the startup is split into three phases:
 *     1. `docker compose up -d --no-deps squid-proxy` — creates `awf-net` and
 *        starts Squid (the network gateway), without waiting on dependent services.
 *     2. `onNetworkReady()` — attaches topology peers to `awf-net`.
 *     3. `docker compose up -d` — full bring-up; the cli-proxy liveness probe can
 *        now resolve the peer, so the health gate succeeds.
 *
 *   When this callback is omitted the existing single-`up` path is used unchanged.
 */
export async function startContainers(workDir: string, allowedDomains: string[], proxyLogsDir?: string, skipPull?: boolean, onNetworkReady?: () => Promise<void>): Promise<void> {
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

  const composeArgs = getComposeUpArgs(skipPull);
  const runComposeUp = () => runDockerComposeUp(workDir, composeArgs);
  const startupError = await attemptContainerStartup(workDir, composeArgs, skipPull, onNetworkReady);
  if (startupError) {
    await handleStartupFailure(startupError, workDir, proxyLogsDir, allowedDomains, runComposeUp);
    return;
  }

  logger.success('Containers started successfully');
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
