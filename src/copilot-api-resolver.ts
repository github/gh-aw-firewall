/**
 * Resolve the Copilot BYOK key from supported environment variables.
 * COPILOT_API_KEY takes precedence over COPILOT_PROVIDER_API_KEY.
 */
export function resolveCopilotApiKey(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env.COPILOT_API_KEY || env.COPILOT_PROVIDER_API_KEY;
}

/**
 * Derive a Copilot API target hostname from COPILOT_PROVIDER_BASE_URL.
 * Returns undefined when the value is empty or not a valid URL/host.
 */
export function deriveCopilotApiTargetFromProviderBaseUrl(
  providerBaseUrl: string | undefined
): string | undefined {
  const trimmed = providerBaseUrl?.trim();
  if (!trimmed) return undefined;

  const candidate = trimmed.includes('://')
    ? trimmed
    : `https://${trimmed}`;

  try {
    return new URL(candidate).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derive a Copilot API base-path prefix from COPILOT_PROVIDER_BASE_URL.
 * Returns undefined when the value is empty, invalid, or has no path.
 */
export function deriveCopilotApiBasePathFromProviderBaseUrl(
  providerBaseUrl: string | undefined
): string | undefined {
  const trimmed = providerBaseUrl?.trim();
  if (!trimmed) return undefined;

  const candidate = trimmed.includes('://')
    ? trimmed
    : `https://${trimmed}`;

  try {
    const pathname = new URL(candidate).pathname.replace(/\/+$/, '');
    if (!pathname || pathname === '/') return undefined;
    return pathname.startsWith('/') ? pathname : `/${pathname}`;
  } catch {
    return undefined;
  }
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
