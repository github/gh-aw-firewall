import { OPENAI_ENV, ANTHROPIC_ENV, GEMINI_ENV, COPILOT_ENV, VERTEX_ENV, OIDC_AUTH_ENV_MAPPING } from '../api-proxy-env-constants';
import type { WrapperConfig } from '../types';
import { validateApiAuthScheme } from '../api-proxy-config-validation';
import { readEnvFile } from '../github-env';

interface ResolveApiCredentialsInputs {
  resolvedCopilotApiTarget?: string;
  resolvedCopilotApiBasePath?: string;
  additionalEnv?: Record<string, string>;
  envFile?: string;
}

type OidcConfigKey = (typeof OIDC_AUTH_ENV_MAPPING)[number]['configKey'];

type ApiCredentials = Pick<WrapperConfig,
  | 'openaiApiKey'
  | 'openaiTrustedService'
  | 'anthropicTrustedService'
  | 'anthropicApiKey'
  | 'copilotGithubToken'
  | 'copilotProviderApiKey'
  | 'copilotProviderType'
  | 'copilotProviderBaseUrl'
  | 'geminiApiKey'
  | 'googleApiKey'
  | 'copilotApiTarget'
  | 'copilotApiBasePath'
  | 'openaiApiTarget'
  | 'openaiBaseUrlEnv'
  | 'openaiApiBasePath'
  | 'anthropicApiTarget'
  | 'anthropicApiBasePath'
  | 'openaiApiAuthHeader'
  | 'anthropicApiAuthHeader'
  | 'openaiApiAuthScheme'
  | 'anthropicApiAuthScheme'
  | 'anthropicTokenUrl'
  | OidcConfigKey
  | 'geminiApiTarget'
  | 'geminiApiBasePath'
  | 'vertexApiTarget'
  | 'vertexApiBasePath'
  | 'githubToken'
>;

type ApiCredentialOptions = Partial<Pick<WrapperConfig, keyof ApiCredentials | 'enableApiProxy'>>;
type StringCredentialKey = Exclude<keyof ApiCredentials, 'openaiTrustedService' | 'anthropicTrustedService'>;

/**
 * Resolves API proxy credentials and related auth settings from config options
 * and environment variables.
 */
export function resolveApiCredentials(
  options: ApiCredentialOptions,
  inputs: ResolveApiCredentialsInputs = {},
  env: NodeJS.ProcessEnv = process.env,
): ApiCredentials {
  let fileEnvironment: Record<string, string> | undefined;
  const resolveExplicitEnvOrHost = (configKey: StringCredentialKey, envVar: string): string | undefined => {
    const option = options[configKey];
    if (option !== undefined) return option;
    if (inputs.additionalEnv?.[envVar] !== undefined) return inputs.additionalEnv[envVar];
    if (inputs.envFile && fileEnvironment === undefined) {
      try { fileEnvironment = readEnvFile(inputs.envFile); } catch { fileEnvironment = {}; }
    }
    return fileEnvironment?.[envVar] ?? env[envVar];
  };
  const oidcCredentials = Object.fromEntries(
    OIDC_AUTH_ENV_MAPPING
      .map(({ configKey, envVar }) => [
        configKey,
        configKey === 'authDatabricksHost' || configKey === 'authDatabricksClientId'
          ? resolveExplicitEnvOrHost(configKey, envVar)
          : resolveOptionOrEnv(options, configKey, envVar, env),
      ])
      .filter(([, value]) => value !== undefined)
  ) as Pick<ApiCredentials, OidcConfigKey>;

  const agentApiKey = resolveAgentApiKey(options, env);
  const openaiApiAuthScheme = resolveExplicitEnvOrHost('openaiApiAuthScheme', OPENAI_ENV.AUTH_SCHEME);
  const anthropicApiAuthScheme = resolveExplicitEnvOrHost('anthropicApiAuthScheme', ANTHROPIC_ENV.AUTH_SCHEME);
  validateApiAuthScheme(openaiApiAuthScheme);
  validateApiAuthScheme(anthropicApiAuthScheme);

  return {
    openaiTrustedService: options.openaiTrustedService,
    anthropicTrustedService: options.anthropicTrustedService,
    openaiApiKey: env[OPENAI_ENV.KEY] || agentApiKey.openai,
    anthropicApiKey: env[ANTHROPIC_ENV.KEY] || agentApiKey.anthropic,
    copilotGithubToken: env[COPILOT_ENV.GITHUB_TOKEN],
    copilotProviderApiKey: env[COPILOT_ENV.PROVIDER_API_KEY] || agentApiKey.copilot,
    copilotProviderType: resolveOptionOrEnv(options, 'copilotProviderType', COPILOT_ENV.PROVIDER_TYPE, env),
    copilotProviderBaseUrl: resolveOptionOrEnv(
      options,
      'copilotProviderBaseUrl',
      COPILOT_ENV.PROVIDER_BASE_URL,
      env,
    ),
    geminiApiKey: env[GEMINI_ENV.KEY] || agentApiKey.gemini,
    googleApiKey: env[VERTEX_ENV.KEY] || agentApiKey.vertex,
    copilotApiTarget: inputs.resolvedCopilotApiTarget,
    copilotApiBasePath: inputs.resolvedCopilotApiBasePath,
    openaiApiTarget: resolveOptionOrEnv(options, 'openaiApiTarget', OPENAI_ENV.TARGET, env),
    openaiBaseUrlEnv: resolveOptionOrEnv(options, 'openaiBaseUrlEnv', 'OPENAI_BASE_URL_ENV', env),
    openaiApiBasePath: resolveOptionOrEnv(options, 'openaiApiBasePath', OPENAI_ENV.BASE_PATH, env),
    anthropicApiTarget: resolveOptionOrEnv(options, 'anthropicApiTarget', ANTHROPIC_ENV.TARGET, env),
    anthropicApiBasePath: resolveOptionOrEnv(
      options,
      'anthropicApiBasePath',
      ANTHROPIC_ENV.BASE_PATH,
      env,
    ),
    openaiApiAuthHeader: resolveOptionOrEnv(options, 'openaiApiAuthHeader', OPENAI_ENV.AUTH_HEADER, env),
    openaiApiAuthScheme,
    anthropicApiAuthHeader: resolveOptionOrEnv(
      options,
      'anthropicApiAuthHeader',
      ANTHROPIC_ENV.AUTH_HEADER,
      env,
    ),
    anthropicApiAuthScheme,
    anthropicTokenUrl: options.anthropicTokenUrl ?? env.AWF_AUTH_ANTHROPIC_TOKEN_URL,
    ...oidcCredentials,
    geminiApiTarget: resolveOptionOrEnv(options, 'geminiApiTarget', GEMINI_ENV.TARGET, env),
    geminiApiBasePath: resolveOptionOrEnv(options, 'geminiApiBasePath', GEMINI_ENV.BASE_PATH, env),
    vertexApiTarget: resolveOptionOrEnv(options, 'vertexApiTarget', VERTEX_ENV.TARGET, env),
    vertexApiBasePath: resolveOptionOrEnv(options, 'vertexApiBasePath', VERTEX_ENV.BASE_PATH, env),
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN,
  };
}

function resolveAgentApiKey(options: ApiCredentialOptions, env: NodeJS.ProcessEnv): Partial<Record<string, string>> {
  const key = env.AWF_AGENT_API_KEY?.trim();
  if (options.enableApiProxy === false || !key) return {};

  // The proxy can enable multiple providers; never broadcast a neutral key.
  const provider = env.AWF_AGENT_API_PROVIDER?.trim().toLowerCase();
  switch (provider) {
    case 'openai':
    case 'anthropic':
    case 'copilot':
    case 'gemini':
    case 'vertex':
      return { [provider]: key };
    default:
      throw new Error('AWF_AGENT_API_KEY requires AWF_AGENT_API_PROVIDER to be openai, anthropic, copilot, gemini, or vertex');
  }
}

function resolveOptionOrEnv(
  options: ApiCredentialOptions,
  optionKey: StringCredentialKey,
  envVar: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return options[optionKey] ?? env[envVar];
}
