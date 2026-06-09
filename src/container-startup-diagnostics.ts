import execa from 'execa';
import { BlockedTarget } from './types';
import { logger } from './logger';
import { parseDomainWithProtocol, isWildcardPattern, wildcardToRegex } from './domain-patterns';
import { getLocalDockerEnv } from './docker-host';
import { checkSquidLogs } from './squid-log-reader';

/**
 * Returns true when the Docker Compose error message indicates that a specific
 * container failed to start. Docker emits
 * "dependency failed to start: container <name> is unhealthy" for healthcheck
 * failures, and may emit "dependency failed to start: container <name> exited
 * (1)" for startup-time process exits.
 */
export function isContainerStartupFailureError(errorMsg: string, containerName: string): boolean {
  if (!errorMsg.includes(containerName)) {
    return false;
  }
  return errorMsg.includes('is unhealthy') || errorMsg.includes('exited (1)');
}

/**
 * Some docker compose failures surface only as a generic execa error message
 * while the actionable container state is visible only via container inspect.
 */
export async function didContainerFailStartup(errorMsg: string, containerName: string): Promise<boolean> {
  if (isContainerStartupFailureError(errorMsg, containerName)) {
    return true;
  }

  try {
    const result = await execa(
      'docker',
      ['inspect', containerName, '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}'],
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
    logger.debug(`Could not inspect ${containerName} after startup failure:`, error);
    return false;
  }
}

/**
 * Dumps the tail of a container's logs to stderr for diagnosis.
 * Silently skips if the container does not exist or logs are unavailable.
 */
export async function logContainerLogsToStderr(containerName: string): Promise<void> {
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
 * Classifies and logs each blocked target, then emits actionable fix suggestions.
 * Extracted to avoid duplicating this logic between the startup-error path
 * (which uses `logger.error`) and the post-run warning path (which uses `logger.warn`).
 *
 * @param blockedTargets - Targets that were denied by the firewall
 * @param allowedDomains - Domains currently in the allowlist
 * @param log - Logging function to use (e.g. `logger.error` or `logger.warn`)
 * @returns The categorized lists so callers can decide on further action
 */
export function reportBlockedDomains(
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
export async function handleHealthcheckError(
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
