import { WrapperConfig } from '../types';
import { LogPaths } from '../log-paths';
import { logger } from '../logger';
import { buildIptablesInitService } from './agent-service';
import { buildApiProxyService } from './api-proxy-service';
import { buildDohProxyService } from './doh-proxy-service';
import { buildCliProxyService } from './cli-proxy-service';
import { buildSysrootStageService, isSysrootEnabled } from './sysroot-service';
import { resolveDockerHostGateway } from './host-gateway';
import { runtimeUsesIptables } from '../container-runtime';
import { NetworkConfig, ImageBuildConfig } from './squid-service';

interface AssembleOptionalServicesParams {
  services: Record<string, any>;
  agentService: any;
  agentVolumes: string[];
  environment: Record<string, string>;
  includeComposeAgent?: boolean;
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  imageConfig: ImageBuildConfig;
  logPaths: LogPaths;
  initSignalDir: string;
  effectiveHome: string;
}

interface AssembleOptionalServicesResult {
  namedVolumes: Record<string, any> | undefined;
}

function presetSidecarIpEnvVars(
  environment: Record<string, string>,
  config: WrapperConfig,
  networkConfig: NetworkConfig,
): void {
  if (config.enableApiProxy && networkConfig.proxyIp) {
    environment.AWF_API_PROXY_IP = networkConfig.proxyIp;
  }

  if (config.difcProxyHost && networkConfig.cliProxyIp) {
    environment.AWF_CLI_PROXY_IP = networkConfig.cliProxyIp;
  }

  if (config.networkIsolation) {
    // Tell the agent entrypoint to skip the iptables-init handshake.
    environment.AWF_NETWORK_ISOLATION = '1';
  }

  if (!runtimeUsesIptables(config.containerRuntime)) {
    // Runtimes whose network stack can't be governed by host-netns iptables
    // (e.g. gVisor's isolated netstack) have no iptables-init container, so the
    // ready-file handshake would never complete.  Tell the entrypoint to skip it.
    environment.AWF_SKIP_IPTABLES_INIT = '1';
  }
}

function filterAgentVolumesForSysroot(
  agentVolumes: string[],
  config: WrapperConfig,
  effectiveHome: string,
): string[] {
  const sysrootShadowedTargets = new Set([
    '/host/usr',
    '/host/bin',
    '/host/sbin',
    '/host/lib',
    '/host/lib64',
    '/host/opt',
  ]);
  const normalizedWorkDirPrefix = config.workDir.replace(/\/+$/, '');
  const hostHomeMountPrefix = `/host${effectiveHome}`;

  return agentVolumes.filter(volume => {
    const parts = volume.split(':');
    if (parts.length < 2) return true; // Keep malformed entries unchanged
    const source = parts[0];
    const target = parts[1];

    // Drop sysroot-shadowed targets (system binaries provided by volume)
    if (sysrootShadowedTargets.has(target)) return false;

    // Drop mounts sourced from AWF workDir (runner's unshared /tmp/awf-*).
    // Matches: the workDir itself, paths under it (`workDir/…`), and the known
    // sibling pattern `workDir-…` (e.g. `${workDir}-chroot-home`).  Using three
    // explicit conditions avoids dropping unrelated bind mounts when workDir is
    // configured to a short or non-unique prefix.
    if (
      source === normalizedWorkDirPrefix ||
      source.startsWith(normalizedWorkDirPrefix + '/') ||
      source.startsWith(normalizedWorkDirPrefix + '-')
    ) {
      return false;
    }
    // Drop home dot-directory mounts (e.g. .cache, .config) — sysroot provides them.
    // Keep workspace/work paths (e.g. _work/_temp/gh-aw) since those are user-supplied
    // custom mounts or tool-cache mounts that the sysroot doesn't provide.
    if (source.startsWith(effectiveHome) && target.startsWith(hostHomeMountPrefix)) {
      const normalizedSource = source.replace(/\/+$/, '') || '/';
      const relPath = normalizedSource.slice(effectiveHome.length);
      if (relPath.startsWith('/.') || relPath === '') return false;
    }

    return true;
  });
}

function assembleSysrootService(
  params: AssembleOptionalServicesParams,
  registry: string,
  parsedTag: import('../image-tag').ParsedImageTag,
  sysrootActive: boolean,
): void {
  if (!sysrootActive) return;

  const { services, agentService, agentVolumes, config, effectiveHome } = params;

  // On split-fs ARC/DinD, the Docker daemon cannot see the runner's
  // filesystem paths. Filter out bind mounts the daemon can't resolve:
  //  - Source under workDir (runner's unshared /tmp/awf-*): daemon can't see it
  //  - Source under effectiveHome with target under /host: sysroot volume provides these
  //  - Sysroot-shadowed targets: system binaries already in the sysroot volume
  // Keep: /tmp:/tmp (daemon has its own), /dev/null overlays, /dev and /sys
  //       (kernel VFS), workspace mounts (ARC shares workspace with daemon).
  const filteredVolumes = filterAgentVolumesForSysroot(agentVolumes, config, effectiveHome);
  agentVolumes.length = 0;
  agentVolumes.push(...filteredVolumes);

  const sysrootService = buildSysrootStageService({
    config,
    registry,
    parsedTag,
  });
  services['sysroot-stage'] = sysrootService;

  // Agent waits for sysroot copy to complete before starting
  agentService.depends_on['sysroot-stage'] = {
    condition: 'service_completed_successfully',
  };

  // Warn if tool cache is under /opt (invisible to the DinD daemon)
  const toolCachePath = config.runnerToolCachePath || process.env.RUNNER_TOOL_CACHE;
  if (!toolCachePath || toolCachePath.startsWith('/opt')) {
    logger.warn(
      'ARC/DinD: RUNNER_TOOL_CACHE is ' +
      (toolCachePath ? `under /opt (${toolCachePath})` : 'not set') +
      ', which is invisible to the DinD daemon. ' +
      'Redirect it to a shared volume path (e.g. /tmp/gh-aw/tool-cache) ' +
      'so setup-* action outputs are available inside the agent container.',
    );
  }
}

function assembleIptablesInitService(
  params: AssembleOptionalServicesParams,
  skipIptables: boolean,
): void {
  if (skipIptables) return;

  const { services, agentService, environment, config, networkConfig, initSignalDir } = params;

  // Resolve the host-gateway IP so the init container can create NAT bypass
  // rules for host.docker.internal traffic.  The init container cannot resolve
  // this itself because Docker rejects extra_hosts on containers using
  // network_mode: service:agent.
  const hostGatewayIp = config.enableHostAccess ? resolveDockerHostGateway() : undefined;

  const iptablesInitService = buildIptablesInitService({
    agentService,
    environment,
    networkConfig,
    initSignalDir,
    dockerHostPathPrefix: config.dockerHostPathPrefix,
    hostGatewayIp,
  });
  services['iptables-init'] = iptablesInitService;
}

function assembleApiProxyService(params: AssembleOptionalServicesParams): void {
  const { services, agentService, environment, config, networkConfig, imageConfig, logPaths } = params;
  const { apiProxyLogs: apiProxyLogsPath } = logPaths;

  if (!config.enableApiProxy || !networkConfig.proxyIp) return;

  const { service: proxyService, agentEnvAdditions } = buildApiProxyService({
    config,
    networkConfig,
    apiProxyLogsPath,
    imageConfig,
  });

  services['api-proxy'] = proxyService;
  Object.assign(environment, agentEnvAdditions);
  agentService.depends_on['api-proxy'] = {
    condition: 'service_healthy',
  };
}

function assembleDohProxyService(params: AssembleOptionalServicesParams): void {
  const { services, agentService, config, networkConfig } = params;

  if (!config.dnsOverHttps || !networkConfig.dohProxyIp) return;

  const dohService = buildDohProxyService({ config, networkConfig });
  services['doh-proxy'] = dohService;
  agentService.depends_on['doh-proxy'] = {
    condition: 'service_healthy',
  };
}

function assembleCliProxyService(params: AssembleOptionalServicesParams): void {
  const { services, agentService, environment, config, networkConfig, imageConfig, logPaths } = params;
  const { cliProxyLogs: cliProxyLogsPath } = logPaths;

  if (!config.difcProxyHost || !networkConfig.cliProxyIp) return;

  const { service: cliService, agentEnvAdditions } = buildCliProxyService({
    config,
    networkConfig,
    cliProxyLogsPath,
    imageConfig,
  });

  services['cli-proxy'] = cliService;
  Object.assign(environment, agentEnvAdditions);
  agentService.depends_on['cli-proxy'] = {
    condition: 'service_healthy',
  };
}

function finalizeSysrootVolumes(
  agentVolumes: string[],
  sysrootActive: boolean,
): Record<string, any> | undefined {
  if (!sysrootActive) return undefined;
  agentVolumes.push('sysroot:/host:rw');
  return { sysroot: {} };
}

/**
 * Inserts all optional sidecar services into `services`, wires `depends_on`
 * edges on `agentService`, and mutates `environment` with any env-var additions
 * required by those sidecars.
 *
 * Environment pre-sets (AWF_API_PROXY_IP, AWF_CLI_PROXY_IP) are applied before
 * the iptables-init service is constructed so that the init container's
 * environment object — which is captured at definition time — already contains
 * the correct values.
 *
 * @returns namedVolumes — the Docker Compose top-level `volumes` map, or
 *   `undefined` when no named volumes are required.
 */
export function assembleOptionalServices(
  params: AssembleOptionalServicesParams,
): AssembleOptionalServicesResult {
  const { agentVolumes, environment, config, networkConfig, imageConfig } = params;

  const networkIsolation = !!config.networkIsolation;
  const includeComposeAgent = params.includeComposeAgent !== false;
  const sysrootActive = isSysrootEnabled(config);

  // Skip the iptables-init container when egress isn't governed by host-netns
  // iptables — either topology-based network isolation, or a runtime whose
  // network stack can't use those rules (e.g. gVisor's isolated netstack).
  const skipIptables = networkIsolation || !runtimeUsesIptables(config.containerRuntime);

  presetSidecarIpEnvVars(environment, config, networkConfig);
  if (includeComposeAgent) {
    assembleSysrootService(params, imageConfig.registry, imageConfig.parsedTag, sysrootActive);
    assembleIptablesInitService(params, skipIptables);
  }
  assembleApiProxyService(params);
  assembleDohProxyService(params);
  assembleCliProxyService(params);

  const namedVolumes = includeComposeAgent
    ? finalizeSysrootVolumes(agentVolumes, sysrootActive)
    : undefined;
  return { namedVolumes };
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const testHelpers = {
  presetSidecarIpEnvVars,
  filterAgentVolumesForSysroot,
};
