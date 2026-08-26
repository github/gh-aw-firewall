/**
 * Run-scoped, private directory that holds the host ends of the published
 * capability sockets.
 *
 * Every socket AWF publishes into an Apple Container guest lives in exactly one
 * of these directories. The directory is the primary access-control boundary:
 * it is created fresh per run with mode `0700` and is owned by the invoking
 * user, so no other local user can reach a capability socket even during the
 * brief window between `listen()` and the follow-up `chmod`.
 *
 * The defences implemented here, and why each one exists:
 *
 * - **Cross-run collision.** The directory is created with a non-recursive
 *   `mkdir`, so an existing path is an error rather than a silent reuse. Two
 *   concurrent runs can never share a socket namespace.
 * - **Symlink substitution.** The base directory is resolved with `realpath`
 *   *before* the run directory is created, the run directory is then verified
 *   to be a real directory (not a symlink) that resolves to itself, and its
 *   ownership and mode are re-read from the filesystem rather than assumed.
 * - **Path traversal.** Socket basenames come from the compiled-in capability
 *   allowlist, never from caller input, and the joined path is re-checked to
 *   still be a direct child of the run directory.
 * - **Stale socket reuse.** A socket path must not exist before it is bound;
 *   binding never unlinks a pre-existing file, so a planted socket produces a
 *   hard failure instead of a hijacked capability.
 * - **`sun_path` truncation.** macOS caps a Unix socket path at 104 bytes
 *   including the NUL terminator. A path over that limit is silently truncated
 *   by the kernel, which would bind a *different* path than the one published
 *   into the guest, so the limit is enforced up front.
 *
 * Removal only ever touches paths this module created, is idempotent, and never
 * recurses.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

import { assertAppleContainerPath } from './validation';

/** macOS `sun_path` is `char[104]`; the usable path is one byte shorter. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/** `--publish-socket` packs `host_path:container_path` into one argv token. */
const SOCKET_PATH_DELIMITERS = [':'] as const;

const RUN_ID_PATTERN = /^[a-f0-9]{8,16}$/;

const DIRECTORY_PREFIX = 'awf-apple-';

/** Generates a short, collision-resistant run id that keeps `sun_path` short. */
export function generateAppleContainerTransportRunId(): string {
  return randomBytes(6).toString('hex');
}

export interface AppleContainerSocketDirectoryOptions {
  /** Parent directory. Defaults to the process temporary directory. */
  readonly baseDirectory: string;
  /** Lowercase hex run id; generated when omitted. */
  readonly runId?: string;
}

export interface AppleContainerSocketDirectoryHandle {
  readonly path: string;
  readonly runId: string;
}

/**
 * Creates the private run directory.
 *
 * @throws when the base directory is unusable, the run directory already
 * exists, or the created directory fails its post-creation ownership/mode/type
 * verification. Nothing is retried and nothing degrades to a shared location.
 */
export async function createAppleContainerSocketDirectory(
  options: AppleContainerSocketDirectoryOptions,
): Promise<AppleContainerSocketDirectoryHandle> {
  const runId = options.runId ?? generateAppleContainerTransportRunId();
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(
      `Apple Container transport run id must be 8-16 lowercase hex characters; got ${runId}`,
    );
  }

  const base = assertAppleContainerPath(
    options.baseDirectory,
    'transport socket base directory',
    SOCKET_PATH_DELIMITERS,
  );

  let resolvedBase: string;
  try {
    resolvedBase = await fs.realpath(base);
  } catch (error) {
    throw new Error(
      `Apple Container transport socket base directory ${base} is not usable: ${describe(error)}`,
    );
  }
  // `realpath` may resolve through a symlink (`/tmp` -> `/private/tmp` on
  // macOS), so the resolved form is re-validated before it is used to build
  // argv tokens.
  const validatedBase = assertAppleContainerPath(
    resolvedBase,
    'transport socket base directory',
    SOCKET_PATH_DELIMITERS,
  );

  const baseStats = await fs.lstat(validatedBase);
  if (!baseStats.isDirectory()) {
    throw new Error(
      `Apple Container transport socket base ${validatedBase} is not a directory`,
    );
  }

  const directory = path.posix.join(validatedBase, `${DIRECTORY_PREFIX}${runId}`);
  assertSocketPathBudget(directory);

  try {
    await fs.mkdir(directory, { mode: 0o700, recursive: false });
  } catch (error) {
    throw new Error(
      `Apple Container transport socket directory ${directory} could not be created: ` +
      `${describe(error)}`,
    );
  }

  try {
    // `mkdir` masks its mode with the process umask, so the mode is forced
    // afterwards rather than trusted.
    await fs.chmod(directory, 0o700);
    await assertPrivateDirectory(directory);
  } catch (error) {
    await removeAppleContainerSocketDirectory({ path: directory, runId }, []);
    throw error;
  }

  return { path: directory, runId };
}

/**
 * Builds the host path for one capability socket inside the run directory.
 *
 * `socketName` always originates from the compiled-in capability allowlist; the
 * containment re-check exists so a future caller cannot turn it into an
 * attacker-influenced value without the check failing.
 */
export function appleContainerHostSocketPath(
  directory: AppleContainerSocketDirectoryHandle,
  socketName: string,
): string {
  if (!/^[a-z0-9][a-z0-9-]*\.sock$/.test(socketName)) {
    throw new Error(`Apple Container transport socket name is not valid: ${socketName}`);
  }
  const candidate = path.posix.join(directory.path, socketName);
  if (path.posix.dirname(candidate) !== directory.path) {
    throw new Error(
      `Apple Container transport socket ${socketName} would escape ${directory.path}`,
    );
  }
  assertSocketPathBudget(candidate);
  return assertAppleContainerPath(candidate, 'transport socket path', SOCKET_PATH_DELIMITERS);
}

/** Rejects a path the kernel would silently truncate when binding. */
export function assertSocketPathBudget(candidate: string): string {
  const bytes = Buffer.byteLength(candidate);
  if (bytes > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(
      `Apple Container transport socket path is ${bytes} bytes, over the ` +
      `${MAX_UNIX_SOCKET_PATH_BYTES}-byte sun_path limit: ${candidate}`,
    );
  }
  return candidate;
}

/** Verifies a directory is a real, self-owned, group/other-inaccessible directory. */
export async function assertPrivateDirectory(directory: string): Promise<void> {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory()) {
    throw new Error(`Apple Container transport socket directory ${directory} is not a directory`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `Apple Container transport socket directory ${directory} is group/world accessible ` +
      `(mode ${(stats.mode & 0o7777).toString(8)})`,
    );
  }
  assertOwnedBySelf(stats.uid, directory);

  const resolved = await fs.realpath(directory);
  if (resolved !== directory) {
    throw new Error(
      `Apple Container transport socket directory ${directory} resolves to ${resolved}; ` +
      'refusing to publish sockets through a substituted path',
    );
  }
}

/** Verifies a bound socket is a real socket owned by this user and private. */
export async function assertPrivateSocket(socketPath: string): Promise<void> {
  const stats = await fs.lstat(socketPath);
  if (!stats.isSocket()) {
    throw new Error(`Apple Container transport path ${socketPath} is not a Unix socket`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(
      `Apple Container transport socket ${socketPath} is group/world accessible ` +
      `(mode ${(stats.mode & 0o7777).toString(8)})`,
    );
  }
  assertOwnedBySelf(stats.uid, socketPath);
}

/** Fails when a socket path is already occupied, rather than unlinking it. */
export async function assertSocketPathUnused(socketPath: string): Promise<void> {
  try {
    await fs.lstat(socketPath);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new Error(
    `Apple Container transport socket ${socketPath} already exists; refusing to reuse or ` +
    'unlink a path this run did not create',
  );
}

/**
 * Removes the sockets this run created and then the run directory itself.
 *
 * Idempotent and non-recursive: missing entries are fine, and anything the run
 * did not create is left untouched so a partially-cleaned directory fails to
 * `rmdir` loudly instead of deleting a stranger's files.
 */
export async function removeAppleContainerSocketDirectory(
  directory: AppleContainerSocketDirectoryHandle,
  socketPaths: readonly string[],
): Promise<void> {
  for (const socketPath of socketPaths) {
    if (path.posix.dirname(socketPath) !== directory.path) {
      throw new Error(
        `Apple Container transport refusing to remove ${socketPath}, which is outside ` +
        `${directory.path}`,
      );
    }
    try {
      await fs.unlink(socketPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  try {
    await fs.rmdir(directory.path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function assertOwnedBySelf(uid: number, target: string): void {
  const self = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (self !== undefined && uid !== self) {
    throw new Error(
      `Apple Container transport path ${target} is owned by uid ${uid}, not ${self}`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
