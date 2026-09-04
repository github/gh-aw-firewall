import * as fs from 'fs';
import * as path from 'path';
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
 * Reports whether runc could create a missing mountpoint under `dirPath`,
 * matching how it actually behaves: a writable covering bind lets Docker
 * `mkdirat` the full chain of missing intermediate directories, so the check
 * has to walk up to the nearest ancestor that already exists rather than
 * requiring the immediate parent to be present.
 *
 * Failing closed (returning `false`) on any surprise -- a missing root, a
 * non-directory ancestor -- is safe here: the caller only uses this to decide
 * whether a *missing* credential mask can be created, never whether an
 * existing one is reachable.
 */
function canCreateMountpointUnder(dirPath: string): boolean {
  let current = dirPath;
  for (;;) {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
      continue;
    }
    if (!stats.isDirectory()) return false;
    try {
      fs.accessSync(current, fs.constants.W_OK | fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Drops `/dev/null` overlays whose mountpoint cannot physically be created.
 *
 * A bind mount requires its mountpoint to already exist; runc creates a missing
 * one with `openat`/`mkdirat` on the parent directory. That silently works
 * while every mount under `$HOME` is read-write and backed by a genuinely
 * writable directory on the runner. Two different things can break it:
 *
 *  - `filesystem.allowWrite` narrows the covering bind to read-only. Docker
 *    remounts that bind read-only *inside the container*, so `mkdirat` for
 *    anything nested under it fails with EROFS no matter what the real host
 *    directory allows.
 *  - The covering bind is still declared read-write, but the directory it
 *    points at is itself read-only on the runner's real filesystem (for
 *    example a staged ARC/DinD layout under `--docker-host-path-prefix`).
 *    Docker does not remount this case, so it touches the real path directly
 *    and hits the same EROFS (github/gh-aw-firewall#8076).
 *
 * An overlay is kept unless its containing bind cannot supply the mountpoint
 * and the path it masks does not already exist behind that bind. Dropping
 * those loses no protection: an unmountable bind is the only way the agent
 * could reach the path, and there is nothing there to read. Every credential
 * that is actually reachable is still masked, because mounting over a path
 * that exists succeeds regardless of the bind's mode or the real directory's
 * writability.
 *
 * This is a no-op for the common case where every covering bind is read-write
 * and genuinely backed by a writable runner directory.
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
    if (fs.existsSync(hostPath)) return true;

    // The mountpoint is missing and runc must create it. A bind Docker
    // narrowed to read-only can never do that, regardless of the real host
    // directory. A read-write bind can, unless the real directory backing it
    // is itself read-only.
    if (cover.mode === 'ro') return false;
    return canCreateMountpointUnder(path.dirname(hostPath));
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
