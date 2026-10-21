import * as path from 'path';
import {
  ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME,
  ENCLAVE_MCP_SERVER_CONTAINER_NAME,
  LOCAL_ENCLAVE_MCP_SERVER_IMAGE,
} from '../constants';
import { API_PROXY_HEALTH_PORT, type WrapperConfig } from '../types';
import {
  isEnclaveAgentGithubRouteEnabled,
  isEnclaveAgentGithubToolsEnabled,
  resolveEnclaveAgentApiPort,
} from '../types/enclave-options';
import type { EnclaveAgentEngine, EnclaveAgentProfile } from '../types/enclave-options';
import {
  ENCLAVE_SERVER_AUDIT_DIR,
  ENCLAVE_SERVER_CAPABILITY_PATH,
  ENCLAVE_SERVER_DELEGATION_CHANNEL_DIR,
  ENCLAVE_SERVER_GITHUB_AGENT_ID_PATH,
  ENCLAVE_SERVER_CONTROL_DIR,
  ENCLAVE_SERVER_DOCKER_SOCKET_PATH,
  ENCLAVE_SERVER_HOST_EXECUTOR_DIR,
  ENCLAVE_SERVER_SEED_MAP_PATH,
  ENCLAVE_SERVER_SEEDS_DIR,
  ENCLAVE_SERVER_CAPABILITY_DIR,
  ENCLAVE_SERVER_WORK_DIR,
  readEnclaveRunId,
  resolveEnclavePaths,
} from '../enclave/paths';
import {
  ENCLAVE_AGENT_API_PROXY_ALIAS,
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_EGRESS_NETWORK,
  ENCLAVE_AGENT_NETWORK,
  ENCLAVE_MCP_CONTROL_ALIAS,
  ENCLAVE_MCP_CONTROL_NETWORK,
} from '../enclave/network';
import { resolvePrimaryRuntimeBackend } from '../enclave/runtime-preflight';
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
import { buildRuntimeImageRef } from '../image-tag';
import {
  ENCLAVE_GITHUB_MCP_INTERNAL_URL,
  resolveEnclaveGithubGatewayContract,
} from '../enclave/github-gateway';
import { getOrCreateEnclaveModelBudgetSecret } from '../enclave/model-budget-capability';

/**
 * Compose assembly for the unified enclave MCP server and its executors.
 *
 * Topology, which is the whole point of the feature:
 *
 * - the **MCP server** joins only the dedicated internal enclave control
 *   network — no `awf-net`, no `awf-ext`, no agent-enclave network, no Squid,
 *   no host gateway.
 *   Docker execution uses the authenticated host channel; only gVisor retains
 *   the Docker socket and private seed/work mounts. Neither holds a provider credential.
 * - **script enclaves** run with `--network none`.
 * - **agent enclaves** join *only* the dedicated `internal`
 *   {@link ENCLAVE_AGENT_NETWORK}. Its mandatory peer is a dedicated API proxy;
 *   issues-read-v1 adds only the policy-isolated shared MCP gateway. No primary agent, Squid,
 *   general proxy, MCP server, safe outputs, or MCP gateway is on that network,
 *   and the API proxy is the only holder of a provider credential.
 * - the **primary agent** receives no socket, capability, direct URL, private
 *   mount, repository list, ledger state, or control metadata. It reaches the
 *   tools only through the externally launched trusted MCP gateway.
 */

const LOCAL_ENCLAVE_SCRIPT_IMAGE = 'awf-enclave-script:local';
const LOCAL_ENCLAVE_AGENT_IMAGE = 'awf-enclave-agent:local';
const ENCLAVE_SCRIPT_IMAGE_NAME = 'enclave-script';
const ENCLAVE_AGENT_IMAGE_NAME = 'enclave-agent';
const ENCLAVE_MCP_SERVER_IMAGE_NAME = 'enclave-mcp-server';

interface EnclaveMcpServiceParams {
  config: WrapperConfig;
  imageConfig: ImageBuildConfig;
  networkConfig?: NetworkConfig;
}

export interface EnclaveMcpBuildResult {
  /** BuildKit source for the locally built agent's shared toolchain base. */
  toolchainImageService?: Record<string, unknown>;
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
      image: imageConfig.resolveImage?.(ENCLAVE_MCP_SERVER_IMAGE_NAME) ??
        buildRuntimeImageRef(imageConfig.registry, ENCLAVE_MCP_SERVER_IMAGE_NAME, imageConfig.parsedTag),
    };
  }
  return {
    image: LOCAL_ENCLAVE_MCP_SERVER_IMAGE,
    build: {
      context: `${imageConfig.projectRoot}/containers`,
      dockerfile: 'enclave/Dockerfile',
      target: 'enclave-mcp-server',
      args: { AWF_SOURCE_REVISION: process.env.GITHUB_SHA ?? 'unavailable' },
    },
  };
}

function resolveScriptImage(
  imageConfig: ImageBuildConfig,
  override?: string,
): { imageRef: string; source: Record<string, unknown> } {
  if (override) return { imageRef: override, source: { image: override } };
  if (imageConfig.useGHCR) {
    const imageRef = imageConfig.resolveImage?.(ENCLAVE_SCRIPT_IMAGE_NAME) ??
      buildRuntimeImageRef(imageConfig.registry, ENCLAVE_SCRIPT_IMAGE_NAME, imageConfig.parsedTag);
    return { imageRef, source: { image: imageRef } };
  }
  return {
    imageRef: LOCAL_ENCLAVE_SCRIPT_IMAGE,
    source: {
      image: LOCAL_ENCLAVE_SCRIPT_IMAGE,
      build: {
        context: `${imageConfig.projectRoot}/containers`,
        dockerfile: 'enclave/Dockerfile',
        target: 'enclave-script',
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
    const imageRef = imageConfig.resolveImage?.(ENCLAVE_AGENT_IMAGE_NAME) ??
      buildRuntimeImageRef(imageConfig.registry, ENCLAVE_AGENT_IMAGE_NAME, imageConfig.parsedTag);
    return { imageRef, source: { image: imageRef } };
  }
  return {
    imageRef: LOCAL_ENCLAVE_AGENT_IMAGE,
    source: {
      image: LOCAL_ENCLAVE_AGENT_IMAGE,
      build: {
        context: `${imageConfig.projectRoot}/containers`,
        dockerfile: 'enclave/Dockerfile',
        target: 'enclave-agent',
        additional_contexts: { 'awf-build-tools': 'service:enclave-build-tools-image' },
      },
    },
  };
}

function toDaemonVisiblePath(hostPath: string, prefix: string | undefined): string {
  const [translated] = applyHostPathPrefixToVolumes([`${hostPath}:${hostPath}`], prefix);
  return translated.split(':')[0];
}

export { resolveEnclaveAgentApiPort } from '../types/enclave-options';

/** Trusted host-only Docker runner settings; never serialized into an invocation. */
export function deriveDockerEnclaveRunnerConfig(
  config: WrapperConfig,
  imageConfig: ImageBuildConfig,
  kind: 'script' | 'agent',
): Record<string, string | number | boolean | undefined> {
  const executor = config.enclaves?.executors[kind];
  if (!executor?.enabled || executor.runtime !== 'docker') {
    throw new Error('Docker enclave runner requires an enabled Docker entry');
  }
  const paths = resolveEnclavePaths(config.workDir);
  const common = {
    seedsDir: paths.seedsDir,
    workDir: paths.workDir,
    auditDir: paths.auditDir,
    hostWorkDir: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
    backend: 'docker',
    executorBackend: 'docker',
    primaryBackend: resolvePrimaryRuntimeBackend(config.containerRuntime),
    timeoutSeconds: executor.timeout,
    maxInvocations: executor.maxInvocations,
    memoryLimit: executor.memoryLimit,
    cpuLimit: executor.cpuLimit,
    pidsLimit: executor.pidsLimit,
    tmpfsLimit: executor.tmpfsLimit,
    maxOutputBytes: executor.maxOutputBytes,
    runLabelKey: 'awf.enclave.run',
    invocationLabelKey: 'awf.enclave.invocation',
  };
  const seccompPath = path.join(paths.root, 'docker-enclave-seccomp.json');
  if (kind === 'script') {
    const script = config.enclaves!.executors.script!;
    return {
      ...common,
      querySeccompPath: seccompPath,
      queryMountDir: '/query',
      queryScriptPath: '/awf/query-script.py',
      queryUid: 65534,
      queryGid: 65534,
      queryImage: resolveScriptImage(imageConfig, script.image).imageRef,
      maxScriptBytes: script.maxScriptBytes,
      containerPrefix: 'awf-enclave-script',
    };
  }
  const agent = config.enclaves!.executors.agent!;
  const githubEnabled = isEnclaveAgentGithubToolsEnabled(agent);
  const gateway = isEnclaveAgentGithubRouteEnabled(agent)
    ? resolveEnclaveGithubGatewayContract(config) : undefined;
  return {
    ...common,
    hostSeedsDir: agent.dynamic ? undefined : toDaemonVisiblePath(paths.seedsDir, config.dockerHostPathPrefix),
    enclaveSeccompPath: seccompPath,
    enclaveMountDir: '/agent',
    enclaveSeedPath: '/awf/seed',
    enclaveTaskPath: '/awf/task.txt',
    enclaveSchemaPath: '/awf/schema.json',
    enclaveUid: 65534,
    enclaveGid: 65534,
    enclaveHostname: 'enclave-agent',
    enclaveImage: resolveAgentImage(imageConfig, agent.image).imageRef,
    engine: agent.engine,
    profile: agent.profile,
    model: agent.model,
    apiEndpoint: `http://${ENCLAVE_AGENT_API_PROXY_IP}:${resolveEnclaveAgentApiPort(agent.engine, agent.profile)}`,
    network: ENCLAVE_AGENT_NETWORK,
    maxPromptBytes: agent.maxTaskBytes,
    maxModelRequests: agent.maxModelRequests,
    maxModelTokens: agent.maxModelTokens,
    modelBudgetSecret: getOrCreateEnclaveModelBudgetSecret(config),
    githubEnabled,
    githubProfile: githubEnabled ? 'issues-read-v1' : undefined,
    githubMcpUrl: githubEnabled ? ENCLAVE_GITHUB_MCP_INTERNAL_URL : undefined,
    githubGatewayContainer: gateway?.containerName,
    enclaveGithubAgentIdPath: '/run/awf-enclave-github/agent-id',
    dynamicEnabled: agent.dynamic !== undefined,
    dynamicSensitivity: agent.dynamic?.sensitivity,
    dynamicGithubMcpUrl: agent.dynamic ? ENCLAVE_GITHUB_MCP_INTERNAL_URL : undefined,
    enclaveGithubBearerPath: '/run/awf-enclave-github/bearer',
    containerPrefix: 'awf-enclave-agent',
  };
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
  modelBudgetSecret?: string;
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
  environment.AWF_ENCLAVE_PROXY_DIAGNOSTICS = '1';
  if (params.modelBudgetSecret !== undefined) {
    environment.AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET = params.modelBudgetSecret;
    service.healthcheck = {
      ...(service.healthcheck as Record<string, unknown>),
      test: [
        'CMD',
        'node',
        '-e',
        `fetch('http://localhost:${API_PROXY_HEALTH_PORT}/health').then(async response => { const health = await response.json(); if (!response.ok || health.model_budget_enforcement !== true) process.exit(1); }).catch(() => process.exit(1))`,
      ],
    };
  }
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
  const modelBudgetSecret = getOrCreateEnclaveModelBudgetSecret(config);
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
  const primaryBackend = resolvePrimaryRuntimeBackend(config.containerRuntime);
  const imageServiceHardening = { memLimit: '32m', pidsLimit: 16, cpuShares: 64 };
  // A dynamic-only entry stages no repository seed at all: no clone, no seed
  // catalog, no `/awf/seed` mount, and no staging credential anywhere in the
  // topology.
  const staticSeedsPresent = enclaves.privateRepos.length > 0;
  const dynamic = agent?.enabled ? agent.dynamic : undefined;
  const cloudHypervisorExecutor = (script?.enabled && script.runtime === 'cloud-hypervisor')
    || (agent?.enabled && agent.runtime === 'cloud-hypervisor');
  const containerExecutor = (script?.enabled && script.runtime !== 'cloud-hypervisor')
    || (agent?.enabled && agent.runtime !== 'cloud-hypervisor');
  const localExecutor = (script?.enabled && script.runtime === 'gvisor')
    || (agent?.enabled && agent.runtime === 'gvisor');
  const hostExecutor = cloudHypervisorExecutor
    || (script?.enabled && script.runtime === 'docker')
    || (agent?.enabled && agent.runtime === 'docker');
  if (cloudHypervisorExecutor && containerExecutor) {
    throw new Error('Cloud Hypervisor enclaves cannot be mixed with container enclave runtimes');
  }
  if (hostExecutor && localExecutor) {
    throw new Error('Docker and gVisor enclaves cannot share a broker; one workload backend is required per run');
  }
  if (cloudHypervisorExecutor && ((script?.enabled && script.image !== undefined)
    || (agent?.enabled && (agent.image !== undefined || agent.dynamic !== undefined)))) {
    throw new Error('Cloud Hypervisor enclaves require static entries and release-attested artifacts');
  }

  const environment: Record<string, string> = {
    AWF_ENCLAVE_PRIMARY_BACKEND: primaryBackend,
    AWF_ENCLAVE_HOST_WORK_DIR: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
    AWF_ENCLAVE_CAPABILITY_PATH: ENCLAVE_SERVER_CAPABILITY_PATH,
    AWF_ENCLAVE_LISTEN_HOST: '0.0.0.0',
    AWF_ENCLAVE_SCRIPT_ENABLED: String(script?.enabled === true),
    AWF_ENCLAVE_AGENT_ENABLED: String(agent?.enabled === true),
    AWF_ENCLAVE_SEED_MAP_ENABLED: String(staticSeedsPresent),
    AWF_ENCLAVE_RUN_ID: readEnclaveRunId(paths) ?? '',
    ...(config.maxNumToolCalls !== undefined && {
      AWF_ENCLAVE_MAX_TOOL_CALLS: String(config.maxNumToolCalls),
    }),
  };
  const dependsOn: Record<string, Record<string, string>> = {};
  const result: EnclaveMcpBuildResult = { service: {} };

  if (script?.enabled) {
    if (script.runtime !== 'cloud-hypervisor') {
      const { imageRef, source } = resolveScriptImage(imageConfig, script.image);
      result.scriptImageService = {
        ...source,
        network_mode: 'none',
        entrypoint: ['/bin/true'],
        ...buildContainerSecurityHardening(imageServiceHardening),
        restart: 'no',
      };
      dependsOn['enclave-script-image'] = { condition: 'service_completed_successfully' };
      environment.AWF_ENCLAVE_IMAGE = imageRef;
    }
    Object.assign(environment, {
      ...(script.runtime !== 'gvisor' && { AWF_ENCLAVE_ENTRY_ID: 'script' }),
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
    const githubEnabled = isEnclaveAgentGithubToolsEnabled(agent);
    const githubGatewayContract = isEnclaveAgentGithubRouteEnabled(agent)
      ? resolveEnclaveGithubGatewayContract(config)
      : undefined;
    if (agent.runtime !== 'cloud-hypervisor') {
      const { imageRef, source } = resolveAgentImage(imageConfig, agent.image);
      if (!imageConfig.useGHCR && !agent.image) {
        result.toolchainImageService = {
          image: 'awf-enclave-build-tools:local',
          build: { context: `${imageConfig.projectRoot}/containers/build-tools` },
          network_mode: 'none',
          entrypoint: ['/bin/true'],
          ...buildContainerSecurityHardening(imageServiceHardening),
          restart: 'no',
        };
      }
      result.agentImageService = {
        ...source,
        network_mode: 'none',
        entrypoint: ['/bin/true'],
        ...buildContainerSecurityHardening(imageServiceHardening),
        restart: 'no',
      };
      dependsOn['enclave-agent-image'] = { condition: 'service_completed_successfully' };
      environment.AWF_ENCLAVE_AGENT_IMAGE = imageRef;
    }
    dependsOn['enclave-agent-api-proxy'] = { condition: 'service_healthy' };
    result.agentApiProxyService = buildAgentApiProxyService({
      config,
      imageConfig,
      networkConfig: params.networkConfig,
      apiProxyLogsPath: paths.apiProxyLogsDir,
      engine: agent.engine,
      profile: agent.profile,
      modelBudgetSecret,
    });
    const apiPort = resolveEnclaveAgentApiPort(agent.engine, agent.profile);
    Object.assign(environment, {
      ...(agent.runtime !== 'gvisor' && { AWF_ENCLAVE_AGENT_ENTRY_ID: 'agent' }),
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
      AWF_ENCLAVE_AGENT_GITHUB_ENABLED: String(githubEnabled),
      ...(githubEnabled && {
        AWF_ENCLAVE_AGENT_GITHUB_PROFILE: 'issues-read-v1',
        AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: ENCLAVE_GITHUB_MCP_INTERNAL_URL,
        AWF_ENCLAVE_AGENT_GITHUB_AGENT_ID_PATH: ENCLAVE_SERVER_GITHUB_AGENT_ID_PATH,
        AWF_ENCLAVE_AGENT_GITHUB_GATEWAY_CONTAINER: githubGatewayContract?.containerName,
      }),
      ...(dynamic !== undefined && {
        // The broker advertises and dispatches only enclave_run_agent for a
        // dynamic entry, and reaches AWF's host-side admission authority
        // through the private channel below. It never receives the control
        // endpoint, the control capability, an identity handle, the compiler
        // envelope, mcpg's state path, or its policy generation.
        AWF_ENCLAVE_AGENT_DYNAMIC_ENABLED: 'true',
        AWF_ENCLAVE_AGENT_DYNAMIC_CHANNEL_DIR: ENCLAVE_SERVER_DELEGATION_CHANNEL_DIR,
        AWF_ENCLAVE_AGENT_DYNAMIC_SENSITIVITY: dynamic.sensitivity,
        AWF_ENCLAVE_AGENT_DYNAMIC_GITHUB_MCP_URL: ENCLAVE_GITHUB_MCP_INTERNAL_URL,
        AWF_ENCLAVE_AGENT_GITHUB_GATEWAY_CONTAINER: githubGatewayContract?.containerName,
      }),
      ...(agent.maxModelRequests !== undefined && {
        AWF_ENCLAVE_AGENT_MAX_MODEL_REQUESTS: String(agent.maxModelRequests),
      }),
      ...(agent.maxModelTokens !== undefined && {
        AWF_ENCLAVE_AGENT_MAX_MODEL_TOKENS: String(agent.maxModelTokens),
      }),
      ...(modelBudgetSecret !== undefined && agent.runtime === 'gvisor' && {
        AWF_ENCLAVE_AGENT_MODEL_BUDGET_SECRET: modelBudgetSecret,
      }),
      // Enclave bind-mount sources are handed to the daemon, not opened by the
      // server, so they must be daemon-visible paths.
      AWF_ENCLAVE_AGENT_HOST_WORK_DIR: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
      ...(staticSeedsPresent && {
        AWF_ENCLAVE_AGENT_HOST_SEEDS_DIR: toDaemonVisiblePath(
          paths.seedsDir,
          config.dockerHostPathPrefix,
        ),
      }),
    });
  }

  const serverVolumes = [
    ...(localExecutor ? [`${paths.workDir}:${ENCLAVE_SERVER_WORK_DIR}:rw`] : []),
    localExecutor
      ? `${paths.runDir}:${ENCLAVE_SERVER_CAPABILITY_DIR}:ro`
      : `${paths.capabilityPath}:${ENCLAVE_SERVER_CAPABILITY_PATH}:ro`,
    `${paths.controlDir}:${ENCLAVE_SERVER_CONTROL_DIR}:rw`,
    `${paths.auditDir}:${ENCLAVE_SERVER_AUDIT_DIR}:rw`,
  ];
  if (hostExecutor) {
    serverVolumes.push(
      `${paths.hostExecutorDir}:${ENCLAVE_SERVER_HOST_EXECUTOR_DIR}:ro`,
    );
  }
  if (!script?.enabled || script.runtime !== 'gvisor') delete environment.AWF_ENCLAVE_HOST_WORK_DIR;
  if (!agent?.enabled || agent.runtime !== 'gvisor') {
    delete environment.AWF_ENCLAVE_AGENT_HOST_WORK_DIR;
    delete environment.AWF_ENCLAVE_AGENT_HOST_SEEDS_DIR;
    delete environment.AWF_ENCLAVE_AGENT_DYNAMIC_CHANNEL_DIR;
    delete environment.AWF_ENCLAVE_AGENT_GITHUB_AGENT_ID_PATH;
  }
  if (localExecutor) {
    serverVolumes.push(`${dockerSocketPath}:${ENCLAVE_SERVER_DOCKER_SOCKET_PATH}:rw`);
  }
  if (staticSeedsPresent) {
    serverVolumes.push(`${paths.seedMapPath}:${ENCLAVE_SERVER_SEED_MAP_PATH}:ro`);
    if (localExecutor) serverVolumes.push(`${paths.seedsDir}:${ENCLAVE_SERVER_SEEDS_DIR}:ro`);
  }
  if (dynamic !== undefined && agent?.runtime === 'gvisor') {
    serverVolumes.push(
      `${paths.delegationChannelDir}:${ENCLAVE_SERVER_DELEGATION_CHANNEL_DIR}:rw`,
    );
  }
  if (isEnclaveAgentGithubToolsEnabled(agent) && agent?.runtime === 'gvisor') {
    serverVolumes.push(
      `${paths.githubAgentIdPath}:${ENCLAVE_SERVER_GITHUB_AGENT_ID_PATH}:ro`,
    );
  }

  result.service = {
    container_name: ENCLAVE_MCP_SERVER_CONTAINER_NAME,
    ...resolveServerImage(imageConfig),
    networks: {
      [ENCLAVE_MCP_CONTROL_NETWORK]: {
        aliases: [ENCLAVE_MCP_CONTROL_ALIAS],
      },
    },
    volumes: applyHostPathPrefixToVolumes(serverVolumes, config.dockerHostPathPrefix),
    environment,
    depends_on: dependsOn,
    healthcheck: {
      test: ['CMD', 'node', '/opt/awf/enclave/mcp-server/healthcheck.js'],
      interval: '5s',
      timeout: '3s',
      retries: 10,
      start_period: '20s',
    },
    ...buildContainerSecurityHardening({ memLimit: '1g', pidsLimit: 100, cpuShares: 256 }),
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
