import execa from 'execa';
import { getLocalDockerEnv } from '../host-env';
import { runtimeUsesComposeAgent } from '../container-runtime';
import type { BoundedQueriesConfig, WrapperConfig } from '../types';
import { normalizeRepoKey } from './paths';
import { MAX_QUERY_TIMEOUT_SECONDS, BOUNDED_QUERY_REPO_PATTERN } from './protocol';
import { resolveStagingToken } from './staging';

/**
 * Fail-closed preflight for bounded queries.
 *
 * JSON Schema already constrains the *shape* of `boundedQueries`. This module
 * covers everything the schema cannot: credential availability, sandbox
 * runtime availability, and combinations of AWF settings under which bounded
 * queries cannot be exposed securely.
 *
 * Every check here is fatal — a bounded-query run that cannot satisfy its
 * isolation guarantees must abort before the primary agent starts rather than
 * silently downgrading.
 */

/** Query sandbox runtimes with a safe, implemented no-network launcher. */
const SUPPORTED_QUERY_RUNTIMES = new Set(['docker', 'gvisor']);

/** Docker OCI runtime name required for the `gvisor` query runtime. */
const GVISOR_DOCKER_RUNTIME = 'runsc';

/** Detects whether the Docker daemon exposes a named OCI runtime. */
export type DockerRuntimeQuery = (runtimeName: string) => Promise<boolean>;

const defaultDockerRuntimeQuery: DockerRuntimeQuery = async (runtimeName) => {
  const result = await execa('docker', ['info', '--format', '{{json .Runtimes}}'], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 30_000,
  });
  if (result.exitCode !== 0) return false;
  try {
    const runtimes = JSON.parse(result.stdout) as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(runtimes, runtimeName);
  } catch {
    return false;
  }
};

/**
 * Validates everything about a bounded-query configuration that can be decided
 * without touching Docker or the network.
 *
 * @returns human-readable errors; empty when the configuration is acceptable.
 */
export function validateBoundedQueryConfig(
  config: WrapperConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const boundedQueries = config.boundedQueries;
  if (!boundedQueries?.enabled) return [];

  const errors: string[] = [];

  if (boundedQueries.privateRepos.length === 0) {
    errors.push('boundedQueries.enabled is true but boundedQueries.privateRepos is empty');
  }

  const seenKeys = new Set<string>();
  for (const entry of boundedQueries.privateRepos) {
    const repo = entry.repo;
    if (!BOUNDED_QUERY_REPO_PATTERN.test(repo)) {
      errors.push(
        `boundedQueries.privateRepos entry "${repo}" is not a bare owner/repo slug ` +
        '(no scheme, host, credentials, path traversal, query, fragment, or wildcard)',
      );
      continue;
    }
    const key = normalizeRepoKey(repo);
    if (seenKeys.has(key)) {
      errors.push(`boundedQueries.privateRepos contains a duplicate entry: "${repo}"`);
    }
    seenKeys.add(key);
  }

  if (!SUPPORTED_QUERY_RUNTIMES.has(boundedQueries.runtime)) {
    errors.push(
      `boundedQueries.runtime "${boundedQueries.runtime}" is not supported. ` +
      'AWF has no no-network, per-invocation bounded-query launcher for it, and bounded queries ' +
      'never downgrade to a weaker runtime. Use "docker" or "gvisor".',
    );
  }

  if (boundedQueries.interpreter !== 'python3') {
    errors.push(`boundedQueries.interpreter "${boundedQueries.interpreter}" is not supported`);
  }

  // Reserve the final minute of the 10-minute response bucket for Docker
  // termination, result validation, container removal, and workspace cleanup.
  // The script timeout cannot consume the entire observable boundary.
  if (!Number.isInteger(boundedQueries.timeout) || boundedQueries.timeout < 1) {
    errors.push('boundedQueries.timeout must be a positive integer number of seconds');
  } else if (boundedQueries.timeout > MAX_QUERY_TIMEOUT_SECONDS) {
    errors.push(
      `boundedQueries.timeout must be at most ${MAX_QUERY_TIMEOUT_SECONDS} seconds ` +
      '(the 10-minute response bucket reserves its final minute for termination, validation, and cleanup)',
    );
  }

  if (!Number.isInteger(boundedQueries.maxInvocations) || boundedQueries.maxInvocations < 1) {
    errors.push('boundedQueries.maxInvocations must be a positive integer');
  }

  if (!/^[1-9][0-9]*[bkmgBKMG]$/.test(boundedQueries.memoryLimit)) {
    errors.push(`boundedQueries.memoryLimit "${boundedQueries.memoryLimit}" is not a Docker memory limit`);
  }

  if (!runtimeUsesComposeAgent(config.containerRuntime)) {
    errors.push(
      `bounded queries cannot be exposed to a "${config.containerRuntime}" primary agent: ` +
      'the broker socket is shared through a Docker Compose bind mount, which a microVM agent ' +
      'does not receive. Disable boundedQueries or use a Compose-based container runtime.',
    );
  }

  const dockerHost = config.awfDockerHost ?? env.DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    errors.push(
      `bounded queries require a Unix-socket Docker host, but the resolved host is "${dockerHost}". ` +
      'The broker runs with network_mode: none so it can only reach the daemon over a bind-mounted ' +
      'socket, and AWF will not weaken that isolation to reach a TCP daemon.',
    );
  }

  if (!resolveStagingToken(env)) {
    errors.push(
      'bounded queries require a staging credential in GH_TOKEN or GITHUB_TOKEN on the AWF host ' +
      '(it is used only by the trusted staging phase and never reaches the agent, broker, or query)',
    );
  }

  return errors;
}

/**
 * Verifies that the requested query sandbox runtime is actually available.
 *
 * Only reached after {@link validateBoundedQueryConfig} accepted the runtime
 * name, so the only remaining question is daemon support.
 */
export async function assertQueryRuntimeAvailable(
  boundedQueries: BoundedQueriesConfig,
  queryDockerRuntime: DockerRuntimeQuery = defaultDockerRuntimeQuery,
): Promise<void> {
  if (boundedQueries.runtime !== 'gvisor') return;

  if (!(await queryDockerRuntime(GVISOR_DOCKER_RUNTIME))) {
    throw new Error(
      `boundedQueries.runtime "gvisor" requires the "${GVISOR_DOCKER_RUNTIME}" OCI runtime to be ` +
      'registered with the Docker daemon. It is not available, and bounded queries never fall back ' +
      'to a weaker runtime.',
    );
  }
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const preflightTestHelpers = {
  SUPPORTED_QUERY_RUNTIMES,
  GVISOR_DOCKER_RUNTIME,
  defaultDockerRuntimeQuery,
};
