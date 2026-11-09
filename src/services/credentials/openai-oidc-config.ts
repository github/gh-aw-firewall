import { WrapperConfig } from '../../types';
import { getConfigEnvValue } from '../../env-utils';

function resolveConfigOrEnvValue(
  config: WrapperConfig,
  configKey: keyof WrapperConfig,
  envVar: string,
): string | undefined {
  const configValue = config[configKey];
  if (typeof configValue === 'string' && configValue.trim()) {
    return configValue.trim();
  }
  const configEnvValue = getConfigEnvValue(config, envVar)?.trim();
  if (configEnvValue) {
    return configEnvValue;
  }
  return process.env[envVar]?.trim() || undefined;
}

function resolveEnvValue(config: WrapperConfig, envVar: string): string | undefined {
  const configEnvValue = getConfigEnvValue(config, envVar)?.trim();
  return configEnvValue || process.env[envVar]?.trim() || undefined;
}

export function isOpenAiOidcConfigured(config: WrapperConfig): boolean {
  const authType = resolveConfigOrEnvValue(config, 'authType', 'AWF_AUTH_TYPE')?.toLowerCase();
  const authProvider = resolveConfigOrEnvValue(config, 'authProvider', 'AWF_AUTH_PROVIDER')?.toLowerCase();
  const identityProviderId = resolveEnvValue(config, 'AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID');
  const serviceAccountId = resolveEnvValue(config, 'AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID');

  return authType === 'github-oidc'
    && authProvider === 'openai'
    && !!identityProviderId
    && !!serviceAccountId;
}
