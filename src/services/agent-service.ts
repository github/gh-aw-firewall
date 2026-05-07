import * as path from 'path';
import {
  AGENT_CONTAINER_NAME,
  IPTABLES_INIT_CONTAINER_NAME,
  SQUID_PORT,
  ACT_PRESET_BASE_IMAGE,
  getSafeHostUid,
  getSafeHostGid,
} from '../host-env';
import { buildRuntimeImageRef } from '../image-tag';
import { logger } from '../logger';
import { WrapperConfig } from '../types';
import { NetworkConfig, ImageBuildConfig } from './squid-service';

// Re-export for backwards compatibility
export { AgentEnvironmentParams, buildAgentEnvironment } from './agent-environment';
export { AgentVolumesParams, buildAgentVolumes } from './agent-volumes';

// ─── Agent Service ────────────────────────────────────────────────────────────

export interface AgentServiceParams {
  config: WrapperConfig;
  networkConfig: NetworkConfig;
  environment: Record<string, string>;
  agentVolumes: string[];
  dnsServers: string[];
  imageConfig: ImageBuildConfig;
}

/**
 * Builds the agent container service configuration for Docker Compose.
 */
export function buildAgentService(params: AgentServiceParams): any {
  const { config, networkConfig, environment, agentVolumes, dnsServers, imageConfig } = params;
  const { useGHCR, registry, parsedTag, projectRoot } = imageConfig;

  // Agent service configuration
  const agentService: any = {
    container_name: AGENT_CONTAINER_NAME,
    networks: {
      'awf-net': {
        ipv4_address: networkConfig.agentIp,
      },
    },
    // When DoH is enabled, route DNS through the DoH proxy sidecar instead of external DNS
    dns: config.dnsOverHttps && networkConfig.dohProxyIp
      ? [networkConfig.dohProxyIp, '127.0.0.11']
      : dnsServers, // Use configured DNS servers (prevents DNS exfiltration)
    dns_search: [], // Disable DNS search domains to prevent embedded DNS fallback
    volumes: agentVolumes,
    environment,
    // SECURITY: Hide sensitive directories from agent using tmpfs overlays (empty in-memory filesystems)
    //
    // 1. MCP logs: tmpfs over /tmp/gh-aw/mcp-logs prevents the agent from reading
    //    MCP server logs inside the container. The host can still write to its own
    //    /tmp/gh-aw/mcp-logs directory since tmpfs only affects the container's view.
    //
    // 2. WorkDir: tmpfs over workDir (e.g., /tmp/awf-<timestamp>) prevents the agent
    //    from reading docker-compose.yml which contains environment variables (tokens,
    //    API keys) in plaintext. Without this overlay, code inside the container could
    //    extract secrets via: cat /tmp/awf-*/docker-compose.yml
    //    Note: volume mounts of workDir subdirectories (agent-logs, squid-logs, etc.)
    //    are mapped to different container paths (e.g., ~/.copilot/logs, /var/log/squid)
    //    so they are unaffected by the tmpfs overlay on workDir.
    //
    // Hide both normal and /host-prefixed paths since /tmp is mounted at both
    // /tmp and /host/tmp in chroot mode (which is always on)
    //
    // /host/dev/shm: /dev is bind-mounted read-only (/dev:/host/dev:ro), which makes
    // /dev/shm read-only after chroot /host. POSIX semaphores and shared memory
    // (used by python/black's blackd server and other tools) require a writable /dev/shm.
    // A tmpfs overlay at /host/dev/shm provides a writable, isolated in-memory filesystem.
    // Security: Docker containers use their own IPC namespace (no --ipc=host), so shared
    // memory is fully isolated from the host and other containers. Size is capped at 64MB
    // (Docker's default). noexec and nosuid flags restrict abuse vectors.
    tmpfs: [
      '/tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m',
      '/host/tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m',
      `${config.workDir}:rw,noexec,nosuid,size=1m`,
      `/host${config.workDir}:rw,noexec,nosuid,size=1m`,
      '/host/dev/shm:rw,noexec,nosuid,nodev,size=65536k',
    ],
    depends_on: {
      'squid-proxy': {
        condition: 'service_healthy',
      },
    },
    // SECURITY: NET_ADMIN is NOT granted to the agent container.
    // iptables setup is performed by the awf-iptables-init service which shares
    // the agent's network namespace via network_mode: "service:agent".
    // SYS_CHROOT is required for chroot operations.
    // SYS_ADMIN is required to mount procfs at /host/proc (required for
    // dynamic /proc/self/exe resolution needed by .NET CLR and other runtimes).
    // Security: SYS_CHROOT and SYS_ADMIN are dropped before running user commands
    // via 'capsh --drop=cap_sys_chroot,cap_sys_admin' in entrypoint.sh.
    cap_add: ['SYS_CHROOT', 'SYS_ADMIN'],
    // Drop capabilities to reduce attack surface (security hardening)
    cap_drop: [
      'NET_RAW',      // Prevents raw socket creation (iptables bypass attempts)
      'SYS_PTRACE',   // Prevents process inspection/debugging (container escape vector)
      'SYS_MODULE',   // Prevents kernel module loading
      'SYS_RAWIO',    // Prevents raw I/O access
      'MKNOD',        // Prevents device node creation
    ],
    // Apply seccomp profile and no-new-privileges to restrict dangerous syscalls and prevent privilege escalation
    // AppArmor is set to unconfined to allow mounting procfs at /host/proc
    // (Docker's default AppArmor profile blocks mount). This is safe because SYS_ADMIN is
    // dropped via capsh before user code runs, so user code cannot mount anything.
    security_opt: [
      'no-new-privileges:true',
      `seccomp=${config.workDir}/seccomp-profile.json`,
      'apparmor:unconfined',
    ],
    // Resource limits to prevent DoS attacks
    // Default 6g matches ~85% of GitHub Actions runner RAM (7GB),
    // with swap unlimited so the kernel can use swap as a pressure valve
    // instead of immediately OOM-killing the agent process.
    mem_limit: config.memoryLimit || '6g',
    memswap_limit: config.memoryLimit ? config.memoryLimit : '-1',  // Disable swap when user specifies limit
    pids_limit: 1000,          // Max 1000 processes
    cpu_shares: 1024,          // Default CPU share
    stdin_open: true,
    tty: config.tty || false, // Use --tty flag, default to false for clean logs
    // Healthcheck ensures the agent process is alive and its PID is visible in /proc
    // before the iptables-init container tries to join via network_mode: service:agent.
    // Without this, there's a race where the init container tries to look up the agent's
    // PID in /proc/PID/ns/net before the kernel has made it visible.
    healthcheck: {
      test: ['CMD-SHELL', 'true'],
      interval: '1s',
      timeout: '1s',
      retries: 3,
      start_period: '1s',
    },
    // Escape $ with $$ for Docker Compose variable interpolation
    command: ['/bin/bash', '-c', config.agentCommand.replace(/\$/g, '$$$$')],
  };

  // Set working directory if specified (overrides Dockerfile WORKDIR)
  if (config.containerWorkDir) {
    agentService.working_dir = config.containerWorkDir;
    logger.debug(`Set container working directory to: ${config.containerWorkDir}`);
  }

  // Enable host.docker.internal for agent when --enable-host-access is set
  if (config.enableHostAccess) {
    agentService.extra_hosts = ['host.docker.internal:host-gateway'];
    environment.AWF_ENABLE_HOST_ACCESS = '1';
  }

  // Use GHCR image or build locally
  // Priority: GHCR preset images > local build (when requested) > custom images
  // For presets ('default', 'act'), use GHCR images
  const agentImage = config.agentImage || 'default';
  const isPreset = agentImage === 'default' || agentImage === 'act';

  if (useGHCR && isPreset) {
    // Use pre-built GHCR image for preset images
    // The GHCR images already have the necessary setup for chroot mode
    const imageName = agentImage === 'act' ? 'agent-act' : 'agent';
    agentService.image = buildRuntimeImageRef(registry, imageName, parsedTag);
    logger.debug(`Using GHCR image ${agentService.image}`);
  } else if (config.buildLocal || !isPreset) {
    // Build locally when:
    // 1. --build-local is explicitly specified, OR
    // 2. A custom (non-preset) image is specified
    const buildArgs: Record<string, string> = {
      USER_UID: getSafeHostUid(),
      USER_GID: getSafeHostGid(),
    };

    // Always use the full Dockerfile for feature parity with GHCR release images.
    // Previously chroot mode used Dockerfile.minimal for smaller image size,
    // but this caused missing packages (e.g., iproute2/net-tools) that
    // setup-iptables.sh depends on for network gateway detection.
    const dockerfile = 'Dockerfile';

    // For custom images (not presets), pass as BASE_IMAGE build arg
    // For 'act' preset with --build-local, use the act base image
    if (!isPreset) {
      buildArgs.BASE_IMAGE = agentImage;
    } else if (agentImage === 'act') {
      // When building locally with 'act' preset, use the catthehacker act image
      buildArgs.BASE_IMAGE = ACT_PRESET_BASE_IMAGE;
    }
    // For 'default' preset with --build-local, use the Dockerfile's default (ubuntu:22.04)

    agentService.build = {
      context: path.join(projectRoot, 'containers/agent'),
      dockerfile,
      args: buildArgs,
    };
  } else {
    // Custom image specified without --build-local
    // Use the image directly (user is responsible for ensuring compatibility)
    agentService.image = agentImage;
  }

  return agentService;
}

// ─── iptables-init Service ────────────────────────────────────────────────────

export interface IptablesInitServiceParams {
  agentService: any;
  environment: Record<string, string>;
  networkConfig: NetworkConfig;
  initSignalDir: string;
}

/**
 * Builds the iptables-init container service configuration for Docker Compose.
 * This container shares the agent's network namespace and sets up NAT rules
 * without ever granting NET_ADMIN to the agent itself.
 */
export function buildIptablesInitService(params: IptablesInitServiceParams): any {
  const { agentService, environment, networkConfig, initSignalDir } = params;

  // SECURITY: iptables init container - sets up NAT rules in a separate container
  // that shares the agent's network namespace but NEVER gives NET_ADMIN to the agent.
  // This eliminates the window where the agent holds NET_ADMIN during startup.
  const iptablesInitService: any = {
    container_name: IPTABLES_INIT_CONTAINER_NAME,
    // Share agent's network namespace so iptables rules apply to agent's traffic
    network_mode: 'service:agent',
    // Only mount the init signal volume and the iptables setup script
    volumes: [
      `${initSignalDir}:/tmp/awf-init:rw`,
    ],
    environment: {
      // Pass through environment variables needed by setup-iptables.sh
      // IMPORTANT: setup-iptables.sh reads SQUID_PROXY_HOST/PORT (not AWF_ prefixed).
      // Use the direct IP address since the init container (network_mode: service:agent)
      // may not have DNS resolution for compose service names.
      SQUID_PROXY_HOST: `${networkConfig.squidIp}`,
      SQUID_PROXY_PORT: String(SQUID_PORT),
      AWF_DNS_SERVERS: environment.AWF_DNS_SERVERS || '',
      AWF_BLOCKED_PORTS: environment.AWF_BLOCKED_PORTS || '',
      AWF_ENABLE_HOST_ACCESS: environment.AWF_ENABLE_HOST_ACCESS || '',
      AWF_ALLOW_HOST_PORTS: environment.AWF_ALLOW_HOST_PORTS || '',
      AWF_HOST_SERVICE_PORTS: environment.AWF_HOST_SERVICE_PORTS || '',
      AWF_API_PROXY_IP: environment.AWF_API_PROXY_IP || '',
      AWF_DOH_PROXY_IP: environment.AWF_DOH_PROXY_IP || '',
      AWF_CLI_PROXY_IP: environment.AWF_CLI_PROXY_IP || '',
      AWF_SSL_BUMP_ENABLED: environment.AWF_SSL_BUMP_ENABLED || '',
      AWF_SSL_BUMP_INTERCEPT_PORT: environment.AWF_SSL_BUMP_INTERCEPT_PORT || '',
    },
    depends_on: {
      'agent': {
        condition: 'service_healthy',
      },
    },
    // NET_ADMIN is required for iptables rule manipulation.
    // NET_RAW is required by iptables for netfilter socket operations.
    cap_add: ['NET_ADMIN', 'NET_RAW'],
    cap_drop: ['ALL'],
    // Override entrypoint to bypass the agent's entrypoint.sh, which contains an
    // "init container wait" loop that would deadlock (the init container waiting for itself).
    // The init container only needs to run setup-iptables.sh directly.
    entrypoint: ['/bin/bash'],
    // Run setup-iptables.sh then signal readiness; log output to shared volume for diagnostics
    command: ['-c', '/usr/local/bin/setup-iptables.sh > /tmp/awf-init/output.log 2>&1 && touch /tmp/awf-init/ready'],
    // Resource limits (init container exits quickly)
    mem_limit: '128m',
    pids_limit: 50,
    // Restart policy: never restart (init container runs once)
    restart: 'no',
  };

  // Use the same image/build as the agent container for the iptables init service
  if (agentService.image) {
    iptablesInitService.image = agentService.image;
  } else if (agentService.build) {
    iptablesInitService.build = agentService.build;
  }

  return iptablesInitService;
}
