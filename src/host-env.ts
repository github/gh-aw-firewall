import * as fs from 'fs';
import { logger } from './logger';
import type { CaFiles } from './ssl-bump';

export const SQUID_PORT = 3128;

/**
 * Container names used in Docker Compose and referenced by docker CLI commands.
 * Extracted as constants so that generateDockerCompose() and helpers like
 * fastKillAgentContainer() stay in sync.
 */
export const AGENT_CONTAINER_NAME = 'awf-agent';
export const SQUID_CONTAINER_NAME = 'awf-squid';
export const IPTABLES_INIT_CONTAINER_NAME = 'awf-iptables-init';
export const API_PROXY_CONTAINER_NAME = 'awf-api-proxy';
export const DOH_PROXY_CONTAINER_NAME = 'awf-doh-proxy';
export const CLI_PROXY_CONTAINER_NAME = 'awf-cli-proxy';

/**
 * Maximum size (bytes) of a single environment variable value allowed through
 * --env-all passthrough. Variables exceeding this are skipped with a warning
 * to prevent E2BIG errors from ARG_MAX exhaustion.
 */
export const MAX_ENV_VALUE_SIZE = 64 * 1024; // 64 KB

/**
 * Total environment size (bytes) threshold for issuing an ARG_MAX warning.
 * Linux ARG_MAX is ~2 MB for argv + envp combined; warn well before that.
 */
export const ENV_SIZE_WARNING_THRESHOLD = 1_500_000; // ~1.5 MB


/**
 * Optional override for the Docker host used by AWF's own container operations.
 * Set via setAwfDockerHost() from the CLI --docker-host flag.
 * When undefined, AWF auto-selects the local socket (see getLocalDockerEnv).
 */
let awfDockerHostOverride: string | undefined;

/**
 * Sets the Docker host to use for AWF's own container operations.
 *
 * When set, overrides DOCKER_HOST for all docker CLI calls made by AWF
 * (compose up/down, docker wait, docker logs, etc.).
 *
 * When not set, AWF auto-detects:
 *  - unix:// DOCKER_HOST values are kept as-is (local socket).
 *  - TCP DOCKER_HOST values (e.g. DinD) are cleared so docker falls back
 *    to the system default socket.
 *
 * @internal Called from cli.ts when --docker-host flag is provided.
 */
export function setAwfDockerHost(host: string | undefined): void {
  awfDockerHostOverride = host;
}

/**
 * Returns an environment object suitable for AWF's own docker CLI calls.
 *
 * When DOCKER_HOST is set to an external TCP daemon (e.g. a workflow-scope
 * DinD sidecar), it is removed so docker/docker-compose use the local Unix
 * socket instead.  When --docker-host was provided via the CLI, that value
 * is used regardless of the environment.
 *
 * The original DOCKER_HOST value is NOT removed from the agent container's
 * environment — see generateDockerCompose for the passthrough logic.
 */
export function getLocalDockerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (awfDockerHostOverride !== undefined) {
    // Explicit CLI override — always use this socket for AWF operations
    env.DOCKER_HOST = awfDockerHostOverride;
  } else {
    const dockerHost = env.DOCKER_HOST;
    if (dockerHost && !dockerHost.startsWith('unix://')) {
      // Non-unix DOCKER_HOST (e.g. tcp://localhost:2375 from a DinD sidecar).
      // Clear it so AWF's docker commands target the local daemon, not the DinD one.
      delete env.DOCKER_HOST;
    }
  }

  return env;
}


/**
 * Base image for the 'act' preset when building locally.
 * Uses catthehacker's GitHub Actions parity image.
 */
export const ACT_PRESET_BASE_IMAGE = 'ghcr.io/catthehacker/ubuntu:act-24.04';

/**
 * Minimum UID/GID value for regular users.
 * UIDs 0-999 are reserved for system users on most Linux distributions.
 */
export const MIN_REGULAR_UID = 1000;

/**
 * Validates that a UID/GID value is safe for use (not in system range).
 * Returns the value if valid, or the default (1000) if in system range.
 * @internal Exported for testing
 */
export function validateIdNotInSystemRange(id: number): string {
  // Reject system UIDs/GIDs (0-999) - use default unprivileged user instead
  if (id < MIN_REGULAR_UID) {
    return MIN_REGULAR_UID.toString();
  }
  return id.toString();
}

/**
 * Gets the host user's UID, with fallback to 1000 if unavailable, root (0),
 * or in the system UID range (0-999).
 * When running with sudo, uses SUDO_UID to get the actual user's UID.
 * @internal Exported for testing
 */
export function getSafeHostUid(): string {
  const uid = process.getuid?.();
  
  // When running as root (sudo), try to get the original user's UID
  if (!uid || uid === 0) {
    const sudoUid = process.env.SUDO_UID;
    if (sudoUid) {
      const parsedUid = parseInt(sudoUid, 10);
      if (!isNaN(parsedUid)) {
        return validateIdNotInSystemRange(parsedUid);
      }
    }
    return MIN_REGULAR_UID.toString();
  }
  
  return validateIdNotInSystemRange(uid);
}

/**
 * Gets the host user's GID, with fallback to 1000 if unavailable, root (0),
 * or in the system GID range (0-999).
 * When running with sudo, uses SUDO_GID to get the actual user's GID.
 * @internal Exported for testing
 */
export function getSafeHostGid(): string {
  const gid = process.getgid?.();
  
  // When running as root (sudo), try to get the original user's GID
  if (!gid || gid === 0) {
    const sudoGid = process.env.SUDO_GID;
    if (sudoGid) {
      const parsedGid = parseInt(sudoGid, 10);
      if (!isNaN(parsedGid)) {
        return validateIdNotInSystemRange(parsedGid);
      }
    }
    return MIN_REGULAR_UID.toString();
  }
  
  return validateIdNotInSystemRange(gid);
}

/**
 * Gets the real user's home directory, accounting for sudo.
 * When running with sudo, uses SUDO_USER to find the actual user's home.
 * @internal Exported for testing
 */
export function getRealUserHome(): string {
  const uid = process.getuid?.();

  // When running as root (sudo), try to get the original user's home
  if (!uid || uid === 0) {
    // Try SUDO_USER first - look up their home directory from passwd
    const sudoUser = process.env.SUDO_USER;
    if (sudoUser) {
      try {
        // Look up user's home directory from /etc/passwd
        const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
        const userLine = passwd.split('\n').find(line => line.startsWith(`${sudoUser}:`));
        if (userLine) {
          const parts = userLine.split(':');
          if (parts.length >= 6 && parts[5]) {
            return parts[5]; // Home directory is the 6th field
          }
        }
      } catch {
        // Fall through to use HOME
      }
    }
  }

  // Use HOME environment variable as fallback
  return process.env.HOME || '/root';
}

/**
 * Extracts the hostname from GITHUB_SERVER_URL to set GH_HOST for gh CLI.
 * Returns the hostname if GITHUB_SERVER_URL points to a non-github.com instance,
 * or null if it points to github.com (no GH_HOST needed).
 * @param serverUrl - The GITHUB_SERVER_URL environment variable value
 * @returns The hostname to use for GH_HOST, or null if not needed
 * @internal Exported for testing
 */
export function extractGhHostFromServerUrl(serverUrl: string | undefined): string | null {
  if (!serverUrl) {
    return null;
  }

  try {
    const url = new URL(serverUrl);
    const hostname = url.hostname;

    // If pointing to public GitHub, no GH_HOST needed
    if (hostname === 'github.com') {
      return null;
    }

    // For GHES/GHEC instances, return the hostname
    return hostname;
  } catch {
    // Invalid URL, return null
    return null;
  }
}

/**
 * Reads path entries from the $GITHUB_PATH file used by GitHub Actions.
 *
 * When setup-* actions (e.g., setup-ruby, setup-dart, setup-python) run before AWF,
 * they add tool paths to the $GITHUB_PATH file. The Actions runner prepends these
 * to $PATH for subsequent steps, but if `sudo` resets PATH (depending on sudoers
 * configuration), those entries may be lost by the time AWF reads process.env.PATH.
 *
 * This function reads the $GITHUB_PATH file directly and returns any path entries
 * found, so they can be merged into AWF_HOST_PATH regardless of sudo behavior.
 *
 * @returns Array of path entries from the $GITHUB_PATH file, or empty array if unavailable
 * @internal Exported for testing
 */
export function readGitHubPathEntries(): string[] {
  const githubPathFile = process.env.GITHUB_PATH;
  if (!githubPathFile) {
    logger.debug('GITHUB_PATH env var is not set; skipping $GITHUB_PATH file merge (tools installed by setup-* actions may be missing from PATH if sudo reset it)');
    return [];
  }

  try {
    const content = fs.readFileSync(githubPathFile, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch {
    // File doesn't exist or isn't readable — expected outside GitHub Actions
    logger.debug(`GITHUB_PATH file at '${githubPathFile}' could not be read; skipping file merge`);
    return [];
  }
}

/**
 * Reads key-value environment entries from the $GITHUB_ENV file.
 *
 * The Actions runner writes to this file when steps call `core.exportVariable()`.
 * When AWF runs via `sudo`, non-standard env vars may be stripped. This function
 * reads the file directly to recover them.
 *
 * Supports both formats used by the Actions runner:
 * - Simple: `KEY=VALUE` (value may contain `=`)
 * - Heredoc: `KEY<<DELIMITER\nVALUE_LINES\nDELIMITER`
 *
 * @returns Map of environment variable names to values
 * @internal Exported for testing
 */
export function readGitHubEnvEntries(): Record<string, string> {
  const githubEnvFile = process.env.GITHUB_ENV;
  if (!githubEnvFile) {
    logger.debug('GITHUB_ENV env var is not set; skipping $GITHUB_ENV file read');
    return {};
  }

  try {
    const content = fs.readFileSync(githubEnvFile, 'utf-8');
    return parseGitHubEnvFile(content);
  } catch {
    logger.debug(`GITHUB_ENV file at '${githubEnvFile}' could not be read; skipping`);
    return {};
  }
}

/**
 * Parses the content of a $GITHUB_ENV file into key-value pairs.
 * @internal Exported for testing
 */
export function parseGitHubEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Normalize CRLF to LF
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Check for heredoc format: KEY<<DELIMITER
    const heredocMatch = line.match(/^([^=]+)<<(.+)$/);
    if (heredocMatch) {
      const key = heredocMatch[1];
      const delimiter = heredocMatch[2];
      const valueLines: string[] = [];
      i++;

      // Collect lines until we find the delimiter
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i++;
      }
      // Skip the closing delimiter line
      if (i < lines.length) i++;

      result[key] = valueLines.join('\n');
      continue;
    }

    // Simple format: KEY=VALUE (split on first = only)
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx);
      const value = line.slice(eqIdx + 1);
      result[key] = value;
    }

    i++;
  }

  return result;
}

/**
 * Toolchain environment variables that should be recovered from $GITHUB_ENV
 * when sudo strips them from process.env. These are set by setup-* actions
 * (setup-go, setup-java, setup-dotnet, etc.) and are needed for correct
 * tool resolution inside the agent container.
 */
export const TOOLCHAIN_ENV_VARS = [
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'JAVA_HOME',
  'DOTNET_ROOT',
  'BUN_INSTALL',
] as const;

/**
 * Merges path entries from the $GITHUB_PATH file into a PATH string.
 * Entries from $GITHUB_PATH are prepended (they have higher priority, matching
 * how the Actions runner processes them). Duplicate entries are removed.
 *
 * @param currentPath - The current PATH string (e.g., from process.env.PATH)
 * @param githubPathEntries - Path entries read from the $GITHUB_PATH file
 * @returns Merged PATH string with $GITHUB_PATH entries prepended
 * @internal Exported for testing
 */
export function mergeGitHubPathEntries(currentPath: string, githubPathEntries: string[]): string {
  if (githubPathEntries.length === 0) {
    return currentPath;
  }

  const currentEntries = currentPath ? currentPath.split(':') : [];
  const currentSet = new Set(currentEntries);

  // Only add entries that aren't already in the current PATH
  const newEntries = githubPathEntries.filter(entry => !currentSet.has(entry));

  if (newEntries.length === 0) {
    return currentPath;
  }

  // Prepend new entries (setup-* actions expect their paths to have priority)
  return [...newEntries, ...currentEntries].join(':');
}

/**
 * Reads environment variables from a KEY=VALUE file (like Docker's --env-file).
 *
 * Rules:
 * - Lines starting with '#' are comments and are ignored.
 * - Empty/whitespace-only lines are ignored.
 * - Each non-comment line must match the pattern KEY=VALUE where KEY starts with a
 *   letter or underscore and contains only letters, digits, or underscores.
 * - Values may be empty (KEY=).
 * - Values are taken literally; no quote-stripping or variable expansion is done.
 *
 * @param filePath - Absolute or relative path to the env file
 * @returns An object mapping variable names to their values
 * @throws {Error} If the file cannot be read
 */
export function readEnvFile(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const result: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    // Skip comments and blank lines
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

/**
 * Checks if two subnets overlap
 * Returns true if the new subnet conflicts with an existing subnet
 */
export function subnetsOverlap(subnet1: string, subnet2: string): boolean {
  // Parse CIDR notation: "172.17.0.0/16" -> ["172.17.0.0", "16"]
  const [ip1, cidr1] = subnet1.split('/');
  const [ip2, cidr2] = subnet2.split('/');

  // Convert IP to number
  const ipToNumber = (ip: string): number => {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
  };

  // Calculate network address and broadcast address for a subnet
  const getNetworkRange = (ip: string, cidr: string): [number, number] => {
    const ipNum = ipToNumber(ip);
    const maskBits = parseInt(cidr, 10);
    const mask = (0xffffffff << (32 - maskBits)) >>> 0;
    const networkAddr = (ipNum & mask) >>> 0;
    const broadcastAddr = (networkAddr | ~mask) >>> 0;
    return [networkAddr, broadcastAddr];
  };

  const [start1, end1] = getNetworkRange(ip1, cidr1);
  const [start2, end2] = getNetworkRange(ip2, cidr2);

  // Check if ranges overlap
  return (start1 <= end2 && end1 >= start2);
}

/**
 * SSL configuration for Docker Compose (when SSL Bump is enabled)
 */
export interface SslConfig {
  caFiles: CaFiles;
  sslDbPath: string;
}

/**
 * Normalizes an API target value to a bare hostname.
 * API target values should be bare hostnames (e.g., "api.openai.com"), but
 * may arrive with a scheme or path when set via GitHub Actions expressions
 * that are resolved at runtime (see github/gh-aw#25137).
 * Discards any scheme, path, query, fragment, credentials, or port —
 * path prefixes must use the separate *_API_BASE_PATH settings.
 */
export function stripScheme(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    return new URL(candidate).hostname || trimmed;
  } catch {
    return trimmed;
  }
}

/**
 * Parses a host:port string into separate host and port components.
 * Supports IPv6 bracketed notation (e.g., [::1]:18443), plain host:port,
 * and optional scheme prefixes.
 * Defaults to host.docker.internal:18443 for empty/missing values.
 */
export function parseDifcProxyHost(value: string): { host: string; port: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { host: 'host.docker.internal', port: '18443' };
  }
  // Use URL to parse host:port correctly (handles IPv6 brackets)
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed);
  const candidate = hasScheme ? trimmed : `tcp://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid --difc-proxy-host value: "${value}". Expected host:port format.`);
  }
  const host = parsed.hostname || 'host.docker.internal';
  const port = parsed.port || '18443';
  if (!/^\d+$/.test(port)) {
    throw new Error(`Invalid --difc-proxy-host port: "${port}". Must be a number.`);
  }
  const portNum = Number(port);
  if (portNum < 1 || portNum > 65535) {
    throw new Error(`Invalid --difc-proxy-host port: ${portNum}. Must be between 1 and 65535.`);
  }
  return { host, port: String(portNum) };
}
