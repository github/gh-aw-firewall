import * as fs from 'fs';
import { logger } from '../../logger';
import { createMissingOwnedDirectorySegments } from '../../fs-utils';
import {
  LocalSourceResolver,
  ParsedMount,
  identityLocalSourceResolver,
  innermostCoveringMount,
  parseMount,
} from './mount-topology';

export interface NestedMountpointRequirement {
  /** Container path whose mountpoint runc must create. */
  containerTarget: string;
  /** Source of the mount that needs the mountpoint. */
  source: string;
  /** Target of the read-only bind that owns the directory entry. */
  coveringTarget: string;
  /** Source of that covering bind, as written into the compose file. */
  coveringSource: string;
  /** Path on the runner that must exist so runc does not have to create it. */
  hostPath?: string;
  /** `/dev/null` credential overlays need a file, every other bind a directory. */
  kind: 'directory' | 'file';
}

/**
 * Derives every mountpoint runc would have to create inside a read-only bind.
 *
 * runc applies binds parent-first and creates a missing mountpoint with
 * `mkdirat` against the *destination*, which resolves into whichever bind
 * already covers that path. While every covering bind is read-write this always
 * succeeds, which is why the nesting went unnoticed. As soon as
 * `filesystem.allowWrite` narrows a covering bind to read-only the same
 * `mkdirat` returns EROFS and container init dies before the agent runs.
 *
 * Deriving the list from the final, policy-applied volumes (rather than from a
 * hand-maintained list of known nested paths) means any internal mount added
 * later is covered automatically.
 *
 * Pure: this only reports requirements, it does not touch the filesystem.
 */
export function planNestedMountpoints(
  volumes: string[],
  localSourceResolver: LocalSourceResolver = identityLocalSourceResolver,
): NestedMountpointRequirement[] {
  const mounts = volumes
    .map(parseMount)
    .filter((mount): mount is ParsedMount => mount !== undefined);
  const binds = mounts.filter((mount) => mount.source !== '/dev/null');

  const requirements: NestedMountpointRequirement[] = [];
  for (const mount of mounts) {
    const cover = innermostCoveringMount(binds, mount.target);
    // No covering bind: the mountpoint lives on the container's own writable
    // rootfs and runc can always create it.
    if (!cover) continue;
    // A read-write cover can still create its own mountpoints.
    if (cover.mode !== 'ro') continue;
    if (!cover.source.startsWith('/')) continue;

    const suffix = mount.target.slice(cover.target.length);
    if (!suffix) continue;

    const localCoverSource = localSourceResolver(cover.source);
    requirements.push({
      containerTarget: mount.target,
      source: mount.source,
      coveringTarget: cover.target,
      coveringSource: cover.source,
      hostPath: localCoverSource === undefined ? undefined : `${localCoverSource}${suffix}`,
      kind: mount.source === '/dev/null' ? 'file' : 'directory',
    });
  }

  return requirements;
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Creates the directory mountpoints reported by {@link planNestedMountpoints}.
 *
 * Only directories are prepared. `/dev/null` credential overlays intentionally
 * are not: fabricating a credential file just to mount over it would create the
 * very path we are hiding. Those are handled by
 * {@link ../agent-volumes/credential-hiding.pruneUnmountableCredentialOverlays}
 * instead, which drops overlays that are unreachable anyway.
 *
 * A requirement is skipped when the covering bind's source is not a real
 * directory on this filesystem — that means either a fabricated path (unit
 * tests) or a daemon-side path we must not touch. Any other failure propagates:
 * an unpreparable mountpoint is a launch failure, and failing here is much
 * better than an opaque EROFS from container init.
 */
export function ensureNestedMountpoints(
  volumes: string[],
  uid: number,
  gid: number,
  localSourceResolver: LocalSourceResolver = identityLocalSourceResolver,
): string[] {
  const created: string[] = [];
  const requirements = planNestedMountpoints(volumes, localSourceResolver);
  const actionable: NestedMountpointRequirement[] = [];

  for (const requirement of requirements) {
    if (requirement.kind !== 'directory') continue;

    const { hostPath } = requirement;
    if (hostPath === undefined) {
      logger.debug(
        `Skipping mountpoint preparation for ${requirement.containerTarget}: the covering bind ` +
        `source ${requirement.coveringSource} is not resolvable on this filesystem`,
      );
      continue;
    }

    const localCoverSource = localSourceResolver(requirement.coveringSource);
    if (localCoverSource === undefined || !isExistingDirectory(localCoverSource)) continue;
    // Only prepare mountpoints for binds that really exist on this filesystem.
    // A source that is absent is either a fabricated path or a daemon-side one,
    // and in both cases we must not materialise a tree for it.
    const localMountSource = localSourceResolver(requirement.source);
    if (localMountSource === undefined || !isExistingDirectory(localMountSource)) continue;

    actionable.push(requirement);
    if (fs.existsSync(hostPath)) continue;

    createMissingOwnedDirectorySegments(hostPath, uid, gid);
    created.push(hostPath);
    logger.debug(
      `Prepared nested mountpoint ${hostPath} for ${requirement.containerTarget} ` +
      `(inside read-only bind ${requirement.coveringTarget})`,
    );
  }

  // Fail closed: a mountpoint that is still missing would surface as an opaque
  // EROFS from container init, long after the useful context is gone.
  const unmet = actionable.filter((requirement) => !fs.existsSync(requirement.hostPath as string));
  if (unmet.length > 0) {
    const details = unmet
      .map((requirement) => `${requirement.containerTarget} (needs ${requirement.hostPath})`)
      .join(', ');
    throw new Error(
      `Could not prepare bind mountpoints nested inside a read-only mount: ${details}. ` +
      'The agent container would fail to start with a read-only filesystem error.',
    );
  }

  return created;
}
