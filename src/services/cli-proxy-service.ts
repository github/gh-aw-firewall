import { CLI_PROXY_CONTAINER_NAME } from '../constants';
import { EXTERNAL_BRIDGE_NAME, NETWORK_SUBNET } from '../config/network-policy';
import { isValidIPv4, isValidIPv6 } from '../domain-utils';
import { parseDifcProxyHost } from '../host-env';
import { assignImageSource } from '../image-tag';
import { logger } from '../logger';
import { WrapperConfig, CLI_PROXY_PORT } from '../types';
import { NetworkConfig, ImageBuildConfig } from './squid-service';
import { applyHostPathPrefixToVolumes } from './host-path-prefix';
import { buildContainerSecurityHardening } from './service-security';
import { buildNoProxyEnv } from './no-proxy-utils';

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
 * Returns true when `ip` (a dotted-quad IPv4 literal) falls inside `cidr`
 * (e.g. `172.30.0.0/24`). Used to recognize a DIFC proxy that was given a
 * static address on `awf-net` itself — such a host is a Compose sibling, not
 * an external endpoint, regardless of it being spelled as an IP literal.
 */
function isIPv4InCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixLenStr] = cidr.split('/');
  const prefixLen = Number(prefixLenStr);
  const toInt = (addr: string): number | null => {
    const octets = addr.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null;
    return octets.reduce((acc, o) => (acc << 8) + o, 0) >>> 0;
  };
  const ipInt = toInt(ip);
  const rangeInt = toInt(rangeIp);
  if (ipInt === null || rangeInt === null || Number.isNaN(prefixLen)) return false;
  const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/**
 * Rewrites a DIFC proxy host that refers to the cli-proxy container's own
 * loopback interface (`localhost`, `127.0.0.0/8`, `::1`) to
 * `host.docker.internal`.
 *
 * `tcp-tunnel.js` binds `localhost:<port>` inside the cli-proxy container and
 * forwards to `AWF_DIFC_PROXY_HOST`. If that host were left as a loopback
 * literal, the tunnel would dial itself instead of the runner-host proxy it
 * is meant to reach — a self-connect, not a route to the host. Any loopback
 * spelling can only sensibly mean "the DIFC proxy on the runner host", so it
 * is normalized to the host gateway name rather than merely classified as
 * external.
 */
export function normalizeLoopbackDifcHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')) {
    return 'host.docker.internal';
  }
  return host;
}

/**
 * Returns true when the DIFC proxy lives outside the AWF Compose project — on
 * the runner host (`host.docker.internal`, a bare non-`awf-net` IP) or behind
 * a public DNS name — rather than as a sibling container attached to
 * `awf-net`.
 *
 * In network-isolation mode `awf-net` is `internal: true`, so a cli-proxy that
 * only joins it has no route to the host gateway and its tcp-tunnel fails with
 * `ENETUNREACH`. Such a cli-proxy must be dual-homed onto the external bridge,
 * exactly like Squid and the API proxy. A sibling container reachable on the
 * internal network — either a bare DNS label (`awmg-cli-proxy`) or a static IP
 * inside `awf-net`'s own subnet — must stay there so it gains no extra egress.
 *
 * Callers must pass the host through {@link normalizeLoopbackDifcHost} first
 * so loopback spellings are already resolved to `host.docker.internal`.
 *
 * Caveat: a single-label host (no dot, e.g. `difcproxy`) is always treated as
 * an attached sibling. A genuinely external DIFC proxy addressed by a bare,
 * search-domain-resolved DNS label would be misclassified and remain
 * unreachable — that host must be given a dotted name (or a literal IP
 * outside `awf-net`'s subnet) to be recognized as external.
 */
export function isExternalDifcProxyHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  if (isValidIPv4(normalized)) return !isIPv4InCidr(normalized, NETWORK_SUBNET);
  if (isValidIPv6(normalized)) return true;
  // Dotted names (host.docker.internal, difc.example.com) resolve outside the
  // Compose project; bare labels are Docker service/container names.
  return normalized.includes('.');
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

  // Parse host:port from difcProxyHost (supports IPv6, e.g. [::1]:18443).
  // Loopback spellings refer to the cli-proxy container's own interface, not
  // the runner host, so normalize them before use anywhere below (env vars,
  // network attachment classification).
  const { host: parsedDifcProxyHost, port: difcProxyPort } = parseDifcProxyHost(config.difcProxyHost);
  const difcProxyHost = normalizeLoopbackDifcHost(parsedDifcProxyHost);

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
      // In network-isolation mode `awf-net` is internal, so an external DIFC
      // proxy (host gateway or public DNS name) is unreachable from it. Attach
      // the external bridge as well — mirroring Squid and the API proxy — so
      // the tcp-tunnel can dial the host instead of failing with ENETUNREACH.
      ...(config.networkIsolation && isExternalDifcProxyHost(difcProxyHost)
        ? { [EXTERNAL_BRIDGE_NAME]: {} }
        : {}),
    },
    // Enable host.docker.internal resolution for connecting to host DIFC proxy
    extra_hosts: { 'host.docker.internal': 'host-gateway' },
    volumes: applyHostPathPrefixToVolumes(
      [
        // Log directory for HTTP server logs
        `${cliProxyLogsPath}:/var/log/cli-proxy:rw`,
        // Mount host CA cert for TLS verification
        ...(config.difcProxyCaCert ? [`${config.difcProxyCaCert}:/tmp/proxy-tls/ca.crt:ro`] : []),
      ],
      config.dockerHostPathPrefix,
    ),
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
      ...buildNoProxyEnv(['host.docker.internal']),
    },
    healthcheck: {
      test: ['CMD', 'curl', '-f', `http://127.0.0.1:${CLI_PROXY_PORT}/health`],
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
    // Security hardening and resource limits to prevent DoS attacks
    ...buildContainerSecurityHardening({ memLimit: '256m', pidsLimit: 50, cpuShares: 256 }),
    stop_grace_period: '2s',
  };

  // Use GHCR image or build locally for the Node.js HTTP server container
  assignImageSource(cliProxyService, {
    useGHCR, registry, imageName: 'cli-proxy', parsedTag, projectRoot, containerDir: 'cli-proxy',
  });

  // Tell the agent how to reach the CLI proxy (use cli-proxy's own IP)
  const agentEnvAdditions: Record<string, string> = {
    AWF_CLI_PROXY_URL: `http://${cliProxyIp}:${CLI_PROXY_PORT}`,
    AWF_CLI_PROXY_IP: cliProxyIp,
  };

  logger.info(`CLI proxy sidecar enabled - connecting to external DIFC proxy at ${config.difcProxyHost}`);

  return { service: cliProxyService, agentEnvAdditions };
}
