import {
  deriveCopilotApiBasePathFromProviderBaseUrl,
  deriveCopilotApiTargetFromProviderBaseUrl,
} from './copilot-api-resolver.internal';

/**
 * Sentinel value injected by gh-aw's compiled lock-file `pathSetup` step as
 * `COPILOT_API_KEY` whenever the user is operating in BYOK mode. The Copilot
 * CLI requires *some* value in `COPILOT_API_KEY` to start up, but in BYOK
 * mode the real upstream credential is `COPILOT_PROVIDER_API_KEY`, which is
 * what the api-proxy sidecar must actually forward upstream.
 *
 * Treating this sentinel as "unset" lets the resolver fall through to
 * `COPILOT_PROVIDER_API_KEY` instead of forwarding the placeholder, which
 * would otherwise produce upstream 401/503 responses.
 *
 * See: github/gh-aw#33116 (introduces the sentinel) and
 * github/gh-aw#35575 / github/gh-aw-firewall#4040 (the resulting BYOK
 * regression this constant guards against).
 */
const COPILOT_BYOK_DUMMY_API_KEY = 'dummy-byok-key-for-offline-mode';

/**
 * Resolve the Copilot BYOK key from supported environment variables.
 *
 * Precedence:
 *   1. `COPILOT_PROVIDER_API_KEY` (explicit BYOK signal; user opted in to a
 *      non-Copilot upstream provider)
 *   2. `COPILOT_API_KEY` (real Copilot token in non-BYOK mode)
 *
 * The BYOK dummy sentinel injected into `COPILOT_API_KEY` by gh-aw is treated
 * as unset, so it never shadows a real `COPILOT_PROVIDER_API_KEY`. The
 * sentinel check is only applied to `COPILOT_API_KEY` since that is the only
 * variable gh-aw writes it into; `COPILOT_PROVIDER_API_KEY` is forwarded
 * verbatim.
 *
 * Empty string is preserved (not coerced to undefined) for callers that
 * distinguish "explicitly set to empty" from "not set".
 */
export function resolveCopilotApiKey(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (env.COPILOT_PROVIDER_API_KEY !== undefined) return env.COPILOT_PROVIDER_API_KEY;

  const apiKey = env.COPILOT_API_KEY;
  if (apiKey !== undefined && apiKey !== COPILOT_BYOK_DUMMY_API_KEY) return apiKey;

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
