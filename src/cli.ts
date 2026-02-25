#!/usr/bin/env node

import { Command } from 'commander';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { isIPv6 } from 'net';
import { WrapperConfig, LogLevel, RateLimitConfig } from './types';
import { logger } from './logger';
import {
  writeConfigs,
  startContainers,
  runAgentCommand,
  stopContainers,
  cleanup,
} from './docker-manager';
import {
  ensureFirewallNetwork,
  setupHostIptables,
  cleanupHostIptables,
} from './host-iptables';
import { runMainWorkflow } from './cli-workflow';
import { redactSecrets } from './redact-secrets';
import { validateDomainOrPattern } from './domain-patterns';
import { OutputFormat } from './types';
import { version } from '../package.json';

/**
 * Parses a comma-separated list of domains into an array of trimmed, non-empty domain strings
 * @param input - Comma-separated domain string (e.g., "github.com, api.github.com, npmjs.org")
 * @returns Array of trimmed domain strings with empty entries filtered out
 */
export function parseDomains(input: string): string[] {
  return input
    .split(',')
    .map(d => d.trim())
    .filter(d => d.length > 0);
}

/**
 * Parses domains from a file, supporting both line-separated and comma-separated formats
 * @param filePath - Path to file containing domains (one per line or comma-separated)
 * @returns Array of trimmed domain strings with empty entries and comments filtered out
 * @throws Error if file doesn't exist or can't be read
 */
export function parseDomainsFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Domains file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const domains: string[] = [];

  // Split by lines first
  const lines = content.split('\n');
  
  for (const line of lines) {
    // Remove comments (anything after #)
    const withoutComment = line.split('#')[0].trim();
    
    // Skip empty lines
    if (withoutComment.length === 0) {
      continue;
    }
    
    // Check if line contains commas (comma-separated format)
    if (withoutComment.includes(',')) {
      // Parse as comma-separated domains
      const commaSeparated = parseDomains(withoutComment);
      domains.push(...commaSeparated);
    } else {
      // Single domain per line
      domains.push(withoutComment);
    }
  }

  return domains;
}

/**
 * Default DNS servers (Google Public DNS)
 */
export const DEFAULT_DNS_SERVERS = ['8.8.8.8', '8.8.4.4'];

/**
 * Validates that a string is a valid IPv4 address
 * @param ip - String to validate
 * @returns true if the string is a valid IPv4 address
 */
export function isValidIPv4(ip: string): boolean {
  const ipv4Regex = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
  return ipv4Regex.test(ip);
}

/**
 * Validates that a string is a valid IPv6 address using Node.js built-in net module
 * @param ip - String to validate
 * @returns true if the string is a valid IPv6 address
 */
export function isValidIPv6(ip: string): boolean {
  return isIPv6(ip);
}

/**
 * Pre-defined agent image presets
 */
export const AGENT_IMAGE_PRESETS = ['default', 'act'] as const;

/**
 * Safe patterns for custom agent base images to prevent supply chain attacks.
 * Allows:
 * - Official Ubuntu images (ubuntu:XX.XX)
 * - catthehacker runner images (ghcr.io/catthehacker/ubuntu:runner-XX.XX, full-XX.XX, or act-XX.XX)
 * - Images with SHA256 digest pinning
 */
const SAFE_BASE_IMAGE_PATTERNS = [
  // Official Ubuntu images (e.g., ubuntu:22.04, ubuntu:24.04)
  /^ubuntu:\d+\.\d+$/,
  // catthehacker runner images (e.g., ghcr.io/catthehacker/ubuntu:runner-22.04, act-24.04)
  /^ghcr\.io\/catthehacker\/ubuntu:(runner|full|act)-\d+\.\d+$/,
  // catthehacker images with SHA256 digest pinning
  /^ghcr\.io\/catthehacker\/ubuntu:(runner|full|act)-\d+\.\d+@sha256:[a-f0-9]{64}$/,
  // Official Ubuntu images with SHA256 digest pinning
  /^ubuntu:\d+\.\d+@sha256:[a-f0-9]{64}$/,
];

/**
 * Checks if the given value is a preset name (default, act)
 */
export function isAgentImagePreset(value: string | undefined): value is 'default' | 'act' {
  return value === 'default' || value === 'act';
}

/**
 * Validates that an agent image value is either a preset or an approved custom base image.
 * For presets ('default', 'act'), validation always passes.
 * For custom images, validates against approved patterns to prevent supply chain attacks.
 * @param image - Agent image value (preset or custom image reference)
 * @returns Object with valid boolean and optional error message
 */
export function validateAgentImage(image: string): { valid: boolean; error?: string } {
  // Presets are always valid
  if (isAgentImagePreset(image)) {
    return { valid: true };
  }

  // Check custom images against safe patterns
  const isValid = SAFE_BASE_IMAGE_PATTERNS.some(pattern => pattern.test(image));
  
  if (isValid) {
    return { valid: true };
  }
  
  return {
    valid: false,
    error: `Invalid agent image: "${image}". ` +
      'For security, only approved images are allowed:\n\n' +
      '  Presets (pre-built, fast):\n' +
      '    default  - Minimal ubuntu:22.04 (~200MB)\n' +
      '    act      - GitHub Actions parity (~2GB)\n\n' +
      '  Custom base images (requires --build-local):\n' +
      '    ubuntu:XX.XX (e.g., ubuntu:22.04)\n' +
      '    ghcr.io/catthehacker/ubuntu:runner-XX.XX\n' +
      '    ghcr.io/catthehacker/ubuntu:full-XX.XX\n' +
      '    ghcr.io/catthehacker/ubuntu:act-XX.XX\n\n' +
      '  Use @sha256:... suffix for digest-pinned versions.'
  };
}

/**
 * Result of processing the agent image option
 */
export interface AgentImageResult {
  /** The resolved agent image value */
  agentImage: string;
  /** Whether this is a preset (default, act) or custom image */
  isPreset: boolean;
  /** Log message to display (info level) */
  infoMessage?: string;
  /** Error message if validation failed */
  error?: string;
  /** Whether --build-local is required but not provided */
  requiresBuildLocal?: boolean;
}

/**
 * Processes and validates the agent image option.
 * This function handles the logic for determining whether the image is valid,
 * whether it requires --build-local, and what messages to display.
 *
 * @param agentImageOption - The --agent-image option value (may be undefined)
 * @param buildLocal - Whether --build-local flag was provided
 * @returns AgentImageResult with the processed values
 */
export function processAgentImageOption(
  agentImageOption: string | undefined,
  buildLocal: boolean
): AgentImageResult {
  const agentImage = agentImageOption || 'default';

  // Validate the image (works for both presets and custom images)
  const validation = validateAgentImage(agentImage);
  if (!validation.valid) {
    return {
      agentImage,
      isPreset: false,
      error: validation.error,
    };
  }

  const isPreset = isAgentImagePreset(agentImage);

  // Custom images (not presets) require --build-local
  if (!isPreset) {
    if (!buildLocal) {
      return {
        agentImage,
        isPreset: false,
        requiresBuildLocal: true,
        error: '❌ Custom agent images require --build-local flag\n   Example: awf --build-local --agent-image ghcr.io/catthehacker/ubuntu:runner-22.04 ...',
      };
    }
    return {
      agentImage,
      isPreset: false,
      infoMessage: `Using custom agent base image: ${agentImage}`,
    };
  }

  // Handle presets
  if (agentImage === 'act') {
    return {
      agentImage,
      isPreset: true,
      infoMessage: 'Using agent image preset: act (GitHub Actions parity)',
    };
  }

  // 'default' preset - no special message needed
  return {
    agentImage,
    isPreset: true,
  };
}

/**
 * Result of validating API proxy configuration
 */
export interface ApiProxyValidationResult {
  /** Whether the API proxy should be enabled */
  enabled: boolean;
  /** Warning messages to display */
  warnings: string[];
  /** Debug messages to display */
  debugMessages: string[];
}

/**
 * Validates the API proxy configuration and returns appropriate messages.
 * Accepts booleans (not actual keys) to prevent sensitive data from flowing
 * through to log output (CodeQL: clear-text logging of sensitive information).
 * @param enableApiProxy - Whether --enable-api-proxy flag was provided
 * @param hasOpenaiKey - Whether an OpenAI API key is present
 * @param hasAnthropicKey - Whether an Anthropic API key is present
 * @param hasCopilotKey - Whether a GitHub Copilot API key is present
 * @returns ApiProxyValidationResult with warnings and debug messages
 */
export function validateApiProxyConfig(
  enableApiProxy: boolean,
  hasOpenaiKey?: boolean,
  hasAnthropicKey?: boolean,
  hasCopilotKey?: boolean
): ApiProxyValidationResult {
  if (!enableApiProxy) {
    return { enabled: false, warnings: [], debugMessages: [] };
  }

  const warnings: string[] = [];
  const debugMessages: string[] = [];

  if (!hasOpenaiKey && !hasAnthropicKey && !hasCopilotKey) {
    warnings.push('⚠️  API proxy enabled but no API keys found in environment');
    warnings.push('   Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or COPILOT_GITHUB_TOKEN to use the proxy');
  }
  if (hasOpenaiKey) {
    debugMessages.push('OpenAI API key detected - will be held securely in sidecar');
  }
  if (hasAnthropicKey) {
    debugMessages.push('Anthropic API key detected - will be held securely in sidecar');
  }
  if (hasCopilotKey) {
    debugMessages.push('GitHub Copilot API key detected - will be held securely in sidecar');
  }

  return { enabled: true, warnings, debugMessages };
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
  const rateLimitDisabled = options.rateLimit === false;
  const config: RateLimitConfig = { enabled: !rateLimitDisabled, rpm: 180, rph: 1000, bytesPm: 52428800 };
  if (!rateLimitDisabled) {
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
 * Result of validating flag combinations
 */
export interface FlagValidationResult {
  /** Whether the validation passed */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
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
 * Result of parsing environment variables
 */
export interface ParseEnvResult {
  success: true;
  env: Record<string, string>;
}

export interface ParseEnvError {
  success: false;
  invalidVar: string;
}

/**
 * Result of parsing volume mounts
 */
export interface ParseVolumeMountsResult {
  success: true;
  mounts: string[];
}

export interface ParseVolumeMountsError {
  success: false;
  invalidMount: string;
  reason: string;
}

/**
 * Parses environment variables from an array of KEY=VALUE strings
 * @param envVars Array of environment variable strings in KEY=VALUE format
 * @returns ParseEnvResult with parsed key-value pairs on success, or ParseEnvError with the invalid variable on failure
 */
export function parseEnvironmentVariables(envVars: string[]): ParseEnvResult | ParseEnvError {
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
 * @returns ParseVolumeMountsResult on success, or ParseVolumeMountsError with details on failure
 */
export function parseVolumeMounts(mounts: string[]): ParseVolumeMountsResult | ParseVolumeMountsError {
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

const program = new Command();

program
  .name('awf')
  .description('Network firewall for agentic workflows with domain whitelisting')
  .version(version)
  .option(
    '--allow-domains <domains>',
    'Comma-separated list of allowed domains. Supports wildcards and protocol prefixes:\n' +
    '                                   github.com         - exact domain + subdomains (HTTP & HTTPS)\n' +
    '                                   *.github.com       - any subdomain of github.com\n' +
    '                                   api-*.example.com  - api-* subdomains\n' +
    '                                   https://secure.com - HTTPS only\n' +
    '                                   http://legacy.com  - HTTP only\n' +
    '                                   localhost          - auto-configure for local testing (Playwright, etc.)'
  )
  .option(
    '--allow-domains-file <path>',
    'Path to file containing allowed domains (one per line or comma-separated, supports # comments)'
  )
  .option(
    '--block-domains <domains>',
    'Comma-separated list of blocked domains (takes precedence over allowed domains). Supports wildcards.'
  )
  .option(
    '--block-domains-file <path>',
    'Path to file containing blocked domains (one per line or comma-separated, supports # comments)'
  )
  .option(
    '--log-level <level>',
    'Log level: debug, info, warn, error',
    'info'
  )
  .option(
    '--keep-containers',
    'Keep containers running after command exits',
    false
  )
  .option(
    '--tty',
    'Allocate a pseudo-TTY for the container (required for interactive tools like Claude Code)',
    false
  )
  .option(
    '--work-dir <dir>',
    'Working directory for temporary files',
    path.join(os.tmpdir(), `awf-${Date.now()}`)
  )
  .option(
    '--build-local',
    'Build containers locally instead of using GHCR images',
    false
  )
  .option(
    '--agent-image <value>',
    'Agent container image (default: "default")\n' +
    '                                   Presets (pre-built, fast):\n' +
    '                                     default  - Minimal ubuntu:22.04 (~200MB)\n' +
    '                                     act      - GitHub Actions parity (~2GB)\n' +
    '                                   Custom base images (requires --build-local):\n' +
    '                                     ubuntu:XX.XX\n' +
    '                                     ghcr.io/catthehacker/ubuntu:runner-XX.XX\n' +
    '                                     ghcr.io/catthehacker/ubuntu:full-XX.XX'
  )
  .option(
    '--image-registry <registry>',
    'Container image registry',
    'ghcr.io/github/gh-aw-firewall'
  )
  .option(
    '--image-tag <tag>',
    'Container image tag',
    'latest'
  )
  .option(
    '--skip-pull',
    'Use local images without pulling from registry (requires images to be pre-downloaded)',
    false
  )
  .option(
    '-e, --env <KEY=VALUE>',
    'Additional environment variables to pass to container (can be specified multiple times)',
    (value, previous: string[] = []) => [...previous, value],
    []
  )
  .option(
    '--env-all',
    'Pass all host environment variables to container (excludes system vars like PATH)',
    false
  )
  .option(
    '-v, --mount <host_path:container_path[:mode]>',
    'Volume mount (can be specified multiple times). Format: host_path:container_path[:ro|rw]',
    (value, previous: string[] = []) => [...previous, value],
    []
  )
  .option(
    '--container-workdir <dir>',
    'Working directory inside the container (should match GITHUB_WORKSPACE for path consistency)'
  )
  .option(
    '--dns-servers <servers>',
    'Comma-separated list of trusted DNS servers. DNS traffic is ONLY allowed to these servers (default: 8.8.8.8,8.8.4.4)',
    '8.8.8.8,8.8.4.4'
  )
  .option(
    '--proxy-logs-dir <path>',
    'Directory to save Squid proxy logs to (writes access.log directly to this directory)'
  )
  .option(
    '--enable-host-access',
    'Enable access to host services via host.docker.internal. ' +
    'Security warning: When combined with --allow-domains host.docker.internal, ' +
    'containers can access ANY service on the host machine.',
    false
  )
  .option(
    '--allow-host-ports <ports>',
    'Comma-separated list of ports or port ranges to allow when using --enable-host-access. ' +
    'By default, only ports 80 and 443 are allowed. ' +
    'Example: --allow-host-ports 3000 or --allow-host-ports 3000,8080 or --allow-host-ports 3000-3010,8000-8090'
  )
  .option(
    '--ssl-bump',
    'Enable SSL Bump for HTTPS content inspection (allows URL path filtering for HTTPS)',
    false
  )
  .option(
    '--allow-urls <urls>',
    'Comma-separated list of allowed URL patterns for HTTPS (requires --ssl-bump).\n' +
    '                                   Supports wildcards: https://github.com/myorg/*'
  )
  .option(
    '--enable-api-proxy',
    'Enable API proxy sidecar for holding authentication credentials.\n' +
    '                                   Deploys a Node.js proxy that injects API keys securely.\n' +
    '                                   Supports OpenAI (Codex) and Anthropic (Claude) APIs.',
    false
  )
  .option(
    '--rate-limit-rpm <n>',
    'Requests per minute per provider (default: 180, requires --enable-api-proxy)',
  )
  .option(
    '--rate-limit-rph <n>',
    'Requests per hour per provider (default: 1000, requires --enable-api-proxy)',
  )
  .option(
    '--rate-limit-bytes-pm <n>',
    'Request bytes per minute per provider (default: 52428800 = 50MB, requires --enable-api-proxy)',
  )
  .option(
    '--no-rate-limit',
    'Disable rate limiting in the API proxy (requires --enable-api-proxy)',
  )
  .argument('[args...]', 'Command and arguments to execute (use -- to separate from options)')
  .action(async (args: string[], options) => {
    // Require -- separator for passing command arguments
    if (args.length === 0) {
      console.error('Error: No command specified. Use -- to separate command from options.');
      console.error('Example: awf --allow-domains github.com -- curl https://api.github.com');
      process.exit(1);
    }

    // Command argument handling:
    //
    // SINGLE ARGUMENT (complete shell command):
    //   When a single argument is passed, it's treated as a complete shell
    //   command string. This is CRITICAL for preserving shell variables ($HOME,
    //   $(command), etc.) that must expand in the container, not on the host.
    //
    //   Example: awf -- 'echo $HOME'
    //   → args = ['echo $HOME']  (single element)
    //   → Passed as-is: 'echo $HOME'
    //   → Docker Compose: 'echo $$HOME' (escaped for YAML)
    //   → Container shell: 'echo $HOME' (expands to container home)
    //
    // MULTIPLE ARGUMENTS (shell-parsed by user's shell):
    //   When multiple arguments are passed, each is shell-escaped and joined.
    //   This happens when the user doesn't quote the command.
    //
    //   Example: awf -- curl -H "Auth: token" https://api.github.com
    //   → args = ['curl', '-H', 'Auth: token', 'https://api.github.com']
    //   → joinShellArgs(): curl -H 'Auth: token' https://api.github.com
    //
    // Why not use shell-quote library?
    // - shell-quote expands variables on the HOST ($HOME → /home/hostuser)
    // - We need variables to expand in CONTAINER ($HOME → /root or /home/runner)
    // - The $$$$  escaping pattern requires literal $ preservation
    //
    const agentCommand = args.length === 1 ? args[0] : joinShellArgs(args);
    // Parse and validate options
    const logLevel = options.logLevel as LogLevel;
    if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
      console.error(`Invalid log level: ${logLevel}`);
      process.exit(1);
    }

    logger.setLevel(logLevel);

    // Parse domains from both --allow-domains flag and --allow-domains-file
    let allowedDomains: string[] = [];

    // Parse domains from command-line flag if provided
    if (options.allowDomains) {
      allowedDomains = parseDomains(options.allowDomains);
    }

    // Parse domains from file if provided
    if (options.allowDomainsFile) {
      try {
        const fileDomainsArray = parseDomainsFile(options.allowDomainsFile);
        allowedDomains.push(...fileDomainsArray);
      } catch (error) {
        logger.error(`Failed to read domains file: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    }

    // Log when no domains are specified (all network access will be blocked)
    if (allowedDomains.length === 0) {
      logger.debug('No allowed domains specified - all network access will be blocked');
    }

    // Remove duplicates (in case domains appear in both sources)
    allowedDomains = [...new Set(allowedDomains)];

    // Handle special "localhost" keyword for Playwright testing
    // This makes localhost testing work out of the box without requiring manual configuration
    const localhostResult = processLocalhostKeyword(
      allowedDomains,
      options.enableHostAccess || false,
      options.allowHostPorts
    );

    if (localhostResult.localhostDetected) {
      allowedDomains = localhostResult.allowedDomains;

      // Auto-enable host access
      if (localhostResult.shouldEnableHostAccess) {
        options.enableHostAccess = true;
        logger.warn('⚠️  Security warning: localhost keyword enables host access - agent can reach services on your machine');
        logger.info('ℹ️  localhost keyword detected - automatically enabling host access');
      }

      // Auto-configure common dev ports if not already specified
      if (localhostResult.defaultPorts) {
        options.allowHostPorts = localhostResult.defaultPorts;
        logger.info('ℹ️  localhost keyword detected - allowing common development ports (3000, 4200, 5173, 8080, etc.)');
        logger.info('   Use --allow-host-ports to customize the port list');
      }
    }

    // Validate all domains and patterns
    for (const domain of allowedDomains) {
      try {
        validateDomainOrPattern(domain);
      } catch (error) {
        logger.error(`Invalid domain or pattern: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    }

    // Parse blocked domains from both --block-domains flag and --block-domains-file
    let blockedDomains: string[] = [];

    // Parse blocked domains from command-line flag if provided
    if (options.blockDomains) {
      blockedDomains = parseDomains(options.blockDomains);
    }

    // Parse blocked domains from file if provided
    if (options.blockDomainsFile) {
      try {
        const fileBlockedDomainsArray = parseDomainsFile(options.blockDomainsFile);
        blockedDomains.push(...fileBlockedDomainsArray);
      } catch (error) {
        logger.error(`Failed to read blocked domains file: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    }

    // Remove duplicates from blocked domains
    blockedDomains = [...new Set(blockedDomains)];

    // Validate all blocked domains and patterns
    for (const domain of blockedDomains) {
      try {
        validateDomainOrPattern(domain);
      } catch (error) {
        logger.error(`Invalid blocked domain or pattern: ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    }

    // Parse additional environment variables from --env flags
    let additionalEnv: Record<string, string> = {};
    if (options.env && Array.isArray(options.env)) {
      const parsed = parseEnvironmentVariables(options.env);
      if (!parsed.success) {
        logger.error(`Invalid environment variable format: ${parsed.invalidVar} (expected KEY=VALUE)`);
        process.exit(1);
      }
      additionalEnv = parsed.env;
    }

    // Parse and validate volume mounts from --mount flags
    let volumeMounts: string[] | undefined = undefined;
    if (options.mount && Array.isArray(options.mount) && options.mount.length > 0) {
      const parsed = parseVolumeMounts(options.mount);
      if (!parsed.success) {
        logger.error(`Invalid volume mount: ${parsed.invalidMount}`);
        logger.error(`Reason: ${parsed.reason}`);
        process.exit(1);
      }
      volumeMounts = parsed.mounts;
      logger.debug(`Parsed ${volumeMounts.length} volume mount(s)`);
    }

    // Parse and validate DNS servers
    let dnsServers: string[];
    try {
      dnsServers = parseDnsServers(options.dnsServers);
    } catch (error) {
      logger.error(`Invalid DNS servers: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }

    // Parse --allow-urls for SSL Bump mode
    let allowedUrls: string[] | undefined;
    if (options.allowUrls) {
      allowedUrls = parseDomains(options.allowUrls);
      if (allowedUrls.length > 0 && !options.sslBump) {
        logger.error('--allow-urls requires --ssl-bump to be enabled');
        process.exit(1);
      }

      // Validate URL patterns for security
      for (const url of allowedUrls) {
        // URL patterns must start with https://
        if (!url.startsWith('https://')) {
          logger.error(`URL patterns must start with https:// (got: ${url})`);
          logger.error('Use --allow-domains for domain-level filtering without SSL Bump');
          process.exit(1);
        }

        // Reject overly broad patterns that would bypass security
        const dangerousPatterns = [
          /^https:\/\/\*$/,           // https://*
          /^https:\/\/\*\.\*$/,       // https://*.*
          /^https:\/\/\.\*$/,         // https://.*
          /^\.\*$/,                   // .*
          /^\*$/,                     // *
          /^https:\/\/[^/]*\*[^/]*$/, // https://*anything* without path
        ];

        for (const pattern of dangerousPatterns) {
          if (pattern.test(url)) {
            logger.error(`URL pattern "${url}" is too broad and would bypass security controls`);
            logger.error('URL patterns must include a specific domain and path, e.g., https://github.com/org/*');
            process.exit(1);
          }
        }

        // Ensure pattern has a path component (not just domain)
        const urlWithoutScheme = url.replace(/^https:\/\//, '');
        if (!urlWithoutScheme.includes('/')) {
          logger.error(`URL pattern "${url}" must include a path component`);
          logger.error('For domain-only filtering, use --allow-domains instead');
          logger.error('Example: https://github.com/myorg/* (includes path)');
          process.exit(1);
        }
      }
    }

    // Validate SSL Bump option
    if (options.sslBump) {
      logger.info('SSL Bump mode enabled - HTTPS content inspection will be performed');
      logger.warn('⚠️  SSL Bump intercepts HTTPS traffic. Only use for trusted workloads.');
    }

    // Validate agent image option
    const agentImageResult = processAgentImageOption(options.agentImage, options.buildLocal);
    if (agentImageResult.error) {
      logger.error(agentImageResult.error);
      process.exit(1);
    }
    if (agentImageResult.infoMessage) {
      logger.info(agentImageResult.infoMessage);
    }
    const agentImage = agentImageResult.agentImage;

    const config: WrapperConfig = {
      allowedDomains,
      blockedDomains: blockedDomains.length > 0 ? blockedDomains : undefined,
      agentCommand,
      logLevel,
      keepContainers: options.keepContainers,
      tty: options.tty || false,
      workDir: options.workDir,
      buildLocal: options.buildLocal,
      skipPull: options.skipPull,
      agentImage,
      imageRegistry: options.imageRegistry,
      imageTag: options.imageTag,
      additionalEnv: Object.keys(additionalEnv).length > 0 ? additionalEnv : undefined,
      envAll: options.envAll,
      volumeMounts,
      containerWorkDir: options.containerWorkdir,
      dnsServers,
      proxyLogsDir: options.proxyLogsDir,
      enableHostAccess: options.enableHostAccess,
      allowHostPorts: options.allowHostPorts,
      sslBump: options.sslBump,
      allowedUrls,
      enableApiProxy: options.enableApiProxy,
      openaiApiKey: process.env.OPENAI_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      copilotGithubToken: process.env.COPILOT_GITHUB_TOKEN,
    };

    // Build rate limit config when API proxy is enabled
    if (config.enableApiProxy) {
      const rateLimitResult = buildRateLimitConfig(options);
      if ('error' in rateLimitResult) {
        logger.error(`❌ ${rateLimitResult.error}`);
        process.exit(1);
      }
      config.rateLimitConfig = rateLimitResult.config;
      logger.debug(`Rate limiting: enabled=${rateLimitResult.config.enabled}, rpm=${rateLimitResult.config.rpm}, rph=${rateLimitResult.config.rph}, bytesPm=${rateLimitResult.config.bytesPm}`);
    }

    // Error if rate limit flags are used without --enable-api-proxy
    const rateLimitFlagValidation = validateRateLimitFlags(config.enableApiProxy ?? false, options);
    if (!rateLimitFlagValidation.valid) {
      logger.error(rateLimitFlagValidation.error!);
      process.exit(1);
    }

    // Warn if --env-all is used
    if (config.envAll) {
      logger.warn('⚠️  Using --env-all: All host environment variables will be passed to container');
      logger.warn('   This may expose sensitive credentials if logs or configs are shared');
    }

    // Warn if --allow-host-ports is used without --enable-host-access
    if (config.allowHostPorts && !config.enableHostAccess) {
      logger.error('❌ --allow-host-ports requires --enable-host-access to be set');
      process.exit(1);
    }

    // Error if --skip-pull is used with --build-local (incompatible flags)
    const skipPullValidation = validateSkipPullWithBuildLocal(config.skipPull, config.buildLocal);
    if (!skipPullValidation.valid) {
      logger.error(`❌ ${skipPullValidation.error}`);
      process.exit(1);
    }

    // Warn if --enable-host-access is used with host.docker.internal in allowed domains
    if (config.enableHostAccess) {
      const hasHostDomain = allowedDomains.some(d =>
        d === 'host.docker.internal' || d.endsWith('.host.docker.internal')
      );
      if (hasHostDomain) {
        logger.warn('⚠️  Host access enabled with host.docker.internal in allowed domains');
        logger.warn('   Containers can access ANY service running on the host machine');
        logger.warn('   Only use this for trusted workloads (e.g., MCP gateways)');
      }
    }

    // Validate and warn about API proxy configuration
    // Pass booleans (not actual keys) to prevent sensitive data flow to logger
    const apiProxyValidation = validateApiProxyConfig(
      config.enableApiProxy || false,
      !!config.openaiApiKey,
      !!config.anthropicApiKey,
      !!config.copilotGithubToken
    );

    // Log API proxy status at info level for visibility
    if (config.enableApiProxy) {
      logger.info(`API proxy enabled: OpenAI=${!!config.openaiApiKey}, Anthropic=${!!config.anthropicApiKey}, Copilot=${!!config.copilotGithubToken}`);
    }

    for (const warning of apiProxyValidation.warnings) {
      logger.warn(warning);
    }
    for (const msg of apiProxyValidation.debugMessages) {
      logger.debug(msg);
    }

    // Log config with redacted secrets - remove API keys entirely
    // to prevent sensitive data from flowing to logger (CodeQL sensitive data logging)
    const redactedConfig: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (key === 'openaiApiKey' || key === 'anthropicApiKey' || key === 'copilotGithubToken') continue;
      redactedConfig[key] = key === 'agentCommand' ? redactSecrets(value as string) : value;
    }
    logger.debug('Configuration:', JSON.stringify(redactedConfig, null, 2));
    logger.info(`Allowed domains: ${allowedDomains.join(', ')}`);
    if (blockedDomains.length > 0) {
      logger.info(`Blocked domains: ${blockedDomains.join(', ')}`);
    }
    logger.debug(`DNS servers: ${dnsServers.join(', ')}`);

    let exitCode = 0;
    let containersStarted = false;
    let hostIptablesSetup = false;

    // Handle cleanup on process exit
    const performCleanup = async (signal?: string) => {
      if (signal) {
        logger.info(`Received ${signal}, cleaning up...`);
      }

      if (containersStarted) {
        await stopContainers(config.workDir, config.keepContainers);
      }

      if (hostIptablesSetup && !config.keepContainers) {
        await cleanupHostIptables();
      }

      if (!config.keepContainers) {
        await cleanup(config.workDir, false, config.proxyLogsDir);
        // Note: We don't remove the firewall network here since it can be reused
        // across multiple runs. Cleanup script will handle removal if needed.
      } else {
        logger.info(`Configuration files preserved at: ${config.workDir}`);
        logger.info(`Agent logs available at: ${config.workDir}/agent-logs/`);
        logger.info(`Squid logs available at: ${config.workDir}/squid-logs/`);
        logger.info(`Host iptables rules preserved (--keep-containers enabled)`);
      }
    };

    // Register signal handlers
    process.on('SIGINT', async () => {
      await performCleanup('SIGINT');
      console.error(`Process exiting with code: 130`);
      process.exit(130); // Standard exit code for SIGINT
    });

    process.on('SIGTERM', async () => {
      await performCleanup('SIGTERM');
      console.error(`Process exiting with code: 143`);
      process.exit(143); // Standard exit code for SIGTERM
    });

    try {
      exitCode = await runMainWorkflow(
        config,
        {
          ensureFirewallNetwork,
          setupHostIptables,
          writeConfigs,
          startContainers,
          runAgentCommand,
        },
        {
          logger,
          performCleanup,
          onHostIptablesSetup: () => {
            hostIptablesSetup = true;
          },
          onContainersStarted: () => {
            containersStarted = true;
          },
        }
      );

      console.error(`Process exiting with code: ${exitCode}`);
      process.exit(exitCode);
    } catch (error) {
      logger.error('Fatal error:', error);
      await performCleanup();
      console.error(`Process exiting with code: 1`);
      process.exit(1);
    }
  });

/**
 * Validates that a format string is one of the allowed values
 * 
 * @param format - Format string to validate
 * @param validFormats - Array of valid format options
 * @throws Exits process with error if format is invalid
 */
export function validateFormat(format: string, validFormats: string[]): void {
  if (!validFormats.includes(format)) {
    logger.error(`Invalid format: ${format}. Must be one of: ${validFormats.join(', ')}`);
    process.exit(1);
  }
}

// Logs subcommand - view Squid proxy logs
const logsCmd = program
  .command('logs')
  .description('View and analyze Squid proxy logs from current or previous runs')
  .option('-f, --follow', 'Follow log output in real-time (like tail -f)', false)
  .option(
    '--format <format>',
    'Output format: raw (as-is), pretty (colorized), json (structured)',
    'pretty'
  )
  .option('--source <path>', 'Path to log directory or "running" for live container')
  .option('--list', 'List available log sources', false)
  .option(
    '--with-pid',
    'Enrich logs with PID/process info (real-time only, requires -f)',
    false
  )
  .action(async (options) => {
    // Validate format option
    const validFormats: OutputFormat[] = ['raw', 'pretty', 'json'];
    validateFormat(options.format, validFormats);

    // Warn if --with-pid is used without -f
    if (options.withPid && !options.follow) {
      logger.warn('--with-pid only works with real-time streaming (-f). PID tracking disabled.');
    }

    // Dynamic import to avoid circular dependencies
    const { logsCommand } = await import('./commands/logs');
    await logsCommand({
      follow: options.follow,
      format: options.format as OutputFormat,
      source: options.source,
      list: options.list,
      withPid: options.withPid && options.follow, // Only enable if also following
    });
  });

// Logs stats subcommand - show aggregated statistics
logsCmd
  .command('stats')
  .description('Show aggregated statistics from firewall logs')
  .option(
    '--format <format>',
    'Output format: json, markdown, pretty',
    'pretty'
  )
  .option('--source <path>', 'Path to log directory or "running" for live container')
  .action(async (options) => {
    // Validate format option
    const validFormats = ['json', 'markdown', 'pretty'];
    if (!validFormats.includes(options.format)) {
      logger.error(`Invalid format: ${options.format}. Must be one of: ${validFormats.join(', ')}`);
      process.exit(1);
    }

    const { statsCommand } = await import('./commands/logs-stats');
    await statsCommand({
      format: options.format as 'json' | 'markdown' | 'pretty',
      source: options.source,
    });
  });

// Logs summary subcommand - generate summary report (optimized for GitHub Actions)
logsCmd
  .command('summary')
  .description('Generate summary report (defaults to markdown for GitHub Actions)')
  .option(
    '--format <format>',
    'Output format: json, markdown, pretty',
    'markdown'
  )
  .option('--source <path>', 'Path to log directory or "running" for live container')
  .action(async (options) => {
    // Validate format option
    const validFormats = ['json', 'markdown', 'pretty'];
    validateFormat(options.format, validFormats);

    const { summaryCommand } = await import('./commands/logs-summary');
    await summaryCommand({
      format: options.format as 'json' | 'markdown' | 'pretty',
      source: options.source,
    });
  });

// Only parse arguments if this file is run directly (not imported as a module)
if (require.main === module) {
  program.parse();
}
