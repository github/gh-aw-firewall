import * as fs from 'fs';
import * as path from 'path';
import { DockerComposeConfig, WrapperConfig } from './types';
import { DEFAULT_DNS_SERVERS } from './dns-resolver';
import { parseImageTag } from './image-tag';
import { SslConfig } from './host-env';
import { getRealUserHome } from './host-identity';
import { resolveLogPaths } from './log-paths';
import { buildSquidService } from './services/squid-service';
import { buildAgentEnvironment, buildAgentVolumes, buildAgentService } from './services/agent-service';
import { assembleOptionalServices } from './services/optional-services';
import { buildComposeNetworks } from './compose-network';

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

  const effectiveHome = getRealUserHome();
  const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();

  const agentVolumes = buildAgentVolumes({
    config,
    sslConfig,
    projectRoot,
    effectiveHome,
    workspaceDir,
    agentLogsPath: logPaths.agentLogs,
    sessionStatePath: logPaths.sessionState,
    initSignalDir,
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

  const services: Record<string, any> = {
    'squid-proxy': squidService,
    'agent': agentService,
  };

  // ── Insert optional sidecars and wire depends_on edges ────────────────────

  const { namedVolumes } = assembleOptionalServices({
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
  });

  // ── Assemble and return the compose result ─────────────────────────────────

  return buildComposeNetworks({
    services,
    squidService,
    agentService,
    networkIsolation: !!config.networkIsolation,
    networkConfig,
    namedVolumes,
  });
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
