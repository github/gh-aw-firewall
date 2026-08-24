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
 * Drops `/dev/null` overlays whose mountpoint cannot physically be created.
 *
 * A bind mount requires its mountpoint to already exist; runc creates a missing
 * one with `openat`/`mkdirat` on the parent directory. That silently works
 * while every mount under `$HOME` is read-write, but once `filesystem.allowWrite`
 * narrows those binds to read-only, runc fails with EROFS and the agent
 * container dies before it starts.
 *
 * An overlay is kept unless its containing bind is read-only *and* the path it
 * masks does not exist behind that bind. Dropping those loses no protection:
 * the read-only bind is the only way the agent could reach the path, and there
 * is nothing there to read. Every credential that is actually reachable is
 * still masked, because mounting over a path that exists succeeds even inside a
 * read-only bind.
 *
 * This is a no-op unless a write policy is active, since every covering bind is
 * read-write otherwise.
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

    const cover = innermostCoveringMount(binds, overlay.target);
    // No covering bind: the mountpoint lives on the container's own writable
    // rootfs, so runc can always create it.
    if (!cover) return true;
    if (cover.mode !== 'ro') return true;
    // Named volumes and other non-path sources cannot be probed on the host.
    if (!cover.source.startsWith('/')) return true;

    const suffix = overlay.target.slice(cover.target.length);
    if (!suffix) return true;

    // On split-filesystem runners the covering source may be a daemon-side path
    // that means nothing to `fs` here. Keep the overlay rather than risk
    // unmasking a credential based on an unrelated runner path.
    const localCoverSource = localSourceResolver(cover.source);
    if (localCoverSource === undefined) return true;

    return fs.existsSync(`${localCoverSource}${suffix}`);
  });

  const dropped = volumes.length - kept.length;
  if (dropped > 0) {
    logger.debug(
      `Dropped ${dropped} credential overlay(s) whose target does not exist behind a read-only ` +
      'mount; those paths are unreadable in the container, so nothing is left unmasked',
    );
  }

  return kept;
}
