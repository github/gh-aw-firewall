import { WrapperConfig } from '../../types';
import { getConfigEnvValue } from '../../env-utils';

function resolveValue(...values: Array<string | undefined>): string | undefined {
  return values.map(value => value?.trim()).find(Boolean);
}

export function isOpenAiOidcConfigured(config: WrapperConfig): boolean {
  const authType = resolveValue(
    config.authType,
    getConfigEnvValue(config, 'AWF_AUTH_TYPE'),
    process.env.AWF_AUTH_TYPE,
  )?.toLowerCase();
  const authProvider = resolveValue(
    config.authProvider,
    getConfigEnvValue(config, 'AWF_AUTH_PROVIDER'),
    process.env.AWF_AUTH_PROVIDER,
  )?.toLowerCase();
  const identityProviderId = resolveValue(
    getConfigEnvValue(config, 'AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID'),
    process.env.AWF_AUTH_OPENAI_IDENTITY_PROVIDER_ID,
  );
  const serviceAccountId = resolveValue(
    getConfigEnvValue(config, 'AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID'),
    process.env.AWF_AUTH_OPENAI_SERVICE_ACCOUNT_ID,
  );

  return authType === 'github-oidc'
    && authProvider === 'openai'
    && !!identityProviderId
    && !!serviceAccountId;
}
