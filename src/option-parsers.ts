import { WrapperConfig, RateLimitConfig } from './types';
import {
  buildRateLimitConfig as buildRateLimitConfigImpl,
  validateRateLimitFlags as validateRateLimitFlagsImpl,
  validateEnableOpenCodeFlag as validateEnableOpenCodeFlagImpl,
  validateEnableTokenSteeringFlag as validateEnableTokenSteeringFlagImpl,
} from './parsers/rate-limit-parsers';
import {
  validateAllowHostPorts as validateAllowHostPortsImpl,
  validateAllowHostServicePorts as validateAllowHostServicePortsImpl,
  applyHostServicePortsConfig as applyHostServicePortsConfigImpl,
} from './parsers/host-port-parsers';
import {
  parseDnsServers as parseDnsServersImpl,
  parseDnsOverHttps as parseDnsOverHttpsImpl,
  processLocalhostKeyword as processLocalhostKeywordImpl,
} from './parsers/dns-parsers';
import {
  escapeShellArg as escapeShellArgImpl,
  joinShellArgs as joinShellArgsImpl,
} from './parsers/shell-utils';
import {
  parseVolumeMounts as parseVolumeMountsImpl,
} from './parsers/volume-parsers';
import { parseEnvironmentVariables as parseEnvironmentVariablesImpl } from './parsers/env-parsers';

/**
 * Result of validating flag combinations
 */
interface FlagValidationResult {
  /** Whether the validation passed */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
}

interface LocalhostProcessingResult {
  allowedDomains: string[];
  localhostDetected: boolean;
  shouldEnableHostAccess: boolean;
  defaultPorts?: string;
}

/**
 * Builds a RateLimitConfig from parsed CLI options.
 */
export function buildRateLimitConfig(options: {
  rateLimit?: boolean;
  rateLimitRpm?: string;
  rateLimitRph?: string;
  rateLimitBytesPm?: string;
}): { config: RateLimitConfig } | { error: string } {
  return buildRateLimitConfigImpl(options);
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
  return validateRateLimitFlagsImpl(enableApiProxy, options);
}

/**
 * Validates that --enable-opencode is not used without --enable-api-proxy.
 */
export function validateEnableOpenCodeFlag(enableApiProxy: boolean, enableOpenCode: boolean): FlagValidationResult {
  return validateEnableOpenCodeFlagImpl(enableApiProxy, enableOpenCode);
}

/**
 * Validates that --enable-token-steering is not used without --enable-api-proxy.
 */
export function validateEnableTokenSteeringFlag(enableApiProxy: boolean, enableTokenSteering: boolean): FlagValidationResult {
  return validateEnableTokenSteeringFlagImpl(enableApiProxy, enableTokenSteering);
}

/**
 * Commander option accumulator for repeatable --ruleset-file flag.
 * Collects multiple values into an array.
 */
export function collectRulesetFile(value: string, previous: string[] = []): string[] {
  return [...previous, value];
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
  return validateAllowHostPortsImpl(allowHostPorts, enableHostAccess);
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
  return validateAllowHostServicePortsImpl(allowHostServicePorts, enableHostAccess);
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
  return applyHostServicePortsConfigImpl(allowHostServicePorts, enableHostAccess, log);
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
 * Resolves the effective Docker host path prefix for bind mount translation.
 *
 * If an explicit prefix is provided, it wins. Otherwise, no prefix is applied.
 */
export function resolveDockerHostPathPrefix(
  _dockerHostCheck: { valid: true } | { valid: false; error: string },
  explicitPrefix: string | undefined
): { dockerHostPathPrefix?: string; autoApplied: boolean } {
  const trimmedExplicitPrefix = explicitPrefix?.trim();

  if (trimmedExplicitPrefix) {
    return { dockerHostPathPrefix: trimmedExplicitPrefix, autoApplied: false };
  }

  return { dockerHostPathPrefix: undefined, autoApplied: false };
}

/**
 * Parses and validates DNS servers from a comma-separated string
 * @param input - Comma-separated DNS server string (e.g., "8.8.8.8,1.1.1.1")
 * @returns Array of validated DNS server IP addresses
 * @throws Error if any IP address is invalid or if the list is empty
 */
export function parseDnsServers(input: string): string[] {
  return parseDnsServersImpl(input);
}

/**
 * Parses and validates the --dns-over-https option value.
 * Commander sets the value to `true` when the flag is used without an argument.
 * Returns the resolved URL, or an error string.
 */
export function parseDnsOverHttps(
  value: boolean | string | undefined
): { url: string } | { error: string } | undefined {
  return parseDnsOverHttpsImpl(value);
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
 */
export function processLocalhostKeyword(
  allowedDomains: string[],
  enableHostAccess: boolean,
  allowHostPorts: string | undefined
): LocalhostProcessingResult {
  return processLocalhostKeywordImpl(allowedDomains, enableHostAccess, allowHostPorts);
}

/**
 * Escapes a shell argument by wrapping it in single quotes and escaping any single quotes within it
 * @param arg - Argument to escape
 * @returns Escaped argument safe for shell execution
 */
export function escapeShellArg(arg: string): string {
  return escapeShellArgImpl(arg);
}

/**
 * Joins an array of shell arguments into a single command string, properly escaping each argument
 * @param args - Array of arguments
 * @returns Command string with properly escaped arguments
 */
export function joinShellArgs(args: string[]): string {
  return joinShellArgsImpl(args);
}

/**
 * Parses environment variables from an array of KEY=VALUE strings
 * @param envVars Array of environment variable strings in KEY=VALUE format
 * @returns Object with parsed key-value pairs on success, or error details on failure
 */
export function parseEnvironmentVariables(
  envVars: string[]
): { success: true; env: Record<string, string> } | { success: false; invalidVar: string } {
  return parseEnvironmentVariablesImpl(envVars);
}

/**
 * Parses and validates volume mount specifications
 * @param mounts Array of volume mount strings in host_path:container_path[:mode] format
 * @returns Object with parsed mount strings on success, or error details on failure
 */
export function parseVolumeMounts(
  mounts: string[]
): { success: true; mounts: string[] } | { success: false; invalidMount: string; reason: string } {
  return parseVolumeMountsImpl(mounts);
}

/**
 * Parses and validates the --max-model-multiplier CLI option.
 *
 * Accepts a comma-separated list of `model:multiplier` pairs, e.g.
 * `claude-opus-4-5-200k:2.5,claude-opus-4-5-1m:10`.
 *
 * Each multiplier must be a positive finite number.
 * Invalid entries are silently ignored; an empty or missing value returns `{}`.
 *
 * @param input - Raw string from the CLI option (may be undefined)
 * @returns Parsed multiplier map, or an error string
 */
export function parseModelMultipliersCli(
  input: string | undefined
): { multipliers: Record<string, number> } | { error: string } {
  if (!input || input.trim() === '') {
    return { multipliers: {} };
  }

  const result: Record<string, number> = {};
  const entries = input.split(',').map(e => e.trim()).filter(Boolean);

  for (const entry of entries) {
    // Split on the last colon to allow colons in model names
    const lastColon = entry.lastIndexOf(':');
    if (lastColon <= 0) {
      return { error: `--max-model-multiplier: invalid entry "${entry}" (expected model:multiplier)` };
    }
    const model = entry.slice(0, lastColon).trim();
    const rawValue = entry.slice(lastColon + 1).trim();

    if (!model) {
      return { error: `--max-model-multiplier: empty model name in "${entry}"` };
    }
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) {
      return { error: `--max-model-multiplier: multiplier for "${model}" must be a positive number (got "${rawValue}")` };
    }
    result[model] = value;
  }

  return { multipliers: result };
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
