import { logger } from '../logger';
import { buildRuntimeImageRef } from '../image-tag';
import { resolveAgentImageConfig } from './agent-service';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import {
  BOUNDED_AGENT_API_PROXY_CONTAINER_NAME,
  BOUNDED_AGENT_BROKER_CONTAINER_NAME,
} from '../constants';
import type { BoundedAgentEngine, WrapperConfig } from '../types';
import { API_PROXY_PORTS } from '../types/ports';
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
  resolveBoundedAgentPaths,
} from '../bounded-agent/paths';
import {
  BOUNDED_AGENT_API_PROXY_IP,
  BOUNDED_AGENT_EGRESS_NETWORK,
  BOUNDED_AGENT_NETWORK,
} from '../bounded-agent/network';
import { resolveDockerSocketPath } from './agent-volumes/docker-socket';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';
import type { ImageBuildConfig, NetworkConfig } from './squid-service';
import { buildApiProxyServiceConfig } from './api-proxy-service-config';
import { resolveDockerHostGateway } from './host-gateway';
import {
  BOUNDED_AGENT_INGRESS_NETWORK,
  BOUNDED_AGENT_TCP_PORT,
} from '../bounded-agent/ingress';
import { resolveBoundedAgentPrimaryBackend } from '../bounded-agent/runtime-matrix';
import { runtimeUsesComposeAgent } from '../container-runtime';
import {
  ANTHROPIC_ENV,
  COPILOT_ENV,
  GEMINI_ENV,
  OIDC_AUTH_ENV_VARS,
  OPENAI_ENV,
  VERTEX_ENV,
} from '../api-proxy-env-constants';

/**
 * Compose assembly for the trusted bounded-agent broker and its enclave.
 *
 * Topology, which is the whole point of the feature:
 *
 * - the **broker** runs with `network_mode: none` — no `awf-net`, no
 *   `awf-ext`, no bounded-agent network, no DNS, no Squid, no host gateway.
 *   Its only agent-facing surface is a Unix socket bind mount.
 * - the **enclave** joins *only* the dedicated `internal` bounded-agent
 *   network. The sole other member is a dedicated API-proxy instance whose
 *   logs, metrics, and quota state are private to this subsystem. The enclave has no
 *   route to the primary agent, Squid, the broker, safe outputs, the MCP
 *   gateway, the CLI proxy, or the internet; the API proxy is its only
 *   upstream egress and the only holder of a real credential.
 * - the **primary agent** receives exactly two mounts (socket + generated
 *   skill) and two environment variables. It never sees the Docker socket, the
 *   enclave network, the model identity, or any provider credential.
 */

/** Local image tag used when building the bounded-agent broker image from source. */
const LOCAL_BOUNDED_AGENT_BROKER_IMAGE = 'awf-bounded-agent-broker:local';

/** Broker image name published to the container registry. */
const BOUNDED_AGENT_BROKER_IMAGE_NAME = 'bounded-agent-broker';

interface BoundedAgentServiceParams {
  config: WrapperConfig;
  imageConfig: ImageBuildConfig;
  networkConfig: NetworkConfig;
}

interface BoundedAgentBuildResult {
  /** One-shot service that makes the enclave image locally available. */
  enclaveImageService: Record<string, unknown>;
  /** Compose service definition for the broker. */
  service: Record<string, unknown>;
  /** Dedicated credential sidecar whose state is invisible to the primary agent. */
  apiProxyService: Record<string, unknown>;
  /** Environment additions merged into the agent container. */
  agentEnvAdditions: Record<string, string>;
  /** Bind mounts added to the agent container. */
  agentVolumes: string[];
}

/**
 * Resolves the shared primary/enclave agent image and the separate broker image.
 *
 * Local builds use the `containers/` build context because the broker reuses
 * the shared PR1 bounded-execution foundation and the audited sandbox seccomp
 * profile that live under `containers/bounded-query/`.
 */
function resolveBoundedAgentImages(
  config: WrapperConfig,
  imageConfig: ImageBuildConfig,
  engine: BoundedAgentEngine = 'copilot',
): {
  enclaveImageRef: string;
  enclaveSource: Record<string, unknown>;
  brokerSource: Record<string, unknown>;
} {
  if (engine !== 'copilot') {
    throw new Error(`No bounded-agent enclave image is implemented for engine "${engine}"`);
  }
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;
  const enclaveSource = resolveAgentImageConfig(config, imageConfig);

  return {
    enclaveImageRef: enclaveSource.image,
    enclaveSource,
    brokerSource: useGHCR
      ? { image: buildRuntimeImageRef(registry, BOUNDED_AGENT_BROKER_IMAGE_NAME, parsedTag) }
      : {
          image: LOCAL_BOUNDED_AGENT_BROKER_IMAGE,
          build: {
            context: `${projectRoot}/containers`,
            dockerfile: 'bounded-agent/Dockerfile',
            target: 'broker',
          },
        },
  };
}

/**
 * Translates a host directory into the path the Docker daemon resolves it at.
 *
 * The broker passes enclave bind-mount sources straight to the daemon, so those
 * sources must already be expressed in the daemon's filesystem view (ARC/DinD
 * split filesystems).
 */
function toDaemonVisiblePath(hostPath: string, dockerHostPathPrefix: string | undefined): string {
  const [translated] = applyHostPathPrefixToVolumes([`${hostPath}:${hostPath}`], dockerHostPathPrefix);
  return translated.split(':')[0];
}

/** Resolves the API-proxy port the enclave's configured profile speaks to. */
export function resolveBoundedAgentApiPort(
  engine: 'copilot' | 'claude' | 'codex' | 'gemini',
  profile: 'openai' | 'anthropic',
): number {
  if (engine === 'copilot') return API_PROXY_PORTS.COPILOT;
  return profile === 'anthropic' ? API_PROXY_PORTS.ANTHROPIC : API_PROXY_PORTS.OPENAI;
}

/** Builds the broker compose service plus the agent's socket/skill wiring. */
export function buildBoundedAgentService(params: BoundedAgentServiceParams): BoundedAgentBuildResult {
  const { config, imageConfig, networkConfig } = params;
  const boundedAgents = config.boundedAgents;

  if (!boundedAgents?.enabled) {
    throw new Error('buildBoundedAgentService: boundedAgents must be enabled');
  }
  if (boundedAgents.runtime === 'sbx') {
    throw new Error(
      'buildBoundedAgentService: boundedAgents.runtime "sbx" is capability-blocked — the installed sbx ' +
      'runtime cannot yet prove all mandatory enclave-isolation controls (see assertEnclaveRuntimeAvailable ' +
      'and BoundedAgentSbxCapabilityReport.missing), so no enclave broker wiring is generated and there is ' +
      'no Docker-socket or credential fallback',
    );
  }
  if (!config.enableApiProxy) {
    throw new Error(
      'buildBoundedAgentService: bounded agents require the API proxy, which is the enclave\'s only ' +
      'permitted upstream egress',
    );
  }

  const paths = resolveBoundedAgentPaths(config.workDir);
  const { enclaveImageRef, enclaveSource, brokerSource } =
    resolveBoundedAgentImages(config, imageConfig, boundedAgents.engine);
  const dockerSocketPath = resolveDockerSocketPath(config);
  const apiPort = resolveBoundedAgentApiPort(boundedAgents.engine, boundedAgents.profile);
  const ingressTransport = config.boundedAgentIngressTransport
    ?? (runtimeUsesComposeAgent(config.containerRuntime) ? 'unix' : 'sbx-http');
  const sbxIngressHostIp = ingressTransport === 'sbx-http' ? resolveDockerHostGateway() : undefined;
  if (ingressTransport === 'sbx-http' && !sbxIngressHostIp) {
    throw new Error('Could not resolve the Docker host-gateway IP for bounded-agent sbx ingress');
  }

  const apiProxyService = buildApiProxyServiceConfig({
    config,
    networkConfig,
    apiProxyLogsPath: paths.apiProxyLogsDir,
    imageConfig,
  }) as Record<string, any>;
  apiProxyService.container_name = BOUNDED_AGENT_API_PROXY_CONTAINER_NAME;
  apiProxyService.networks = {
    [BOUNDED_AGENT_NETWORK]: {
      ipv4_address: BOUNDED_AGENT_API_PROXY_IP,
      aliases: ['awf-bounded-agent-api-proxy'],
    },
    [BOUNDED_AGENT_EGRESS_NETWORK]: {},
  };

  const proxyEnv = apiProxyService.environment as Record<string, string>;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'https_proxy']) delete proxyEnv[key];
  for (const key of [
    'GH_AW_OTLP_ENDPOINTS',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'GITHUB_AW_OTEL_TRACE_ID',
    'GITHUB_AW_OTEL_PARENT_SPAN_ID',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    ...OIDC_AUTH_ENV_VARS,
  ]) {
    delete proxyEnv[key];
  }
  const unusedProviderCredentials = boundedAgents.engine === 'copilot'
    ? [OPENAI_ENV.KEY, ANTHROPIC_ENV.KEY, GEMINI_ENV.KEY, VERTEX_ENV.KEY]
    : boundedAgents.profile === 'openai'
      ? [ANTHROPIC_ENV.KEY, COPILOT_ENV.GITHUB_TOKEN, COPILOT_ENV.PROVIDER_API_KEY, GEMINI_ENV.KEY, VERTEX_ENV.KEY]
      : [OPENAI_ENV.KEY, COPILOT_ENV.GITHUB_TOKEN, COPILOT_ENV.PROVIDER_API_KEY, GEMINI_ENV.KEY, VERTEX_ENV.KEY];
  for (const key of unusedProviderCredentials) delete proxyEnv[key];

  // Compose must pull/build the enclave target before starting the offline
  // broker. The one-shot service has no mounts or network and exits only after
  // Docker has made the exact image reference available to the daemon.
  const enclaveImageService: Record<string, unknown> = {
    ...enclaveSource,
    network_mode: 'none',
    entrypoint: ['/bin/true'],
    ...buildContainerSecurityHardening({ memLimit: '32m', pidsLimit: 16, cpuShares: 64 }),
    restart: 'no',
  };

  const service: Record<string, unknown> = {
    container_name: BOUNDED_AGENT_BROKER_CONTAINER_NAME,
    ...brokerSource,
    // The broker is deliberately networkless when the primary agent shares a
    // Unix-socket-mountable host with it: it never joins the enclave network
    // it launches enclaves onto. When the primary agent is a microVM that
    // cannot receive that bind mount (sbx-http transport), the broker instead
    // joins a *separate*, dedicated `internal` ingress bridge — distinct from
    // BOUNDED_AGENT_NETWORK — so it still never shares a network with an
    // enclave, the primary agent's own network, Squid, or the API proxy.
    ...(ingressTransport === 'unix'
      ? { network_mode: 'none' }
      : {
          networks: [BOUNDED_AGENT_INGRESS_NETWORK],
          ports: [`${sbxIngressHostIp}::${BOUNDED_AGENT_TCP_PORT}`],
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
      AWF_BOUNDED_AGENT_IMAGE: enclaveImageRef,
      // The broker selects a fixed EnclaveRunner from this normalized value.
      // Runtime flags are never accepted from an invocation.
      AWF_BOUNDED_AGENT_BACKEND: boundedAgents.runtime,
      AWF_BOUNDED_AGENT_PRIMARY_BACKEND: resolveBoundedAgentPrimaryBackend(config.containerRuntime),
      AWF_BOUNDED_AGENT_NETWORK: BOUNDED_AGENT_NETWORK,
      AWF_BOUNDED_AGENT_API_ENDPOINT: `http://${BOUNDED_AGENT_API_PROXY_IP}:${apiPort}`,
      AWF_BOUNDED_AGENT_ENGINE: boundedAgents.engine,
      AWF_BOUNDED_AGENT_PROFILE: boundedAgents.profile,
      AWF_BOUNDED_AGENT_MODEL: boundedAgents.model,
      AWF_BOUNDED_AGENT_TIMEOUT: String(boundedAgents.timeout),
      AWF_BOUNDED_AGENT_MEMORY: boundedAgents.memoryLimit,
      AWF_BOUNDED_AGENT_CPUS: boundedAgents.cpuLimit,
      AWF_BOUNDED_AGENT_PIDS: String(boundedAgents.pidsLimit),
      AWF_BOUNDED_AGENT_TMPFS: boundedAgents.tmpfsLimit,
      AWF_BOUNDED_AGENT_MAX_OUTPUT_BYTES: String(boundedAgents.maxOutputBytes),
      AWF_BOUNDED_AGENT_MAX_TASK_BYTES: String(boundedAgents.maxTaskBytes),
      AWF_BOUNDED_AGENT_MAX_INVOCATIONS: String(boundedAgents.maxInvocations),
      AWF_BOUNDED_AGENT_MAX_MODEL_REQUESTS: String(boundedAgents.maxModelRequests),
      AWF_BOUNDED_AGENT_MAX_MODEL_TOKENS: String(boundedAgents.maxModelTokens),
      // Enclave bind-mount sources are handed to the daemon, not opened by the
      // broker, so they must be daemon-visible paths.
      AWF_BOUNDED_AGENT_HOST_WORK_DIR: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
      AWF_BOUNDED_AGENT_HOST_SEEDS_DIR: toDaemonVisiblePath(paths.seedsDir, config.dockerHostPathPrefix),
      AWF_BOUNDED_AGENT_SOCKET_UID: getSafeHostUid(),
      AWF_BOUNDED_AGENT_SOCKET_GID: getSafeHostGid(),
      ...(ingressTransport === 'sbx-http'
        ? { AWF_BOUNDED_AGENT_TCP_PORT: String(BOUNDED_AGENT_TCP_PORT) }
        : {}),
    },
    depends_on: {
      'bounded-agent-image': {
        condition: 'service_completed_successfully',
      },
      'bounded-agent-api-proxy': {
        condition: 'service_healthy',
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
    // The broker is root only so it can hand the pre-created result file to the
    // unprivileged enclave uid. Keep the default set dropped and restore only
    // those filesystem duties.
    cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    restart: 'no',
    stop_grace_period: '5s',
  };

  const agentEnvAdditions: Record<string, string> = {
    ...(ingressTransport === 'unix' ? { AWF_BOUNDED_AGENT_SOCKET: AGENT_SOCKET_PATH } : {}),
    AWF_BOUNDED_AGENT_SKILL: AGENT_SKILL_PATH,
    AWF_BOUNDED_AGENT_REPOS: boundedAgents.privateRepos.map((repository) => repository.repo).join(','),
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

  logger.info(
    `Bounded agents enabled - enclave runtime: ${boundedAgents.runtime}, ` +
    `engine: ${boundedAgents.engine}, profile: ${boundedAgents.profile}, ` +
    `enclave network: ${BOUNDED_AGENT_NETWORK} (API proxy only), ` +
    `broker ingress transport: ${ingressTransport}`,
  );

  return { enclaveImageService, service, apiProxyService, agentEnvAdditions, agentVolumes };
}

/**
 * True when a volume entry is one of the bounded-agent agent mounts.
 *
 * Recognizing these mounts centrally lets sysroot filtering preserve mandatory
 * bounded-agent ingress without coupling that code to dynamic host paths.
 */
export function isBoundedAgentAgentMount(volume: string): boolean {
  const target = volume.split(':')[1];
  if (!target) return false;
  const normalized = target.startsWith('/host') ? target.slice('/host'.length) : target;
  return normalized === AGENT_SOCKET_DIR || normalized === AGENT_SKILL_DIR;
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const boundedAgentServiceTestHelpers = {
  LOCAL_BOUNDED_AGENT_BROKER_IMAGE,
  BOUNDED_AGENT_BROKER_IMAGE_NAME,
  resolveBoundedAgentImages,
  toDaemonVisiblePath,
};
