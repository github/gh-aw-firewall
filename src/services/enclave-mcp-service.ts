import * as path from 'path';
import {
  ENCLAVE_MCP_SERVER_CONTAINER_NAME,
  LOCAL_ENCLAVE_MCP_SERVER_IMAGE,
} from '../constants';
import type { WrapperConfig } from '../types';
import {
  isEnclaveAgentGithubRouteEnabled,
  isEnclaveAgentGithubToolsEnabled,
  resolveEnclaveAgentApiPort,
} from '../types/enclave-options';
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
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_NETWORK,
  ENCLAVE_MCP_CONTROL_ALIAS,
  ENCLAVE_MCP_CONTROL_NETWORK,
} from '../enclave/network';
import { resolvePrimaryRuntimeBackend } from '../enclave/runtime-preflight';
import { resolveDockerSocketPath } from './agent-volumes/docker-socket';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';
import type { ImageBuildConfig, NetworkConfig } from './squid-service';
import { buildRuntimeImageRef } from '../image-tag';
import {
  ENCLAVE_GITHUB_MCP_INTERNAL_URL,
  resolveEnclaveGithubGatewayContract,
} from '../enclave/github-gateway';
import { getOrCreateEnclaveModelBudgetSecret } from '../enclave/model-budget-capability';
import {
  resolveEnclaveMcpExecutorTopology,
  validateEnclaveMcpExecutors,
} from './enclave-mcp-executor-topology';
import {
  buildEnclaveMcpScriptService,
  ENCLAVE_SCRIPT_IMAGE_NAME,
  LOCAL_ENCLAVE_SCRIPT_IMAGE,
  resolveScriptImage,
} from './enclave-mcp-script-service';
import {
  buildEnclaveMcpAgentService,
  ENCLAVE_AGENT_IMAGE_NAME,
  LOCAL_ENCLAVE_AGENT_IMAGE,
  resolveAgentImage,
} from './enclave-mcp-agent-service';

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

export function buildEnclaveMcpService(params: EnclaveMcpServiceParams): EnclaveMcpBuildResult {
  const { config, imageConfig } = params;
  const enclaves = config.enclaves;
  const script = enclaves?.executors.script;
  const agent = enclaves?.executors.agent;
  const modelBudgetSecret = getOrCreateEnclaveModelBudgetSecret(config);
  const enabledEnclaves = validateEnclaveMcpExecutors(config);

  const paths = resolveEnclavePaths(config.workDir);
  const dockerSocketPath = resolveDockerSocketPath(config);
  const primaryBackend = resolvePrimaryRuntimeBackend(config.containerRuntime);
  // A dynamic-only entry stages no repository seed at all: no clone, no seed
  // catalog, no `/awf/seed` mount, and no staging credential anywhere in the
  // topology.
  const staticSeedsPresent = enabledEnclaves.privateRepos.length > 0;
  const dynamic = agent?.enabled ? agent.dynamic : undefined;
  const { localExecutor, hostExecutor } = resolveEnclaveMcpExecutorTopology(script, agent);

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
    buildEnclaveMcpScriptService({ script, imageConfig, environment, dependsOn, result });
  }

  if (agent?.enabled) {
    buildEnclaveMcpAgentService({
      config,
      agent,
      imageConfig,
      networkConfig: params.networkConfig,
      apiProxyLogsPath: paths.apiProxyLogsDir,
      hostWorkDir: toDaemonVisiblePath(paths.workDir, config.dockerHostPathPrefix),
      hostSeedsDir: staticSeedsPresent
        ? toDaemonVisiblePath(paths.seedsDir, config.dockerHostPathPrefix) : undefined,
      modelBudgetSecret,
      environment,
      dependsOn,
      result,
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
