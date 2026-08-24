import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';
import { createMissingOwnedDirectorySegments } from '../../fs-utils';
import { isStagedHostFile } from './docker-host-staging';
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
  /**
   * What runc needs at the mountpoint. A bind's target must match its source's
   * type, so this is derived from the source, not guessed from the target.
   * `unknown` means the source could not be classified on this filesystem.
   */
  kind: 'directory' | 'file' | 'unknown';
  /**
   * `/dev/null` credential masks. These need a file mountpoint too, but AWF must
   * never fabricate one: creating the credential path is exactly what the mask
   * exists to prevent. Unmountable overlays are dropped upstream instead.
   */
  credentialOverlay: boolean;
}

function statKind(candidate: string): 'directory' | 'file' | 'missing' | 'unknown' {
  try {
    const stats = fs.statSync(candidate);
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    return 'unknown';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'unknown';
  }
}

function resolveSourceKind(
  source: string,
  localSource: string | undefined,
): 'directory' | 'file' | 'unknown' {
  // Staged files sit under the daemon prefix, so `localSource` is deliberately
  // undefined for them. The staging record is the only surviving evidence of
  // their type.
  if (isStagedHostFile(source)) return 'file';
  // No local path at all: a daemon-side source we cannot inspect and did not
  // stage. Guessing here is what the fail-closed path exists to prevent.
  if (localSource === undefined) return 'unknown';

  const kind = statKind(localSource);
  // A source that simply does not exist yet is not ambiguous. Some AWF-owned
  // sources (the init signal directory among them) are materialised after the
  // volume list is built, and the daemon creates a *directory* for any bind
  // source still missing at launch — so the mountpoint has to be a directory to
  // match. Verified against a real daemon: binding a missing source yields a
  // directory on both the host and inside the guest.
  if (kind === 'missing') return 'directory';
  return kind;
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
    const credentialOverlay = mount.source === '/dev/null';
    requirements.push({
      containerTarget: mount.target,
      source: mount.source,
      coveringTarget: cover.target,
      coveringSource: cover.source,
      hostPath: localCoverSource === undefined ? undefined : `${localCoverSource}${suffix}`,
      kind: credentialOverlay
        ? 'file'
        : resolveSourceKind(mount.source, localSourceResolver(mount.source)),
      credentialOverlay,
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
 * Creates an empty file for runc to bind over.
 *
 * Deliberately exclusive (`wx`): if something already occupies the path we must
 * not truncate it. Contents are never written — the bind replaces the file's
 * contents wholesale, so the placeholder only has to exist and be of the right
 * type. The mode is owner-only because these paths can land in a world-writable
 * directory (`/tmp/awf-runner-bin` under a narrowed `/tmp`), and a bind does not
 * care about its mountpoint's permissions.
 *
 * An exclusive create is also what makes the symlink check below reachable
 * rather than theoretical: `O_CREAT | O_EXCL` refuses to follow a symlink, so a
 * planted one surfaces as `EEXIST` instead of being silently written through.
 */
function createOwnedPlaceholderFile(filePath: string, uid: number, gid: number): void {
  let handle: number | undefined;
  try {
    handle = fs.openSync(filePath, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      assertUsableFileMountpoint(filePath);
      return;
    }
    throw err;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }

  try {
    fs.chownSync(filePath, uid, gid);
  } catch (err) {
    // Ownership is a convenience for the in-container user; the mountpoint
    // itself is what runc needs, and the bind masks the placeholder entirely.
    logger.debug(`Could not chown placeholder mountpoint ${filePath}: ${err}`);
  }
}

/**
 * Accepts an entry that appeared underneath us only if runc could actually bind
 * over it.
 *
 * Reaching here means the path was absent when preparation looked and present a
 * moment later. A regular file is the benign explanation and is fine to reuse.
 * Anything else is not: a symlink hands runc a target of someone else's
 * choosing, and a directory makes the daemon reject the bind with "not a
 * directory" once the run is already under way. Neither is repaired here —
 * deleting a path we did not create is how a mountpoint helper turns into a
 * destructive one — so both fail closed while the context is still useful.
 */
function assertUsableFileMountpoint(filePath: string): void {
  const entry = fs.lstatSync(filePath);
  if (entry.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as bind mountpoint: ${filePath}`);
  }
  if (!entry.isFile()) {
    throw new Error(`Bind mountpoint exists but is not a regular file: ${filePath}`);
  }
}

/**
 * Creates the mountpoints reported by {@link planNestedMountpoints}.
 *
 * A requirement is *inert* only when the covering bind's source is not a real
 * directory on this filesystem: that means a fabricated path or a daemon-side
 * one, and in both cases there is nothing here we could or should write into.
 *
 * Everything else is *required*. A required mountpoint is either already
 * present, or gets created as the same type as its source — a directory for a
 * directory bind, an empty placeholder file for a regular-file bind. Nothing
 * required is skipped silently: a requirement we cannot classify or cannot
 * satisfy fails the launch, because the alternative is an opaque EROFS from
 * container init long after the useful context is gone.
 *
 * The one thing never fabricated is a `/dev/null` credential mask. Creating the
 * credential path is precisely what the mask exists to prevent, so unmountable
 * overlays are dropped upstream by
 * {@link ../agent-volumes/credential-hiding.pruneUnmountableCredentialOverlays}.
 * That runs first and probes the same paths, so a surviving overlay always has
 * an existing mountpoint; if one ever does not, that is a real inconsistency and
 * is reported rather than papered over.
 */
export function ensureNestedMountpoints(
  volumes: string[],
  uid: number,
  gid: number,
  localSourceResolver: LocalSourceResolver = identityLocalSourceResolver,
): string[] {
  const created: string[] = [];
  const requirements = planNestedMountpoints(volumes, localSourceResolver);
  const unmet: string[] = [];

  for (const requirement of requirements) {
    const localCoverSource = localSourceResolver(requirement.coveringSource);
    // Not a place we can write: fabricated or daemon-side cover.
    if (localCoverSource === undefined || !isExistingDirectory(localCoverSource)) {
      logger.debug(
        `Skipping mountpoint preparation for ${requirement.containerTarget}: covering bind ` +
        `source ${requirement.coveringSource} is not a directory on this filesystem`,
      );
      continue;
    }

    const { hostPath } = requirement;
    // The cover resolved, so `planNestedMountpoints` always produced a hostPath.
    if (hostPath === undefined) continue;
    if (fs.existsSync(hostPath)) {
      // An existing directory mountpoint is the overwhelmingly common case and
      // is left exactly as it was found. A *file* mountpoint is different: the
      // daemon rejects the bind outright if the entry is the wrong type, so the
      // one kind this pass introduces is also the one kind worth checking.
      if (requirement.kind === 'file' && !requirement.credentialOverlay) {
        assertUsableFileMountpoint(hostPath);
      }
      continue;
    }

    if (requirement.credentialOverlay) {
      unmet.push(
        `${requirement.containerTarget} (credential mask needs ${hostPath}, which AWF must not create)`,
      );
      continue;
    }

    if (requirement.kind === 'unknown') {
      unmet.push(
        `${requirement.containerTarget} (needs ${hostPath}, but source ${requirement.source} ` +
        'could not be classified as a file or a directory)',
      );
      continue;
    }

    if (requirement.kind === 'file') {
      createMissingOwnedDirectorySegments(path.dirname(hostPath), uid, gid);
      createOwnedPlaceholderFile(hostPath, uid, gid);
    } else {
      createMissingOwnedDirectorySegments(hostPath, uid, gid);
    }

    created.push(hostPath);
    logger.debug(
      `Prepared nested ${requirement.kind} mountpoint ${hostPath} for ` +
      `${requirement.containerTarget} (inside read-only bind ${requirement.coveringTarget})`,
    );

    if (!fs.existsSync(hostPath)) {
      unmet.push(`${requirement.containerTarget} (needs ${hostPath})`);
    }
  }

  if (unmet.length > 0) {
    throw new Error(
      `Could not prepare bind mountpoints nested inside a read-only mount: ${unmet.join(', ')}. ` +
      'The agent container would fail to start with a read-only filesystem error.',
    );
  }

  return created;
}
