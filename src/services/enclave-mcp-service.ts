import { buildRuntimeImageRef } from '../image-tag';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import {
  ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME,
  ENCLAVE_MCP_SERVER_CONTAINER_NAME,
} from '../constants';
import type { WrapperConfig } from '../types';
import { API_PROXY_PORTS } from '../types/ports';
import type { EnclaveAgentEngine, EnclaveAgentProfile } from '../types/enclave-options';
import {
  ENCLAVE_BROKER_AUDIT_DIR,
  ENCLAVE_BROKER_CAPABILITY_PATH,
  ENCLAVE_BROKER_CONTROL_DIR,
  ENCLAVE_BROKER_DOCKER_SOCKET_PATH,
  ENCLAVE_BROKER_SEED_MAP_PATH,
  ENCLAVE_BROKER_SEEDS_DIR,
  ENCLAVE_BROKER_SOCKET_DIR,
  ENCLAVE_BROKER_WORK_DIR,
  resolveEnclavePaths,
} from '../enclave/paths';
import {
  ENCLAVE_AGENT_API_PROXY_ALIAS,
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_EGRESS_NETWORK,
  ENCLAVE_AGENT_NETWORK,
} from '../enclave/network';
import { resolveBoundedQueryPrimaryBackend } from '../bounded-query/runtime-matrix';
import { resolveDockerSocketPath } from './agent-volumes/docker-socket';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';
import type { ImageBuildConfig, NetworkConfig } from './squid-service';
import { buildApiProxyServiceConfig } from './api-proxy-service-config';
import {
  ANTHROPIC_ENV,
  COPILOT_ENV,
  GEMINI_ENV,
  OIDC_AUTH_ENV_VARS,
  OPENAI_ENV,
  VERTEX_ENV,
} from '../api-proxy-env-constants';

/**
 * Compose assembly for the unified enclave MCP server and its executors.
 *
 * Topology, which is the whole point of the feature:
 *
 * - the **MCP server** runs with `network_mode: none` — no `awf-net`, no
 *   `awf-ext`, no agent-enclave network, no DNS, no Squid, no host gateway.
 *   It holds the Docker socket and the private seed/work/audit mounts, and it
 *   never holds a provider credential.
 * - **script enclaves** run with `--network none`.
 * - **agent enclaves** join *only* the dedicated `internal`
 *   {@link ENCLAVE_AGENT_NETWORK}. The sole other member is a dedicated
 *   API-proxy instance whose logs, metrics, and quota state are private to
 *   this subsystem. No primary agent, Squid, general proxy, MCP server, safe
 *   outputs, MCP gateway, or CLI proxy is on that network, and the API proxy
 *   is the only holder of a real credential.
 * - the **primary agent** receives nothing at all in this migration layer:
 *   gh-aw-mcpg owns attaching the private socket in a later layer.
 */

const LOCAL_ENCLAVE_SCRIPT_IMAGE = 'awf-enclave-script:local';
const LOCAL_ENCLAVE_AGENT_IMAGE = 'awf-enclave-agent:local';
const LOCAL_ENCLAVE_MCP_SERVER_IMAGE = 'awf-enclave-mcp-server:local';
const ENCLAVE_SCRIPT_IMAGE_NAME = 'enclave-script';
const ENCLAVE_AGENT_IMAGE_NAME = 'enclave-agent';
const ENCLAVE_MCP_SERVER_IMAGE_NAME = 'enclave-mcp-server';

interface EnclaveMcpServiceParams {
  config: WrapperConfig;
  imageConfig: ImageBuildConfig;
  networkConfig?: NetworkConfig;
}

export interface EnclaveMcpBuildResult {
  /** One-shot service making the script sandbox image locally available. */
  scriptImageService?: Record<string, unknown>;
  /** One-shot service making the agent enclave image locally available. */
  agentImageService?: Record<string, unknown>;
  /** Dedicated credential sidecar for agent enclaves, when that executor runs. */
  agentApiProxyService?: Record<string, unknown>;
  service: Record<string, unknown>;
}

function resolveServerImage(imageConfig: ImageBuildConfig): Record<string, unknown> {
  if (imageConfig.useGHCR) {
    return {
      image: buildRuntimeImageRef(
        imageConfig.registry,
        ENCLAVE_MCP_SERVER_IMAGE_NAME,
        imageConfig.parsedTag,
      ),
    };
  }
  return {
    image: LOCAL_ENCLAVE_MCP_SERVER_IMAGE,
    build: {
      // The server drives both executors, so its build context spans
      // containers/bounded-query and containers/bounded-agent.
      context: `${imageConfig.projectRoot}/containers`,
      dockerfile: 'bounded-query/enclave-mcp/Dockerfile',
      target: 'enclave-mcp-server',
    },
  };
}

function resolveScriptImage(
  imageConfig: ImageBuildConfig,
  override?: string,
): { imageRef: string; source: Record<string, unknown> } {
  if (override) return { imageRef: override, source: { image: override } };
  if (imageConfig.useGHCR) {
    const imageRef = buildRuntimeImageRef(
      imageConfig.registry,
      ENCLAVE_SCRIPT_IMAGE_NAME,
      imageConfig.parsedTag,
    );
    return { imageRef, source: { image: imageRef } };
  }
  return {
    imageRef: LOCAL_ENCLAVE_SCRIPT_IMAGE,
    source: {
      image: LOCAL_ENCLAVE_SCRIPT_IMAGE,
      build: {
        context: `${imageConfig.projectRoot}/containers/bounded-query`,
        dockerfile: 'Dockerfile',
        target: 'query',
      },
    },
  };
}

function resolveAgentImage(
  imageConfig: ImageBuildConfig,
  override?: string,
): { imageRef: string; source: Record<string, unknown> } {
  if (override) return { imageRef: override, source: { image: override } };
  if (imageConfig.useGHCR) {
    const imageRef = buildRuntimeImageRef(
      imageConfig.registry,
      ENCLAVE_AGENT_IMAGE_NAME,
      imageConfig.parsedTag,
    );
    return { imageRef, source: { image: imageRef } };
  }
  return {
    imageRef: LOCAL_ENCLAVE_AGENT_IMAGE,
    source: {
      image: LOCAL_ENCLAVE_AGENT_IMAGE,
      build: {
        // Reuses the audited native enclave image target verbatim.
        context: `${imageConfig.projectRoot}/containers`,
        dockerfile: 'bounded-agent/Dockerfile',
        target: 'enclave',
      },
    },
  };
}

function toDaemonVisiblePath(hostPath: string, prefix: string | undefined): string {
  const [translated] = applyHostPathPrefixToVolumes([`${hostPath}:${hostPath}`], prefix);
  return translated.split(':')[0];
}

/** Resolves the API-proxy port the enclave's configured profile speaks to. */
export function resolveEnclaveAgentApiPort(
  engine: EnclaveAgentEngine,
  profile: EnclaveAgentProfile,
): number {
  if (engine === 'copilot') return API_PROXY_PORTS.COPILOT;
  return profile === 'anthropic' ? API_PROXY_PORTS.ANTHROPIC : API_PROXY_PORTS.OPENAI;
}

/**
 * Builds the dedicated agent-enclave API proxy.
 *
 * The proxy is the only component on the enclave network that holds a real
 * credential; the MCP server, the enclave itself, and the primary agent never
 * do. Its environment is minimized to the single provider route the configured
 * engine/profile actually uses, and every external telemetry and OIDC control
 * is stripped so private-repository-derived provider traffic can never be
 * exported to a third-party collector or exchanged for another identity.
 */
function buildAgentApiProxyService(params: {
  config: WrapperConfig;
  imageConfig: ImageBuildConfig;
  networkConfig: NetworkConfig;
  apiProxyLogsPath: string;
  engine: EnclaveAgentEngine;
  profile: EnclaveAgentProfile;
}): Record<string, unknown> {
  const service = buildApiProxyServiceConfig({
    config: params.config,
    networkConfig: params.networkConfig,
    apiProxyLogsPath: params.apiProxyLogsPath,
    imageConfig: params.imageConfig,
  }) as Record<string, unknown>;

  service.container_name = ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME;
  service.networks = {
    [ENCLAVE_AGENT_NETWORK]: {
      ipv4_address: ENCLAVE_AGENT_API_PROXY_IP,
      aliases: [ENCLAVE_AGENT_API_PROXY_ALIAS],
    },
    [ENCLAVE_AGENT_EGRESS_NETWORK]: {},
  };

  const environment = service.environment as Record<string, string>;
  // The dedicated proxy has direct upstream egress; it is never routed through
  // Squid or the primary agent's proxy chain.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'https_proxy']) delete environment[key];
  for (const key of [
    'GH_AW_OTLP_ENDPOINTS',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'GH_AW_OTLP_WORKLOAD_IDENTITY',
    'GITHUB_AW_OTEL_TRACE_ID',
    'GITHUB_AW_OTEL_PARENT_SPAN_ID',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'AWF_AUTH_ANTHROPIC_TOKEN_URL',
    ...OIDC_AUTH_ENV_VARS,
  ]) {
    delete environment[key];
  }
  const unusedProviderCredentials = params.engine === 'copilot'
    ? [OPENAI_ENV.KEY, ANTHROPIC_ENV.KEY, GEMINI_ENV.KEY, VERTEX_ENV.KEY]
    : params.profile === 'openai'
      ? [ANTHROPIC_ENV.KEY, COPILOT_ENV.GITHUB_TOKEN, COPILOT_ENV.PROVIDER_API_KEY, GEMINI_ENV.KEY, VERTEX_ENV.KEY]
      : [OPENAI_ENV.KEY, COPILOT_ENV.GITHUB_TOKEN, COPILOT_ENV.PROVIDER_API_KEY, GEMINI_ENV.KEY, VERTEX_ENV.KEY];
  for (const key of unusedProviderCredentials) delete environment[key];

  return service;
}

export function buildEnclaveMcpService(params: EnclaveMcpServiceParams): EnclaveMcpBuildResult {
  const { config, imageConfig } = params;
  const enclaves = config.enclaves;
  const script = enclaves?.executors.script;
  const agent = enclaves?.executors.agent;
  if (!enclaves?.enabled || (!script?.enabled && !agent?.enabled)) {
    throw new Error('buildEnclaveMcpService: at least one enclave executor must be enabled');
  }
  if (script?.enabled && script.runtime === 'sbx') {
    throw new Error('buildEnclaveMcpService: sbx script enclave capability is not yet available');
  }
  if (agent?.enabled && agent.runtime === 'sbx') {
    throw new Error('buildEnclaveMcpService: sbx agent enclave capability is not yet available');
  }
  if (agent?.enabled && !config.enableApiProxy) {
    throw new Error(
      'buildEnclaveMcpService: the enclave agent executor requires the API proxy, which is the ' +
      "enclave's only permitted upstream egress",
    );
  }

  const paths = resolveEnclavePaths(config.workDir);
  const dockerSocketPath = resolveDockerSocketPath(config);
  const primaryBackend = resolveBoundedQueryPrimaryBackend(config.containerRuntime);
  const imageServiceHardening = { memLimit: '32m', pidsLimit: 16, cpuShares: 64 };

  const environment: Record<string, string> = {
    AWF_ENCLAVE_PRIMARY_BACKEND: primaryBackend,
    AWF_ENCLAVE_HOST_WORK_DIR: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
    AWF_ENCLAVE_SOCKET_UID: getSafeHostUid(),
    AWF_ENCLAVE_SOCKET_GID: getSafeHostGid(),
    AWF_ENCLAVE_CAPABILITY_PATH: ENCLAVE_BROKER_CAPABILITY_PATH,
    AWF_ENCLAVE_SCRIPT_ENABLED: String(script?.enabled === true),
    AWF_ENCLAVE_AGENT_ENABLED: String(agent?.enabled === true),
  };
  const dependsOn: Record<string, Record<string, string>> = {};
  const result: EnclaveMcpBuildResult = { service: {} };

  if (script?.enabled) {
    const { imageRef, source } = resolveScriptImage(imageConfig, script.image);
    result.scriptImageService = {
      ...source,
      network_mode: 'none',
      entrypoint: ['/bin/true'],
      ...buildContainerSecurityHardening(imageServiceHardening),
      restart: 'no',
    };
    dependsOn['enclave-script-image'] = { condition: 'service_completed_successfully' };
    Object.assign(environment, {
      AWF_ENCLAVE_IMAGE: imageRef,
      AWF_ENCLAVE_BACKEND: script.runtime,
      AWF_ENCLAVE_TIMEOUT: String(script.timeout),
      AWF_ENCLAVE_MEMORY: script.memoryLimit,
      AWF_ENCLAVE_CPU: script.cpuLimit,
      AWF_ENCLAVE_PIDS: String(script.pidsLimit),
      AWF_ENCLAVE_TMPFS: script.tmpfsLimit,
      AWF_ENCLAVE_MAX_OUTPUT_BYTES: String(script.maxOutputBytes),
      AWF_ENCLAVE_MAX_SCRIPT_BYTES: String(script.maxScriptBytes),
      AWF_ENCLAVE_MAX_INVOCATIONS: String(script.maxInvocations),
    });
  }

  if (agent?.enabled) {
    if (!params.networkConfig) {
      throw new Error('buildEnclaveMcpService: the enclave agent executor requires network configuration');
    }
    const { imageRef, source } = resolveAgentImage(imageConfig, agent.image);
    result.agentImageService = {
      ...source,
      network_mode: 'none',
      entrypoint: ['/bin/true'],
      ...buildContainerSecurityHardening(imageServiceHardening),
      restart: 'no',
    };
    dependsOn['enclave-agent-image'] = { condition: 'service_completed_successfully' };
    dependsOn['enclave-agent-api-proxy'] = { condition: 'service_healthy' };
    result.agentApiProxyService = buildAgentApiProxyService({
      config,
      imageConfig,
      networkConfig: params.networkConfig,
      apiProxyLogsPath: paths.apiProxyLogsDir,
      engine: agent.engine,
      profile: agent.profile,
    });
    const apiPort = resolveEnclaveAgentApiPort(agent.engine, agent.profile);
    Object.assign(environment, {
      AWF_ENCLAVE_AGENT_IMAGE: imageRef,
      // The server selects a fixed EnclaveRunner from this normalized value.
      // Runtime flags are never accepted from an invocation.
      AWF_ENCLAVE_AGENT_BACKEND: agent.runtime,
      AWF_ENCLAVE_AGENT_NETWORK: ENCLAVE_AGENT_NETWORK,
      AWF_ENCLAVE_AGENT_API_ENDPOINT: `http://${ENCLAVE_AGENT_API_PROXY_IP}:${apiPort}`,
      AWF_ENCLAVE_AGENT_ENGINE: agent.engine,
      AWF_ENCLAVE_AGENT_PROFILE: agent.profile,
      AWF_ENCLAVE_AGENT_MODEL: agent.model,
      AWF_ENCLAVE_AGENT_TIMEOUT: String(agent.timeout),
      AWF_ENCLAVE_AGENT_MEMORY: agent.memoryLimit,
      AWF_ENCLAVE_AGENT_CPU: agent.cpuLimit,
      AWF_ENCLAVE_AGENT_PIDS: String(agent.pidsLimit),
      AWF_ENCLAVE_AGENT_TMPFS: agent.tmpfsLimit,
      AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES: String(agent.maxOutputBytes),
      AWF_ENCLAVE_AGENT_MAX_PROMPT_BYTES: String(agent.maxTaskBytes),
      AWF_ENCLAVE_AGENT_MAX_INVOCATIONS: String(agent.maxInvocations),
      AWF_ENCLAVE_AGENT_MAX_MODEL_REQUESTS: String(agent.maxModelRequests),
      AWF_ENCLAVE_AGENT_MAX_MODEL_TOKENS: String(agent.maxModelTokens),
      // Enclave bind-mount sources are handed to the daemon, not opened by the
      // server, so they must be daemon-visible paths.
      AWF_ENCLAVE_AGENT_HOST_WORK_DIR: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
      AWF_ENCLAVE_AGENT_HOST_SEEDS_DIR: toDaemonVisiblePath(paths.seedsDir, config.dockerHostPathPrefix),
    });
  }

  result.service = {
    container_name: ENCLAVE_MCP_SERVER_CONTAINER_NAME,
    ...resolveServerImage(imageConfig),
    network_mode: 'none',
    volumes: applyHostPathPrefixToVolumes(
      [
        `${paths.seedsDir}:${ENCLAVE_BROKER_SEEDS_DIR}:ro`,
        `${paths.workDir}:${ENCLAVE_BROKER_WORK_DIR}:rw`,
        `${paths.runDir}:${ENCLAVE_BROKER_SOCKET_DIR}:rw`,
        `${paths.controlDir}:${ENCLAVE_BROKER_CONTROL_DIR}:rw`,
        `${paths.auditDir}:${ENCLAVE_BROKER_AUDIT_DIR}:rw`,
        `${paths.seedMapPath}:${ENCLAVE_BROKER_SEED_MAP_PATH}:ro`,
        `${dockerSocketPath}:${ENCLAVE_BROKER_DOCKER_SOCKET_PATH}:rw`,
      ],
      config.dockerHostPathPrefix,
    ),
    environment,
    depends_on: dependsOn,
    healthcheck: {
      test: ['CMD', 'node', '/opt/awf/enclave-mcp/healthcheck.js'],
      interval: '5s',
      timeout: '3s',
      retries: 10,
      start_period: '20s',
    },
    ...buildContainerSecurityHardening({ memLimit: '256m', pidsLimit: 100, cpuShares: 256 }),
    cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    restart: 'no',
    stop_grace_period: '5s',
  };
  return result;
}

export const enclaveMcpServiceTestHelpers = {
  ENCLAVE_SCRIPT_IMAGE_NAME,
  ENCLAVE_AGENT_IMAGE_NAME,
  ENCLAVE_MCP_SERVER_IMAGE_NAME,
  LOCAL_ENCLAVE_SCRIPT_IMAGE,
  LOCAL_ENCLAVE_AGENT_IMAGE,
  LOCAL_ENCLAVE_MCP_SERVER_IMAGE,
  resolveAgentImage,
  resolveScriptImage,
  resolveServerImage,
  toDaemonVisiblePath,
};
