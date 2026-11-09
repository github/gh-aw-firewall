import { validateHeaderValue } from 'http';
import { isIP } from 'net';
import type { WrapperConfig } from './types';
import { getConfigEnvValue } from './env-utils';
import { isDomainMatchedByPattern, parseDomainList } from './domain-matchers';

export interface TrustedService {
  endpoint: string;
  secretHeaders: Record<string, string>;
}

type ServiceConfig = Pick<WrapperConfig, 'openaiTrustedService' | 'anthropicTrustedService'>;

const RESERVED_HEADERS = new Set([
  'authorization', 'authentication-info', 'www-authenticate', 'x-api-key', 'api-key',
  'x-goog-api-key', 'host', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
  'transfer-encoding', 'content-length', 'content-type', 'content-encoding',
  'expect', 'via', 'forwarded', 'cookie', 'set-cookie', 'range', 'accept-encoding',
  'anthropic-version', 'anthropic-beta', 'x-request-id',
  'x-original-url', 'x-rewrite-url', 'x-http-method-override', 'x-method-override',
  'x-real-ip', 'x-host', 'origin', 'referer', 'destination', 'max-forwards',
  'http2-settings', 'content-range', 'x-url-scheme', 'x-scheme',
]);

export function validateTrustedService(service: TrustedService, authHeader?: string): URL {
  const invalid = () => new Error('Invalid trustedService endpoint: expected an HTTPS URL on port 443 without credentials, query, fragment, or unsafe path');
  if (!service || typeof service.endpoint !== 'string' ||
      service.endpoint !== service.endpoint.trim() ||
      !/^https:\/\/[a-z0-9.-]+(?::443)?(?:\/[a-z0-9/_~-]*)?$/i.test(service.endpoint) ||
      service.endpoint.split('/').some(part => part === '.' || part === '..')) throw invalid();
  let url: URL;
  try { url = new URL(service.endpoint); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || !url.hostname.includes('.') ||
      isIP(url.hostname) || /\.(?:localhost|local|localdomain|internal)$/i.test(url.hostname) || url.hostname.split('.').some(label =>
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw invalid();
  if (!service.secretHeaders || typeof service.secretHeaders !== 'object' || Array.isArray(service.secretHeaders)) {
    throw new Error('trustedService.secretHeaders must map header names to runner environment variable names');
  }
  const seen = new Set<string>();
  for (const [header, name] of Object.entries(service.secretHeaders)) {
    const lower = header.toLowerCase();
    if (header !== header.trim() || !/^[a-z][a-z0-9-]*$/i.test(header) || seen.has(lower) || RESERVED_HEADERS.has(lower) ||
        /^(?:proxy|x-forwarded|x-original|x-rewrite|x-envoy-|x-awf|awf-|sec-|access-control-|openai-|anthropic-|copilot-)/.test(lower) ||
        lower === authHeader?.trim().toLowerCase()) {
      throw new Error('Invalid or reserved trustedService secret header name');
    }
    seen.add(lower);
    if (typeof name !== 'string' || name !== name.trim() || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        /^(?:AWF_|NODE_|LD_|DYLD_|OPENAI_|ANTHROPIC_|COPILOT_|GEMINI_|GOOGLE_|VERTEX_|GITHUB_|GH_|ACTIONS_|DOCKER_|BASH_|OPENSSL_|SSL|UV_|ENV$|IFS$|SHELLOPTS$|PATH$|HOME$|HTTP|HTTPS|ALL_PROXY$|NO_PROXY$|SHELL$|USER$|PWD$)/i.test(name)) {
      throw new Error('Invalid or reserved trustedService secret environment variable name');
    }
  }
  return url;
}

export function trustedServices(config: ServiceConfig): Array<['openai' | 'anthropic', TrustedService]> {
  return (['openai', 'anthropic'] as const).flatMap(provider => {
    const service = config[`${provider}TrustedService`];
    return service ? [[provider, service] as ['openai' | 'anthropic', TrustedService]] : [];
  });
}

export function trustedServiceSecretNames(config: ServiceConfig): string[] {
  return [...new Set(trustedServices(config).flatMap(([, service]) => Object.values(service.secretHeaders)))];
}

export function validateTrustedServiceSecrets(config: ServiceConfig): void {
  for (const name of trustedServiceSecretNames(config)) {
    const value = process.env[name];
    if (!value?.trim()) throw new Error('Missing trustedService secret in runner environment');
    try { validateHeaderValue('x-secret', value); } catch {
      throw new Error('Invalid trustedService secret header value');
    }
  }
}

export function trustedServiceTargets(config: WrapperConfig): Record<string, string> {
  const targets: Record<string, string> = {};
  for (const [provider, service] of trustedServices(config)) {
    const prefix = provider.toUpperCase();
    const authHeader = config[`${provider}ApiAuthHeader`] ??
      getConfigEnvValue(config, `AWF_${prefix}_AUTH_HEADER`) ?? process.env[`AWF_${prefix}_AUTH_HEADER`];
    const url = validateTrustedService(service, authHeader);
    const blocked = parseDomainList((config.blockedDomains ?? [])
      .map(domain => domain.replace(/^https?:\/\//, '').replace(/\/$/, '')));
    const blockedHost = blocked.plainDomains.some(entry => {
      const domain = entry.domain.replace(/^\./, '').toLowerCase();
      return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
    }) || isDomainMatchedByPattern({ domain: url.hostname, protocol: 'both' }, blocked.patterns);
    if (blockedHost) throw new Error('trustedService endpoint is prohibited by blockedDomains');
    const conflicts = [`${prefix}_API_TARGET`, `${prefix}_API_BASE_PATH`,
      ...(provider === 'openai' ? ['OPENAI_ENDPOINT_OVERRIDE', 'OPENAI_BASE_URL_ENV', 'COPILOT_PROVIDER_BASE_URL'] : [])];
    if (config[`${provider}ApiTarget`] !== undefined || config[`${provider}ApiBasePath`] !== undefined ||
        (provider === 'openai' && (config.openaiBaseUrlEnv !== undefined || config.copilotProviderBaseUrl !== undefined)) ||
        conflicts.some(name => getConfigEnvValue(config, name) !== undefined || process.env[name] !== undefined)) {
      throw new Error('trustedService cannot be combined with target host, basePath, or base URL overrides');
    }
    if (config.enableApiProxy === false || config.experimentalModelRouting) {
      throw new Error('trustedService requires the API proxy and cannot be combined with experimental model routing');
    }
    if (config.containerRuntime && !['docker', 'runc'].includes(config.containerRuntime)) {
      throw new Error('trustedService currently supports only the ordinary Docker runtime');
    }
    const authType = config.authType ?? getConfigEnvValue(config, 'AWF_AUTH_TYPE') ?? process.env.AWF_AUTH_TYPE;
    const authProvider = config.authProvider ?? getConfigEnvValue(config, 'AWF_AUTH_PROVIDER') ?? process.env.AWF_AUTH_PROVIDER;
    if (authType?.trim().toLowerCase() === 'github-oidc' &&
        ['aws', 'gcp'].includes(authProvider?.trim().toLowerCase() ?? '')) {
      throw new Error('trustedService does not support AWS or GCP OIDC request signing');
    }
    targets[`${prefix}_API_TARGET`] = url.host;
    targets[`${prefix}_API_BASE_PATH`] = url.pathname.replace(/\/$/, '') || (provider === 'openai' ? '/v1' : '');
    targets[`AWF_${prefix}_TRUSTED_SERVICE`] = JSON.stringify(service);
  }
  validateTrustedServiceSecrets(config);
  return targets;
}

export function isolateTrustedServiceEnvironment(config: ServiceConfig, environment: Record<string, string>): void {
  const names = new Set(trustedServiceSecretNames(config));
  const values = [...names].map(name => process.env[name]).filter((value): value is string => !!value);
  for (const [name, value] of Object.entries(environment)) {
    if (names.has(name) || values.some(secret => value.includes(secret)) ||
        /^AWF_(?:OPENAI|ANTHROPIC)_TRUSTED_SERVICE$/.test(name)) delete environment[name];
  }
}
