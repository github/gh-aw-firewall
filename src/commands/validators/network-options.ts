import { logger } from '../../logger';
import { UpstreamProxyConfig } from '../../types';
import {
  checkDockerHost,
  resolveDockerHostPathPrefix,
} from '../../option-parsers';
import { resolveAllowedDomains, resolveBlockedDomains } from '../preflight';
import { resolveNetworkConfig } from '../network-setup';

/**
 * The result produced by {@link validateNetworkOptions}.
 */
export interface NetworkOptionsResult {
  dockerHostCheck: ReturnType<typeof checkDockerHost>;
  dockerHostPathPrefixResolution: ReturnType<typeof resolveDockerHostPathPrefix>;
  allowedDomains: string[];
  blockedDomains: string[];
  localhostResult: ReturnType<typeof resolveAllowedDomains>['localhostResult'];
  resolvedCopilotApiTarget: string | undefined;
  resolvedCopilotApiBasePath: string | undefined;
  upstreamProxy: UpstreamProxyConfig | undefined;
  dnsServers: string[];
  dnsOverHttps: string | undefined;
}

/**
 * Validates Docker-host, domain-resolution, and network-configuration options.
 *
 * Covers the following option groups:
 *  - `--docker-host` / `DOCKER_HOST` environment variable detection
 *  - `--docker-host-path-prefix`
 *  - `--allow-domains`, `--allow-domains-file`, `--block-domains`
 *  - `--upstream-proxy`, `--dns-servers`, `--dns-over-https`
 *
 * Emits warnings for external Docker hosts and missing path prefixes but
 * does not exit for those cases — hard exits happen only in the delegated
 * helpers (`resolveAllowedDomains`, `resolveNetworkConfig`).
 */
export function validateNetworkOptions(options: Record<string, unknown>): NetworkOptionsResult {
  // --- Docker host ---------------------------------------------------------

  // When DOCKER_HOST points at a non-loopback TCP daemon (e.g. a remote host
  // or workflow-scope DinD), AWF redirects its own docker calls to the local
  // socket automatically.  Loopback TCP endpoints (tcp://localhost:2375) and
  // unix sockets are passed through as-is.
  // The original DOCKER_HOST value is forwarded into the agent container so the
  // agent workload can still reach the DinD daemon.
  const dockerHostCheck = checkDockerHost();
  if (!dockerHostCheck.valid) {
    logger.warn(
      '⚠️  External DOCKER_HOST detected. AWF will redirect its own Docker calls to the local socket.',
    );
    logger.warn(
      '   The original DOCKER_HOST (and related Docker client env vars) are forwarded into the agent container.',
    );
  }
  const dockerHostPathPrefixResolution = resolveDockerHostPathPrefix(
    dockerHostCheck,
    options.dockerHostPathPrefix as string | undefined,
  );
  if (!dockerHostCheck.valid && !dockerHostPathPrefixResolution.dockerHostPathPrefix) {
    logger.warn(
      '⚠️  If your Docker daemon uses a split runner/daemon filesystem, set --docker-host-path-prefix (for example: /host).',
    );
  }
  if (dockerHostPathPrefixResolution.dindHint && !dockerHostPathPrefixResolution.dockerHostPathPrefix) {
    logger.warn(
      '⚠️  Non-standard DOCKER_HOST unix socket or AWF_DIND=1 detected — this typically indicates an ARC/DinD',
    );
    logger.warn(
      '   setup where the runner and Docker daemon have separate root filesystems.',
    );
    logger.warn(
      '   If bind mounts fail, set --docker-host-path-prefix to the path prefix where the runner filesystem',
    );
    logger.warn(
      '   is visible inside the daemon (e.g. --docker-host-path-prefix /tmp/gh-aw).',
    );
  }

  if (options.runnerTopology === 'arc-dind') {
    const runnerToolCache = process.env.RUNNER_TOOL_CACHE?.trim();
    if (runnerToolCache === '/opt' || runnerToolCache?.startsWith('/opt/')) {
      logger.warn(
        '⚠️  RUNNER_TOOL_CACHE is under /opt, which is typically invisible to DinD daemons in ARC.',
      );
      logger.warn(
        '   Prefer a runner-visible shared path (for example under /tmp/gh-aw) for tool-cache mounts.',
      );
    }
  }

  // --- Domain resolution --------------------------------------------------

  // Resolve allowed and blocked domains (parse, merge, validate)
  const {
    allowedDomains,
    localhostResult,
    resolvedCopilotApiTarget,
    resolvedCopilotApiBasePath,
  } = resolveAllowedDomains(options);

  const blockedDomains = resolveBlockedDomains(options);

  // --- Network configuration -----------------------------------------------

  // Resolve network configuration (upstream proxy, DNS servers, DNS-over-HTTPS)
  const { upstreamProxy, dnsServers, dnsOverHttps } = resolveNetworkConfig(options);

  return {
    dockerHostCheck,
    dockerHostPathPrefixResolution,
    allowedDomains,
    blockedDomains,
    localhostResult,
    resolvedCopilotApiTarget,
    resolvedCopilotApiBasePath,
    upstreamProxy,
    dnsServers,
    dnsOverHttps,
  };
}
