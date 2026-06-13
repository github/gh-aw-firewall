import { isLoopbackTcpDockerHostUri } from './option-parsers';

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
 * When not set, AWF inspects the current DOCKER_HOST: unix:// sockets and
 * loopback TCP endpoints (tcp://localhost:*, tcp://127.0.0.1:*) are passed
 * through unchanged; non-loopback TCP endpoints are cleared so the docker
 * CLI falls back to the default local socket.
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
 * of the environment.  Otherwise, the current DOCKER_HOST is filtered:
 *  - unix:// sockets are passed through unchanged.
 *  - Loopback TCP endpoints (tcp://localhost:*, tcp://127.0.0.1:*) are
 *    passed through unchanged — they are the standard ARC/DinD sidecar
 *    configuration.
 *  - Any other DOCKER_HOST value (e.g. a remote TCP daemon) is removed so
 *    the docker CLI falls back to the default local socket, preserving
 *    AWF's network isolation model.
 *
 * The original DOCKER_HOST value is NOT removed from the agent container's
 * environment — see generateDockerCompose for the passthrough logic.
 */
export function getLocalDockerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (awfDockerHostOverride !== undefined) {
    // Explicit CLI override — always use this value for AWF operations
    env.DOCKER_HOST = awfDockerHostOverride;
    return env;
  }

  // Pass through unix:// sockets and loopback TCP endpoints unchanged.
  // For any other DOCKER_HOST value (e.g. a remote TCP daemon), remove it
  // so docker falls back to the default local socket.
  const dockerHost = env.DOCKER_HOST;
  if (dockerHost !== undefined &&
      !dockerHost.startsWith('unix://') &&
      !isLoopbackTcpDockerHostUri(dockerHost)) {
    delete env.DOCKER_HOST;
  }

  return env;
}
