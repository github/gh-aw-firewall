import * as path from 'path';
import { SslConfig, SQUID_PORT, SQUID_CONTAINER_NAME } from '../host-env';
import { parseImageTag, buildRuntimeImageRef } from '../image-tag';
import { logger } from '../logger';
import { WrapperConfig } from '../types';

/** Network configuration passed to service builders */
export interface NetworkConfig {
  subnet: string;
  squidIp: string;
  agentIp: string;
  proxyIp?: string;
  dohProxyIp?: string;
  cliProxyIp?: string;
}

/** Image source configuration shared across service builders */
export interface ImageBuildConfig {
  useGHCR: boolean;
  registry: string;
  parsedTag: ReturnType<typeof parseImageTag>;
  projectRoot: string;
}

interface SquidServiceParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  sslConfig?: SslConfig;
  squidConfigContent?: string;
  squidLogsPath: string;
  imageConfig: ImageBuildConfig;
}

/**
 * Builds the Squid proxy service configuration for Docker Compose.
 */
export function buildSquidService(params: SquidServiceParams): any {
  const { config, networkConfig, sslConfig, squidConfigContent, squidLogsPath, imageConfig } = params;
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;

  // Build Squid volumes list
  // Note: squid.conf is NOT bind-mounted. Instead, it's passed as a base64-encoded
  // environment variable (AWF_SQUID_CONFIG_B64) and decoded by the entrypoint override.
  // This supports Docker-in-Docker (DinD) environments where the Docker daemon runs
  // in a separate container and cannot access files on the host filesystem.
  // See: https://github.com/github/gh-aw/issues/18385
  const squidVolumes = [
    `${squidLogsPath}:/var/log/squid:rw`,
  ];

  // Add SSL-related volumes if SSL Bump is enabled
  if (sslConfig) {
    squidVolumes.push(`${sslConfig.caFiles.certPath}:${sslConfig.caFiles.certPath}:ro`);
    squidVolumes.push(`${sslConfig.caFiles.keyPath}:${sslConfig.caFiles.keyPath}:ro`);
    // Mount SSL database at /var/spool/squid_ssl_db (Squid's expected location)
    squidVolumes.push(`${sslConfig.sslDbPath}:/var/spool/squid_ssl_db:rw`);
  }

  // Squid service configuration
  const squidService: any = {
    container_name: SQUID_CONTAINER_NAME,
    networks: {
      'awf-net': {
        ipv4_address: networkConfig.squidIp,
      },
    },
    volumes: squidVolumes,
    healthcheck: {
      test: ['CMD', 'nc', '-z', 'localhost', '3128'],
      interval: '1s',
      timeout: '1s',
      retries: 5,
      start_period: '2s',
    },
    ports: [`${SQUID_PORT}:${SQUID_PORT}`],
    // Security hardening: Drop unnecessary capabilities
    // Squid only needs network capabilities, not system administration capabilities
    cap_drop: [
      'NET_RAW',      // No raw socket access needed
      'SYS_ADMIN',    // No system administration needed
      'SYS_PTRACE',   // No process tracing needed
      'SYS_MODULE',   // No kernel module loading
      'MKNOD',        // No device node creation
      'AUDIT_WRITE',  // No audit log writing
      'SETFCAP',      // No setting file capabilities
    ],
    stop_grace_period: '2s',
  };

  // Inject squid.conf via environment variable instead of bind mount.
  // In Docker-in-Docker (DinD) environments, the Docker daemon runs in a separate
  // container and cannot access files on the host filesystem. Bind-mounting
  // squid.conf fails because the daemon creates a directory at the missing path.
  // Passing the config as a base64-encoded env var works universally because
  // env vars are part of the container spec sent via the Docker API.
  if (squidConfigContent) {
    const configB64 = Buffer.from(squidConfigContent).toString('base64');
    squidService.environment = {
      ...squidService.environment,
      AWF_SQUID_CONFIG_B64: configB64,
    };
    // Override entrypoint to decode the config before starting squid.
    // The original entrypoint (/usr/local/bin/entrypoint.sh) is called after decoding.
    // Use $$ to escape $ for Docker Compose variable interpolation.
    // Docker Compose interprets $VAR as variable substitution in YAML values;
    // $$ produces a literal $ that the shell inside the container will expand.
    squidService.entrypoint = [
      '/bin/bash', '-c',
      'echo "$$AWF_SQUID_CONFIG_B64" | base64 -d > /etc/squid/squid.conf && exec /usr/local/bin/entrypoint.sh',
    ];
  }

  // Only enable host.docker.internal when explicitly requested via --enable-host-access
  // This allows containers to reach services on the host machine (e.g., MCP gateways)
  // Security note: When combined with allowing host.docker.internal domain,
  // containers can access any port on the host
  if (config.enableHostAccess) {
    squidService.extra_hosts = ['host.docker.internal:host-gateway'];
    logger.debug('Host access enabled: host.docker.internal will resolve to host gateway');
  }

  // Use GHCR image or build locally
  // For SSL Bump, we always build locally to include OpenSSL tools
  if (useGHCR && !config.sslBump) {
    squidService.image = buildRuntimeImageRef(registry, 'squid', parsedTag);
  } else {
    squidService.build = {
      context: path.join(projectRoot, 'containers/squid'),
      dockerfile: 'Dockerfile',
    };
  }

  return squidService;
}
