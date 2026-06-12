/**
 * Optional override for the Docker host used by AWF's own container operations.
 * Set via setAwfDockerHost() from the CLI --docker-host flag.
 * When undefined, AWF auto-selects the local socket (see getLocalDockerEnv).
 */
let awfDockerHostOverride: string | undefined;

/**
 * Sets the Docker host to use for AWF's own container operations.
 *
 * When set, overrides DOCKER_HOST for all docker CLI calls made by AWF
 * (compose up/down, docker wait, docker logs, etc.).
 *
 * When not set, AWF uses the current DOCKER_HOST as-is — both unix://
 * sockets and tcp:// endpoints (e.g. tcp://localhost:2375 in ARC/DinD
 * deployments) are passed through unchanged.
 *
 * @internal Called from cli.ts when --docker-host flag is provided.
 */
export function setAwfDockerHost(host: string | undefined): void {
  awfDockerHostOverride = host;
}

/**
 * Returns an environment object suitable for AWF's own docker CLI calls.
 *
 * When --docker-host was provided via the CLI, that value is used regardless
 * of the environment.  Otherwise the current DOCKER_HOST is passed through
 * unchanged — both unix:// sockets and tcp:// endpoints (e.g. the ARC/DinD
 * sidecar at tcp://localhost:2375) are valid Docker API endpoints and work
 * correctly with docker/docker-compose.
 *
 * The original DOCKER_HOST value is NOT removed from the agent container's
 * environment — see generateDockerCompose for the passthrough logic.
 */
export function getLocalDockerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (awfDockerHostOverride !== undefined) {
    // Explicit CLI override — always use this value for AWF operations
    env.DOCKER_HOST = awfDockerHostOverride;
  }
  // Otherwise, preserve whatever DOCKER_HOST is set in the environment.
  // TCP endpoints such as tcp://localhost:2375 (standard ARC/DinD sidecar
  // configuration) work fine for docker compose orchestration.

  return env;
}
