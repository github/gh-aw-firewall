/**
 * Extracts GHEC domains from GITHUB_SERVER_URL and GITHUB_API_URL environment variables.
 * When GITHUB_SERVER_URL points to a GHEC tenant (*.ghe.com), returns the tenant hostname,
 * its API subdomain, the Copilot API subdomain, and the Copilot telemetry subdomain so they
 * can be auto-added to the firewall allowlist.
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns Array of GHEC-related domains (tenant, api.*, copilot-api.*, copilot-telemetry-service.*)
 *          to auto-add to the allowlist, or an empty array if not GHEC
 */
function extractGhecDomainsFromServerUrl(
  env: Record<string, string | undefined> = process.env
): string[] {
  const domains: string[] = [];

  // Extract from GITHUB_SERVER_URL (e.g., https://company.ghe.com)
  const serverUrl = env['GITHUB_SERVER_URL'];
  if (serverUrl) {
    try {
      const hostname = new URL(serverUrl).hostname;
      if (hostname !== 'github.com' && hostname.endsWith('.ghe.com')) {
        // GHEC tenant with data residency: add the tenant domain, API subdomain,
        // Copilot inference subdomain, and Copilot telemetry subdomain.
        // e.g., company.ghe.com → company.ghe.com + api.company.ghe.com
        //        + copilot-api.company.ghe.com + copilot-telemetry-service.company.ghe.com
        domains.push(hostname);
        domains.push(`api.${hostname}`);
        domains.push(`copilot-api.${hostname}`);
        domains.push(`copilot-telemetry-service.${hostname}`);
      }
    } catch {
      // Invalid URL — skip
    }
  }

  // Extract from GITHUB_API_URL (e.g., https://api.company.ghe.com)
  const apiUrl = env['GITHUB_API_URL'];
  if (apiUrl) {
    try {
      const hostname = new URL(apiUrl).hostname;
      if (hostname !== 'api.github.com' && hostname.endsWith('.ghe.com')) {
        if (!domains.includes(hostname)) {
          domains.push(hostname);
        }
      }
    } catch {
      // Invalid URL — skip
    }
  }

  return domains;
}

/**
 * Extracts GHES API domains from engine.api-target environment variable.
 * When engine.api-target is set (indicating GHES), returns the GHES hostname,
 * API subdomain, and required Copilot API domains.
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns Array of domains to auto-add to allowlist, or empty array if not GHES
 */
function extractGhesDomainsFromEngineApiTarget(
  env: Record<string, string | undefined> = process.env
): string[] {
  const engineApiTarget = env['ENGINE_API_TARGET'];
  if (!engineApiTarget) {
    return [];
  }

  const domains: string[] = [];

  try {
    // Parse the engine.api-target URL (e.g., https://api.github.mycompany.com)
    const url = new URL(engineApiTarget);
    const hostname = url.hostname;

    // Extract the base GHES domain from api.github.<ghes-domain>
    // For example: api.github.mycompany.com → github.mycompany.com
    if (hostname.startsWith('api.')) {
      const baseDomain = hostname.substring(4); // Remove 'api.' prefix
      domains.push(baseDomain);
      domains.push(hostname); // Also add the api subdomain itself
    } else {
      // If it doesn't start with 'api.', just add the hostname
      domains.push(hostname);
    }

    // Add Copilot API domains (needed even on GHES since Copilot models run in GitHub's cloud)
    domains.push('api.githubcopilot.com');
    domains.push('api.enterprise.githubcopilot.com');
    domains.push('telemetry.enterprise.githubcopilot.com');
  } catch {
    // Invalid URL format - skip GHES domain extraction
    return [];
  }

  return domains;
}

/**
 * Resolves API target values from CLI options and environment variables, and merges them
 * into the allowed domains list. Also ensures each target is present as an explicit URL entry
 * (defaulting to https:// when no scheme is provided).
 * @param options - Partial options with API target flag values
 * @param allowedDomains - The current list of allowed domains (mutated in place)
 * @param env - Environment variables (defaults to process.env)
 * @param debug - Optional debug logging function
 * @param sensitiveAllowedDomains - Optional separate array for sensitive (secret-derived) domains.
 *   When provided, domains derived from `OPENAI_ENDPOINT_OVERRIDE` are pushed here instead of
 *   into `allowedDomains` so they are never logged or included in audit artifacts.
 * @param openaiEndpointOverride - Optional pre-resolved value of OPENAI_ENDPOINT_OVERRIDE,
 *   already read from all config sources (additionalEnv, envFile, process.env). When provided,
 *   it takes precedence over `env['OPENAI_ENDPOINT_OVERRIDE']` so that overrides supplied via
 *   `--env` or `--env-file` are honoured by allowlist expansion as well as sidecar routing.
 * @returns The updated allowedDomains array (same reference, mutated)
 */
export function resolveApiTargetsToAllowedDomains(
  options: {
    copilotApiTarget?: string;
    openaiApiTarget?: string;
    anthropicApiTarget?: string;
    geminiApiTarget?: string;
    vertexApiTarget?: string;
  },
  allowedDomains: string[],
  env: Record<string, string | undefined> = process.env,
  debug: (msg: string) => void = () => {},
  sensitiveAllowedDomains?: string[],
  openaiEndpointOverride?: string,
): string[] {
  const apiTargets: Array<{ value: string; sensitive?: boolean }> = [];

  if (options.copilotApiTarget) {
    apiTargets.push({ value: options.copilotApiTarget });
  } else if (env['COPILOT_API_TARGET']) {
    apiTargets.push({ value: env['COPILOT_API_TARGET'] });
  }

  if (options.openaiApiTarget) {
    apiTargets.push({ value: options.openaiApiTarget });
  } else if (env['OPENAI_API_TARGET']) {
    apiTargets.push({ value: env['OPENAI_API_TARGET'] });
  } else {
    // Prefer the pre-resolved override (from additionalEnv / envFile / process.env),
    // falling back to the raw env lookup for backward-compat callers that don't pass it.
    const endpointOverride = openaiEndpointOverride ?? env['OPENAI_ENDPOINT_OVERRIDE'];
    if (endpointOverride) {
      apiTargets.push({ value: endpointOverride, sensitive: true });
    }
  }

  if (options.anthropicApiTarget) {
    apiTargets.push({ value: options.anthropicApiTarget });
  } else if (env['ANTHROPIC_API_TARGET']) {
    apiTargets.push({ value: env['ANTHROPIC_API_TARGET'] });
  }

  if (options.geminiApiTarget) {
    apiTargets.push({ value: options.geminiApiTarget });
  } else if (env['GEMINI_API_TARGET']) {
    apiTargets.push({ value: env['GEMINI_API_TARGET'] });
  }

  if (options.vertexApiTarget) {
    apiTargets.push({ value: options.vertexApiTarget });
  } else if (env['VERTEX_API_TARGET']) {
    apiTargets.push({ value: env['VERTEX_API_TARGET'] });
  }

  // Auto-populate GHEC domains when GITHUB_SERVER_URL points to a *.ghe.com tenant
  const ghecDomains = extractGhecDomainsFromServerUrl(env);
  if (ghecDomains.length > 0) {
    for (const domain of ghecDomains) {
      if (!allowedDomains.includes(domain)) {
        allowedDomains.push(domain);
      }
    }
    debug(`Auto-added GHEC domains from GITHUB_SERVER_URL/GITHUB_API_URL: ${ghecDomains.join(', ')}`);
  }

  // Auto-populate GHES domains when engine.api-target is set
  const ghesDomains = extractGhesDomainsFromEngineApiTarget(env);
  if (ghesDomains.length > 0) {
    for (const domain of ghesDomains) {
      if (!allowedDomains.includes(domain)) {
        allowedDomains.push(domain);
      }
    }
    debug(`Auto-added GHES domains from engine.api-target: ${ghesDomains.join(', ')}`);
  }

  // Merge API target values into the allowedDomains list so that later checks/logs about
  // "no allowed domains" see the final, expanded allowlist.
  // API targets may be provided as full URLs; only the hostname is relevant to Squid allowlisting.
  type NormalizedApiTarget = { hostname: string; scheme: 'http' | 'https'; sensitive?: boolean };
  const normalizedApiTargets = apiTargets
    .map(({ value, sensitive }) => ({ value: (typeof value === 'string' ? value.trim() : ''), sensitive }))
    .filter(({ value }) => value.length > 0)
    .flatMap(({ value, sensitive }): NormalizedApiTarget[] => {
      const raw = value;
      const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw);
      const candidate = hasScheme ? raw : `https://${raw}`;

      let hostname = '';
      try {
        hostname = new URL(candidate).hostname;
      } catch {
        // Let domain-validation surface a clear error later.
      }
      if (!hostname) return [];

      const scheme: 'http' | 'https' = /^http:\/\//i.test(raw) ? 'http' : 'https';
      return [{ hostname, scheme, sensitive }];
    });

  if (normalizedApiTargets.length > 0) {
    for (const { hostname, scheme, sensitive } of normalizedApiTargets) {
      const urlEntry = `${scheme}://${hostname}`;
      // Route sensitive (secret-derived) entries to sensitiveAllowedDomains when the
      // caller supplies that array so the value never appears in allowedDomains (which
      // is logged and written to the audit artifact).  Fall back to allowedDomains for
      // callers that don't supply the array (backward compatibility).
      const targetList = (sensitive && sensitiveAllowedDomains) ? sensitiveAllowedDomains : allowedDomains;
      if (!targetList.includes(urlEntry)) {
        targetList.push(urlEntry);
        if (!sensitive) {
          debug(`Automatically added API target to allowlist: ${urlEntry}`);
        }
      }
    }

    const nonSensitiveHosts = normalizedApiTargets.filter(t => !t.sensitive).map(t => t.hostname);
    if (nonSensitiveHosts.length > 0) {
      debug(`Auto-added API target hostnames to allowed domains: ${nonSensitiveHosts.join(', ')}`);
    }
    if (normalizedApiTargets.some(t => t.sensitive)) {
      debug('Auto-added OpenAI endpoint override host to allowed domains');
    }
  }

  return allowedDomains;
}
