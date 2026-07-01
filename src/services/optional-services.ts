import { WrapperConfig } from '../types';
import { LogPaths } from '../log-paths';
import { logger } from '../logger';
import { buildIptablesInitService } from './agent-service';
import { buildApiProxyService } from './api-proxy-service';
import { buildDohProxyService } from './doh-proxy-service';
import { buildCliProxyService } from './cli-proxy-service';
import { buildSysrootStageService, isSysrootEnabled } from './sysroot-service';
import { resolveDockerHostGateway } from './host-gateway';
import { NetworkConfig, ImageBuildConfig } from './squid-service';

interface AssembleOptionalServicesParams {
  services: Record<string, any>;
  agentService: any;
  agentVolumes: string[];
  environment: Record<string, string>;
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
  const {
    services,
    agentService,
    agentVolumes,
    environment,
    config,
    networkConfig,
    imageConfig,
    logPaths,
    initSignalDir,
    effectiveHome,
  } = params;

  const { registry, parsedTag } = imageConfig;
  const { apiProxyLogs: apiProxyLogsPath, cliProxyLogs: cliProxyLogsPath } = logPaths;

  const networkIsolation = !!config.networkIsolation;
  const sysrootActive = isSysrootEnabled(config);

  // ── Pre-set proxy IPs in environment before the init container definition ──
  //
  // The iptables-init container's environment object captures values at
  // definition time, so AWF_API_PROXY_IP and AWF_CLI_PROXY_IP must be set
  // before buildIptablesInitService is called below.  Without this, the init
  // container gets empty values and setup-iptables.sh never adds the required
  // ACCEPT rules, blocking connectivity to those sidecars.

  if (config.enableApiProxy && networkConfig.proxyIp) {
    environment.AWF_API_PROXY_IP = networkConfig.proxyIp;
  }

  if (config.difcProxyHost && networkConfig.cliProxyIp) {
    environment.AWF_CLI_PROXY_IP = networkConfig.cliProxyIp;
  }

  if (networkIsolation) {
    // Tell the agent entrypoint to skip the iptables-init handshake.
    environment.AWF_NETWORK_ISOLATION = '1';
  }

  // ── Optional: sysroot-stage init container (ARC/DinD) ─────────────────────

  if (sysrootActive) {
    // On split-fs ARC/DinD, the Docker daemon cannot see the runner's
    // filesystem paths. Filter out bind mounts the daemon can't resolve:
    //  - Source under workDir (runner's unshared /tmp/awf-*): daemon can't see it
    //  - Source under effectiveHome with target under /host: sysroot volume provides these
    //  - Sysroot-shadowed targets: system binaries already in the sysroot volume
    // Keep: /tmp:/tmp (daemon has its own), /dev/null overlays, /dev and /sys
    //       (kernel VFS), workspace mounts (ARC shares workspace with daemon).
    const sysrootShadowedTargets = new Set([
      '/host/usr',
      '/host/bin',
      '/host/sbin',
      '/host/lib',
      '/host/lib64',
      '/host/opt',
    ]);
    const workDirPrefix = config.workDir;
    const hostHomeMountPrefix = `/host${effectiveHome}`;

    const filteredVolumes = agentVolumes.filter(volume => {
      const parts = volume.split(':');
      if (parts.length < 2) return true; // Keep malformed entries unchanged
      const source = parts[0];
      const target = parts[1];

      // Drop sysroot-shadowed targets (system binaries provided by volume)
      if (sysrootShadowedTargets.has(target)) return false;

      // Drop mounts sourced from AWF workDir (runner's unshared /tmp/awf-*)
      if (source.startsWith(workDirPrefix)) return false;

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
    agentVolumes.length = 0;
    agentVolumes.push(...filteredVolumes);

    const sysrootService = buildSysrootStageService({
      config,
      registry,
      imageTag: parsedTag.tag,
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

  // ── Optional: iptables-init service ───────────────────────────────────────
  //
  // In network-isolation (topology) mode there is no iptables enforcement, so
  // the init container is omitted entirely.

  if (!networkIsolation) {
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

  // ── Optional: API proxy sidecar ────────────────────────────────────────────

  if (config.enableApiProxy && networkConfig.proxyIp) {
    const { service: proxyService, agentEnvAdditions } = buildApiProxyService({
      config,
      networkConfig,
      apiProxyLogsPath,
      imageConfig,
    });

    services['api-proxy'] = proxyService;

    // Apply agent environment mutations from the api-proxy builder
    Object.assign(environment, agentEnvAdditions);

    // Update agent dependencies to wait for api-proxy
    agentService.depends_on['api-proxy'] = {
      condition: 'service_healthy',
    };
  }

  // ── Optional: DNS-over-HTTPS proxy sidecar ─────────────────────────────────

  if (config.dnsOverHttps && networkConfig.dohProxyIp) {
    const dohService = buildDohProxyService({ config, networkConfig });

    services['doh-proxy'] = dohService;

    // Update agent dependencies to also wait for doh-proxy
    agentService.depends_on['doh-proxy'] = {
      condition: 'service_healthy',
    };
  }

  // ── Optional: CLI proxy sidecar ────────────────────────────────────────────

  if (config.difcProxyHost && networkConfig.cliProxyIp) {
    const { service: cliService, agentEnvAdditions } = buildCliProxyService({
      config,
      networkConfig,
      cliProxyLogsPath,
      imageConfig,
    });

    services['cli-proxy'] = cliService;

    // Apply agent environment mutations from the cli-proxy builder
    Object.assign(environment, agentEnvAdditions);

    // Update agent dependencies to wait for cli-proxy
    agentService.depends_on['cli-proxy'] = {
      condition: 'service_healthy',
    };
  }

  // ── Sysroot named volume and agent volume mount ────────────────────────────
  //
  // The sysroot named volume provides most /host content (system binaries,
  // libs, etc.) via the sysroot-stage init container instead of per-directory
  // userspace bind mounts.

  const namedVolumes: Record<string, any> | undefined = sysrootActive
    ? { sysroot: {} }
    : undefined;

  if (sysrootActive) {
    agentVolumes.push('sysroot:/host:rw');
  }

  return { namedVolumes };
}
