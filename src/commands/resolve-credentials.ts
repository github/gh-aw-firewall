import { OPENAI_ENV, ANTHROPIC_ENV, GEMINI_ENV, COPILOT_ENV, OIDC_AUTH_ENV_MAPPING } from '../api-proxy-env-constants';
import type { WrapperConfig } from '../types';

interface ResolveApiCredentialsInputs {
  resolvedCopilotApiTarget?: string;
  resolvedCopilotApiBasePath?: string;
}

type OidcConfigKey = (typeof OIDC_AUTH_ENV_MAPPING)[number]['configKey'];

type ApiCredentials = Pick<WrapperConfig,
  | 'openaiApiKey'
  | 'anthropicApiKey'
  | 'copilotGithubToken'
  | 'copilotProviderApiKey'
  | 'copilotProviderType'
  | 'copilotProviderBaseUrl'
  | 'geminiApiKey'
  | 'copilotApiTarget'
  | 'copilotApiBasePath'
  | 'openaiApiTarget'
  | 'openaiApiBasePath'
  | 'anthropicApiTarget'
  | 'anthropicApiBasePath'
  | 'openaiApiAuthHeader'
  | 'anthropicApiAuthHeader'
  | 'anthropicTokenUrl'
  | OidcConfigKey
  | 'geminiApiTarget'
  | 'geminiApiBasePath'
  | 'githubToken'
>;

/**
 * Resolves API proxy credentials and related auth settings from config options
 * and environment variables.
 */
export function resolveApiCredentials(
  options: Record<string, unknown>,
  inputs: ResolveApiCredentialsInputs = {}
): ApiCredentials {
  const oidcCredentials = Object.fromEntries(
    OIDC_AUTH_ENV_MAPPING
      .map(({ configKey, envVar }) => [
        configKey,
        resolveOptionOrEnv(options, configKey, envVar),
      ])
      .filter(([, value]) => value !== undefined)
  ) as Pick<ApiCredentials, OidcConfigKey>;

  return {
    openaiApiKey: process.env[OPENAI_ENV.KEY],
    anthropicApiKey: process.env[ANTHROPIC_ENV.KEY],
    copilotGithubToken: process.env[COPILOT_ENV.GITHUB_TOKEN],
    copilotProviderApiKey: process.env[COPILOT_ENV.PROVIDER_API_KEY],
    copilotProviderType: resolveOptionOrEnv(options, 'copilotProviderType', COPILOT_ENV.PROVIDER_TYPE),
    copilotProviderBaseUrl: resolveOptionOrEnv(
      options,
      'copilotProviderBaseUrl',
      COPILOT_ENV.PROVIDER_BASE_URL
    ),
    geminiApiKey: process.env[GEMINI_ENV.KEY],
    copilotApiTarget: inputs.resolvedCopilotApiTarget,
    copilotApiBasePath: inputs.resolvedCopilotApiBasePath,
    openaiApiTarget: resolveOptionOrEnv(options, 'openaiApiTarget', OPENAI_ENV.TARGET),
    openaiApiBasePath: resolveOptionOrEnv(options, 'openaiApiBasePath', OPENAI_ENV.BASE_PATH),
    anthropicApiTarget: resolveOptionOrEnv(options, 'anthropicApiTarget', ANTHROPIC_ENV.TARGET),
    anthropicApiBasePath: resolveOptionOrEnv(
      options,
      'anthropicApiBasePath',
      ANTHROPIC_ENV.BASE_PATH
    ),
    openaiApiAuthHeader: resolveOptionOrEnv(options, 'openaiApiAuthHeader', OPENAI_ENV.AUTH_HEADER),
    anthropicApiAuthHeader: resolveOptionOrEnv(
      options,
      'anthropicApiAuthHeader',
      ANTHROPIC_ENV.AUTH_HEADER
    ),
    anthropicTokenUrl: (options.anthropicTokenUrl as string | undefined) ?? process.env.AWF_AUTH_ANTHROPIC_TOKEN_URL,
    ...oidcCredentials,
    geminiApiTarget: resolveOptionOrEnv(options, 'geminiApiTarget', GEMINI_ENV.TARGET),
    geminiApiBasePath: resolveOptionOrEnv(options, 'geminiApiBasePath', GEMINI_ENV.BASE_PATH),
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  };
}

function resolveOptionOrEnv(
  options: Record<string, unknown>,
  optionKey: string,
  envVar: string
): string | undefined {
  return (options[optionKey] as string | undefined) ?? process.env[envVar];
}
