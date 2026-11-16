import execa from 'execa';
import { logger } from './logger';
import { runComposeDown } from './container-stop';
import {
  AGENT_CONTAINER_NAME,
  SQUID_CONTAINER_NAME,
  IPTABLES_INIT_CONTAINER_NAME,
  API_PROXY_CONTAINER_NAME,
  ROUTER_CONTAINER_NAME,
  CLI_PROXY_CONTAINER_NAME,
  ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME,
  ENCLAVE_MCP_SERVER_CONTAINER_NAME,
} from './constants';
import { getLocalDockerEnv } from './docker-host';
import {
  didContainerFailStartup,
  handleHealthcheckError,
  logContainerLogsToStderr,
  detectDnsResolutionFailure,
} from './container-startup-diagnostics';
import { removeConflictingComposeNetworks } from './compose-network-conflicts';
import { captureEnclaveStartupDiagnostics } from './enclave/startup-diagnostics';

class InfrastructureReadinessError extends Error {
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'InfrastructureReadinessError';
    Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}
class PostReadinessAgentStartupError extends Error {}

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
  onInfrastructureReady?: () => Promise<void>,
  proxyLogsDir?: string,
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

  let enclaveServerStarted = false;
  try {
    if (onInfrastructureReady) {
      const listed = await execa('docker', ['compose', 'config', '--services'], {
        cwd: workDir,
        env: getLocalDockerEnv(),
      });
      const services = listed.stdout
        .split('\n')
        .map((service) => service.trim())
        .filter(Boolean);
      enclaveServerStarted = services.includes('enclave-mcp-server');
      const infrastructure = services.filter(
        (service) => service !== 'agent' && service !== 'iptables-init',
      );
      if (infrastructure.length === 0) {
        throw new Error('No infrastructure services were generated for enclave gateway startup');
      }
      await runDockerComposeUp(workDir, [...composeArgs, ...infrastructure]);
      try {
        await onInfrastructureReady();
      } catch (error) {
        throw new InfrastructureReadinessError(
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
      if (!services.includes('agent')) {
        return undefined;
      }
      try {
        await runDockerComposeUp(workDir, composeArgs);
      } catch (error) {
        throw new PostReadinessAgentStartupError(
          error instanceof Error ? error.message : String(error),
        );
      }
      return undefined;
    }
    await runDockerComposeUp(workDir, composeArgs);
    return undefined;
  } catch (error) {
    if (enclaveServerStarted) {
      await captureEnclaveStartupDiagnostics(workDir, proxyLogsDir, 'startup-failure');
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

function createCliProxyStartupError(dnsFailureHost?: string | null): Error {
  let message =
    `AWF firewall failed to start: ${CLI_PROXY_CONTAINER_NAME} could not connect to the external DIFC proxy (or exited before establishing a connection). ` +
    `Failing fast to avoid repeated in-agent retries. ` +
    `The agent was never invoked. ` +
    `See ${CLI_PROXY_CONTAINER_NAME} container logs above for details.`;

  if (dnsFailureHost) {
    message +=
      `\n\nDNS resolution failed for "${dnsFailureHost}" (getaddrinfo EAI_AGAIN/ENOTFOUND). ` +
      `On ARC/DinD runners, containers created by the Docker-in-Docker daemon run on the DinD ` +
      `Docker network, which may inherit Kubernetes search domains / ndots settings that break ` +
      `single-label peer lookups on internal Docker networks, or may not forward DNS to the ` +
      `Kubernetes cluster resolver for Service names. To fix this, set dockerd --dns-opt ndots:0, ` +
      `address the DIFC proxy by IP, or configure dockerd DNS (e.g. --dns <kube-dns-ip>) so ` +
      `container lookups reach Kubernetes DNS. See https://github.github.io/gh-aw/guides/arc-dind-copilot-agent/ for details.`;
  }

  return new Error(message);
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
    const dnsFailureHost = await detectDnsResolutionFailure(CLI_PROXY_CONTAINER_NAME);
    throw createCliProxyStartupError(dnsFailureHost);
  }
  if (await didContainerFailStartup(retryErrorMsg, ENCLAVE_MCP_SERVER_CONTAINER_NAME)) {
    await captureEnclaveStartupDiagnostics(workDir, proxyLogsDir, 'startup-failure');
    throw retryError;
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
  const firstAttemptEnclaveServerFailure = !firstAttemptApiProxyStartupFailure
    && !firstAttemptSquidStartupFailure
    && !firstAttemptCliProxyStartupFailure
    && await didContainerFailStartup(errorMsg, ENCLAVE_MCP_SERVER_CONTAINER_NAME);

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
    const dnsFailureHost = await detectDnsResolutionFailure(CLI_PROXY_CONTAINER_NAME);
    throw createCliProxyStartupError(dnsFailureHost);
  }

  if (firstAttemptEnclaveServerFailure) {
    await captureEnclaveStartupDiagnostics(workDir, proxyLogsDir, 'startup-failure');
    throw error;
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
 * @param onInfrastructureReady - Optional fail-closed gate invoked after every
 *   non-agent Compose service starts and before the compose agent starts. For
 *   infrastructure-only runtimes such as sbx, it runs before startContainers
 *   returns and therefore before the sandbox is created.
 */
export async function startContainers(
  workDir: string,
  allowedDomains: string[],
  proxyLogsDir?: string,
  skipPull?: boolean,
  onNetworkReady?: () => Promise<void>,
  onInfrastructureReady?: () => Promise<void>,
): Promise<void> {
  logger.info('Starting containers...');

  // Force remove any existing containers with these names to avoid conflicts
  // This handles orphaned containers from failed/interrupted previous runs
  logger.debug('Removing any existing containers with conflicting names...');
  try {
    await execa('docker', [
      'rm',
      '-f',
      SQUID_CONTAINER_NAME,
      AGENT_CONTAINER_NAME,
      IPTABLES_INIT_CONTAINER_NAME,
      API_PROXY_CONTAINER_NAME,
      ROUTER_CONTAINER_NAME,
      CLI_PROXY_CONTAINER_NAME,
      ENCLAVE_MCP_SERVER_CONTAINER_NAME,
      ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME,
    ], {
      reject: false,
      env: getLocalDockerEnv(),
    });
  } catch {
    // Ignore errors if containers don't exist
    logger.debug('No existing containers to remove (this is normal)');
  }

  // Reclaim fixed-name Docker networks (e.g. `awf-net`) left behind by a
  // previous run. Compose refuses to attach to a network it did not create for
  // this project ("a network with name awf-net exists but was not created for
  // project ..."), which otherwise blocks startup entirely.
  await removeConflictingComposeNetworks(workDir);

  const composeArgs = getComposeUpArgs(skipPull);
  const runComposeUp = onInfrastructureReady
    ? async () => {
        const error = await attemptContainerStartup(
          workDir,
          composeArgs,
          skipPull,
          onNetworkReady,
          onInfrastructureReady,
          proxyLogsDir,
        );
        if (error) throw error;
      }
    : () => runDockerComposeUp(workDir, composeArgs);
  const startupError = await attemptContainerStartup(
    workDir,
    composeArgs,
    skipPull,
    onNetworkReady,
    onInfrastructureReady,
    proxyLogsDir,
  );
  if (startupError) {
    if (
      startupError instanceof InfrastructureReadinessError
      || startupError instanceof PostReadinessAgentStartupError
    ) {
      throw startupError;
    }
    await handleStartupFailure(startupError, workDir, proxyLogsDir, allowedDomains, runComposeUp);
    return;
  }

  logger.success('Containers started successfully');
}
