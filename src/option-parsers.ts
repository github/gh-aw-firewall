import * as fs from 'fs';
import { WrapperConfig, RateLimitConfig } from './types';
import { isValidIPv4, isValidIPv6 } from './domain-utils';

/**
 * Builds a RateLimitConfig from parsed CLI options.
 */
export function buildRateLimitConfig(options: {
  rateLimit?: boolean;
  rateLimitRpm?: string;
  rateLimitRph?: string;
  rateLimitBytesPm?: string;
}): { config: RateLimitConfig } | { error: string } {
  // --no-rate-limit explicitly disables (even if other flags are set)
  if (options.rateLimit === false) {
    return { config: { enabled: false, rpm: 0, rph: 0, bytesPm: 0 } };
  }

  // Rate limiting is opt-in: disabled unless at least one --rate-limit-* flag is provided
  const hasAnyLimit = options.rateLimitRpm !== undefined ||
    options.rateLimitRph !== undefined ||
    options.rateLimitBytesPm !== undefined;

  if (!hasAnyLimit) {
    return { config: { enabled: false, rpm: 0, rph: 0, bytesPm: 0 } };
  }

  // Defaults for any limit not explicitly set
  const config: RateLimitConfig = { enabled: true, rpm: 600, rph: 10000, bytesPm: 52428800 };

  if (options.rateLimitRpm !== undefined) {
    const rpm = parseInt(options.rateLimitRpm, 10);
    if (isNaN(rpm) || rpm <= 0) return { error: '--rate-limit-rpm must be a positive integer' };
    config.rpm = rpm;
  }
  if (options.rateLimitRph !== undefined) {
    const rph = parseInt(options.rateLimitRph, 10);
    if (isNaN(rph) || rph <= 0) return { error: '--rate-limit-rph must be a positive integer' };
    config.rph = rph;
  }
  if (options.rateLimitBytesPm !== undefined) {
    const bytesPm = parseInt(options.rateLimitBytesPm, 10);
    if (isNaN(bytesPm) || bytesPm <= 0) return { error: '--rate-limit-bytes-pm must be a positive integer' };
    config.bytesPm = bytesPm;
  }

  return { config };
}

/**
 * Validates that rate-limit flags are not used without --enable-api-proxy.
 */
export function validateRateLimitFlags(enableApiProxy: boolean, options: {
  rateLimit?: boolean;
  rateLimitRpm?: string;
  rateLimitRph?: string;
  rateLimitBytesPm?: string;
}): FlagValidationResult {
  if (!enableApiProxy) {
    const hasRateLimitFlags = options.rateLimitRpm !== undefined ||
      options.rateLimitRph !== undefined ||
      options.rateLimitBytesPm !== undefined ||
      options.rateLimit === false;
    if (hasRateLimitFlags) {
      return { valid: false, error: 'Rate limit flags require --enable-api-proxy' };
    }
  }
  return { valid: true };
}

/**
 * Validates that --enable-opencode is not used without --enable-api-proxy.
 */
export function validateEnableOpenCodeFlag(enableApiProxy: boolean, enableOpenCode: boolean): FlagValidationResult {
  if (enableOpenCode && !enableApiProxy) {
    return { valid: false, error: '--enable-opencode requires --enable-api-proxy' };
  }
  return { valid: true };
}

/**
 * Result of validating flag combinations
 */
export interface FlagValidationResult {
  /** Whether the validation passed */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
}

/**
 * Checks if any rate limit options are set in the CLI options.
 * Used to warn when rate limit flags are provided without --enable-api-proxy.
 */
/**
 * Commander option accumulator for repeatable --ruleset-file flag.
 * Collects multiple values into an array.
 */
export function collectRulesetFile(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function hasRateLimitOptions(options: {
  rateLimitRpm?: string;
  rateLimitRph?: string;
  rateLimitBytesPm?: string;
  rateLimit?: boolean;
}): boolean {
  return !!(options.rateLimitRpm || options.rateLimitRph || options.rateLimitBytesPm || options.rateLimit === false);
}

/**
 * Validates that --skip-pull is not used with --build-local
 * @param skipPull - Whether --skip-pull flag was provided
 * @param buildLocal - Whether --build-local flag was provided
 * @returns FlagValidationResult with validation status and error message
 */
export function validateSkipPullWithBuildLocal(
  skipPull: boolean | undefined,
  buildLocal: boolean | undefined
): FlagValidationResult {
  if (skipPull && buildLocal) {
    return {
      valid: false,
      error: '--skip-pull cannot be used with --build-local. Building images requires pulling base images from the registry.',
    };
  }
  return { valid: true };
}

/**
 * Validates that --allow-host-ports is only used with --enable-host-access
 * @param allowHostPorts - The --allow-host-ports value (undefined if not provided)
 * @param enableHostAccess - Whether --enable-host-access flag was provided
 * @returns FlagValidationResult with validation status and error message
 */
export function validateAllowHostPorts(
  allowHostPorts: string | undefined,
  enableHostAccess: boolean | undefined
): FlagValidationResult {
  if (allowHostPorts && !enableHostAccess) {
    return {
      valid: false,
      error: '--allow-host-ports requires --enable-host-access to be set',
    };
  }
  return { valid: true };
}

/**
 * Validates --allow-host-service-ports values.
 * Ports must be numeric and in the range 1-65535.
 * Unlike --allow-host-ports, dangerous ports are intentionally allowed because
 * these ports are restricted to the host gateway IP only (not the internet).
 * Returns an object indicating whether host access should be auto-enabled.
 */
export function validateAllowHostServicePorts(
  allowHostServicePorts: string | undefined,
  enableHostAccess: boolean | undefined
): FlagValidationResult & { autoEnableHostAccess?: boolean } {
  if (!allowHostServicePorts) {
    return { valid: true };
  }

  const servicePorts = allowHostServicePorts.split(',').map(p => p.trim());
  for (const port of servicePorts) {
    if (!/^\d+$/.test(port)) {
      return {
        valid: false,
        error: `Invalid port in --allow-host-service-ports: ${port}. Must be a numeric value`,
      };
    }
    const portNum = parseInt(port, 10);
    if (portNum < 1 || portNum > 65535) {
      return {
        valid: false,
        error: `Invalid port in --allow-host-service-ports: ${port}. Must be a number between 1 and 65535`,
      };
    }
  }

  return {
    valid: true,
    autoEnableHostAccess: !enableHostAccess,
  };
}

/**
 * Applies --allow-host-service-ports validation and config mutations.
 * Extracted from the main command handler for testability.
 *
 * Returns { valid: false, error } if validation fails (caller should exit).
 * Returns { valid: true, enableHostAccess } with the (possibly mutated) value.
 */
export function applyHostServicePortsConfig(
  allowHostServicePorts: string | undefined,
  enableHostAccess: boolean | undefined,
  log: { warn: (msg: string) => void; info: (msg: string) => void }
): { valid: true; enableHostAccess: boolean | undefined } | { valid: false; error: string } {
  const validation = validateAllowHostServicePorts(allowHostServicePorts, enableHostAccess);
  if (!validation.valid) {
    return { valid: false, error: validation.error! };
  }

  if (allowHostServicePorts) {
    log.warn('--allow-host-service-ports bypasses dangerous port restrictions for host-local traffic.');
    log.warn('Ensure host services on these ports do not provide external network access.');

    if (validation.autoEnableHostAccess) {
      log.warn('--allow-host-service-ports automatically enabling host access (ports 80/443 to host gateway also opened)');
      enableHostAccess = true;
    }
    log.info(`Host service ports allowed (host gateway only): ${allowHostServicePorts}`);
  }

  return { valid: true, enableHostAccess };
}

/**
 * Parses and validates a Docker memory limit string.
 * Valid formats: positive integer followed by b, k, m, or g (e.g., "2g", "512m", "4g").
 */
export function parseMemoryLimit(input: string): { value: string; error?: undefined } | { value?: undefined; error: string } {
  const pattern = /^(\d+)([bkmg])$/i;
  const match = input.match(pattern);
  if (!match) {
    return { error: `Invalid --memory-limit value "${input}". Expected format: <number><unit> (e.g., 2g, 512m, 4g)` };
  }
  const num = parseInt(match[1], 10);
  if (num <= 0) {
    return { error: `Invalid --memory-limit value "${input}". Memory limit must be a positive number.` };
  }
  return { value: input.toLowerCase() };
}

/**
 * Parses and validates the --agent-timeout option
 * @param value - The raw string value from the CLI option
 * @returns The parsed timeout in minutes, or an error
 */
export function parseAgentTimeout(value: string): { minutes: number } | { error: string } {
  if (!/^[1-9]\d*$/.test(value)) {
    return { error: '--agent-timeout must be a positive integer (minutes)' };
  }
  const timeoutMinutes = parseInt(value, 10);
  return { minutes: timeoutMinutes };
}

/**
 * Applies the --agent-timeout option to the config if present.
 * Exits with code 1 if the value is invalid.
 */
export function applyAgentTimeout(
  agentTimeout: string | undefined,
  config: WrapperConfig,
  logger: { error: (msg: string) => void; info: (msg: string) => void }
): void {
  if (agentTimeout === undefined) return;
  const result = parseAgentTimeout(agentTimeout);
  if ('error' in result) {
    logger.error(result.error);
    process.exit(1);
  }
  config.agentTimeout = result.minutes;
  logger.info(`Agent timeout set to ${result.minutes} minutes`);
}

/**
 * Checks whether DOCKER_HOST is set to an external daemon that is incompatible
 * with AWF.
 *
 * AWF manages its own Docker network (`172.30.0.0/24`) and iptables rules that
 * require direct access to the host's Docker socket.  When DOCKER_HOST points
 * at an external TCP daemon (e.g. a DinD sidecar), Docker Compose routes all
 * container creation through that daemon's network namespace, which breaks:
 *  - AWF's fixed subnet routing
 *  - The iptables DNAT rules set up by awf-iptables-init
 *  - Port-binding expectations between containers
 *
 * Any unix socket (standard or non-standard path) is considered local and valid.
 *
 * @param env - Environment variables to inspect (defaults to process.env)
 * @returns `{ valid: true }` when DOCKER_HOST is absent or points at a local
 *          unix socket; `{ valid: false, error: string }` otherwise.
 */
export function checkDockerHost(
  env: Record<string, string | undefined> = process.env
): { valid: true } | { valid: false; error: string } {
  const dockerHost = env['DOCKER_HOST'];

  if (!dockerHost) {
    return { valid: true };
  }

  if (dockerHost.startsWith('unix://')) {
    return { valid: true };
  }

  return {
    valid: false,
    error:
      `DOCKER_HOST is set to an external daemon (${dockerHost}). ` +
      'AWF requires the local Docker daemon (default socket). ' +
      'Workflow-scope DinD is incompatible with AWF\'s network isolation model. ' +
      'See the "Workflow-Scope DinD Incompatibility" section in docs/usage.md for details and workarounds.',
  };
}

/**
 * Parses and validates DNS servers from a comma-separated string
 * @param input - Comma-separated DNS server string (e.g., "8.8.8.8,1.1.1.1")
 * @returns Array of validated DNS server IP addresses
 * @throws Error if any IP address is invalid or if the list is empty
 */
export function parseDnsServers(input: string): string[] {
  const servers = input
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (servers.length === 0) {
    throw new Error('At least one DNS server must be specified');
  }

  for (const server of servers) {
    if (!isValidIPv4(server) && !isValidIPv6(server)) {
      throw new Error(`Invalid DNS server IP address: ${server}`);
    }
  }

  return servers;
}

const DEFAULT_DOH_RESOLVER = 'https://dns.google/dns-query';

/**
 * Parses and validates the --dns-over-https option value.
 * Commander sets the value to `true` when the flag is used without an argument.
 * Returns the resolved URL, or an error string.
 */
export function parseDnsOverHttps(
  value: boolean | string | undefined
): { url: string } | { error: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const resolvedUrl: string = value === true ? DEFAULT_DOH_RESOLVER : String(value);
  if (!resolvedUrl.startsWith('https://')) {
    return { error: '--dns-over-https resolver URL must start with https://' };
  }
  return { url: resolvedUrl };
}

/**
 * Result of processing the localhost keyword in allowed domains
 */
export interface LocalhostProcessingResult {
  /** Updated array of allowed domains with localhost replaced by host.docker.internal */
  allowedDomains: string[];
  /** Whether the localhost keyword was found and processed */
  localhostDetected: boolean;
  /** Whether host access should be enabled (if not already enabled) */
  shouldEnableHostAccess: boolean;
  /** Default port list to use if no custom ports were specified */
  defaultPorts?: string;
}

/**
 * Processes the localhost keyword in the allowed domains list.
 * This function handles the logic for replacing localhost with host.docker.internal,
 * preserving protocol prefixes, and determining whether to auto-enable host access
 * and default development ports.
 *
 * @param allowedDomains - Array of allowed domains (may include localhost variants)
 * @param enableHostAccess - Whether host access is already enabled
 * @param allowHostPorts - Custom host ports if already specified
 * @returns LocalhostProcessingResult with the processed values
 */
export function processLocalhostKeyword(
  allowedDomains: string[],
  enableHostAccess: boolean,
  allowHostPorts: string | undefined
): LocalhostProcessingResult {
  const localhostIndex = allowedDomains.findIndex(d => 
    d === 'localhost' || d === 'http://localhost' || d === 'https://localhost'
  );

  if (localhostIndex === -1) {
    return {
      allowedDomains,
      localhostDetected: false,
      shouldEnableHostAccess: false,
    };
  }

  // Remove localhost and replace with host.docker.internal
  const localhostValue = allowedDomains[localhostIndex];
  const updatedDomains = [...allowedDomains];
  updatedDomains.splice(localhostIndex, 1);
  
  // Preserve protocol if specified
  if (localhostValue.startsWith('http://')) {
    updatedDomains.push('http://host.docker.internal');
  } else if (localhostValue.startsWith('https://')) {
    updatedDomains.push('https://host.docker.internal');
  } else {
    updatedDomains.push('host.docker.internal');
  }

  return {
    allowedDomains: updatedDomains,
    localhostDetected: true,
    shouldEnableHostAccess: !enableHostAccess,
    defaultPorts: allowHostPorts ? undefined : '3000,3001,4000,4200,5000,5173,8000,8080,8081,8888,9000,9090',
  };
}

/**
 * Escapes a shell argument by wrapping it in single quotes and escaping any single quotes within it
 * @param arg - Argument to escape
 * @returns Escaped argument safe for shell execution
 */
export function escapeShellArg(arg: string): string {
  // If the argument doesn't contain special characters, return as-is
  // Character class includes: letters, digits, underscore, dash, dot (literal), slash, equals, colon
  if (/^[a-zA-Z0-9_\-./=:]+$/.test(arg)) {
    return arg;
  }
  // Otherwise, wrap in single quotes and escape any single quotes inside
  // The pattern '\\'' works by: ending the single-quoted string ('),
  // adding an escaped single quote (\'), then starting a new single-quoted string (')
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Joins an array of shell arguments into a single command string, properly escaping each argument
 * @param args - Array of arguments
 * @returns Command string with properly escaped arguments
 */
export function joinShellArgs(args: string[]): string {
  return args.map(escapeShellArg).join(' ');
}

/**
 * Parses environment variables from an array of KEY=VALUE strings
 * @param envVars Array of environment variable strings in KEY=VALUE format
 * @returns Object with parsed key-value pairs on success, or error details on failure
 */
export function parseEnvironmentVariables(
  envVars: string[]
): { success: true; env: Record<string, string> } | { success: false; invalidVar: string } {
  const result: Record<string, string> = {};

  for (const envVar of envVars) {
    const match = envVar.match(/^([^=]+)=(.*)$/);
    if (!match) {
      return { success: false, invalidVar: envVar };
    }
    const [, key, value] = match;
    result[key] = value;
  }

  return { success: true, env: result };
}

/**
 * Parses and validates volume mount specifications
 * @param mounts Array of volume mount strings in host_path:container_path[:mode] format
 * @returns Object with parsed mount strings on success, or error details on failure
 */
export function parseVolumeMounts(
  mounts: string[]
): { success: true; mounts: string[] } | { success: false; invalidMount: string; reason: string } {
  const result: string[] = [];

  for (const mount of mounts) {
    // Parse mount specification: host_path:container_path[:mode]
    const parts = mount.split(':');

    if (parts.length < 2 || parts.length > 3) {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Mount must be in format host_path:container_path[:mode]'
      };
    }

    const [hostPath, containerPath, mode] = parts;

    // Validate host path is not empty
    if (!hostPath || hostPath.trim() === '') {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Host path cannot be empty'
      };
    }

    // Validate container path is not empty
    if (!containerPath || containerPath.trim() === '') {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Container path cannot be empty'
      };
    }

    // Validate host path is absolute
    if (!hostPath.startsWith('/')) {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Host path must be absolute (start with /)'
      };
    }

    // Validate container path is absolute
    if (!containerPath.startsWith('/')) {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Container path must be absolute (start with /)'
      };
    }

    // Validate mode if specified
    if (mode && mode !== 'ro' && mode !== 'rw') {
      return {
        success: false,
        invalidMount: mount,
        reason: 'Mount mode must be either "ro" or "rw"'
      };
    }

    // Validate host path exists
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs');
      if (!fs.existsSync(hostPath)) {
        return {
          success: false,
          invalidMount: mount,
          reason: `Host path does not exist: ${hostPath}`
        };
      }
    } catch (error) {
      return {
        success: false,
        invalidMount: mount,
        reason: `Failed to check host path: ${error}`
      };
    }

    // Add to result list
    result.push(mount);
  }

  return { success: true, mounts: result };
}

export function formatItem(
  term: string,
  description: string,
  termWidth: number,
  indent: number,
  sep: number,
  _helpWidth: number
): string {
  const indentStr = ' '.repeat(indent);
  const fullWidth = termWidth + sep;
  if (description) {
    if (term.length < fullWidth - sep) {
      return `${indentStr}${term.padEnd(fullWidth)}${description}`;
    }
    return `${indentStr}${term}\n${' '.repeat(indent + fullWidth)}${description}`;
  }
  return `${indentStr}${term}`;
}
