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

/** Local image tag used when building the sealed-probe broker image from source. */
const LOCAL_SEALED_PROBE_BROKER_IMAGE = 'awf-sealed-probe-broker:local';

/** Local image tag used when building the sealed-probe probe image from source. */
const LOCAL_SEALED_PROBE_IMAGE = 'awf-sealed-probe:local';

/** Broker image name published to the container registry. */
const SEALED_PROBE_BROKER_IMAGE_NAME = 'sealed-probe-broker';

/** Probe image name published to the container registry. */
const SEALED_PROBE_IMAGE_NAME = 'sealed-probe';

interface SealedProbeServiceParams {
  config: WrapperConfig;
  imageConfig: ImageBuildConfig;
}

interface SealedProbeBuildResult {
  /** One-shot service that makes the probe image locally available. */
  probeImageService: Record<string, unknown>;
  /** Compose service definition for the broker. */
  service: Record<string, unknown>;
  /** Environment additions merged into the agent container. */
  agentEnvAdditions: Record<string, string>;
  /** Bind mounts added to the agent container. */
  agentVolumes: string[];
}

/**
 * Resolves the image references for the broker and probe sandbox separately.
 *
 * The broker and probe are built from separate Dockerfile stages and published
 * as separate images (`sealed-probe-broker` and `sealed-probe`). Using two
 * images keeps the probe environment minimal (Python 3 only — no Node, no
 * docker-cli) while still guaranteeing the probe image is local when the
 * broker starts: the release workflow pushes both and compose pulls the broker
 * image which declares a dependency on the probe image.
 */
function resolveSealedProbeImages(imageConfig: ImageBuildConfig): {
  probeImageRef: string;
  probeSource: Record<string, unknown>;
  brokerSource: Record<string, unknown>;
} {
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;

  if (useGHCR) {
    const probeImageRef = buildRuntimeImageRef(registry, SEALED_PROBE_IMAGE_NAME, parsedTag);
    const brokerImageRef = buildRuntimeImageRef(registry, SEALED_PROBE_BROKER_IMAGE_NAME, parsedTag);
    return {
      probeImageRef,
      probeSource: { image: probeImageRef },
      brokerSource: { image: brokerImageRef },
    };
  }

  // Local builds pin an explicit `image:` alongside `build:` so the built
  // image gets a deterministic tag the broker can pass to `docker run`.
  return {
    probeImageRef: LOCAL_SEALED_PROBE_IMAGE,
    probeSource: {
      image: LOCAL_SEALED_PROBE_IMAGE,
      build: {
        context: `${projectRoot}/containers/sealed-probe`,
        dockerfile: 'Dockerfile',
        target: 'probe',
      },
    },
    brokerSource: {
      image: LOCAL_SEALED_PROBE_BROKER_IMAGE,
      build: {
        context: `${projectRoot}/containers/sealed-probe`,
        dockerfile: 'Dockerfile',
        // Build the broker (default) stage; probe is a separate target.
        target: 'broker',
      },
    },
  };
}

/**
 * Resolves the image reference for the probe image only (legacy single-image
 * helper preserved for the test-helpers export).
 *
 * @internal
 */
function resolveSealedProbeImage(imageConfig: ImageBuildConfig): {
  imageRef: string;
  source: Record<string, unknown>;
} {
  const { probeImageRef, brokerSource } = resolveSealedProbeImages(imageConfig);
  return { imageRef: probeImageRef, source: brokerSource };
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
  const { probeImageRef, probeSource, brokerSource } = resolveSealedProbeImages(imageConfig);
  const dockerSocketPath = resolveDockerSocketPath(config);

  // Compose must pull/build the probe target before starting the offline
  // broker. The one-shot service has no mounts or network and exits only after
  // Docker has made the exact image reference available to the daemon.
  const probeImageService: Record<string, unknown> = {
    ...probeSource,
    network_mode: 'none',
    entrypoint: ['/bin/true'],
    ...buildContainerSecurityHardening({ memLimit: '32m', pidsLimit: 16, cpuShares: 64 }),
    restart: 'no',
  };

  const service: Record<string, unknown> = {
    container_name: SEALED_PROBE_BROKER_CONTAINER_NAME,
    ...brokerSource,
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
      AWF_SEALED_PROBE_IMAGE: probeImageRef,
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
    depends_on: {
      'sealed-probe-image': {
        condition: 'service_completed_successfully',
      },
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
    AWF_SEALED_PROBE_REPOS: sealedProbes.privateRepos.map((repository) => repository.repo).join(','),
  };

  // The agent receives four sealed-probe mounts:
  //
  //  1+2. Masking mounts: an empty directory is mounted at the sealed-probe
  //       root as seen through the agent's broad /tmp bind mount. This hides
  //       seeds, work, audit, and the seed-map from the agent even in rootless
  //       mode where directory permissions alone are insufficient.
  //
  //  3+4. Socket mount: the broker's Unix socket directory at its contract path.
  //
  //  5+6. Skill mount: the generated SKILL.md at its contract path.
  //
  // Paths are duplicated (bare and /host-prefixed) because the agent runs
  // chrooted into /host. The masking mounts come first; Docker applies mounts
  // in order, so the more-specific socket/skill mounts take precedence.
  const agentVolumes = applyHostPathPrefixToVolumes(
    [
      // Masking mounts — cover the sealed-probe root visible through /tmp.
      `${paths.maskDir}:${paths.root}:ro`,
      `${paths.maskDir}:/host${paths.root}:ro`,
      // Socket mounts.
      `${paths.runDir}:${AGENT_SOCKET_DIR}:rw`,
      `${paths.runDir}:/host${AGENT_SOCKET_DIR}:rw`,
      // Skill mounts.
      `${paths.agentDir}:${AGENT_SKILL_DIR}:ro`,
      `${paths.agentDir}:/host${AGENT_SKILL_DIR}:ro`,
    ],
    config.dockerHostPathPrefix,
  );

  logger.info(
    `Sealed probes enabled - offline broker (network_mode: none) exposed to the agent at ${AGENT_SOCKET_PATH}`,
  );

  return { probeImageService, service, agentEnvAdditions, agentVolumes };
}

/**
 * True when a volume entry is one of the sealed-probe agent mounts.
 *
 * The ARC/DinD sysroot filter drops bind mounts sourced from `workDir`; the
 * sealed-probe socket, skill, and masking mounts are sourced there but are
 * mandatory, so they are exempted explicitly rather than silently disappearing.
 */
export function isSealedProbeAgentMount(volume: string): boolean {
  const target = volume.split(':')[1];
  if (!target) return false;
  const normalized = target.startsWith('/host') ? target.slice('/host'.length) : target;
  return (
    normalized === AGENT_SOCKET_DIR ||
    normalized === AGENT_SKILL_DIR ||
    // The masking mount's target is the sealed-probe root itself (paths.root).
    // We check by suffix since paths.root includes the dynamic workDir prefix.
    normalized.endsWith('/sealed-probes')
  );
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const sealedProbeServiceTestHelpers = {
  LOCAL_SEALED_PROBE_IMAGE,
  LOCAL_SEALED_PROBE_BROKER_IMAGE,
  SEALED_PROBE_IMAGE_NAME,
  SEALED_PROBE_BROKER_IMAGE_NAME,
  resolveSealedProbeImages,
  resolveSealedProbeImage,
  toDaemonVisiblePath,
};
