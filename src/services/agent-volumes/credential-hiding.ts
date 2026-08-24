import * as fs from 'fs';
import { logger } from '../../logger';
import { credentialFilesToHide } from '../../config/mount-policy';

/**
 * Builds the compose-mode `/dev/null` overlays that blank known on-disk
 * credential files. The file list is derived from the central mount policy
 * ({@link ../../config/mount-policy}) so it can't drift from the sbx backend.
 *
 * Each credential file is masked twice: once at the real `$HOME` path and once
 * at the chroot `/host$HOME` path (the agent runs chrooted into `/host`).
 *
 * Only files that actually exist on the host are masked. A `/dev/null` overlay
 * requires its mountpoint to already exist: runc creates a missing one by
 * `openat(..., O_CREAT)` on the parent, which fails with EROFS once
 * `filesystem.allowWrite` narrows the `$HOME` bind to read-only, taking the
 * whole agent container down before it starts. Skipping absent files loses no
 * protection, because a file that does not exist cannot leak a credential —
 * every file that does exist is still masked, including inside a read-only
 * parent (mounting over an existing path does not write to the filesystem).
 */
export function buildCredentialHidingOverlays(effectiveHome: string): string[] {
  const allCredentialFiles = credentialFilesToHide().map((rel) => `${effectiveHome}/${rel}`);
  const credentialFiles = allCredentialFiles.filter((credFile) => fs.existsSync(credFile));
  const skipped = allCredentialFiles.length - credentialFiles.length;
  if (skipped > 0) {
    logger.debug(`Skipped ${skipped} credential overlay(s) with no file on the host`);
  }

  const mounts = credentialFiles.map((credFile) => `/dev/null:${credFile}:ro`);
  logger.debug(`Hidden ${credentialFiles.length} credential file(s) via /dev/null mounts`);

  logger.debug('Hiding credential files at /host paths');
  const chrootCredentialFiles = credentialFiles.map((credFile) => `/dev/null:/host${credFile}:ro`);
  mounts.push(...chrootCredentialFiles);
  logger.debug(`Hidden ${chrootCredentialFiles.length} credential file(s) at /host paths`);

  return mounts;
}
