export interface HostedWebConfig {
  enabled?: boolean;
  allowedDomains?: string[];
  blockedDomains?: string[];
  maxUses?: number;
}

export interface NormalizedHostedWebPolicy {
  enabled: boolean;
  mode: 'allow' | 'block' | null;
  domains: string[];
  maxUses?: number;
}

const LABEL_CHARS = /^[a-z0-9-]+$/;
const DIGITS_ONLY = /^\d+$/;
const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

export function isValidHostedWebDomain(value: string): boolean {
  if (!value || value.length > MAX_DOMAIN_LENGTH) return false;
  const labels = value.split('.');
  if (labels.length < 2) return false;
  if (labels.every((label) => DIGITS_ONLY.test(label))) return false;
  return labels.every((label) =>
    label.length > 0 &&
    label.length <= MAX_LABEL_LENGTH &&
    LABEL_CHARS.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-'),
  );
}

function normalizeDomains(values: unknown, field: string, configPath: string, source: string): string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${source}: ${configPath}.${field} must be a non-empty array of domains`);
  }
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') {
      throw new Error(`${source}: ${configPath}.${field} entries must be strings`);
    }
    const domain = value.trim().toLowerCase();
    if (!isValidHostedWebDomain(domain)) {
      throw new Error(
        `${source}: ${configPath}.${field} entry "${value}" is not a valid domain. ` +
          'Use a lowercase DNS hostname with at least two labels and no scheme, port, path, wildcard or IP address.',
      );
    }
    if (!normalized.includes(domain)) normalized.push(domain);
  }
  return normalized;
}

export function normalizeHostedWebPolicy(
  config: HostedWebConfig | undefined,
  provider: 'claude' | 'codex',
  source = 'config',
): NormalizedHostedWebPolicy | undefined {
  const configPath = `apiProxy.hostedWeb.${provider}`;
  if (config === undefined || config === null) return undefined;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${source}: ${configPath} must be an object`);
  }
  if (typeof config.enabled !== 'boolean') {
    throw new Error(`${source}: ${configPath}.enabled is required and must be a boolean`);
  }

  const hasAllow = config.allowedDomains !== undefined;
  const hasBlock = config.blockedDomains !== undefined;
  if (hasAllow && hasBlock) {
    throw new Error(`${source}: ${configPath}.allowedDomains and blockedDomains are mutually exclusive`);
  }
  if (!config.enabled) {
    if (hasAllow || hasBlock) {
      throw new Error(`${source}: ${configPath}.allowedDomains/blockedDomains cannot be combined with enabled: false`);
    }
    return { enabled: false, mode: null, domains: [] };
  }
  if (!hasAllow && !hasBlock) {
    throw new Error(`${source}: ${configPath} requires exactly one of allowedDomains or blockedDomains when enabled is true`);
  }

  const mode: 'allow' | 'block' = hasAllow ? 'allow' : 'block';
  const domains = normalizeDomains(
    hasAllow ? config.allowedDomains : config.blockedDomains,
    hasAllow ? 'allowedDomains' : 'blockedDomains',
    configPath,
    source,
  );
  const policy: NormalizedHostedWebPolicy = { enabled: true, mode, domains };
  if (config.maxUses !== undefined) {
    if (typeof config.maxUses !== 'number' || !Number.isInteger(config.maxUses) || config.maxUses < 1) {
      throw new Error(`${source}: ${configPath}.maxUses must be a positive integer`);
    }
    policy.maxUses = config.maxUses;
  }
  return policy;
}
