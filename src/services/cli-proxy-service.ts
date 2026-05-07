import * as path from 'path';
import { CLI_PROXY_CONTAINER_NAME, parseDifcProxyHost } from '../host-env';
import { buildRuntimeImageRef } from '../image-tag';
import { logger } from '../logger';
import { WrapperConfig, CLI_PROXY_PORT } from '../types';
import { NetworkConfig, ImageBuildConfig } from './squid-service';

interface CliProxyBuildResult {
  /** The cli-proxy service definition to add to Docker Compose services. */
  service: any;
  /**
   * Additional environment variables to merge into the agent container's environment.
   * These tell the agent how to reach the CLI proxy for GitHub API operations.
   */
  agentEnvAdditions: Record<string, string>;
}

interface CliProxyServiceParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  cliProxyLogsPath: string;
  imageConfig: ImageBuildConfig;
}

/**
 * Builds the CLI proxy sidecar service configuration and associated agent environment
 * mutations for connecting to an external DIFC proxy.
 */
export function buildCliProxyService(params: CliProxyServiceParams): CliProxyBuildResult {
  const { config, networkConfig, cliProxyLogsPath, imageConfig } = params;
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;

  if (!networkConfig.cliProxyIp || !config.difcProxyHost) {
    throw new Error('buildCliProxyService: cliProxyIp and difcProxyHost are required');
  }

  const cliProxyIp = networkConfig.cliProxyIp;

  // Parse host:port from difcProxyHost (supports IPv6, e.g. [::1]:18443)
  const { host: difcProxyHost, port: difcProxyPort } = parseDifcProxyHost(config.difcProxyHost);

  // --- CLI proxy HTTP server (Node.js + gh CLI) ---
  // Connects to external DIFC proxy via TCP tunnel for TLS hostname matching.
  // The TCP tunnel forwards localhost:${difcProxyPort} → ${difcProxyHost}:${difcProxyPort}
  // so that gh CLI's GH_HOST=localhost:${difcProxyPort} matches the cert's SAN.
  const cliProxyService: any = {
    container_name: CLI_PROXY_CONTAINER_NAME,
    networks: {
      'awf-net': {
        ipv4_address: cliProxyIp,
      },
    },
    // Enable host.docker.internal resolution for connecting to host DIFC proxy
    extra_hosts: ['host.docker.internal:host-gateway'],
    volumes: [
      // Log directory for HTTP server logs
      `${cliProxyLogsPath}:/var/log/cli-proxy:rw`,
      // Mount host CA cert for TLS verification
      ...(config.difcProxyCaCert ? [`${config.difcProxyCaCert}:/tmp/proxy-tls/ca.crt:ro`] : []),
    ],
    environment: {
      // External DIFC proxy connection info for tcp-tunnel.js
      AWF_DIFC_PROXY_HOST: difcProxyHost,
      AWF_DIFC_PROXY_PORT: difcProxyPort,
      // Pass GITHUB_REPOSITORY for GH_REPO default in entrypoint
      ...(process.env.GITHUB_REPOSITORY && { GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY }),
      // The gh CLI inside the cli-proxy needs a GitHub token to authenticate API
      // requests. The token is safe here: the cli-proxy container is inside the
      // firewall perimeter and not accessible to the agent. The DIFC proxy on the
      // host provides write-control via its guard policy.
      ...(process.env.GH_TOKEN && { GH_TOKEN: process.env.GH_TOKEN }),
      ...(process.env.GITHUB_TOKEN && !process.env.GH_TOKEN && { GH_TOKEN: process.env.GITHUB_TOKEN }),
      // Prevent curl/node from routing localhost or host.docker.internal through Squid
      NO_PROXY: `localhost,127.0.0.1,::1,host.docker.internal`,
      no_proxy: `localhost,127.0.0.1,::1,host.docker.internal`,
    },
    healthcheck: {
      test: ['CMD', 'curl', '-f', `http://localhost:${CLI_PROXY_PORT}/health`],
      interval: '5s',
      timeout: '3s',
      retries: 5,
      start_period: '30s',
    },
    depends_on: {
      'squid-proxy': {
        condition: 'service_healthy',
      },
    },
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    mem_limit: '256m',
    memswap_limit: '256m',
    pids_limit: 50,
    cpu_shares: 256,
    stop_grace_period: '2s',
  };

  // Use GHCR image or build locally for the Node.js HTTP server container
  if (useGHCR) {
    cliProxyService.image = buildRuntimeImageRef(registry, 'cli-proxy', parsedTag);
  } else {
    cliProxyService.build = {
      context: path.join(projectRoot, 'containers/cli-proxy'),
      dockerfile: 'Dockerfile',
    };
  }

  // Tell the agent how to reach the CLI proxy (use cli-proxy's own IP)
  const agentEnvAdditions: Record<string, string> = {
    AWF_CLI_PROXY_URL: `http://${cliProxyIp}:${CLI_PROXY_PORT}`,
    AWF_CLI_PROXY_IP: cliProxyIp,
  };

  logger.info(`CLI proxy sidecar enabled - connecting to external DIFC proxy at ${config.difcProxyHost}`);

  return { service: cliProxyService, agentEnvAdditions };
}
