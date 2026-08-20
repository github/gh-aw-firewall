/**
 * Runner-side resolution of a secret-backed OpenAI-compatible endpoint.
 *
 * `apiProxy.targets.openai.baseUrlEnv` names a runner environment variable
 * (typically bound to `${{ secrets.* }}` by the gh-aw compiler) whose value is
 * the base URL of a private OpenAI-compatible endpoint. The URL is read and
 * validated here — on the runner, before any container starts — so that:
 *
 * - the endpoint never has to be written into workflow source or lockfiles;
 * - the derived host can be added to the sensitive (never logged) Squid
 *   allowlist and to the api-proxy sidecar target; and
 * - the value is never placed in the untrusted agent's environment.
 *
 * Every error message below is deliberately free of the resolved value so that
 * a misconfigured endpoint cannot leak through logs or diagnostics.
 */

/** Derived, validated forms of a secret-backed OpenAI base URL. */
export interface ResolvedOpenAiBaseUrl {
  /** Name of the runner environment variable the value was read from. */
  envVarName: string;
  /** Normalized base URL (scheme + host + optional base path, no trailing slash). */
  url: string;
  /** URL scheme (`https`). */
  scheme: 'https';
  /** Hostname without port. */
  host: string;
  /** Hostname with the effective port (explicit or scheme default). */
  hostPort: string;
  /** Normalized base path (e.g. `/v1`), or `''` when the URL has no path. */
  basePath: string;
}

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validates a configured environment variable name for `baseUrlEnv`.
 * @param rawName - Raw configured name.
 * @returns The trimmed name.
 * @throws Error when the name is empty or is not a valid environment variable name.
 */
function validateEnvVarName(rawName: string): string {
  const name = rawName.trim();
  if (!name) {
    throw new Error(
      'apiProxy.targets.openai.baseUrlEnv is empty. Set it to the name of the runner ' +
      'environment variable that holds the OpenAI-compatible base URL.'
    );
  }
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    throw new Error(
      `apiProxy.targets.openai.baseUrlEnv "${name}" is not a valid environment variable name ` +
      '(expected letters, digits and underscores, not starting with a digit).'
    );
  }
  return name;
}

/**
 * Resolves and validates the OpenAI base URL named by `baseUrlEnv`.
 *
 * @param envVarName - Configured environment variable name, or undefined when the feature is unused.
 * @param env - Environment to read from (defaults to `process.env`).
 * @returns The derived endpoint forms, or `undefined` when `envVarName` is not configured.
 * @throws Error with a value-free message when the variable is unset or holds an invalid URL.
 */
export function resolveOpenAiBaseUrlFromEnv(
  envVarName: string | undefined,
  env: Record<string, string | undefined> = process.env
): ResolvedOpenAiBaseUrl | undefined {
  if (envVarName === undefined) return undefined;

  const name = validateEnvVarName(envVarName);
  const rawValue = env[name];
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) {
    throw new Error(
      `Environment variable "${name}" (apiProxy.targets.openai.baseUrlEnv) is not set. ` +
      'Bind it to the secret holding the OpenAI-compatible base URL before starting awf.'
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `Environment variable "${name}" does not contain a valid absolute URL ` +
      '(expected e.g. https://host.example.com/v1). The value is not shown to avoid leaking it.'
    );
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Environment variable "${name}" uses an unsupported URL scheme. ` +
      'Only https:// endpoints are supported.'
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      `Environment variable "${name}" contains embedded credentials (user:pass@), which are not supported. ` +
      'Provide the API key separately via OPENAI_API_KEY.'
    );
  }

  if (parsed.search || parsed.hash) {
    throw new Error(
      `Environment variable "${name}" must not contain a query string or fragment.`
    );
  }

  const host = parsed.hostname;
  if (!host || /[\s#;'"\\]/.test(host)) {
    throw new Error(
      `Environment variable "${name}" has a missing or malformed hostname.`
    );
  }

  const scheme = 'https';
  const defaultPort = '443';
  if (parsed.port && parsed.port !== defaultPort) {
    // The api-proxy sidecar always connects to the target host on the scheme's
    // default port, so a custom port would be silently dropped and misrouted.
    throw new Error(
      `Environment variable "${name}" specifies a non-default port, which the OpenAI API proxy ` +
      'target does not support. Expose the endpoint on the default port for its scheme.'
    );
  }

  const basePath = normalizeBasePath(parsed.pathname);

  return {
    envVarName: name,
    url: `${scheme}://${host}${basePath}`,
    scheme,
    host,
    hostPort: `${host}:${defaultPort}`,
    basePath,
  };
}

/**
 * Normalizes a URL pathname into an api-proxy base path (no trailing slash, `''` for root).
 * @param pathname - Raw URL pathname.
 * @returns Normalized base path.
 */
function normalizeBasePath(pathname: string): string {
  const trimmed = (pathname || '').replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
