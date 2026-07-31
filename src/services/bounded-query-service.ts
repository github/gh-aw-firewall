import { logger } from '../logger';
import { buildRuntimeImageRef } from '../image-tag';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { BOUNDED_QUERY_BROKER_CONTAINER_NAME } from '../constants';
import type { WrapperConfig } from '../types';
import { runtimeUsesComposeAgent } from '../container-runtime';
import {
  AGENT_SKILL_DIR,
  AGENT_SKILL_PATH,
  AGENT_SOCKET_DIR,
  AGENT_SOCKET_PATH,
  BROKER_AUDIT_DIR,
  BROKER_CONTROL_DIR,
  BROKER_DOCKER_SOCKET_PATH,
  BROKER_SEED_MAP_PATH,
  BROKER_SEEDS_DIR,
  BROKER_SOCKET_DIR,
  BROKER_WORK_DIR,
  resolveBoundedQueryPaths,
} from '../bounded-query/paths';
import { resolveDockerSocketPath } from './agent-volumes/docker-socket';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';
import type { ImageBuildConfig } from './squid-service';
import {
  BOUNDED_QUERY_INGRESS_NETWORK,
  BOUNDED_QUERY_TCP_PORT,
} from '../bounded-query/ingress';

/**
 * Compose assembly for the trusted bounded-query broker.
 *
 * The broker is deliberately the *only* AWF sidecar with `network_mode: none`:
 * it has no interface on `awf-net`, no external bridge, no DNS, no Squid
 * route, and therefore no path to the internet or to any other AWF service.
 * Its whole surface is a single Unix socket shared with the agent through a
 * tightly scoped bind mount.
 *
 * It does receive the Docker socket, because it launches ephemeral query
 * containers. That is the subsystem's most privileged component, so:
 *
 * - its API accepts only a repository selector, three outcome labels, and
 *   script bytes — never a path, image, command, mount, or runtime flag;
 * - the Docker socket path is never placed in the agent's environment or
 *   volumes (the agent only ever sees `${AGENT_SOCKET_PATH}`);
 * - every query container is launched with a fixed, AWF-authored argument
 *   vector.
 */

/** Local image tag used when building the bounded-query broker image from source. */
const LOCAL_BOUNDED_QUERY_BROKER_IMAGE = 'awf-bounded-query-broker:local';

/** Local image tag used when building the bounded-query sandbox image from source. */
const LOCAL_BOUNDED_QUERY_IMAGE = 'awf-bounded-query:local';

/** Broker image name published to the container registry. */
const BOUNDED_QUERY_BROKER_IMAGE_NAME = 'bounded-query-broker';

/** Query image name published to the container registry. */
const BOUNDED_QUERY_IMAGE_NAME = 'bounded-query';

interface BoundedQueryServiceParams {
  config: WrapperConfig;
  imageConfig: ImageBuildConfig;
}

interface BoundedQueryBuildResult {
  /** One-shot service that makes the query image locally available. */
  queryImageService: Record<string, unknown>;
  /** Compose service definition for the broker. */
  service: Record<string, unknown>;
  /** Environment additions merged into the agent container. */
  agentEnvAdditions: Record<string, string>;
  /** Bind mounts added to the agent container. */
  agentVolumes: string[];
}

/**
 * Resolves the image references for the broker and query sandbox separately.
 *
 * The broker and query are built from separate Dockerfile stages and published
 * as separate images (`bounded-query-broker` and `bounded-query`). Using two
 * images keeps the query environment minimal (Python 3 only — no Node, no
 * docker-cli) while still guaranteeing the query image is local when the
 * broker starts: the release workflow pushes both and compose pulls the broker
 * image which declares a dependency on the query image.
 */
function resolveBoundedQueryImages(imageConfig: ImageBuildConfig): {
  queryImageRef: string;
  querySource: Record<string, unknown>;
  brokerSource: Record<string, unknown>;
} {
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;

  if (useGHCR) {
    const queryImageRef = buildRuntimeImageRef(registry, BOUNDED_QUERY_IMAGE_NAME, parsedTag);
    const brokerImageRef = buildRuntimeImageRef(registry, BOUNDED_QUERY_BROKER_IMAGE_NAME, parsedTag);
    return {
      queryImageRef,
      querySource: { image: queryImageRef },
      brokerSource: { image: brokerImageRef },
    };
  }

  // Local builds pin an explicit `image:` alongside `build:` so the built
  // image gets a deterministic tag the broker can pass to `docker run`.
  return {
    queryImageRef: LOCAL_BOUNDED_QUERY_IMAGE,
    querySource: {
      image: LOCAL_BOUNDED_QUERY_IMAGE,
      build: {
        context: `${projectRoot}/containers/bounded-query`,
        dockerfile: 'Dockerfile',
        target: 'query',
      },
    },
    brokerSource: {
      image: LOCAL_BOUNDED_QUERY_BROKER_IMAGE,
      build: {
        context: `${projectRoot}/containers/bounded-query`,
        dockerfile: 'Dockerfile',
        // Build the broker (default) stage; query is a separate target.
        target: 'broker',
      },
    },
  };
}

/**
 * Resolves the image reference for the query image only (legacy single-image
 * helper preserved for the test-helpers export).
 *
 * @internal
 */
function resolveBoundedQueryImage(imageConfig: ImageBuildConfig): {
  imageRef: string;
  source: Record<string, unknown>;
} {
  const { queryImageRef, brokerSource } = resolveBoundedQueryImages(imageConfig);
  return { imageRef: queryImageRef, source: brokerSource };
}

/**
 * Translates a host directory into the path the Docker daemon resolves it at.
 *
 * The broker passes query bind-mount sources straight to the daemon, so those
 * sources must already be expressed in the daemon's filesystem view (ARC/DinD
 * split filesystems).
 */
function toDaemonVisiblePath(hostPath: string, dockerHostPathPrefix: string | undefined): string {
  const [translated] = applyHostPathPrefixToVolumes([`${hostPath}:${hostPath}`], dockerHostPathPrefix);
  return translated.split(':')[0];
}

/** Builds the broker compose service plus the agent's socket/skill wiring. */
export function buildBoundedQueryService(params: BoundedQueryServiceParams): BoundedQueryBuildResult {
  const { config, imageConfig } = params;
  const boundedQueries = config.boundedQueries;

  if (!boundedQueries?.enabled) {
    throw new Error('buildBoundedQueryService: boundedQueries must be enabled');
  }

  const paths = resolveBoundedQueryPaths(config.workDir);
  const { queryImageRef, querySource, brokerSource } = resolveBoundedQueryImages(imageConfig);
  const dockerSocketPath = resolveDockerSocketPath(config);
  const ingressTransport = config.boundedQueryIngressTransport
    ?? (runtimeUsesComposeAgent(config.containerRuntime) ? 'unix' : 'sbx-http');

  // Compose must pull/build the query target before starting the offline
  // broker. The one-shot service has no mounts or network and exits only after
  // Docker has made the exact image reference available to the daemon.
  const queryImageService: Record<string, unknown> = {
    ...querySource,
    network_mode: 'none',
    entrypoint: ['/bin/true'],
    ...buildContainerSecurityHardening({ memLimit: '32m', pidsLimit: 16, cpuShares: 64 }),
    restart: 'no',
  };

  const service: Record<string, unknown> = {
    container_name: BOUNDED_QUERY_BROKER_CONTAINER_NAME,
    ...brokerSource,
    ...(ingressTransport === 'unix'
      ? {
          // Compose agents need no network at all.
          network_mode: 'none',
        }
      : {
          // sbx reaches a loopback-published port. This dedicated Docker
          // `internal` network has no external route and no other member.
          networks: [BOUNDED_QUERY_INGRESS_NETWORK],
          ports: [`127.0.0.1::${BOUNDED_QUERY_TCP_PORT}`],
        }),
    volumes: applyHostPathPrefixToVolumes(
      [
        `${paths.seedsDir}:${BROKER_SEEDS_DIR}:ro`,
        `${paths.workDir}:${BROKER_WORK_DIR}:rw`,
        `${paths.runDir}:${BROKER_SOCKET_DIR}:rw`,
        `${paths.controlDir}:${BROKER_CONTROL_DIR}:rw`,
        `${paths.auditDir}:${BROKER_AUDIT_DIR}:rw`,
        `${paths.seedMapPath}:${BROKER_SEED_MAP_PATH}:ro`,
        `${dockerSocketPath}:${BROKER_DOCKER_SOCKET_PATH}:rw`,
      ],
      config.dockerHostPathPrefix,
    ),
    environment: {
      AWF_BOUNDED_QUERY_IMAGE: queryImageRef,
      // The broker selects a fixed QueryRunner from this normalized value.
      // Runtime flags are never accepted from an invocation.
      AWF_BOUNDED_QUERY_BACKEND: boundedQueries.runtime,
      AWF_BOUNDED_QUERY_TIMEOUT: String(boundedQueries.timeout),
      AWF_BOUNDED_QUERY_MEMORY: boundedQueries.memoryLimit,
      AWF_BOUNDED_QUERY_MAX_INVOCATIONS: String(boundedQueries.maxInvocations),
      // Query bind-mount sources are handed to the daemon, not opened by the
      // broker, so they must be daemon-visible paths.
      AWF_BOUNDED_QUERY_HOST_WORK_DIR: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
      AWF_BOUNDED_QUERY_SOCKET_UID: getSafeHostUid(),
      AWF_BOUNDED_QUERY_SOCKET_GID: getSafeHostGid(),
      ...(ingressTransport === 'sbx-http'
        ? { AWF_BOUNDED_QUERY_TCP_PORT: String(BOUNDED_QUERY_TCP_PORT) }
        : {}),
    },
    depends_on: {
      'bounded-query-image': {
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
    // workspaces and hand those workspaces to the unprivileged query uid.
    // Keep the default set dropped and restore only those filesystem duties.
    cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    restart: 'no',
    stop_grace_period: '5s',
  };

  const agentEnvAdditions: Record<string, string> = {
    ...(ingressTransport === 'unix' ? { AWF_BOUNDED_QUERY_SOCKET: AGENT_SOCKET_PATH } : {}),
    AWF_BOUNDED_QUERY_SKILL: AGENT_SKILL_PATH,
    AWF_BOUNDED_QUERY_REPOS: boundedQueries.privateRepos.map((repository) => repository.repo).join(','),
  };

  // The agent receives only the socket and skill mounts. Paths are duplicated
  // (bare and /host-prefixed) because the agent runs chrooted into /host.
  const agentVolumes = applyHostPathPrefixToVolumes(
    [
      `${paths.runDir}:${AGENT_SOCKET_DIR}:rw`,
      `${paths.runDir}:/host${AGENT_SOCKET_DIR}:rw`,
      `${paths.agentDir}:${AGENT_SKILL_DIR}:ro`,
      `${paths.agentDir}:/host${AGENT_SKILL_DIR}:ro`,
    ],
    config.dockerHostPathPrefix,
  );

  logger.info(`Bounded queries enabled - broker ingress transport: ${ingressTransport}`);

  return { queryImageService, service, agentEnvAdditions, agentVolumes };
}

/**
 * True when a volume entry is one of the bounded-query agent mounts.
 *
 * Recognizing these mounts centrally lets sysroot filtering preserve mandatory
 * bounded-query ingress without coupling that code to dynamic host paths.
 */
export function isBoundedQueryAgentMount(volume: string): boolean {
  const target = volume.split(':')[1];
  if (!target) return false;
  const normalized = target.startsWith('/host') ? target.slice('/host'.length) : target;
  return (
    normalized === AGENT_SOCKET_DIR ||
    normalized === AGENT_SKILL_DIR
  );
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const boundedQueryServiceTestHelpers = {
  LOCAL_BOUNDED_QUERY_IMAGE,
  LOCAL_BOUNDED_QUERY_BROKER_IMAGE,
  BOUNDED_QUERY_IMAGE_NAME,
  BOUNDED_QUERY_BROKER_IMAGE_NAME,
  resolveBoundedQueryImages,
  resolveBoundedQueryImage,
  toDaemonVisiblePath,
};
