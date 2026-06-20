import * as fs from 'fs';
import * as path from 'path';
import { DockerComposeConfig, WrapperConfig } from './types';
import { DEFAULT_DNS_SERVERS } from './dns-resolver';
import { parseImageTag } from './image-tag';
import { SslConfig } from './host-env';
import { getRealUserHome } from './host-identity';
import { resolveLogPaths } from './log-paths';
import { buildSquidService } from './services/squid-service';
import { buildAgentEnvironment, buildAgentVolumes, buildAgentService, buildIptablesInitService } from './services/agent-service';
import { buildApiProxyService } from './services/api-proxy-service';
import { buildDohProxyService } from './services/doh-proxy-service';
import { buildCliProxyService } from './services/cli-proxy-service';

/**
 * Generates Docker Compose configuration
 * Note: Uses external network 'awf-net' created by host-iptables setup
 */
export function generateDockerCompose(
  config: WrapperConfig,
  networkConfig: { subnet: string; squidIp: string; agentIp: string; proxyIp?: string; dohProxyIp?: string; cliProxyIp?: string },
  sslConfig?: SslConfig,
  squidConfigContent?: string
): DockerComposeConfig {
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
  const imageConfig = { useGHCR, registry, parsedTag: parsedImageTag, projectRoot };

  // ── Log / state paths ──────────────────────────────────────────────────────

  const logPaths = resolveLogPaths(config);
  const { squidLogs: squidLogsPath, sessionState: sessionStatePath, agentLogs: agentLogsPath, apiProxyLogs: apiProxyLogsPath, cliProxyLogs: cliProxyLogsPath } = logPaths;

  // ── Init-signal directory ──────────────────────────────────────────────────

  // Create init-signal directory for iptables init container coordination
  const initSignalDir = path.join(config.workDir, 'init-signal');
  if (!fs.existsSync(initSignalDir)) {
    fs.mkdirSync(initSignalDir, { recursive: true });
  }

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

  // ── Agent environment ──────────────────────────────────────────────────────

  const environment = buildAgentEnvironment({
    config,
    networkConfig,
    dnsServers,
    sslConfig,
  });

  // Pre-set API proxy IP in environment before the init container definition.
  // The init container's environment object captures values at definition time,
  // so AWF_API_PROXY_IP must be set before the init container is defined.
  // Without this, the init container gets an empty AWF_API_PROXY_IP and
  // setup-iptables.sh never adds ACCEPT rules for the API proxy, blocking connectivity.
  if (config.enableApiProxy && networkConfig.proxyIp) {
    environment.AWF_API_PROXY_IP = networkConfig.proxyIp;
  }

  // Pre-set CLI proxy IP in environment before the init container definition
  // for the same reason as AWF_API_PROXY_IP above.
  if (config.difcProxyHost && networkConfig.cliProxyIp) {
    environment.AWF_CLI_PROXY_IP = networkConfig.cliProxyIp;
  }

  // ── Agent volumes ──────────────────────────────────────────────────────────

  const effectiveHome = getRealUserHome();
  const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();

  const agentVolumes = buildAgentVolumes({
    config,
    sslConfig,
    projectRoot,
    effectiveHome,
    workspaceDir,
    agentLogsPath,
    sessionStatePath,
    initSignalDir,
  });

  // ── Agent service ──────────────────────────────────────────────────────────

  const agentService = buildAgentService({
    config,
    networkConfig,
    environment,
    agentVolumes,
    dnsServers,
    imageConfig,
  });

  // ── iptables-init service ──────────────────────────────────────────────────
  //
  // In network-isolation (topology) mode there is no iptables enforcement, so the
  // init container is omitted entirely. The agent skips its init-wait loop via the
  // AWF_NETWORK_ISOLATION env var set below.

  const networkIsolation = !!config.networkIsolation;

  if (networkIsolation) {
    // Tell the agent entrypoint to skip the iptables-init handshake.
    environment.AWF_NETWORK_ISOLATION = '1';
  }

  // ── Assemble base services ─────────────────────────────────────────────────

  const services: Record<string, any> = {
    'squid-proxy': squidService,
    'agent': agentService,
  };

  if (!networkIsolation) {
    const iptablesInitService = buildIptablesInitService({
      agentService,
      environment,
      networkConfig,
      initSignalDir,
      dockerHostPathPrefix: config.dockerHostPathPrefix,
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

  // ── Final compose result ───────────────────────────────────────────────────

  if (networkIsolation) {
    // Topology enforcement: the agent (and sidecars) live on an `internal`
    // network with no route to the internet. Squid is dual-homed — attached to
    // both the internal network and an external bridge network — so it is the
    // sole egress path. No host iptables and no NET_ADMIN are involved.
    squidService.networks = {
      ...(squidService.networks || {}),
      'awf-ext': {},
    };

    // The agent must resolve names via Docker's embedded resolver (127.0.0.11),
    // which forwards through the daemon's network rather than the agent's, so it
    // still works on an internal network. The configured external DNS servers are
    // unreachable from an internal network.
    agentService.dns = ['127.0.0.11'];

    const composeResult: DockerComposeConfig = {
      services,
      networks: {
        'awf-net': {
          internal: true,
          ipam: {
            config: [{ subnet: networkConfig.subnet }],
          },
        },
        'awf-ext': {
          driver: 'bridge',
        },
      },
    };

    return composeResult;
  }

  const composeResult: DockerComposeConfig = {
    services,
    networks: {
      'awf-net': {
        external: true,
      },
    },
  };

  return composeResult;
}

/**
 * Redacts sensitive environment variables from a Docker Compose config for audit logging.
 * Replaces values of env vars that look like secrets (tokens, keys, passwords) with "[REDACTED]".
 */
export function redactDockerComposeSecrets(compose: DockerComposeConfig): DockerComposeConfig {
  // Match env var names containing sensitive keywords.
  // Uses substring matching (not just suffix) to catch patterns like
  // GOOGLE_APPLICATION_CREDENTIALS, PRIVATE_KEY_PATH, etc.
  const sensitivePatterns = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|_B64|_PAT|_AUTH|PRIVATE_KEY)/i;
  const redacted = JSON.parse(JSON.stringify(compose)) as DockerComposeConfig;

  for (const service of Object.values(redacted.services)) {
    if (service.environment && typeof service.environment === 'object') {
      for (const key of Object.keys(service.environment)) {
        if (sensitivePatterns.test(key)) {
          (service.environment as Record<string, string>)[key] = '[REDACTED]';
        }
      }
    }
  }

  return redacted;
}
