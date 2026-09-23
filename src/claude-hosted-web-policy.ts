/**
 * Claude hosted-web policy normalization.
 *
 * Anthropic's hosted `web_search_*` / `web_fetch_*` server tools execute on
 * Anthropic infrastructure, so Squid never observes the searched or fetched
 * destination. The trusted api-proxy sidecar therefore enforces an AWF-owned
 * domain policy on those tool definitions before dispatching the request
 * upstream (see docs/awf-config-spec.md §9.9).
 *
 * This module converts the validated `apiProxy.hostedWeb.claude` config object
 * into the single normalized representation that is serialized into the sidecar
 * environment. It fails closed: any ambiguous or unrepresentable policy throws
 * before containers start.
 */

/** Raw `apiProxy.hostedWeb.claude` config object as authored by the user. */
export interface ClaudeHostedWebConfig {
  enabled?: boolean;
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
}

/** Normalized policy handed to the api-proxy sidecar. */
export interface NormalizedClaudeHostedWebPolicy {
  enabled: boolean;
  /** `null` only when `enabled` is false (no domain mode is required then). */
  mode: 'allow' | 'block' | null;
  domains: string[];
  maxUses?: number;
}

/**
 * Lowercase DNS label characters. Validation is done label-by-label (rather
 * than with one nested-quantifier hostname regex) so the check stays linear on
 * adversarial input.
 */
const LABEL_CHARS = /^[a-z0-9-]+$/;
const DIGITS_ONLY = /^\d+$/;
const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * Lowercase DNS hostname with at least two labels. Deliberately rejects
 * schemes, paths, ports, credentials, wildcards, CIDRs, raw IPv4 addresses and
 * single-label names such as `localhost` or Docker service aliases.
 */
function isValidDomain(value: string): boolean {
  if (!value || value.length > MAX_DOMAIN_LENGTH) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  if (labels.every((label) => DIGITS_ONLY.test(label))) return false; // raw IPv4
  return labels.every((label) =>
    label.length > 0 &&
    label.length <= MAX_LABEL_LENGTH &&
    LABEL_CHARS.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-'),
  );
}

function normalizeDomains(values: unknown, field: string, source: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${source}: apiProxy.hostedWeb.claude.${field} must be a non-empty array of domains`);
  }
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error(`${source}: apiProxy.hostedWeb.claude.${field} entries must be strings`);
    }
    const domain = value.trim().toLowerCase();
    if (!isValidDomain(domain)) {
      throw new Error(
        `${source}: apiProxy.hostedWeb.claude.${field} entry "${value}" is not a valid domain. ` +
          'Use a lowercase DNS hostname with at least two labels and no scheme, port, path, wildcard or IP address.',
      );
    }
    if (!normalized.includes(domain)) normalized.push(domain);
  }
  return normalized;
}

/**
 * Validate and normalize a Claude hosted-web policy.
 *
 * @param config Raw config object (already schema-validated when loaded from a
 *   config file or stdin; re-checked here because the value may also arrive
 *   through programmatic callers).
 * @param source Label used in error messages (e.g. `config`, `stdin`).
 * @returns The normalized policy, or `undefined` when no policy is configured.
 */
export function normalizeClaudeHostedWebPolicy(
  config: ClaudeHostedWebConfig | undefined,
  source = 'config',
): NormalizedClaudeHostedWebPolicy | undefined {
  if (config === undefined || config === null) return undefined;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${source}: apiProxy.hostedWeb.claude must be an object`);
  }
  if (typeof config.enabled !== 'boolean') {
    throw new Error(`${source}: apiProxy.hostedWeb.claude.enabled is required and must be a boolean`);
  }

  const hasAllow = config.allowedDomains !== undefined;
  const hasBlock = config.blockedDomains !== undefined;
  if (hasAllow && hasBlock) {
    throw new Error(
      `${source}: apiProxy.hostedWeb.claude.allowedDomains and blockedDomains are mutually exclusive ` +
        '(Anthropic rejects both filters on one tool definition)',
    );
  }

  if (!config.enabled) {
    if (hasAllow || hasBlock) {
      throw new Error(
        `${source}: apiProxy.hostedWeb.claude.allowedDomains/blockedDomains cannot be combined with enabled: false`,
      );
    }
    return { enabled: false, mode: null, domains: [] };
  }

  if (!hasAllow && !hasBlock) {
    throw new Error(
      `${source}: apiProxy.hostedWeb.claude requires exactly one of allowedDomains or blockedDomains when enabled is true`,
    );
  }

  const mode: 'allow' | 'block' = hasAllow ? 'allow' : 'block';
  const domains = hasAllow
    ? normalizeDomains(config.allowedDomains, 'allowedDomains', source)
    : normalizeDomains(config.blockedDomains, 'blockedDomains', source);

  const policy: NormalizedClaudeHostedWebPolicy = { enabled: true, mode, domains };

  if (config.maxUses !== undefined) {
    if (typeof config.maxUses !== 'number' || !Number.isInteger(config.maxUses) || config.maxUses < 1) {
      throw new Error(`${source}: apiProxy.hostedWeb.claude.maxUses must be a positive integer`);
    }
    policy.maxUses = config.maxUses;
  }

  return policy;
}
