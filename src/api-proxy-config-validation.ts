import type { WrapperConfig } from './types';
import { readEnvFile } from './github-env';

export function validateApiAuthScheme(value: string | undefined): void {
  if (value !== undefined && !/^[!#$%&'*+.^_`|~A-Za-z0-9-]+(?![\s\S])/.test(value)) {
    throw new Error('Invalid API auth scheme: expected an HTTP authentication scheme token');
  }
}

export function validateDatabricksHost(value: string | undefined): URL {
  const invalid = () => new Error('Invalid Databricks host: expected an HTTPS workspace origin without credentials, path, query or fragment');
  if (!value || !/^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?\/?(?![\s\S])/.test(value)) {
    throw invalid();
  }
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || (url.port && Number(url.port) === 0)) throw invalid();
  return url;
}

/** Resolve only Databricks OIDC; other provider enablement remains unchanged. */
export function resolveDatabricksOidcHost(config: WrapperConfig): URL | undefined {
  let fileEnvironment: Record<string, string> = {};
  if (config.envFile) {
    try { fileEnvironment = readEnvFile(config.envFile); } catch {
      // Preflight warning checks must not fail unrelated providers on unreadable env files.
    }
  }
  const resolve = (key: keyof WrapperConfig, envVar: string): string | undefined =>
    (config[key] as string | undefined)
    ?? config.additionalEnv?.[envVar]
    ?? fileEnvironment[envVar]
    ?? process.env[envVar];
  const type = resolve('authType', 'AWF_AUTH_TYPE')?.trim().toLowerCase();
  const provider = resolve('authProvider', 'AWF_AUTH_PROVIDER')?.trim().toLowerCase();
  if (type !== 'github-oidc' || provider !== 'databricks') return undefined;
  const host = validateDatabricksHost(resolve('authDatabricksHost', 'AWF_AUTH_DATABRICKS_HOST'));
  if (!resolve('authOidcAudience', 'AWF_AUTH_OIDC_AUDIENCE')?.trim()) {
    throw new Error('Databricks OIDC requires a nonempty oidcAudience');
  }
  return host;
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
 * @param hasGeminiKey - Whether a Google Gemini API key is present
 * @param hasAnthropicWif - Whether Anthropic WIF (GitHub OIDC) auth is configured
 * @param hasGoogleApiKey - Whether a Google API key for Vertex AI is present
 * @param hasDatabricksOidc - Whether Databricks OIDC auth is configured without requiring a static key
 * @returns ApiProxyValidationResult with warnings and debug messages
 */
export function validateApiProxyConfig(
  enableApiProxy: boolean,
  hasOpenaiKey?: boolean,
  hasAnthropicKey?: boolean,
  hasCopilotKey?: boolean,
  hasGeminiKey?: boolean,
  hasAnthropicWif?: boolean,
  hasGoogleApiKey?: boolean,
  hasDatabricksOidc?: boolean,
): ApiProxyValidationResult {
  if (!enableApiProxy) {
    return { enabled: false, warnings: [], debugMessages: [] };
  }

  const warnings: string[] = [];
  const debugMessages: string[] = [];

  if (!hasOpenaiKey && !hasAnthropicKey && !hasCopilotKey && !hasGeminiKey && !hasAnthropicWif && !hasGoogleApiKey && !hasDatabricksOidc) {
    warnings.push('⚠️  API proxy enabled but no API keys found in environment');
    warnings.push('   Set OPENAI_API_KEY, ANTHROPIC_API_KEY, COPILOT_GITHUB_TOKEN, COPILOT_PROVIDER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY to use the proxy');
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
  if (hasDatabricksOidc) {
    debugMessages.push('Databricks OIDC auth configured - OIDC token exchange will be used in sidecar');
  }
  if (hasCopilotKey) {
    debugMessages.push('GitHub Copilot API key detected - will be held securely in sidecar');
  }
  if (hasGeminiKey) {
    debugMessages.push('Google Gemini API key detected - will be held securely in sidecar');
  }
  if (hasGoogleApiKey) {
    debugMessages.push('Google API key (Vertex AI) detected - will be held securely in sidecar');
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
