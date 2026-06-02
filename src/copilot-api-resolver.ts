import {
  deriveCopilotApiBasePathFromProviderBaseUrl,
  deriveCopilotApiTargetFromProviderBaseUrl,
} from './copilot-api-resolver.internal';
import { COPILOT_PLACEHOLDER_TOKEN } from './constants/placeholders';
import { logger } from './logger';

let copilotApiKeyDeprecationWarned = false;
const COPILOT_DUMMY_BYOK_KEY = 'dummy-byok-key-for-offline-mode';

function shouldWarnForDeprecatedLegacyCopilotApiKey(legacyKey: string | undefined): boolean {
  if (legacyKey === undefined) {
    return false;
  }

  const normalizedLegacyKey = legacyKey.trim();
  if (normalizedLegacyKey.length === 0) {
    return false;
  }

  return normalizedLegacyKey !== COPILOT_PLACEHOLDER_TOKEN && normalizedLegacyKey !== COPILOT_DUMMY_BYOK_KEY;
}

/**
 * Resolve the Copilot BYOK key from supported environment variables.
 * COPILOT_PROVIDER_API_KEY is the only supported BYOK key source.
 */
export function resolveCopilotApiKey(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (env.COPILOT_PROVIDER_API_KEY !== undefined) {
    return env.COPILOT_PROVIDER_API_KEY;
  }

  if (shouldWarnForDeprecatedLegacyCopilotApiKey(env.COPILOT_API_KEY) && !copilotApiKeyDeprecationWarned) {
    logger.warn(
      'COPILOT_API_KEY is deprecated for BYOK and will be ignored; use COPILOT_PROVIDER_API_KEY and COPILOT_PROVIDER_BASE_URL instead.'
    );
    copilotApiKeyDeprecationWarned = true;
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
