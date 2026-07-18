import { copyEnvEntries } from '../../env-utils';
import { SslConfig } from '../../host-env';
import { WrapperConfig } from '../../types';

interface OtelEnvironmentParams {
  config: WrapperConfig;
  environment: Record<string, string>;
  excludedEnvVars: Set<string>;
}

export function buildOtelEnvironment(params: OtelEnvironmentParams): void {
  const { config, environment, excludedEnvVars } = params;
  if (config.envAll) {
    return;
  }

  copyEnvEntries(process.env, environment, {
    excludedKeys: excludedEnvVars,
    noOverwrite: true,
    keyPredicate: (key) => key.startsWith('OTEL_'),
  });
}

export function buildSslEnvironment(environment: Record<string, string>, sslConfig?: SslConfig): void {
  if (!sslConfig) {
    return;
  }

  environment.AWF_SSL_BUMP_ENABLED = 'true';
  environment.NODE_EXTRA_CA_CERTS = '/usr/local/share/ca-certificates/awf-ca.crt';
}
