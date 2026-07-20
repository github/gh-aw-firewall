import { logger } from '../../logger';
import { credentialFilesToHide } from '../../config/mount-policy';

/**
 * Builds the compose-mode `/dev/null` overlays that blank known on-disk
 * credential files. The file list is derived from the central mount policy
 * ({@link ../../config/mount-policy}) so it can't drift from the sbx backend.
 *
 * Each credential file is masked twice: once at the real `$HOME` path and once
 * at the chroot `/host$HOME` path (the agent runs chrooted into `/host`).
 */
export function buildCredentialHidingOverlays(effectiveHome: string): string[] {
  const credentialFiles = credentialFilesToHide().map((rel) => `${effectiveHome}/${rel}`);

  const mounts = credentialFiles.map((credFile) => `/dev/null:${credFile}:ro`);
  logger.debug(`Hidden ${credentialFiles.length} credential file(s) via /dev/null mounts`);

  logger.debug('Hiding credential files at /host paths');
  const chrootCredentialFiles = credentialFiles.map((credFile) => `/dev/null:/host${credFile}:ro`);
  mounts.push(...chrootCredentialFiles);
  logger.debug(`Hidden ${chrootCredentialFiles.length} credential file(s) at /host paths`);

  return mounts;
}
