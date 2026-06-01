import {
  deriveCopilotApiBasePathFromProviderBaseUrl,
  deriveCopilotApiTargetFromProviderBaseUrl,
} from './copilot-api-resolver.internal';

/**
 * Resolve the Copilot BYOK key from supported environment variables.
 *
 * `COPILOT_PROVIDER_API_KEY` takes precedence over `COPILOT_API_KEY`.
 *
 * Rationale: `COPILOT_API_KEY` is the Copilot CLI's *session token* env var,
 * not a BYOK upstream credential. In integrations such as gh-aw's
 * `byok-copilot: true` flow, `COPILOT_API_KEY` is intentionally set to a
 * placeholder sentinel (e.g. `dummy-byok-key-for-offline-mode`) to satisfy
 * the CLI's startup check, while the real upstream BYOK credential is passed
 * via `COPILOT_PROVIDER_API_KEY` (paired with `COPILOT_PROVIDER_BASE_URL`).
 * Preferring `COPILOT_PROVIDER_API_KEY` here prevents AWF from forwarding the
 * sentinel to the sidecar (github/gh-aw#35575, github/gh-aw-firewall#4040).
 *
 * `COPILOT_API_KEY` is still honored as a fallback for callers that have
 * only ever set that variable.
 */
export function resolveCopilotApiKey(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env.COPILOT_PROVIDER_API_KEY || env.COPILOT_API_KEY;
}

/**
 * Resolve Copilot target/base-path routing for BYOK provider-style env vars.
 *
 * Target precedence:
 *   1. --copilot-api-target
 *   2. COPILOT_API_TARGET
 *   3. Hostname from COPILOT_PROVIDER_BASE_URL
 *
 * Base path precedence:
 *   1. COPILOT_API_BASE_PATH
 *   2. Pathname from COPILOT_PROVIDER_BASE_URL
 */
export function resolveCopilotApiRouting(
  options: { copilotApiTarget?: string },
  env: Record<string, string | undefined> = process.env
): { copilotApiTarget?: string; copilotApiBasePath?: string } {
  const providerBaseUrl = env.COPILOT_PROVIDER_BASE_URL;
  const copilotApiTargetFromProviderBaseUrl = deriveCopilotApiTargetFromProviderBaseUrl(providerBaseUrl);
  const copilotApiBasePathFromProviderBaseUrl = deriveCopilotApiBasePathFromProviderBaseUrl(providerBaseUrl);

  return {
    copilotApiTarget:
      options.copilotApiTarget ||
      env.COPILOT_API_TARGET ||
      copilotApiTargetFromProviderBaseUrl,
    copilotApiBasePath:
      env.COPILOT_API_BASE_PATH ||
      copilotApiBasePathFromProviderBaseUrl,
  };
}
