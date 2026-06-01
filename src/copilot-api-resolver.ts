import {
  deriveCopilotApiBasePathFromProviderBaseUrl,
  deriveCopilotApiTargetFromProviderBaseUrl,
} from './copilot-api-resolver.internal';
import { logger } from './logger';

let copilotApiKeyDeprecationWarned = false;

/**
 * Resolve the upstream Copilot BYOK key from supported environment variables.
 * Only COPILOT_PROVIDER_API_KEY is supported for BYOK provider credentials.
 */
export function resolveCopilotApiKey(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (env.COPILOT_PROVIDER_API_KEY !== undefined) {
    return env.COPILOT_PROVIDER_API_KEY;
  }

  if (env.COPILOT_API_KEY !== undefined && !copilotApiKeyDeprecationWarned) {
    copilotApiKeyDeprecationWarned = true;
    logger.warn(
      'COPILOT_API_KEY is set but COPILOT_PROVIDER_API_KEY is not. ' +
        'Agentic Workflow Firewall (AWF) no longer treats COPILOT_API_KEY as a BYOK upstream credential ' +
        '(it is owned by the Copilot CLI). Set COPILOT_PROVIDER_API_KEY (and COPILOT_PROVIDER_BASE_URL) ' +
        'for BYOK, or COPILOT_GITHUB_TOKEN for standard Copilot auth.',
    );
  }

  return undefined;
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
