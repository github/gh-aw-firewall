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
 * @param hasGeminiKey - Whether a Google Gemini API key is present
 * @param hasAnthropicWif - Whether Anthropic WIF (GitHub OIDC) auth is configured
 * @returns ApiProxyValidationResult with warnings and debug messages
 */
export function validateApiProxyConfig(
  enableApiProxy: boolean,
  hasOpenaiKey?: boolean,
  hasAnthropicKey?: boolean,
  hasCopilotKey?: boolean,
  hasGeminiKey?: boolean,
  hasAnthropicWif?: boolean,
): ApiProxyValidationResult {
  if (!enableApiProxy) {
    return { enabled: false, warnings: [], debugMessages: [] };
  }

  const warnings: string[] = [];
  const debugMessages: string[] = [];

  if (!hasOpenaiKey && !hasAnthropicKey && !hasCopilotKey && !hasGeminiKey && !hasAnthropicWif) {
    warnings.push('⚠️  API proxy enabled but no API keys found in environment');
    warnings.push('   Set OPENAI_API_KEY, ANTHROPIC_API_KEY, COPILOT_GITHUB_TOKEN, COPILOT_PROVIDER_API_KEY, or GEMINI_API_KEY to use the proxy');
  }
  if (hasOpenaiKey) {
    debugMessages.push('OpenAI API key detected - will be held securely in sidecar');
  }
  if (hasAnthropicKey) {
    debugMessages.push('Anthropic API key detected - will be held securely in sidecar');
  }
  if (hasAnthropicWif) {
    debugMessages.push('Anthropic WIF (GitHub OIDC) auth configured - OIDC token exchange will be used in sidecar');
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
