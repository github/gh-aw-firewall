import * as fs from 'fs';
import { isIPv6 } from 'net';

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
 * @deprecated Import from dns-resolver.ts instead
 */

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
interface AgentImageResult {
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

/** Default upstream hostname for OpenAI API requests in the api-proxy sidecar */
export const DEFAULT_OPENAI_API_TARGET = 'api.openai.com';
/** Default upstream hostname for Anthropic API requests in the api-proxy sidecar */
export const DEFAULT_ANTHROPIC_API_TARGET = 'api.anthropic.com';
/** Default upstream hostname for Google Gemini API requests in the api-proxy sidecar */
export const DEFAULT_GEMINI_API_TARGET = 'generativelanguage.googleapis.com';
/** Default upstream hostname for GitHub Copilot API requests in the api-proxy sidecar (when running on github.com) */
export const DEFAULT_COPILOT_API_TARGET = 'api.githubcopilot.com';
