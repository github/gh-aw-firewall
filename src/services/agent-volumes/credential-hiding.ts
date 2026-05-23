import { logger } from '../../logger';

export function buildCredentialHidingOverlays(effectiveHome: string): string[] {
  const credentialFiles = [
    `${effectiveHome}/.docker/config.json`,
    `${effectiveHome}/.npmrc`,
    `${effectiveHome}/.cargo/credentials`,
    `${effectiveHome}/.composer/auth.json`,
    `${effectiveHome}/.config/gh/hosts.yml`,
    `${effectiveHome}/.ssh/id_rsa`,
    `${effectiveHome}/.ssh/id_ed25519`,
    `${effectiveHome}/.ssh/id_ecdsa`,
    `${effectiveHome}/.ssh/id_dsa`,
    `${effectiveHome}/.aws/credentials`,
    `${effectiveHome}/.aws/config`,
    `${effectiveHome}/.kube/config`,
    `${effectiveHome}/.azure/credentials`,
    `${effectiveHome}/.config/gcloud/credentials.db`,
  ];

  const mounts = credentialFiles.map(credFile => `/dev/null:${credFile}:ro`);
  logger.debug(`Hidden ${credentialFiles.length} credential file(s) via /dev/null mounts`);

  logger.debug('Hiding credential files at /host paths');

  const chrootCredentialFiles = [
    `/dev/null:/host${effectiveHome}/.docker/config.json:ro`,
    `/dev/null:/host${effectiveHome}/.npmrc:ro`,
    `/dev/null:/host${effectiveHome}/.cargo/credentials:ro`,
    `/dev/null:/host${effectiveHome}/.composer/auth.json:ro`,
    `/dev/null:/host${effectiveHome}/.config/gh/hosts.yml:ro`,
    `/dev/null:/host${effectiveHome}/.ssh/id_rsa:ro`,
    `/dev/null:/host${effectiveHome}/.ssh/id_ed25519:ro`,
    `/dev/null:/host${effectiveHome}/.ssh/id_ecdsa:ro`,
    `/dev/null:/host${effectiveHome}/.ssh/id_dsa:ro`,
    `/dev/null:/host${effectiveHome}/.aws/credentials:ro`,
    `/dev/null:/host${effectiveHome}/.aws/config:ro`,
    `/dev/null:/host${effectiveHome}/.kube/config:ro`,
    `/dev/null:/host${effectiveHome}/.azure/credentials:ro`,
    `/dev/null:/host${effectiveHome}/.config/gcloud/credentials.db:ro`,
  ];

  mounts.push(...chrootCredentialFiles);
  logger.debug(`Hidden ${chrootCredentialFiles.length} credential file(s) at /host paths`);

  return mounts;
}
