import * as fs from 'fs';
import { logger } from '../../logger';
import { credentialFilesToHide } from '../../config/mount-policy';
import {
  LocalSourceResolver,
  ParsedMount,
  identityLocalSourceResolver,
  innermostCoveringMount,
  parseMount,
} from './mount-topology';

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

/**
 * Drops `/dev/null` overlays whose target is missing behind a host bind.
 *
 * runc creates missing mountpoints on the underlying filesystem. Behind a
 * writable bind this leaves empty files and directories on the host, owned by
 * root when AWF runs under sudo. Behind a read-only bind it fails with EROFS.
 *
 * A missing credential has nothing to mask at startup. Existing credentials
 * remain masked regardless of bind mode; paths that cannot be probed locally
 * keep their overlays. A file created by the host after this check is not masked.
 */
export function pruneUnmountableCredentialOverlays(
  volumes: string[],
  localSourceResolver: LocalSourceResolver = identityLocalSourceResolver,
): string[] {
  const binds = volumes
    .map(parseMount)
    .filter((mount): mount is ParsedMount => mount !== undefined && mount.source !== '/dev/null');

  const kept = volumes.filter((spec) => {
    const overlay = parseMount(spec);
    if (!overlay || overlay.source !== '/dev/null') return true;

    const exactBinds = binds.filter((bind) => bind.target === overlay.target);
    const exactBind = exactBinds[exactBinds.length - 1];
    if (exactBind) return true;

    const cover = innermostCoveringMount(binds, overlay.target);
    // No covering bind: the mountpoint lives on the container's own writable
    // rootfs, so runc can always create it.
    if (!cover) return true;
    // Named volumes and other non-path sources cannot be probed on the host.
    if (!cover.source.startsWith('/')) return true;

    const suffix = overlay.target.slice(cover.target.length);
    if (!suffix) return true;

    // On split-filesystem runners the covering source may be a daemon-side path
    // that means nothing to `fs` here. Keep the overlay rather than risk
    // unmasking a credential based on an unrelated runner path.
    const localCoverSource = localSourceResolver(cover.source);
    if (localCoverSource === undefined) return true;

    const hostPath = `${localCoverSource}${suffix}`;
    return fs.existsSync(hostPath);
  });

  const dropped = volumes.length - kept.length;
  if (dropped > 0) {
    logger.debug(
      `Dropped ${dropped} credential overlay(s) whose target does not exist behind a host ` +
      'bind; avoiding creation of credential placeholders on the host',
    );
  }

  return kept;
}
