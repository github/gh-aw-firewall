import { isIP } from 'net';
import type { WrapperConfig } from './types';
import { getConfigEnvValue } from './env-utils';
import { OIDC_AUTH_ENV_VARS, OIDC_AUTH_ENV_MAPPING } from './api-proxy-env-constants';
import { COPILOT_PLACEHOLDER_TOKEN } from './constants/placeholders';
import { validateApiProxyPort } from './squid/validation';

export const COPILOT_BROKER_PRIVATE_ENV = [
  'AWF_COPILOT_TOKEN_BROKER',
  'GH_AW_TOKEN_BROKER_URL',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
] as const;

export const COPILOT_BROKER_CONTEXT_ENV = [
  'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID',
  'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_JOB',
] as const;
const COPILOT_HOSTS = new Set([
  'api.githubcopilot.com',
  'api.individual.githubcopilot.com',
  'api.business.githubcopilot.com',
  'api.enterprise.githubcopilot.com',
]);
interface BrokerRuntime {
  environment: Readonly<Record<string, string>>;
  endpoints: ReadonlyArray<{ hostname: string; port: number }>;
}
const snapshots = new WeakMap<WrapperConfig, BrokerRuntime>();

function parseHttpsEndpoint(raw: string, oidc: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid Copilot token-broker HTTPS runtime endpoint');
  }
  const hostname = url.hostname;
  const ip = isIP(hostname.replace(/^\[|\]$/g, ''));
  const authority = raw.split('://')[1]?.split(/[/?#]/)[0] ?? '';
  if (!/^https:\/\//i.test(raw) || raw.includes('#') || authority.includes('@') ||
      raw !== raw.trim() || /[\s\\]/.test(raw) || url.protocol !== 'https:' ||
      url.username || url.password || url.hash ||
      hostname.length > 253 ||
      (!ip && !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) ||
      (oidc && (url.port || !hostname.endsWith('.actions.githubusercontent.com')))) {
    throw new Error('Unsafe Copilot token-broker HTTPS runtime endpoint');
  }
  validateApiProxyPort(Number(url.port || 443));
  return url;
}

export function validateCopilotBrokerTarget(target: string | undefined, basePath?: string): void {
  const raw = target ?? 'api.githubcopilot.com';
  const url = parseHttpsEndpoint(raw.includes('://') ? raw : `https://${raw}`, false);
  if (!COPILOT_HOSTS.has(url.hostname) || raw.includes('?') || url.port || url.pathname !== '/' ||
      url.search || basePath) {
    throw new Error('Copilot token broker requires an approved HTTPS Copilot target without a base path');
  }
}

function validateConflicts(config: WrapperConfig): void {
  if (!config.enableApiProxy) throw new Error('Copilot token broker requires the API proxy');
  const envValue = (name: string): string | undefined =>
    getConfigEnvValue(config, name) ?? process.env[name];
  for (const name of ['COPILOT_GITHUB_TOKEN', 'COPILOT_TOKEN', 'COPILOT_PROVIDER_API_KEY']) {
    const value = envValue(name);
    if (value && value !== COPILOT_PLACEHOLDER_TOKEN) {
      throw new Error('Copilot token broker conflicts with static Copilot credentials');
    }
  }
  if (config.copilotGithubToken || config.copilotProviderApiKey ||
      config.copilotProviderType || config.copilotProviderBaseUrl ||
      config.apiProxyProviders !== undefined || config.fallbackModels !== undefined ||
      config.modelFallback !== undefined || config.modelRouting !== undefined || config.modelAliases !== undefined ||
      config.experimentalModelRouting || config.copilotByokExtraHeaders !== undefined ||
      config.copilotByokExtraBodyFields !== undefined ||
      ['COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_BASE_URL', 'AWF_API_PROXY_PROVIDERS',
        'AWF_FALLBACK_MODELS', 'AWF_MODEL_FALLBACK', 'AWF_ROUTING_CONFIG', 'AWF_MODEL_ALIASES',
        'AWF_BYOK_EXTRA_HEADERS', 'AWF_BYOK_EXTRA_BODY_FIELDS', 'AWF_AUTH_HEADER'].some(name => envValue(name))) {
    throw new Error('Copilot token broker conflicts with BYOK, alternate providers, or model routing');
  }
  if (OIDC_AUTH_ENV_VARS.some(name => envValue(name)) ||
      OIDC_AUTH_ENV_MAPPING.some(({ configKey }) =>
        (config as unknown as Record<string, unknown>)[configKey]) ||
      config.anthropicTokenUrl || envValue('AWF_AUTH_ANTHROPIC_TOKEN_URL')) {
    throw new Error('Copilot token broker conflicts with cloud authentication');
  }
  validateCopilotBrokerTarget(
    config.copilotApiTarget ?? envValue('COPILOT_API_TARGET'),
    config.copilotApiBasePath ?? envValue('COPILOT_API_BASE_PATH'),
  );
}

/** Capture host-only bootstrap and identity once; never resolve these from sandbox --env inputs. */
export function resolveCopilotBrokerRuntime(config: WrapperConfig): BrokerRuntime | undefined {
  if (config.copilotTokenBroker !== true) return undefined;
  validateConflicts(config);
  const cached = snapshots.get(config);
  if (cached) return cached;
  const environment: Record<string, string> = { AWF_COPILOT_TOKEN_BROKER: 'true' };
  for (const name of [...COPILOT_BROKER_PRIVATE_ENV.slice(1), ...COPILOT_BROKER_CONTEXT_ENV]) {
    const value = process.env[name];
    if (!value || !value.trim() || /[\r\n\0]/.test(value)) {
      throw new Error(`Copilot token broker requires host runtime ${name}`);
    }
    if (name !== 'GITHUB_JOB' && COPILOT_BROKER_CONTEXT_ENV.some(key => key === name) && !/^[1-9][0-9]*$/.test(value)) {
      throw new Error(`Invalid Copilot token-broker context ${name}`);
    }
    environment[name] = value;
  }
  const urls = [
    parseHttpsEndpoint(environment.GH_AW_TOKEN_BROKER_URL, false),
    parseHttpsEndpoint(environment.ACTIONS_ID_TOKEN_REQUEST_URL, true),
  ];
  const runtime = Object.freeze({
    environment: Object.freeze(environment),
    endpoints: Object.freeze(urls.map(url => Object.freeze({
      hostname: url.hostname, port: Number(url.port || 443),
    }))),
  });
  snapshots.set(config, runtime);
  return runtime;
}

export function resolveCopilotBrokerUpstreams(config: WrapperConfig): Array<{ hostname: string; port: number }> {
  const runtime = resolveCopilotBrokerRuntime(config);
  if (!runtime) return [];
  const target = config.copilotApiTarget ?? getConfigEnvValue(config, 'COPILOT_API_TARGET')
    ?? process.env.COPILOT_API_TARGET ?? 'api.githubcopilot.com';
  const url = new URL(target.includes('://') ? target : `https://${target}`);
  return [...runtime.endpoints, { hostname: url.hostname, port: 443 }];
}

export function copilotBrokerSensitiveValues(config: WrapperConfig): string[] {
  const runtime = resolveCopilotBrokerRuntime(config);
  if (!runtime) return [];
  const values = [
    ...COPILOT_BROKER_PRIVATE_ENV.slice(1).map(name => runtime.environment[name]),
    ...runtime.endpoints.map(endpoint => endpoint.hostname),
    ...runtime.endpoints.map(endpoint => endpoint.hostname.replace(/^\[|\]$/g, '')),
  ].filter(value => value !== 'true' && value.length > 3);
  const forms = new Set(values);
  for (const value of values) {
    forms.add(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  for (const value of [...forms]) forms.add(JSON.stringify(value).slice(1, -1));
  return [...forms].sort((a, b) => b.length - a.length);
}
