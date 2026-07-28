import { logger } from '../logger';
import { buildRuntimeImageRef } from '../image-tag';
import { resolveDockerRuntime } from '../container-runtime';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { SEALED_PROBE_BROKER_CONTAINER_NAME } from '../constants';
import type { WrapperConfig } from '../types';
import {
  AGENT_SKILL_DIR,
  AGENT_SKILL_PATH,
  AGENT_SOCKET_DIR,
  AGENT_SOCKET_PATH,
  BROKER_AUDIT_DIR,
  BROKER_DOCKER_SOCKET_PATH,
  BROKER_SEED_MAP_PATH,
  BROKER_SEEDS_DIR,
  BROKER_SOCKET_DIR,
  BROKER_WORK_DIR,
  resolveSealedProbePaths,
} from '../sealed-probe/paths';
import { resolveDockerSocketPath } from './agent-volumes/docker-socket';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';
import type { ImageBuildConfig } from './squid-service';

/**
 * Compose assembly for the trusted sealed-probe broker.
 *
 * The broker is deliberately the *only* AWF sidecar with `network_mode: none`:
 * it has no interface on `awf-net`, no external bridge, no DNS, no Squid
 * route, and therefore no path to the internet or to any other AWF service.
 * Its whole surface is a single Unix socket shared with the agent through a
 * tightly scoped bind mount.
 *
 * It does receive the Docker socket, because it launches ephemeral probe
 * containers. That is the subsystem's most privileged component, so:
 *
 * - its API accepts only a repository selector, three outcome labels, and
 *   script bytes — never a path, image, command, mount, or runtime flag;
 * - the Docker socket path is never placed in the agent's environment or
 *   volumes (the agent only ever sees `${AGENT_SOCKET_PATH}`);
 * - every probe container is launched with a fixed, AWF-authored argument
 *   vector.
 */

/** Local image tag used when building the sealed-probe image from source. */
const LOCAL_SEALED_PROBE_IMAGE = 'awf-sealed-probe:local';

/** Image name published to the container registry. */
const SEALED_PROBE_IMAGE_NAME = 'sealed-probe';

interface SealedProbeServiceParams {
  config: WrapperConfig;
  imageConfig: ImageBuildConfig;
}

interface SealedProbeBuildResult {
  /** Compose service definition for the broker. */
  service: Record<string, unknown>;
  /** Environment additions merged into the agent container. */
  agentEnvAdditions: Record<string, string>;
  /** Bind mounts added to the agent container. */
  agentVolumes: string[];
}

/**
 * Resolves the image reference used for both the broker and the probe
 * sandbox.
 *
 * Reusing one image guarantees the probe image is already present locally
 * when the broker starts (compose pulled or built it), so an invocation never
 * triggers a registry pull — the broker has no network to perform one with.
 */
function resolveSealedProbeImage(imageConfig: ImageBuildConfig): {
  imageRef: string;
  source: Record<string, unknown>;
} {
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;

  if (useGHCR) {
    const imageRef = buildRuntimeImageRef(registry, SEALED_PROBE_IMAGE_NAME, parsedTag);
    return { imageRef, source: { image: imageRef } };
  }

  // Local builds pin an explicit `image:` alongside `build:` so the built
  // image gets a deterministic tag the broker can pass to `docker run`.
  return {
    imageRef: LOCAL_SEALED_PROBE_IMAGE,
    source: {
      image: LOCAL_SEALED_PROBE_IMAGE,
      build: {
        context: `${projectRoot}/containers/sealed-probe`,
        dockerfile: 'Dockerfile',
      },
    },
  };
}

/**
 * Translates a host directory into the path the Docker daemon resolves it at.
 *
 * The broker passes probe bind-mount sources straight to the daemon, so those
 * sources must already be expressed in the daemon's filesystem view (ARC/DinD
 * split filesystems).
 */
function toDaemonVisiblePath(hostPath: string, dockerHostPathPrefix: string | undefined): string {
  const [translated] = applyHostPathPrefixToVolumes([`${hostPath}:${hostPath}`], dockerHostPathPrefix);
  return translated.split(':')[0];
}

/** Builds the broker compose service plus the agent's socket/skill wiring. */
export function buildSealedProbeService(params: SealedProbeServiceParams): SealedProbeBuildResult {
  const { config, imageConfig } = params;
  const sealedProbes = config.sealedProbes;

  if (!sealedProbes?.enabled) {
    throw new Error('buildSealedProbeService: sealedProbes must be enabled');
  }

  const paths = resolveSealedProbePaths(config.workDir);
  const { imageRef, source } = resolveSealedProbeImage(imageConfig);
  const dockerSocketPath = resolveDockerSocketPath(config);

  const service: Record<string, unknown> = {
    container_name: SEALED_PROBE_BROKER_CONTAINER_NAME,
    ...source,
    // SECURITY: no networks key at all. `none` gives the broker a loopback-only
    // namespace: no awf-net, no awf-ext, no DNS, no Squid, no host gateway.
    network_mode: 'none',
    volumes: applyHostPathPrefixToVolumes(
      [
        `${paths.seedsDir}:${BROKER_SEEDS_DIR}:ro`,
        `${paths.workDir}:${BROKER_WORK_DIR}:rw`,
        `${paths.runDir}:${BROKER_SOCKET_DIR}:rw`,
        `${paths.auditDir}:${BROKER_AUDIT_DIR}:rw`,
        `${paths.seedMapPath}:${BROKER_SEED_MAP_PATH}:ro`,
        `${dockerSocketPath}:${BROKER_DOCKER_SOCKET_PATH}:rw`,
      ],
      config.dockerHostPathPrefix,
    ),
    environment: {
      AWF_SEALED_PROBE_IMAGE: imageRef,
      // "docker" means the daemon's default OCI runtime. Passing
      // `--runtime docker` would fail because Docker has no runtime by that
      // name; only non-default runtimes get an explicit value.
      AWF_SEALED_PROBE_RUNTIME:
        sealedProbes.runtime === 'docker'
          ? ''
          : resolveDockerRuntime(sealedProbes.runtime) ?? '',
      AWF_SEALED_PROBE_TIMEOUT: String(sealedProbes.timeout),
      AWF_SEALED_PROBE_MEMORY: sealedProbes.memoryLimit,
      AWF_SEALED_PROBE_MAX_INVOCATIONS: String(sealedProbes.maxInvocations),
      // Probe bind-mount sources are handed to the daemon, not opened by the
      // broker, so they must be daemon-visible paths.
      AWF_SEALED_PROBE_HOST_WORK_DIR: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
      AWF_SEALED_PROBE_SOCKET_UID: getSafeHostUid(),
      AWF_SEALED_PROBE_SOCKET_GID: getSafeHostGid(),
    },
    healthcheck: {
      test: ['CMD', 'node', '/opt/awf/broker/healthcheck.js'],
      interval: '5s',
      timeout: '3s',
      retries: 10,
      start_period: '20s',
    },
    ...buildContainerSecurityHardening({ memLimit: '256m', pidsLimit: 100, cpuShares: 256 }),
    // The broker is root only to copy host-owned read-only seeds into private
    // workspaces and hand those workspaces to the unprivileged probe uid.
    // Keep the default set dropped and restore only those filesystem duties.
    cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    restart: 'no',
    stop_grace_period: '5s',
  };

  const agentEnvAdditions: Record<string, string> = {
    AWF_SEALED_PROBE_SOCKET: AGENT_SOCKET_PATH,
    AWF_SEALED_PROBE_SKILL: AGENT_SKILL_PATH,
    AWF_SEALED_PROBE_REPOS: sealedProbes.privateRepos.join(','),
  };

  // The agent receives exactly two sealed-probe mounts: the broker socket
  // (read-write, required to connect) and the generated skill (read-only).
  // Both paths are mounted twice because the agent runs chrooted into /host.
  const agentVolumes = applyHostPathPrefixToVolumes(
    [
      `${paths.runDir}:${AGENT_SOCKET_DIR}:rw`,
      `${paths.runDir}:/host${AGENT_SOCKET_DIR}:rw`,
      `${paths.agentDir}:${AGENT_SKILL_DIR}:ro`,
      `${paths.agentDir}:/host${AGENT_SKILL_DIR}:ro`,
    ],
    config.dockerHostPathPrefix,
  );

  logger.info(
    `Sealed probes enabled - offline broker (network_mode: none) exposed to the agent at ${AGENT_SOCKET_PATH}`,
  );

  return { service, agentEnvAdditions, agentVolumes };
}

/**
 * True when a volume entry is one of the sealed-probe agent mounts.
 *
 * The ARC/DinD sysroot filter drops bind mounts sourced from `workDir`; the
 * sealed-probe socket and skill mounts are sourced there but are mandatory,
 * so they are exempted explicitly rather than silently disappearing.
 */
export function isSealedProbeAgentMount(volume: string): boolean {
  const target = volume.split(':')[1];
  if (!target) return false;
  const normalized = target.startsWith('/host') ? target.slice('/host'.length) : target;
  return normalized === AGENT_SOCKET_DIR || normalized === AGENT_SKILL_DIR;
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const sealedProbeServiceTestHelpers = {
  LOCAL_SEALED_PROBE_IMAGE,
  SEALED_PROBE_IMAGE_NAME,
  resolveSealedProbeImage,
  toDaemonVisiblePath,
};
