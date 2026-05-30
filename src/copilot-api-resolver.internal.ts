/**
 * Parse a provider base URL into a URL object, handling missing schemes.
 * Returns undefined if the input is empty or unparseable.
 */
function parseProviderBaseUrl(providerBaseUrl: string | undefined): URL | undefined {
  const trimmed = providerBaseUrl?.trim();
  if (!trimmed) return undefined;

  const candidate = trimmed.includes('://')
    ? trimmed
    : `https://${trimmed}`;

  try {
    return new URL(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Derive a Copilot API target hostname from COPILOT_PROVIDER_BASE_URL.
 * Returns undefined when the value is empty or not a valid URL/host.
 */
export function deriveCopilotApiTargetFromProviderBaseUrl(
  providerBaseUrl: string | undefined
): string | undefined {
  return parseProviderBaseUrl(providerBaseUrl)?.hostname || undefined;
}

/**
 * Derive a Copilot API base-path prefix from COPILOT_PROVIDER_BASE_URL.
 * Returns undefined when the value is empty, invalid, or has no path.
 */
export function deriveCopilotApiBasePathFromProviderBaseUrl(
  providerBaseUrl: string | undefined
): string | undefined {
  const url = parseProviderBaseUrl(providerBaseUrl);
  if (!url) return undefined;

  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/') return undefined;
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}
