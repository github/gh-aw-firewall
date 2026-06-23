import execa from 'execa';
import { getLocalDockerEnv } from './docker-host';
import { logger } from './logger';

/**
 * Deterministic name of the internal Docker network used by network-isolation
 * (topology) mode. Pinned via `name:` in the generated compose file so that
 * externally-launched trusted containers (mcp-gateway, DIFC proxy) can be
 * attached to it with a stable `docker network connect <TOPOLOGY_NETWORK_NAME>`.
 */
export const TOPOLOGY_NETWORK_NAME = 'awf-net';

const DAEMON_PING_TIMEOUT_MS = 5000;

interface TopologyLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

/**
 * Returns true if the Docker daemon is reachable via `docker info`.
 * Uses a short timeout so the fail-stop preflight does not hang.
 */
async function isDockerDaemonReachable(): Promise<boolean> {
  try {
    const result = await execa(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      {
        env: getLocalDockerEnv(),
        timeout: DAEMON_PING_TIMEOUT_MS,
        reject: false,
      },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Detects an ARC (Actions Runner Controller) Kubernetes-native runner
 * (`containerMode: kubernetes`). In that mode there is no Docker daemon — work
 * is dispatched via container hooks — so network-isolation cannot be supported.
 */
function isArcKubernetesNative(): boolean {
  return Boolean(
    process.env.ACTIONS_RUNNER_CONTAINER_HOOKS ||
    process.env.ACTIONS_RUNNER_POD_NAME
  );
}

/**
 * Fail-stop preflight for network-isolation (topology) mode.
 *
 * Topology enforcement is implemented entirely through the Docker daemon's
 * networking (an `internal` network plus a dual-homed proxy), so a reachable
 * Docker daemon is mandatory. When the daemon is unreachable this aborts with a
 * clear, platform-specific message and exits the process — it never falls back
 * to an unenforced run.
 */
export async function assertTopologySupported(): Promise<void> {
  if (await isDockerDaemonReachable()) {
    return;
  }

  if (isArcKubernetesNative()) {
    logger.error('❌ --network-isolation is not supported on this platform.');
    logger.error('   Detected an ARC (Actions Runner Controller) Kubernetes-native runner');
    logger.error('   (containerMode: kubernetes) with no reachable Docker daemon.');
    logger.error('   Network-isolation enforces egress through Docker network topology and');
    logger.error('   therefore requires a Docker daemon. Use an ARC runner configured with a');
    logger.error('   Docker-in-Docker (DinD) sidecar, or run on a host where Docker is available.');
  } else {
    logger.error('❌ --network-isolation requires a reachable Docker daemon, but none was found.');
    logger.error('   Ensure the Docker daemon is running and DOCKER_HOST points at it.');
    logger.error('   In ARC, a Docker-in-Docker (DinD) sidecar is required for this mode.');
  }
  process.exit(1);
}

/**
 * Connects externally-launched trusted containers (e.g. the mcp-gateway and the
 * DIFC proxy) to the internal topology network so the agent can reach them
 * without granting them an egress path. Must run after the AWF containers (and
 * the compose-managed internal network) have been created.
 *
 * The operation is idempotent: a container that is already attached is skipped
 * rather than treated as an error.
 */
export async function connectTopologyContainers(
  networkName: string,
  containerNames: string[],
  log: TopologyLogger = logger,
): Promise<void> {
  for (const name of containerNames) {
    log.info(`Network-isolation: connecting container "${name}" to "${networkName}"...`);
    const result = await execa(
      'docker',
      ['network', 'connect', networkName, name],
      {
        env: getLocalDockerEnv(),
        reject: false,
      },
    );

    if (result.exitCode !== 0) {
      const stderr = (result.stderr || '').trim();
      // Already-connected is benign and treated as success (idempotent).
      if (/already exists in network|is already attached|already connected/i.test(stderr)) {
        log.info(`Container "${name}" is already attached to "${networkName}".`);
        continue;
      }
      throw new Error(
        `Failed to connect container "${name}" to network "${networkName}": ` +
        (stderr || `docker network connect exited with code ${result.exitCode}`),
      );
    }
  }
}
