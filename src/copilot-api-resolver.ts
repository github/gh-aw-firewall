import {
  deriveCopilotApiBasePathFromProviderBaseUrl,
  deriveCopilotApiTargetFromProviderBaseUrl,
} from './copilot-api-resolver.internal';
import { logger } from './logger';

/**
 * Tracks whether we've already logged the COPILOT_API_KEY deprecation warning
 * in this process so we don't spam users with repeats per invocation of the
 * resolver (which is called from multiple sites in build-config and CLI tests).
 */
let copilotApiKeyDeprecationWarned = false;

/**
 * Reset the deprecation-warning latch. Intended for tests; not exported from
 * the production module surface (see `copilot-api-resolver.test-utils.ts`).
 */
export function __resetCopilotApiKeyDeprecationLatchForTesting(): void {
  copilotApiKeyDeprecationWarned = false;
}

/**
 * Resolve the upstream Copilot BYOK key from supported environment variables.
 *
 * Only `COPILOT_PROVIDER_API_KEY` is consulted. The legacy `COPILOT_API_KEY`
 * input is intentionally ignored here:
 *
 *   - The Copilot CLI itself reads `COPILOT_API_KEY` as its session token.
 *     In BYOK mode that value is gh-aw's placeholder sentinel
 *     (`dummy-byok-key-for-offline-mode`), not a real upstream credential.
 *     Forwarding it produced github/gh-aw#35575 / github/gh-aw-firewall#4040.
 *   - The real, documented BYOK entry point is `COPILOT_PROVIDER_API_KEY`,
 *     paired with `COPILOT_PROVIDER_BASE_URL` (see
 *     https://github.blog/changelog/2026-04-07-copilot-cli-now-supports-byok-and-local-models/).
 *   - Non-BYOK Copilot auth has its own field on the resolved config
 *     (`copilotGithubToken`, sourced from `COPILOT_GITHUB_TOKEN`) and does not
 *     flow through this resolver.
 *
 * For backwards compatibility, if a caller still has `COPILOT_API_KEY` set
 * but no `COPILOT_PROVIDER_API_KEY`, we log a one-time deprecation warning so
 * operators can migrate. The legacy value is *not* forwarded.
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
        'AWF no longer treats COPILOT_API_KEY as a BYOK upstream credential ' +
        '(it is owned by the Copilot CLI). Set COPILOT_PROVIDER_API_KEY ' +
        '(and COPILOT_PROVIDER_BASE_URL) to enable BYOK, or COPILOT_GITHUB_TOKEN ' +
        'for standard Copilot auth.',
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
