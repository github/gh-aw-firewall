import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { logger } from './logger';

/**
 * Attempts to reclaim a directory tree that is not writable by the current user.
 *
 * On persistent GitHub Actions runners, a previous AWF run (or Docker daemon)
 * can leave directories under workDir owned by root. When the next AWF
 * invocation runs as non-root (rootless/network-isolation mode), mkdirSync
 * fails with EACCES before any container is started.
 *
 * This function detects non-writable ancestors in the workDir path and attempts
 * to reclaim them via:
 *   1. `sudo rm -rf` (available on GitHub-hosted runners without a password)
 *   2. Plain `rm -rf` fallback (may work if only leaf permissions are wrong)
 *
 * The function is intentionally conservative:
 * - Only acts when the directory actually exists AND is not writable
 * - Only removes the narrowest non-writable ancestor (not arbitrary paths)
 * - Refuses to operate on system paths (/, /tmp, /var, etc.)
 * - Logs all actions for auditability
 *
 * @param targetDir - The directory AWF wants to create/use (e.g., workDir)
 * @returns true if reclaim was attempted, false if no action was needed
 */
export function reclaimStaleDirectory(targetDir: string): boolean {
  const currentUid = process.getuid?.();
  // If running as root, EACCES won't happen — skip preflight
  if (currentUid === 0) {
    return false;
  }

  // Walk from the target up to find the first existing ancestor
  // that is not writable by the current user
  const nonWritableDir = findNonWritableAncestor(targetDir);
  if (!nonWritableDir) {
    return false;
  }

  // Safety: refuse to remove system directories
  if (isProtectedPath(nonWritableDir)) {
    logger.warn(
      `Pre-flight: stale directory ${nonWritableDir} is not writable, but refusing to remove protected path`
    );
    return false;
  }

  logger.info(
    `Pre-flight: reclaiming stale directory ${nonWritableDir} (not writable by UID ${currentUid})`
  );

  // Attempt 1: sudo rm -rf (works on GitHub-hosted runners without password)
  try {
    const result = execa.sync('sudo', ['rm', '-rf', nonWritableDir], {
      reject: false,
      timeout: 10_000,
    });
    if (result.exitCode === 0) {
      logger.debug(`Pre-flight: successfully removed ${nonWritableDir} via sudo`);
      return true;
    }
    logger.debug(
      `Pre-flight: sudo rm failed (exit ${result.exitCode}): ${result.stderr || '(no stderr)'}`
    );
  } catch (error) {
    logger.debug(`Pre-flight: sudo rm threw:`, error);
  }

  // Attempt 2: plain rm -rf (may work if only leaf permissions are wrong)
  try {
    fs.rmSync(nonWritableDir, { recursive: true, force: true });
    logger.debug(`Pre-flight: successfully removed ${nonWritableDir} via fs.rmSync`);
    return true;
  } catch (error) {
    logger.debug(`Pre-flight: fs.rmSync failed:`, error);
  }

  logger.warn(
    `Pre-flight: could not reclaim ${nonWritableDir} — writeConfigs may fail with EACCES`
  );
  return false;
}

/**
 * Walks from targetDir upward to find the shallowest existing directory
 * that is not writable by the current process.
 *
 * Returns undefined if all existing ancestors are writable (normal case).
 */
function findNonWritableAncestor(targetDir: string): string | undefined {
  const resolvedTarget = path.resolve(targetDir);
  let current = resolvedTarget;

  // Collect path segments from target down to the first existing directory
  const nonExistentSegments: string[] = [];
  while (!fs.existsSync(current)) {
    nonExistentSegments.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break; // reached root
    current = parent;
  }

  // `current` is now the first existing ancestor of targetDir
  if (!fs.existsSync(current)) {
    return undefined;
  }

  // Check if this existing ancestor is writable
  try {
    fs.accessSync(current, fs.constants.W_OK);
    // The existing ancestor is writable — mkdirSync should succeed
    return undefined;
  } catch {
    // Not writable — this is the directory we need to reclaim
    return current;
  }
}

/**
 * Returns true for paths that must never be removed, even if they're
 * not writable. Prevents catastrophic damage from bugs or unexpected state.
 */
function isProtectedPath(dirPath: string): boolean {
  const resolved = path.resolve(dirPath);
  const protectedPaths = new Set([
    '/',
    '/tmp',
    '/var',
    '/var/tmp',
    '/home',
    '/root',
    '/usr',
    '/etc',
    '/opt',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/dev',
    '/sys',
    '/proc',
    '/run',
    // GitHub Actions runner paths (protect the runner itself)
    '/home/runner',
    '/home/runner/work',
  ]);

  return protectedPaths.has(resolved);
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const preflightReclaimTestHelpers = {
  findNonWritableAncestor,
  isProtectedPath,
  reclaimStaleDirectory,
};
