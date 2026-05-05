import {
  DEFAULT_OPENAI_API_TARGET,
  DEFAULT_ANTHROPIC_API_TARGET,
  DEFAULT_COPILOT_API_TARGET,
  DEFAULT_GEMINI_API_TARGET,
} from './domain-utils';

/**
 * Result of validating API proxy configuration
 */
interface ApiProxyValidationResult {
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
 * @param hasGeminiKey - Whether a Google Gemini API key is present
 * @returns ApiProxyValidationResult with warnings and debug messages
 */
export function validateApiProxyConfig(
  enableApiProxy: boolean,
  hasOpenaiKey?: boolean,
  hasAnthropicKey?: boolean,
  hasCopilotKey?: boolean,
  hasGeminiKey?: boolean
): ApiProxyValidationResult {
  if (!enableApiProxy) {
    return { enabled: false, warnings: [], debugMessages: [] };
  }

  const warnings: string[] = [];
  const debugMessages: string[] = [];

  if (!hasOpenaiKey && !hasAnthropicKey && !hasCopilotKey && !hasGeminiKey) {
    warnings.push('⚠️  API proxy enabled but no API keys found in environment');
    warnings.push('   Set OPENAI_API_KEY, ANTHROPIC_API_KEY, COPILOT_GITHUB_TOKEN, COPILOT_API_KEY, or GEMINI_API_KEY to use the proxy');
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
  if (hasGeminiKey) {
    debugMessages.push('Google Gemini API key detected - will be held securely in sidecar');
  }

  return { enabled: true, warnings, debugMessages };
}

/**
 * Validates the value of --anthropic-cache-tail-ttl.
 * Exits the process with an error if the value is not "5m" or "1h".
 * @param value - The value provided for --anthropic-cache-tail-ttl (may be undefined)
 */
export function validateAnthropicCacheTailTtl(value: string | undefined): void {
  if (value !== undefined && value !== '5m' && value !== '1h') {
    console.error(`Invalid --anthropic-cache-tail-ttl value: "${value}". Must be "5m" or "1h".`);
    process.exit(1);
  }
}

/**
 * Validates that a custom API proxy target hostname is covered by the allowed domains list.
 * Returns a warning message if the target domain is not in allowed domains, otherwise null.
 * @param targetHost - The custom target hostname (e.g. "custom.example.com")
 * @param defaultHost - The default target hostname for this provider (e.g. "api.openai.com")
 * @param flagName - The CLI flag name for use in the warning message (e.g. "--openai-api-target")
 * @param allowedDomains - The list of domains allowed through the firewall
 */
export function validateApiTargetInAllowedDomains(
  targetHost: string,
  defaultHost: string,
  flagName: string,
  allowedDomains: string[]
): string | null {
  // No warning needed if using the default host
  if (targetHost === defaultHost) return null;

  // Check if the hostname or any of its parent domains is explicitly allowed
  const isDomainAllowed = allowedDomains.some(d => {
    const domain = d.startsWith('.') ? d.slice(1) : d;
    return targetHost === domain || targetHost.endsWith('.' + domain);
  });

  if (!isDomainAllowed) {
    return `${flagName}=${targetHost} is not in --allow-domains. Add "${targetHost}" to --allow-domains or outbound traffic to this host will be blocked by the firewall.`;
  }

  return null;
}

/**
 * Emits warnings for custom API proxy target hostnames that are not in the allowed domains list.
 * Checks OpenAI, Anthropic, and Copilot targets when the API proxy is enabled.
 * @param config - Partial wrapper config with API proxy settings
 * @param allowedDomains - The list of domains allowed through the firewall
 * @param warn - Function to emit a warning message
 */
export function emitApiProxyTargetWarnings(
  config: { enableApiProxy?: boolean; openaiApiTarget?: string; anthropicApiTarget?: string; copilotApiTarget?: string; geminiApiTarget?: string },
  allowedDomains: string[],
  warn: (msg: string) => void
): void {
  if (!config.enableApiProxy) return;

  const openaiTargetWarning = validateApiTargetInAllowedDomains(
    config.openaiApiTarget ?? DEFAULT_OPENAI_API_TARGET,
    DEFAULT_OPENAI_API_TARGET,
    '--openai-api-target',
    allowedDomains
  );
  if (openaiTargetWarning) {
    warn(`⚠️  ${openaiTargetWarning}`);
  }

  const anthropicTargetWarning = validateApiTargetInAllowedDomains(
    config.anthropicApiTarget ?? DEFAULT_ANTHROPIC_API_TARGET,
    DEFAULT_ANTHROPIC_API_TARGET,
    '--anthropic-api-target',
    allowedDomains
  );
  if (anthropicTargetWarning) {
    warn(`⚠️  ${anthropicTargetWarning}`);
  }

  const copilotTargetWarning = validateApiTargetInAllowedDomains(
    config.copilotApiTarget ?? DEFAULT_COPILOT_API_TARGET,
    DEFAULT_COPILOT_API_TARGET,
    '--copilot-api-target',
    allowedDomains
  );
  if (copilotTargetWarning) {
    warn(`⚠️  ${copilotTargetWarning}`);
  }

  const geminiTargetWarning = validateApiTargetInAllowedDomains(
    config.geminiApiTarget ?? DEFAULT_GEMINI_API_TARGET,
    DEFAULT_GEMINI_API_TARGET,
    '--gemini-api-target',
    allowedDomains
  );
  if (geminiTargetWarning) {
    warn(`⚠️  ${geminiTargetWarning}`);
  }
}

/**
 * Logs CLI proxy status and emits warnings when misconfigured.
 * Extracted for testability (same pattern as emitApiProxyTargetWarnings).
 */
export function emitCliProxyStatusLogs(
  config: { difcProxyHost?: string; githubToken?: string },
  info: (msg: string) => void,
  warn: (msg: string) => void,
): void {
  if (!config.difcProxyHost) return;

  info(`CLI proxy enabled: connecting to external DIFC proxy at ${config.difcProxyHost}`);
  if (config.githubToken) {
    info('GitHub token present — will be excluded from agent environment');
  } else {
    warn('⚠️  CLI proxy enabled but no GitHub token found in environment');
    warn('   The external DIFC proxy handles token authentication');
  }
}

/**
 * Warns when a classic GitHub PAT (ghp_* prefix) is used alongside COPILOT_MODEL.
 * Copilot CLI 1.0.21+ performs a GET /models validation at startup when COPILOT_MODEL
 * is set. This endpoint rejects classic PATs, causing the agent to fail with exit code 1
 * before any useful work begins.
 * Accepts booleans (not actual tokens/values) to prevent sensitive data from flowing
 * through to log output (CodeQL: clear-text logging of sensitive information).
 * @param isClassicPAT - Whether COPILOT_GITHUB_TOKEN starts with 'ghp_' (classic PAT)
 * @param hasCopilotModel - Whether COPILOT_MODEL is set in the agent environment
 * @param warn - Function to emit a warning message
 */
export function warnClassicPATWithCopilotModel(
  isClassicPAT: boolean,
  hasCopilotModel: boolean,
  warn: (msg: string) => void,
): void {
  if (!isClassicPAT || !hasCopilotModel) return;

  warn('⚠️  COPILOT_MODEL is set with a classic PAT (ghp_* token)');
  warn('   Copilot CLI 1.0.21+ validates COPILOT_MODEL via GET /models at startup.');
  warn('   Classic PATs are rejected by this endpoint — the agent will likely fail with exit code 1.');
  warn('   Use a fine-grained PAT or OAuth token, or unset COPILOT_MODEL to skip model validation.');
}

/**
 * Extracts GHEC domains from GITHUB_SERVER_URL and GITHUB_API_URL environment variables.
 * When GITHUB_SERVER_URL points to a GHEC tenant (*.ghe.com), returns the tenant hostname,
 * its API subdomain, the Copilot API subdomain, and the Copilot telemetry subdomain so they
 * can be auto-added to the firewall allowlist.
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns Array of GHEC-related domains (tenant, api.*, copilot-api.*, copilot-telemetry-service.*)
 *          to auto-add to the allowlist, or an empty array if not GHEC
 */
export function extractGhecDomainsFromServerUrl(
  env: Record<string, string | undefined> = process.env
): string[] {
  const domains: string[] = [];

  // Extract from GITHUB_SERVER_URL (e.g., https://company.ghe.com)
  const serverUrl = env['GITHUB_SERVER_URL'];
  if (serverUrl) {
    try {
      const hostname = new URL(serverUrl).hostname;
      if (hostname !== 'github.com' && hostname.endsWith('.ghe.com')) {
        // GHEC tenant with data residency: add the tenant domain, API subdomain,
        // Copilot inference subdomain, and Copilot telemetry subdomain.
        // e.g., company.ghe.com → company.ghe.com + api.company.ghe.com
        //        + copilot-api.company.ghe.com + copilot-telemetry-service.company.ghe.com
        domains.push(hostname);
        domains.push(`api.${hostname}`);
        domains.push(`copilot-api.${hostname}`);
        domains.push(`copilot-telemetry-service.${hostname}`);
      }
    } catch {
      // Invalid URL — skip
    }
  }

  // Extract from GITHUB_API_URL (e.g., https://api.company.ghe.com)
  const apiUrl = env['GITHUB_API_URL'];
  if (apiUrl) {
    try {
      const hostname = new URL(apiUrl).hostname;
      if (hostname !== 'api.github.com' && hostname.endsWith('.ghe.com')) {
        if (!domains.includes(hostname)) {
          domains.push(hostname);
        }
      }
    } catch {
      // Invalid URL — skip
    }
  }

  return domains;
}

/**
 * Extracts GHES API domains from engine.api-target environment variable.
 * When engine.api-target is set (indicating GHES), returns the GHES hostname,
 * API subdomain, and required Copilot API domains.
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns Array of domains to auto-add to allowlist, or empty array if not GHES
 */
export function extractGhesDomainsFromEngineApiTarget(
  env: Record<string, string | undefined> = process.env
): string[] {
  const engineApiTarget = env['ENGINE_API_TARGET'];
  if (!engineApiTarget) {
    return [];
  }

  const domains: string[] = [];

  try {
    // Parse the engine.api-target URL (e.g., https://api.github.mycompany.com)
    const url = new URL(engineApiTarget);
    const hostname = url.hostname;

    // Extract the base GHES domain from api.github.<ghes-domain>
    // For example: api.github.mycompany.com → github.mycompany.com
    if (hostname.startsWith('api.')) {
      const baseDomain = hostname.substring(4); // Remove 'api.' prefix
      domains.push(baseDomain);
      domains.push(hostname); // Also add the api subdomain itself
    } else {
      // If it doesn't start with 'api.', just add the hostname
      domains.push(hostname);
    }

    // Add Copilot API domains (needed even on GHES since Copilot models run in GitHub's cloud)
    domains.push('api.githubcopilot.com');
    domains.push('api.enterprise.githubcopilot.com');
    domains.push('telemetry.enterprise.githubcopilot.com');
  } catch {
    // Invalid URL format - skip GHES domain extraction
    return [];
  }

  return domains;
}

/**
 * Resolves API target values from CLI options and environment variables, and merges them
 * into the allowed domains list. Also ensures each target is present as an https:// URL.
 * @param options - Partial options with API target flag values
 * @param allowedDomains - The current list of allowed domains (mutated in place)
 * @param env - Environment variables (defaults to process.env)
 * @param debug - Optional debug logging function
 * @returns The updated allowedDomains array (same reference, mutated)
 */
export function resolveApiTargetsToAllowedDomains(
  options: {
    copilotApiTarget?: string;
    openaiApiTarget?: string;
    anthropicApiTarget?: string;
    geminiApiTarget?: string;
  },
  allowedDomains: string[],
  env: Record<string, string | undefined> = process.env,
  debug: (msg: string) => void = () => {}
): string[] {
  const apiTargets: string[] = [];

  if (options.copilotApiTarget) {
    apiTargets.push(options.copilotApiTarget);
  } else if (env['COPILOT_API_TARGET']) {
    apiTargets.push(env['COPILOT_API_TARGET']);
  }

  if (options.openaiApiTarget) {
    apiTargets.push(options.openaiApiTarget);
  } else if (env['OPENAI_API_TARGET']) {
    apiTargets.push(env['OPENAI_API_TARGET']);
  }

  if (options.anthropicApiTarget) {
    apiTargets.push(options.anthropicApiTarget);
  } else if (env['ANTHROPIC_API_TARGET']) {
    apiTargets.push(env['ANTHROPIC_API_TARGET']);
  }

  if (options.geminiApiTarget) {
    apiTargets.push(options.geminiApiTarget);
  } else if (env['GEMINI_API_TARGET']) {
    apiTargets.push(env['GEMINI_API_TARGET']);
  }

  // Auto-populate GHEC domains when GITHUB_SERVER_URL points to a *.ghe.com tenant
  const ghecDomains = extractGhecDomainsFromServerUrl(env);
  if (ghecDomains.length > 0) {
    for (const domain of ghecDomains) {
      if (!allowedDomains.includes(domain)) {
        allowedDomains.push(domain);
      }
    }
    debug(`Auto-added GHEC domains from GITHUB_SERVER_URL/GITHUB_API_URL: ${ghecDomains.join(', ')}`);
  }

  // Auto-populate GHES domains when engine.api-target is set
  const ghesDomains = extractGhesDomainsFromEngineApiTarget(env);
  if (ghesDomains.length > 0) {
    for (const domain of ghesDomains) {
      if (!allowedDomains.includes(domain)) {
        allowedDomains.push(domain);
      }
    }
    debug(`Auto-added GHES domains from engine.api-target: ${ghesDomains.join(', ')}`);
  }

  // Merge raw target values into the allowedDomains list so that later
  // checks/logs about "no allowed domains" see the final, expanded allowlist.
  const normalizedApiTargets = apiTargets.filter((t) => typeof t === 'string' && t.trim().length > 0);
  if (normalizedApiTargets.length > 0) {
    for (const target of normalizedApiTargets) {
      if (!allowedDomains.includes(target)) {
        allowedDomains.push(target);
      }
    }
    debug(`Auto-added API target values to allowed domains: ${normalizedApiTargets.join(', ')}`);
  }

  // Also ensure each target is present as an explicit https:// URL
  for (const target of normalizedApiTargets) {

    // Ensure auto-added API targets are explicitly HTTPS to avoid over-broad HTTP+HTTPS allowlisting
    const normalizedTarget = /^https?:\/\//.test(target) ? target : `https://${target}`;

    if (!allowedDomains.includes(normalizedTarget)) {
      allowedDomains.push(normalizedTarget);
      debug(`Automatically added API target to allowlist: ${normalizedTarget}`);
    }
  }

  return allowedDomains;
}
