import { ENCLAVE_AGENT_API_PROXY_CONTAINER_NAME } from '../constants';
import { API_PROXY_HEALTH_PORT, type WrapperConfig } from '../types';
import {
  isEnclaveAgentGithubRouteEnabled,
  isEnclaveAgentGithubToolsEnabled,
  resolveEnclaveAgentApiPort,
} from '../types/enclave-options';
import type {
  EnclaveAgentEngine,
  EnclaveAgentExecutorConfig,
  EnclaveAgentProfile,
} from '../types/enclave-options';
import {
  ENCLAVE_SERVER_DELEGATION_CHANNEL_DIR,
  ENCLAVE_SERVER_GITHUB_AGENT_ID_PATH,
} from '../enclave/paths';
import {
  ENCLAVE_AGENT_API_PROXY_ALIAS,
  ENCLAVE_AGENT_API_PROXY_IP,
  ENCLAVE_AGENT_EGRESS_NETWORK,
  ENCLAVE_AGENT_NETWORK,
} from '../enclave/network';
import {
  ENCLAVE_GITHUB_MCP_INTERNAL_URL,
  resolveEnclaveGithubGatewayContract,
} from '../enclave/github-gateway';
import {
  ANTHROPIC_ENV,
  COPILOT_ENV,
  GEMINI_ENV,
  OIDC_AUTH_ENV_VARS,
  OPENAI_ENV,
  VERTEX_ENV,
  FOUNDRY_ENV,
} from '../api-proxy-env-constants';
import { buildRuntimeImageRef } from '../image-tag';
import { buildApiProxyServiceConfig } from './api-proxy-service-config';
import type { EnclaveMcpBuildResult } from './enclave-mcp-service';
import { buildContainerSecurityHardening } from './service-security';
import type { ImageBuildConfig, NetworkConfig } from './squid-service';

export const LOCAL_ENCLAVE_AGENT_IMAGE = 'awf-enclave-agent:local';
export const ENCLAVE_AGENT_IMAGE_NAME = 'enclave-agent';

export function resolveAgentImage(
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
    config: {
      ...params.config,
      openaiTrustedService: undefined,
      anthropicTrustedService: undefined,
    },
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
  environment.AWF_ENCLAVE_AGENT_PROXY = '1';
  // Enclave shell requests must not inherit the primary agent's hosted-web access.
  environment.AWF_CODEX_HOSTED_WEB_POLICY = '{"enabled":false}';
  environment.AWF_CLAUDE_HOSTED_WEB_POLICY = '{"enabled":false}';
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
  for (const key of [
    FOUNDRY_ENV.KEY,
    FOUNDRY_ENV.ENTRA_TOKEN,
    FOUNDRY_ENV.TARGET,
    FOUNDRY_ENV.BASE_PATH,
  ]) {
    delete environment[key];
  }

  return service;
}

export function buildEnclaveMcpAgentService(params: {
  config: WrapperConfig;
  agent: EnclaveAgentExecutorConfig;
  imageConfig: ImageBuildConfig;
  networkConfig?: NetworkConfig;
  apiProxyLogsPath: string;
  hostWorkDir: string;
  hostSeedsDir?: string;
  modelBudgetSecret?: string;
  environment: Record<string, string>;
  dependsOn: Record<string, Record<string, string>>;
  result: EnclaveMcpBuildResult;
}): void {
  const { config, agent, imageConfig, environment, dependsOn, result, modelBudgetSecret } = params;
  if (!params.networkConfig) {
    throw new Error('buildEnclaveMcpService: the enclave agent executor requires network configuration');
  }
  const githubEnabled = isEnclaveAgentGithubToolsEnabled(agent);
  const githubGatewayContract = isEnclaveAgentGithubRouteEnabled(agent)
    ? resolveEnclaveGithubGatewayContract(config)
    : undefined;
  const dynamic = agent.dynamic;
  const imageServiceHardening = { memLimit: '32m', pidsLimit: 16, cpuShares: 64 };
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
    apiProxyLogsPath: params.apiProxyLogsPath,
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
    AWF_ENCLAVE_AGENT_HOST_WORK_DIR: params.hostWorkDir,
    ...(params.hostSeedsDir !== undefined && {
      AWF_ENCLAVE_AGENT_HOST_SEEDS_DIR: params.hostSeedsDir,
    }),
  });
}
