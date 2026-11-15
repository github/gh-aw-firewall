import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { WrapperConfig } from './types';
import { logger } from './logger';
import { getSafeHostGid, getSafeHostUid, isNativeRootWithoutSudo } from './host-identity';

/**
 * Produces a human-readable diagnostic string explaining why EACCES occurred.
 * Walks the path hierarchy to identify which ancestor is not writable/searchable.
 * Returns the diagnostic string and the identified blocking path (if found).
 */
function diagnoseEacces(targetDir: string): { diagnosis: string; blockerPath: string | null } {
  const resolvedTarget = path.resolve(targetDir);
  let current = resolvedTarget;
  const lines: string[] = [];
  let blockerPath: string | null = null;

  // Walk up to find the blocking directory
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      try {
        const stat = fs.statSync(current);
        const writable = isWritable(current);
        lines.push(
          `  ${current}: uid=${stat.uid} gid=${stat.gid} mode=${(stat.mode & 0o7777).toString(8)} writable=${writable}`
        );
        if (!writable) {
          blockerPath = current;
          lines.push(`  └─ BLOCKED HERE: current process (uid=${process.getuid?.() ?? '?'}) cannot write to this directory`);
          break;
        }
      } catch {
        lines.push(`  ${current}: (cannot stat)`);
        break;
      }
    }
    current = path.dirname(current);
  }

  const diagnosis = lines.length > 0
    ? `Path diagnosis:\n${lines.join('\n')}`
    : `Path diagnosis: could not determine blocking ancestor`;
  return { diagnosis, blockerPath };
}

function isWritable(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively transfers ownership of `targetPath` without ever dereferencing a
 * symbolic link.
 *
 * Delegates to coreutils `chown`, whose recursive mode performs a physical
 * (`-P`) descriptor-relative traversal. Re-implementing the walk in JavaScript
 * would be racy: Node exposes no `openat`/`fchownat`, so every recursion step
 * has to re-resolve a pathname that a process running as the target uid can
 * swap for a symlink between the check and the chown.
 */
function chownTreeWithoutFollowingSymlink(targetPath: string, uid: number, gid: number): void {
  // Built from numbers validated by the caller; passed as a single argv entry.
  const ownerSpec = [uid, gid].join(':');
  const result = execa.sync(
    'chown',
    // -h: act on symlinks themselves, -P: never traverse symlinks, -R: recurse,
    // --: stop option parsing so paths are never interpreted as flags.
    ['-h', '-P', '-R', '--', ownerSpec, targetPath],
    { reject: false }
  );

  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.exitCode}`;
    throw new Error(detail);
  }
}

/**
 * Resolves the sandbox identity used inside the agent container, or null when
 * it is not a usable unprivileged identity.
 */
function resolveSandboxIdentity(): { uid: number; gid: number } | null {
  const uid = Number.parseInt(getSafeHostUid(), 10);
  const gid = Number.parseInt(getSafeHostGid(), 10);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || gid <= 0) {
    return null;
  }
  return { uid, gid };
}

/**
 * Transfers ownership of a host path to the sandbox identity, logging (rather
 * than throwing) when the repair cannot be completed.
 */
function repairPathOwnership(targetPath: string, uid: number, gid: number): void {
  try {
    chownTreeWithoutFollowingSymlink(targetPath, uid, gid);
    logger.debug(`Transferred ${targetPath} ownership to sandbox user (${uid}:${gid}) before container launch`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to transfer ${targetPath} ownership to sandbox user (${uid}:${gid}): ${message}`);
  }
}

export function repairRunnerTempGhAwOwnership(): void {
  if (process.getuid?.() !== 0) {
    return;
  }

  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp || !path.isAbsolute(runnerTemp)) {
    return;
  }

  const ghAwRoot = path.join(runnerTemp, 'gh-aw');
  if (!fs.existsSync(ghAwRoot)) {
    return;
  }

  const identity = resolveSandboxIdentity();
  if (!identity) {
    logger.warn(`Skipping ${ghAwRoot} ownership repair because the sandbox identity is invalid`);
    return;
  }

  repairPathOwnership(ghAwRoot, identity.uid, identity.gid);
}

/**
 * Reports whether the sandbox identity can create entries in `targetDir`.
 *
 * The host process usually runs as root, which bypasses permission checks, so
 * `fs.accessSync` cannot answer this question. The mode bits are inspected
 * directly instead: the sandbox identity has no supplementary groups inside the
 * container, so owner/group/other is the complete picture.
 */
function isDirectoryWritableByIdentity(targetDir: string, uid: number, gid: number): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetDir);
  } catch {
    return false;
  }

  if (!stat.isDirectory()) {
    return false;
  }

  // Write + search permission are both required to create entries in a directory.
  if (stat.uid === uid) {
    return (stat.mode & 0o300) === 0o300;
  }
  if (stat.gid === gid) {
    return (stat.mode & 0o030) === 0o030;
  }
  return (stat.mode & 0o003) === 0o003;
}

/**
 * Repairs ownership of the host workspace mount and verifies the sandbox
 * identity can write to it.
 *
 * On native-root runners (root with no `SUDO_UID`, e.g. AWS CodeBuild-hosted
 * runners) the checkout is root-owned while the agent runs as the fallback
 * sandbox identity, so the workdir is writable by mount but not by ownership.
 * Without this repair the agent silently fails to write and the job reports a
 * false green.
 */
export function repairContainerWorkDirOwnership(config: WrapperConfig): void {
  const containerWorkDir = config.containerWorkDir;
  if (!containerWorkDir || !path.isAbsolute(containerWorkDir)) {
    return;
  }

  if (!isNativeRootWithoutSudo()) {
    return;
  }

  const workspaceDir = process.env.GITHUB_WORKSPACE || process.cwd();
  if (!path.isAbsolute(workspaceDir)) {
    return;
  }

  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  const normalizedContainerWorkDir = path.resolve(containerWorkDir);
  const relativeWorkDir = path.relative(normalizedWorkspaceDir, normalizedContainerWorkDir);
  const workDirUsesWorkspaceMount =
    relativeWorkDir === '' ||
    (relativeWorkDir !== '..' &&
      !relativeWorkDir.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeWorkDir));
  if (!workDirUsesWorkspaceMount) {
    return;
  }

  if (!fs.existsSync(normalizedWorkspaceDir)) {
    return;
  }

  const canonicalWorkspaceDir = fs.realpathSync(normalizedWorkspaceDir);
  if (canonicalWorkspaceDir === path.parse(canonicalWorkspaceDir).root) {
    throw new Error(`Refusing to repair ownership of filesystem root: ${canonicalWorkspaceDir}`);
  }

  const identity = resolveSandboxIdentity();
  if (!identity) {
    logger.warn(`Skipping ${canonicalWorkspaceDir} ownership repair because the sandbox identity is invalid`);
    return;
  }

  repairPathOwnership(canonicalWorkspaceDir, identity.uid, identity.gid);

  if (!isDirectoryWritableByIdentity(canonicalWorkspaceDir, identity.uid, identity.gid)) {
    throw new Error(
      `Host workspace is not writable by the sandbox identity ` +
      `(${identity.uid}:${identity.gid}): ${canonicalWorkspaceDir}\n` +
      `AWF is running as root without SUDO_UID, so it attempted to transfer ` +
      `ownership of the host workspace to the sandbox identity, but the ` +
      `workspace is still not writable.\n` +
      `The agent would start and exit successfully without being able to write ` +
      `any files, so AWF is failing early instead.\n` +
      `  Suggested fix: chown -R ${identity.uid}:${identity.gid} ${canonicalWorkspaceDir} before invoking AWF.`
    );
  }
}

/**
 * Phase 1 — Validates and hardens the work directory.
 *
 * Creates the directory with restrictive `0o700` permissions and rejects
 * symlinks, unsafe ownership, or group/world-writable reused directories.
 * Security-critical: docker-compose.yml (which contains plaintext secrets) is
 * written here, so non-root host processes must not be able to read it.
 */
export function validateAndPrepareWorkDir(config: WrapperConfig): void {
  // Ensure work directory exists with restricted permissions (owner-only access)
  // Defense-in-depth: even if tmpfs overlay fails, non-root processes on the host
  // cannot read the docker-compose.yml which contains sensitive tokens
  try {
    const workDirCreated = Boolean(
      fs.mkdirSync(config.workDir, { recursive: true, mode: 0o700 })
    );
    const workDirLstat = fs.lstatSync(config.workDir);
    if (workDirLstat.isSymbolicLink()) {
      throw new Error(`Refusing to use symlink as directory: ${config.workDir}`);
    }
    const workDirStat = fs.statSync(config.workDir);
    if (!workDirStat.isDirectory()) {
      throw new Error(`Expected directory but found non-directory path: ${config.workDir}`);
    }
    const effectiveUid = process.getuid?.();
    const sudoUid = process.env.SUDO_UID !== undefined
      ? Number.parseInt(process.env.SUDO_UID, 10)
      : undefined;
    const trustedOwners = new Set<number>();
    if (effectiveUid !== undefined) {
      trustedOwners.add(effectiveUid);
    }
    if (
      effectiveUid === 0 &&
      sudoUid !== undefined &&
      Number.isSafeInteger(sudoUid) &&
      sudoUid >= 0
    ) {
      trustedOwners.add(sudoUid);
    }
    if (!trustedOwners.has(workDirStat.uid)) {
      throw new Error(
        `Refusing to use work directory not owned by the invoking user: ${config.workDir} ` +
        `(owner uid=${workDirStat.uid}, trusted uid(s)=${[...trustedOwners].join(',')})`
      );
    }
    if ((workDirStat.mode & 0o077) !== 0) {
      throw new Error(
        `Refusing to use work directory accessible by group or other users: ${config.workDir} ` +
        `(mode=${(workDirStat.mode & 0o777).toString(8)})`
      );
    }
    if (workDirCreated) {
      fs.chmodSync(config.workDir, 0o700);
    }
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
      const { diagnosis, blockerPath } = diagnoseEacces(config.workDir);
      const suggestedPath = blockerPath ?? config.workDir;
      throw new Error(
        `EACCES: cannot create work directory: ${config.workDir}\n` +
        `${diagnosis}\n` +
        `This typically happens on persistent runners when a previous AWF run ` +
        `left directories owned by root. The calling process (e.g., gh-aw setup) ` +
        `must remove or chown the stale directory before invoking AWF.\n` +
        `  Suggested fix: sudo rm -rf ${suggestedPath} && mkdir -p ${suggestedPath}`
      );
    }
    throw error;
  }
}
