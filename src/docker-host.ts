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
 * When not set, AWF auto-detects:
 *  - unix:// DOCKER_HOST values are kept as-is (local socket).
 *  - TCP DOCKER_HOST values (e.g. DinD) are cleared so docker falls back
 *    to the system default socket.
 *
 * @internal Called from cli.ts when --docker-host flag is provided.
 */
export function setAwfDockerHost(host: string | undefined): void {
  awfDockerHostOverride = host;
}

/**
 * Returns an environment object suitable for AWF's own docker CLI calls.
 *
 * When DOCKER_HOST is set to an external TCP daemon (e.g. a workflow-scope
 * DinD sidecar), it is removed so docker/docker-compose use the local Unix
 * socket instead.  When --docker-host was provided via the CLI, that value
 * is used regardless of the environment.
 *
 * The original DOCKER_HOST value is NOT removed from the agent container's
 * environment — see generateDockerCompose for the passthrough logic.
 */
export function getLocalDockerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (awfDockerHostOverride !== undefined) {
    // Explicit CLI override — always use this socket for AWF operations
    env.DOCKER_HOST = awfDockerHostOverride;
  } else {
    const dockerHost = env.DOCKER_HOST;
    if (dockerHost && !dockerHost.startsWith('unix://')) {
      // Non-unix DOCKER_HOST (e.g. tcp://localhost:2375 from a DinD sidecar).
      // Clear it so AWF's docker commands target the local daemon, not the DinD one.
      delete env.DOCKER_HOST;
    }
  }

  return env;
}
