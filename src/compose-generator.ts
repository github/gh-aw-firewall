import * as fs from 'fs';
import * as path from 'path';
import { DockerComposeConfig, WrapperConfig } from './types';
import { DEFAULT_DNS_SERVERS } from './dns-resolver';
import { parseImageTag } from './image-tag';
import { resolveRuntimeImage, validateCustomImageManifest } from './image-resolver';
import { SslConfig } from './host-env';
import { getRealUserHome } from './host-identity';
import { resolveLogPaths } from './log-paths';
import { redactComposeServiceEnvironment } from './compose-sanitizer';
import { buildSquidService } from './services/squid-service';
import { buildAgentEnvironment, buildAgentVolumes, buildAgentService } from './services/agent-service';
import { isolateTrustedServiceEnvironment } from './trusted-service';
import { assembleOptionalServices, filterAgentVolumesForSysroot } from './services/optional-services';
import { buildComposeNetworks } from './compose-network';
import { runtimeNeedsStaticDns, runtimeUsesComposeAgent } from './container-runtime';
import { API_PROXY_PORTS } from './types/ports';
import { EXTERNAL_BRIDGE_NAME } from './config/network-policy';
import {
  ENCLAVE_AGENT_EGRESS_NETWORK,
  ENCLAVE_AGENT_NETWORK,
  ENCLAVE_AGENT_SUBNET,
  ENCLAVE_MCP_CONTROL_NETWORK,
} from './enclave/network';
import { buildInternalServiceHosts } from './services/internal-service-hosts';
import { filterComposeCapDrop } from './capability-filter';
import { ROUTING_NETWORK_NAME } from './services/router-service';
import {
  GEMINI_SETTINGS_MOUNT,
  GEMINI_SETTINGS_VOLUME,
} from './services/gemini-settings-service';
import {
  isGeminiProxyRoutingEnabled,
  shouldPinGeminiAuthType,
  GEMINI_CLI_SYSTEM_SETTINGS_DIRECTORY,
} from './services/credentials/gemini-cli-settings';

/**
 * Generates Docker Compose configuration
 * Note: Uses external network 'awf-net' created by host-iptables setup
 */
export function generateDockerCompose(
  config: WrapperConfig,
  networkConfig: { subnet: string; squidIp: string; agentIp: string; proxyIp?: string; dohProxyIp?: string; cliProxyIp?: string },
  sslConfig?: SslConfig,
  squidConfigContent?: string,
  options: {
    effectiveHome?: string;
    pathExists?: (candidate: string) => boolean;
    prepareNestedMountpoints?: (
      volumes: string[],
      uid: number,
      gid: number,
      localSourceResolver: (source: string) => string | undefined,
    ) => string[];
  } = {},
): DockerComposeConfig {
  validateCustomImageManifest(config);
  const projectRoot = path.join(__dirname, '..');

  // Guard: --build-local requires full repo checkout (not available in standalone bundle)
  if (config.buildLocal) {
    const containersDir = path.join(projectRoot, 'containers');
    if (!fs.existsSync(containersDir)) {
      throw new Error(
        'The --build-local flag requires a full repository checkout. ' +
        'It is not supported with the standalone bundle. ' +
        'Use the npm package or clone the repository instead.'
      );
    }
  }

  // Default to GHCR images unless buildLocal is explicitly set
  const useGHCR = !config.buildLocal;
  const registry = config.imageRegistry || 'ghcr.io/github/gh-aw-firewall';
  const parsedImageTag = parseImageTag(config.imageTag || 'latest');

  // Shared image build configuration passed to all service builders
  const imageConfig = {
    useGHCR,
    registry,
    parsedTag: parsedImageTag,
    projectRoot,
    resolveImage: (name: import('./image-resolver').RuntimeImageName) =>
      resolveRuntimeImage(config, name, registry, parsedImageTag),
  };

  // ── Log / state paths ──────────────────────────────────────────────────────

  const logPaths = resolveLogPaths(config);
  const { squidLogs: squidLogsPath } = logPaths;

  // ── Init-signal directory path ─────────────────────────────────────────────
  //
  // The directory is created by prepareWorkDirectories (workdir-setup.ts)
  // during Phase 2 of writeConfigs, before generateDockerCompose is called.
  // Here we only derive the path so it can be forwarded into optional service assembly.

  const initSignalDir = path.join(config.workDir, 'init-signal');

  // ── DNS servers ────────────────────────────────────────────────────────────

  const dnsServers = config.dnsServers || DEFAULT_DNS_SERVERS;

  // ── Squid service ──────────────────────────────────────────────────────────

  const squidService = buildSquidService({
    config,
    networkConfig,
    sslConfig,
    squidConfigContent,
    squidLogsPath,
    imageConfig,
  });

  // ── Agent environment, volumes, and service ────────────────────────────────

  const environment = buildAgentEnvironment({
    config,
    networkConfig,
    dnsServers,
    sslConfig,
  });

  const effectiveHome = options.effectiveHome ?? getRealUserHome();
  const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
  const stageGeminiSettings = isGeminiProxyRoutingEnabled(config) && shouldPinGeminiAuthType(config);

  const agentVolumes = buildAgentVolumes({
    config,
    internalServiceHosts: runtimeNeedsStaticDns(config.containerRuntime)
      ? buildInternalServiceHosts({
          squidIp: networkConfig.squidIp,
          apiProxyIp: networkConfig.proxyIp,
          cliProxyIp: networkConfig.cliProxyIp,
        })
      : undefined,
    sslConfig,
    projectRoot,
    effectiveHome,
    workspaceDir,
    agentLogsPath: logPaths.agentLogs,
    sessionStatePath: logPaths.sessionState,
    initSignalDir,
    pathExists: options.pathExists,
    prepareNestedMountpoints: options.prepareNestedMountpoints,
    additionalMounts: stageGeminiSettings ? [GEMINI_SETTINGS_MOUNT] : [],
    nestedMountpointOptions: stageGeminiSettings ? {
      directoryVolumeSources: [GEMINI_SETTINGS_VOLUME],
      rootOwnedTargets: [`/host${GEMINI_CLI_SYSTEM_SETTINGS_DIRECTORY}`],
    } : undefined,
    filterVolumes: config.runnerTopology === 'arc-dind'
      ? volumes => filterAgentVolumesForSysroot(volumes, config, effectiveHome)
      : undefined,
  });

  const agentService = buildAgentService({
    config,
    networkConfig,
    environment,
    agentVolumes,
    dnsServers,
    imageConfig,
  });

  // ── Assemble base services ─────────────────────────────────────────────────
  // For microVM backends (e.g. sbx), the agent is NOT a compose service —
  // it's launched externally.  We still build the agent service object so that
  // optional-services can wire depends_on edges for infra containers, but we
  // omit it from the final compose output.
  const includeAgent = runtimeUsesComposeAgent(config.containerRuntime);

  const services: Record<string, any> = {
    'squid-proxy': squidService,
    ...(includeAgent ? { 'agent': agentService } : {}),
  };

  // ── Insert optional sidecars and wire depends_on edges ────────────────────

  const { namedVolumes } = assembleOptionalServices({
    services,
    agentService,
    agentVolumes,
    environment,
    includeComposeAgent: includeAgent,
    config,
    networkConfig,
    imageConfig,
    logPaths,
    initSignalDir,
    effectiveHome,
  });
  isolateTrustedServiceEnvironment(config, environment);

  // ── Publish infra ports for microVM runtimes ───────────────────────────────
  // When the agent runs in a microVM (e.g. sbx), it can't reach Docker-internal
  // IPs (172.30.0.x).  Publish api-proxy ports to the host so the microVM can
  // reach them via its gateway IP.  (Squid already has ports published.)
  //
  // In network-isolation mode the internal network blocks host→container traffic,
  // so we also attach api-proxy to the external bridge (`awf-ext`) — same as
  // Squid — so published ports are reachable from outside Docker.
  if (!includeAgent && services['api-proxy']) {
    const proxyService = services['api-proxy'];
    if (!proxyService.ports) {
      proxyService.ports = [];
    }
    for (const port of Object.values(API_PROXY_PORTS)) {
      proxyService.ports.push(`${port}:${port}`);
    }
    // Attach to external network so port publishing works with internal awf-net
    if (config.networkIsolation) {
      proxyService.networks = {
        ...(proxyService.networks || {}),
        [EXTERNAL_BRIDGE_NAME]: {},
      };
    }
  }

  // ── Assemble and return the compose result ─────────────────────────────────

  const compose = buildComposeNetworks({
    services,
    squidService,
    agentService,
    networkIsolation: !!config.networkIsolation,
    networkConfig,
    namedVolumes,
  });
  if (config.enclaves?.enabled && config.enclaves.executors.agent.enabled) {
    // Dedicated `internal` network whose only members are unified-enclave
    // agent enclaves and the dual-homed dedicated API proxy. An explicit
    // `name:` is required because the enclave MCP server launches enclaves
    // with a fixed `docker run --network <name>` argument and must not have to
    // derive a Compose project prefix at runtime.
    compose.networks[ENCLAVE_AGENT_NETWORK] = {
      name: ENCLAVE_AGENT_NETWORK,
      driver: 'bridge',
      internal: true,
      ipam: {
        config: [{ subnet: ENCLAVE_AGENT_SUBNET }],
      },
    };
    // Only the dedicated credential sidecar joins this bridge. It receives
    // direct upstream egress while enclaves remain confined to the internal
    // network and the primary agent cannot observe its metrics or state.
    compose.networks[ENCLAVE_AGENT_EGRESS_NETWORK] = {
      name: ENCLAVE_AGENT_EGRESS_NETWORK,
      driver: 'bridge',
    };
  }
  if (config.enclaves?.enabled) {
    compose.networks[ENCLAVE_MCP_CONTROL_NETWORK] = {
      name: ENCLAVE_MCP_CONTROL_NETWORK,
      driver: 'bridge',
      internal: true,
    };
  }
  if (config.experimentalModelRouting === true && config.modelRouting && config.modelRoutingBootstrap) {
    compose.networks[ROUTING_NETWORK_NAME] = {
      name: ROUTING_NETWORK_NAME,
      driver: 'bridge',
      internal: true,
    };
  }
  return filterComposeCapDrop(compose);
}

/**
 * Redacts environment values by default from a Docker Compose config for audit logging.
 *
 * @param compose - Compose config to redact (not mutated).
 */
export function redactDockerComposeSecrets(compose: DockerComposeConfig): DockerComposeConfig {
  const redacted = JSON.parse(JSON.stringify(compose)) as DockerComposeConfig;

  for (const service of Object.values(redacted.services)) {
    redactComposeServiceEnvironment(service);
  }

  return redacted;
}
