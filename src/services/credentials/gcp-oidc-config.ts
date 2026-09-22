import { WrapperConfig } from '../../types';
import { getConfigEnvValue } from '../../env-utils';

function resolveConfigOrEnvValue(config: WrapperConfig, configKey: keyof WrapperConfig, envVar: string): string | undefined {
  const configValue = config[configKey];
  if (typeof configValue === 'string' && configValue.trim()) {
    return configValue.trim();
  }
  return getConfigEnvValue(config, envVar) ?? (process.env[envVar]?.trim() || undefined);
}

export function isGcpOidcConfigured(config: WrapperConfig): boolean {
  const authType = resolveConfigOrEnvValue(config, 'authType', 'AWF_AUTH_TYPE')?.toLowerCase();
  const authProvider = resolveConfigOrEnvValue(config, 'authProvider', 'AWF_AUTH_PROVIDER')?.toLowerCase();
  const workloadIdentityProvider = resolveConfigOrEnvValue(
    config,
    'authGcpWorkloadIdentityProvider',
    'AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER'
  );

  return authType === 'github-oidc'
    && authProvider === 'gcp'
    && !!workloadIdentityProvider;
}
