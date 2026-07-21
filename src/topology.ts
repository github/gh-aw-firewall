import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import * as yaml from 'js-yaml';
import { getLocalDockerEnv } from './docker-host';
import { logger } from './logger';
import { NETWORK_NAME } from './config/network-policy';

/**
 * Deterministic name of the internal Docker network used by network-isolation
 * (topology) mode. Pinned via `name:` in the generated compose file so that
 * externally-launched trusted containers (mcp-gateway, DIFC proxy) can be
 * attached to it with a stable `docker network connect <TOPOLOGY_NETWORK_NAME>`.
 * Centralized in src/config/sandbox-network-policy.json.
 */
export const TOPOLOGY_NETWORK_NAME = NETWORK_NAME;

const DAEMON_PING_TIMEOUT_MS = 5000;
const DAEMON_PING_RETRIES = 3;
const DAEMON_PING_RETRY_DELAY_MS = 2000;

interface TopologyLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
}

/**
 * Returns true if the Docker daemon is reachable via `docker info`.
 * Retries with backoff to tolerate transient daemon unresponsiveness
 * (e.g., when the daemon is under load from concurrent container healthchecks
 * and image operations during GitHub Actions job startup).
 */
async function isDockerDaemonReachable(): Promise<boolean> {
  for (let attempt = 1; attempt <= DAEMON_PING_RETRIES; attempt++) {
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
      if (result.exitCode === 0) {
        return true;
      }
    } catch {
      // timeout or exec failure — retry
    }
    if (attempt < DAEMON_PING_RETRIES) {
      logger.debug(`Docker daemon probe attempt ${attempt}/${DAEMON_PING_RETRIES} failed, retrying in ${DAEMON_PING_RETRY_DELAY_MS}ms...`);
      await new Promise(resolve => setTimeout(resolve, DAEMON_PING_RETRY_DELAY_MS));
    }
  }
  return false;
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

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Inspects the IP addresses of topology-attached containers on the specified
 * Docker network. Used when the agent runs under an alternative container
 * runtime (e.g., gVisor's runsc) whose userspace netstack cannot resolve
 * container names via Docker's embedded DNS at 127.0.0.11.
 *
 * @see https://github.com/google/gvisor/issues/7469 — gVisor DNS incompatibility
 */
export async function getTopologyContainerIps(
  networkName: string,
  containerNames: string[],
  log: TopologyLogger = logger,
): Promise<Map<string, string>> {
  const ips = new Map<string, string>();
  for (const name of containerNames) {
    try {
      const result = await execa(
        'docker',
        [
          'inspect',
          '--format',
          `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`,
          name,
        ],
        { env: getLocalDockerEnv(), reject: false },
      );
      const ip = (result.stdout || '').trim();
      if (ip && IPV4_REGEX.test(ip)) {
        ips.set(name, ip);
        log.info(`Topology peer "${name}" has IP ${ip} on ${networkName}`);
      } else {
        log.warn(`Could not determine IP for topology peer "${name}" on ${networkName}`);
      }
    } catch (err) {
      log.warn(`Failed to inspect topology peer "${name}": ${err}`);
    }
  }
  return ips;
}

/**
 * Patches docker-compose.yml to add /etc/hosts entries for topology-attached
 * containers in the agent service. This bypasses Docker's embedded DNS
 * (127.0.0.11) for runtimes whose network stack cannot reach it (e.g. gVisor).
 *
 * Must be called AFTER topology containers are connected to the network
 * (so their IPs are known) and BEFORE the full `docker compose up` that
 * starts the agent container (so it picks up the extra_hosts entries).
 */
export function patchComposeWithTopologyHosts(
  workDir: string,
  peerIps: Map<string, string>,
  log: TopologyLogger = logger,
): void {
  const composePath = path.join(workDir, 'docker-compose.yml');
  const content = fs.readFileSync(composePath, 'utf8');
  const compose = yaml.load(content) as any;

  const agentService = compose?.services?.agent;
  if (!agentService) {
    log.warn('Could not find agent service in docker-compose.yml; skipping topology DNS patch');
    return;
  }

  if (!agentService.extra_hosts) {
    agentService.extra_hosts = {};
  }
  for (const [name, ip] of peerIps) {
    agentService.extra_hosts[name] = ip;
  }

  // Also give the squid-proxy container the same name→IP mappings. Squid resolves
  // proxied destinations via its external `dns_nameservers`, which cannot resolve
  // Docker-only peer hostnames (e.g. `awmg-mcpg`). Squid reads `/etc/hosts`
  // (hosts_file directive) before falling back to DNS, so extra_hosts lets it
  // resolve these peers. Without this, a NO_PROXY-ignoring client's request
  // passes the domain ACL but fails when Squid tries to resolve the peer name.
  // The phased startup patches this before the full `docker compose up`, which
  // recreates squid-proxy to pick up the new extra_hosts.
  const squidService = compose?.services?.['squid-proxy'];
  if (squidService) {
    if (!squidService.extra_hosts) {
      squidService.extra_hosts = {};
    }
    for (const [name, ip] of peerIps) {
      squidService.extra_hosts[name] = ip;
    }
  } else {
    log.warn('Could not find squid-proxy service in docker-compose.yml; skipping Squid topology DNS patch');
  }

  fs.writeFileSync(composePath, yaml.dump(compose, { lineWidth: -1 }), { mode: 0o600 });
  log.info(`Patched docker-compose.yml with ${peerIps.size} topology peer host(s) for static DNS compatibility`);

  // Also patch the chroot hosts file. The agent runs chrooted to /host, so it
  // reads /host/etc/hosts — a pre-generated file mounted read-only from the host.
  // Docker's extra_hosts only populates the container's /etc/hosts (outside chroot).
  // Find the source path of the /host/etc/hosts bind mount and append entries there.
  const volumes: string[] = agentService.volumes || [];
  const hostsMount = volumes.find((v: string) => v.includes(':/host/etc/hosts'));
  if (hostsMount) {
    const hostPath = hostsMount.split(':')[0];
    try {
      let hostsEntries = '';
      for (const [name, ip] of peerIps) {
        hostsEntries += `${ip}\t${name}\n`;
      }
      fs.appendFileSync(hostPath, hostsEntries);
      log.info(`Appended ${peerIps.size} topology peer(s) to chroot hosts file: ${hostPath}`);
    } catch (err) {
      log.warn(`Could not patch chroot hosts file at ${hostPath}: ${err}`);
    }
  } else {
    log.info('No /host/etc/hosts mount found (sysroot-stage mode); topology peers rely on extra_hosts + container DNS');
  }
}
