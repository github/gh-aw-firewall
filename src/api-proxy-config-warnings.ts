import {
  DEFAULT_OPENAI_API_TARGET,
  DEFAULT_ANTHROPIC_API_TARGET,
  DEFAULT_COPILOT_API_TARGET,
  DEFAULT_GEMINI_API_TARGET,
} from './domain-utils';

/**
 * Validates that a custom API proxy target hostname is covered by the allowed domains list.
 * Returns a warning message if the target domain is not in allowed domains, otherwise null.
 * @param targetHost - The custom target hostname (e.g. "custom.example.com")
 * @param defaultHost - The default target hostname for this provider (e.g. "api.openai.com")
 * @param flagName - The CLI flag name for use in the warning message (e.g. "--openai-api-target")
 * @param allowedDomains - The list of domains allowed through the firewall
 */
function validateApiTargetInAllowedDomains(
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
