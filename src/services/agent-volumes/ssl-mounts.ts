import { SslConfig } from '../../host-env';

export function buildSslMounts(sslConfig?: SslConfig): string[] {
  if (!sslConfig) {
    return [];
  }

  return [`${sslConfig.caFiles.certPath}:/usr/local/share/ca-certificates/awf-ca.crt:ro`];
}
