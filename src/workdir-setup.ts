import * as fs from 'fs';
import * as path from 'path';
import { WrapperConfig } from './types';
import { logger } from './logger';
import { getSafeHostUid, getSafeHostGid, getRealUserHome } from './host-env';
import { LogPaths } from './log-paths';
import { resolveRunnerToolCachePath } from './runner-tool-cache';

interface EnsureDirectoryOptions {
  mode?: number;
  onCreate?: () => void;
  onExists?: () => void;
  onAfterEnsure?: () => void;
}

function ensureDirectory(dirPath: string, options: EnsureDirectoryOptions = {}): boolean {
  const { mode, onCreate, onExists, onAfterEnsure } = options;
  const created = Boolean(
    fs.mkdirSync(dirPath, mode === undefined ? { recursive: true } : { recursive: true, mode })
  );

  const lstat = fs.lstatSync(dirPath);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${dirPath}`);
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${dirPath}`);
  }

  if (created) {
    onCreate?.();
  } else {
    onExists?.();
  }

  onAfterEnsure?.();
  return created;
}

function assertRealDirectory(dirPath: string): void {
  const lstat = fs.lstatSync(dirPath);
  if (lstat.isSymbolicLink()) {
    throw new Error(`Refusing to use symlink as directory: ${dirPath}`);
  }

  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Expected directory but found non-directory path: ${dirPath}`);
  }
}

function createMissingOwnedDirectorySegments(dirPath: string, uid: number, gid: number): void {
  let currentPath = path.isAbsolute(dirPath)
    ? path.parse(dirPath).root
    : '';
  const segments = dirPath.split(path.sep).filter(Boolean);

  for (const segment of segments) {
    currentPath = currentPath ? path.join(currentPath, segment) : segment;
    let created = false;
    if (!fs.existsSync(currentPath)) {
      fs.mkdirSync(currentPath);
      created = true;
    }

    // Validate the current segment is a directory. Allow root-owned system symlinks
    // (e.g. /var on macOS) but refuse user-controlled symlinks.
    const lstat = fs.lstatSync(currentPath);
    if (lstat.isSymbolicLink() && (created || lstat.uid !== 0)) {
      throw new Error(`Refusing to use symlink as directory: ${currentPath}`);
    }
    const stat = fs.statSync(currentPath);
    if (!stat.isDirectory()) {
      throw new Error(`Expected directory but found non-directory path: ${currentPath}`);
    }

    if (created) {
      fs.chownSync(currentPath, uid, gid);
      fs.chmodSync(currentPath, 0o755);
    }
  }
}

// Prepare a nested bind-mount destination inside the empty chroot home before
// Docker sees it. Without this, Docker may create intermediate parents such as
// `<emptyHome>/work` as root-owned directories with restrictive traversal bits,
// causing the chrooted runner user to get EACCES before reaching the leaf mount.
// This operates only on the chroot-home placeholder path, e.g.
// `<emptyHome>/work/_tool`; it does not chown or chmod the real host source
// `/home/runner/work/_tool`, which Docker will later mount over the placeholder.
function prepareChrootHomeMountpoint(emptyHomeDir: string, relativeMountPath: string, uid: number, gid: number): string {
  let chrootPath = emptyHomeDir;
  const segments = relativeMountPath.split(path.sep).filter(Boolean);

  for (const segment of segments) {
    chrootPath = path.join(chrootPath, segment);
    if (!fs.existsSync(chrootPath)) {
      fs.mkdirSync(chrootPath);
    }

    // The final segment may be the leaf mountpoint (`_tool`). That is okay: this
    // is still only the placeholder inside emptyHomeDir, not the host tool cache.
    assertRealDirectory(chrootPath);
    fs.chownSync(chrootPath, uid, gid);
    fs.chmodSync(chrootPath, 0o755);
  }

  return chrootPath;
}

/**
 * Creates all log and session-state directories required before container
 * startup, setting ownership and permissions for the respective service users.
 */
function prepareLogDirectories(logPaths: LogPaths): void {
  // Create agent logs directory for persistence
  // Chown to host user so Copilot CLI can write logs (AWF runs as root, agent runs as host user)
  ensureDirectory(logPaths.agentLogs, {
    onAfterEnsure: () => {
      try {
        fs.chownSync(logPaths.agentLogs, parseInt(getSafeHostUid(), 10), parseInt(getSafeHostGid(), 10));
      } catch { /* ignore chown failures in non-root context */ }
    },
  });
  logger.debug(`Agent logs directory created at: ${logPaths.agentLogs}`);

  // Create agent session-state directory for persistence (events.jsonl, session data)
  // If sessionStateDir is specified, write directly there (timeout-safe, predictable path)
  // Otherwise, use workDir/agent-session-state (will be moved to /tmp after cleanup)
  // Chown to host user so Copilot CLI can create session subdirs and write events.jsonl
  ensureDirectory(logPaths.sessionState, {
    onAfterEnsure: () => {
      try {
        fs.chownSync(logPaths.sessionState, parseInt(getSafeHostUid(), 10), parseInt(getSafeHostGid(), 10));
      } catch { /* ignore chown failures in non-root context */ }
    },
  });
  logger.debug(`Agent session-state directory created at: ${logPaths.sessionState}`);

  // Create squid logs directory for persistence
  // If proxyLogsDir is specified, write directly there (timeout-safe)
  // Otherwise, use workDir/squid-logs (will be moved to /tmp after cleanup)
  //
  // TRIPLE-LAYER DEFENSE for squid log permissions:
  // Layer 1 (here): best-effort chown to UID 13:13 on the host filesystem during workdir setup.
  //   On non-ARC deployments this is typically sufficient.
  //   On ARC/DinD this may be a no-op (daemon has a different filesystem view).
  // Layer 2 (squid-service.ts entrypoint): chown preflight inside the container.
  //   Repairs ownership when Docker daemon auto-creates the bind-mount source
  //   as root:root on split filesystems. Required for ARC/DinD.
  // Layer 3 (container-stop.ts): chmod -R a+rX before compose down.
  //   Ensures the runner user can read log files (owned by UID 13) after
  //   the container is removed, for `awf logs summary` and artifact uploads.
  //
  // Each layer compensates for the others' failure modes. Do not remove any
  // layer without understanding all deployment topologies (shared FS, DinD,
  // rootless Docker, NFS root-squash).
  const SQUID_PROXY_UID = 13;
  const SQUID_PROXY_GID = 13;
  ensureDirectory(logPaths.squidLogs, {
    mode: 0o755,
    onAfterEnsure: () => {
      try {
        fs.chownSync(logPaths.squidLogs, SQUID_PROXY_UID, SQUID_PROXY_GID);
      } catch {
        // Fallback to world-writable if chown fails (e.g., non-root context,
        // pre-existing dir owned by another user, NFS root-squash)
        try {
          fs.chmodSync(logPaths.squidLogs, 0o777);
        } catch { /* best-effort — container entrypoint preflight will retry */ }
      }
    },
  });
  logger.debug(`Squid logs directory created at: ${logPaths.squidLogs}`);

  // Create api-proxy logs directory for persistence
  // If proxyLogsDir is specified, write inside it as a subdirectory (timeout-safe,
  // and included in the firewall-audit-logs artifact upload automatically)
  // Otherwise, write to workDir/api-proxy-logs (will be moved to /tmp after cleanup)
  // Note: API proxy runs as user 'apiproxy' (non-root)
  ensureDirectory(logPaths.apiProxyLogs, {
    mode: 0o777,
    onCreate: () => {
      // Explicitly set permissions to 0o777 (not affected by umask)
      fs.chmodSync(logPaths.apiProxyLogs, 0o777);
    },
  });
  logger.debug(`API proxy logs directory created at: ${logPaths.apiProxyLogs}`);

  // Create CLI proxy logs directory for persistence
  // Note: CLI proxy runs as user 'cliproxy' (non-root)
  ensureDirectory(logPaths.cliProxyLogs, {
    mode: 0o777,
    onCreate: () => fs.chmodSync(logPaths.cliProxyLogs, 0o777),
  });
  logger.debug(`CLI proxy logs directory created at: ${logPaths.cliProxyLogs}`);

  // Create /tmp/gh-aw/mcp-logs directory
  // This directory exists on the HOST for MCP gateway to write logs
  // Inside the AWF container, it's hidden via tmpfs mount (see generateDockerCompose)
  // Uses mode 0o777 to allow GitHub Actions workflows and MCP gateway to create subdirectories
  // even when AWF runs as root (e.g., sudo awf)
  const mcpLogsDir = '/tmp/gh-aw/mcp-logs';
  if (ensureDirectory(mcpLogsDir, { mode: 0o777 })) {
    // Explicitly set permissions to 0o777 (not affected by umask)
    fs.chmodSync(mcpLogsDir, 0o777);
    logger.debug(`MCP logs directory created at: ${mcpLogsDir}`);
  } else {
    // Best-effort permission fix if directory already exists (e.g., created by MCP gateway
    // or a previous run). May fail with EPERM if owned by a different user.
    try {
      fs.chmodSync(mcpLogsDir, 0o777);
      logger.debug(`MCP logs directory permissions fixed at: ${mcpLogsDir}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EROFS') {
        throw error;
      }
      logger.debug(`MCP logs directory already exists at: ${mcpLogsDir} (chmod skipped: ${code})`);
    }
  }

  // Prune stale MCP log subdirectories to prevent unbounded growth on persistent
  // runners. Each AWF run or MCP gateway session creates timestamped subdirs;
  // without pruning these accumulate indefinitely since mcpLogsDir lives outside
  // workDir and is not cleaned up by removeWorkDirectories().
  pruneStaleMcpLogDirs(mcpLogsDir);
}

const MCP_LOGS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function pruneStaleMcpLogDirs(mcpLogsDir: string): void {
  try {
    const entries = fs.readdirSync(mcpLogsDir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(mcpLogsDir, entry.name);
      try {
        const stat = fs.statSync(dirPath);
        if (now - stat.mtimeMs > MCP_LOGS_MAX_AGE_MS) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          logger.debug(`Pruned stale MCP log directory: ${dirPath}`);
        }
      } catch {
        // Skip entries we can't stat or remove (owned by another user, etc.)
      }
    }
  } catch {
    // Best-effort: if we can't read the directory, skip pruning silently
  }
}

/**
 * Creates the empty chroot home directory placeholder, all whitelisted ~/.
 * subdirectories on the host, and any runner tool-cache mountpoints so Docker
 * does not create them as root-owned before bind mounts are established.
 *
 * Security note: this enforces correct UID/GID ownership on chroot home paths
 * before Docker bind-mounts overwrite the placeholders at container start.
 */
function prepareChrootHomeMounts(config: WrapperConfig): void {
  // Ensure chroot home subdirectories exist with correct ownership before Docker
  // bind-mounts them. If a source directory doesn't exist, Docker creates it as
  // root:root, making it inaccessible to the agent user (e.g., UID 1001).
  // Also create an empty writable home directory that gets mounted as $HOME
  // in the chroot, giving tools a writable home without exposing credentials.
  const effectiveHome = getRealUserHome();
  const uid = parseInt(getSafeHostUid(), 10);
  const gid = parseInt(getSafeHostGid(), 10);

  // Create empty writable home directory for the chroot
  // This is mounted as $HOME inside the container so tools can write to it
  // NOTE: Must be outside workDir to avoid being hidden by the tmpfs overlay
  const emptyHomeDir = `${config.workDir}-chroot-home`;
  if (!fs.existsSync(emptyHomeDir)) {
    fs.mkdirSync(emptyHomeDir, { recursive: true });
  }
  fs.chownSync(emptyHomeDir, uid, gid);
  logger.debug(`Created chroot home directory: ${emptyHomeDir} (${uid}:${gid})`);

  // Ensure source directories for home subdirectory mounts exist with correct ownership.
  const hostHomeMountSourceDirs = [
    '.copilot', '.cache', '.config', '.local',
    '.anthropic', '.claude', '.cargo', '.rustup', '.npm', '.nvm',
    ...(config.geminiApiKey || config.googleApiKey ? ['.gemini'] : []),
  ];
  for (const dir of hostHomeMountSourceDirs) {
    const dirPath = path.join(effectiveHome, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      fs.chownSync(dirPath, uid, gid);
      logger.debug(`Created host home subdirectory: ${dirPath} (${uid}:${gid})`);
    } else if (dir === '.gemini') {
      // Repair existing .gemini ownership for Gemini/Vertex runs where prior
      // root-owned bind mounts can break atomic writes in the CLI.
      fs.chownSync(dirPath, uid, gid);
      logger.debug(`Fixed host home subdirectory ownership: ${dirPath} (${uid}:${gid})`);
    }
  }

  // Source-side prep: this only applies when the config file explicitly names
  // a runner tool-cache source path that does not exist yet. Create that host
  // source so Docker has something real to bind-mount later.
  if (config.runnerToolCachePath && !fs.existsSync(config.runnerToolCachePath)) {
    const relToHome = path.relative(effectiveHome, config.runnerToolCachePath);
    const isUnderHome = relToHome && !relToHome.startsWith('..') && !path.isAbsolute(relToHome);

    if (isUnderHome) {
      createMissingOwnedDirectorySegments(config.runnerToolCachePath, uid, gid);
      logger.debug(`Created runner tool cache directory: ${config.runnerToolCachePath} (${uid}:${gid})`);
    } else {
      logger.warn(`Runner tool cache path does not exist; refusing to create outside effective home (${effectiveHome}): ${config.runnerToolCachePath}`);
    }
  }

  // Destination-side prep: resolve the same source path that home-strategy.ts
  // will mount. If that source is nested under the empty chroot home, prepare
  // the placeholder mountpoint there so Docker does not create parents as root.
  const runnerToolCachePath = resolveRunnerToolCachePath(config, effectiveHome);
  if (runnerToolCachePath) {
    const relativeToolCachePath = path.relative(effectiveHome, runnerToolCachePath);
    if (relativeToolCachePath && !relativeToolCachePath.startsWith('..') && !path.isAbsolute(relativeToolCachePath)) {
      const chrootToolCachePath = prepareChrootHomeMountpoint(emptyHomeDir, relativeToolCachePath, uid, gid);
      logger.debug(`Prepared chroot runner tool cache mountpoint: ${chrootToolCachePath} (${uid}:${gid})`);
    }
  }
}

/**
 * Creates the init-signal directory used for iptables-init ↔ agent handshake.
 *
 * Returns the path so callers (e.g. compose-generator) can reference it
 * without duplicating the derivation logic.
 */
export function ensureInitSignalDir(workDir: string): string {
  const initSignalDir = path.join(workDir, 'init-signal');
  ensureDirectory(initSignalDir);
  return initSignalDir;
}

/**
 * Prepares all working directories required before container startup.
 *
 * Delegates to focused sub-functions:
 * - {@link prepareLogDirectories} — log/state directory setup
 * - {@link prepareChrootHomeMounts} — chroot home bind-mount preparation
 * - {@link ensureInitSignalDir} — iptables-init handshake directory
 */
export function prepareWorkDirectories(config: WrapperConfig, logPaths: LogPaths): void {
  prepareLogDirectories(logPaths);
  prepareChrootHomeMounts(config);
  ensureInitSignalDir(config.workDir);
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const workdirSetupTestHelpers = {
  ensureDirectory,
  assertRealDirectory,
  createMissingOwnedDirectorySegments,
  prepareChrootHomeMountpoint,
  prepareLogDirectories,
  prepareChrootHomeMounts,
  ensureInitSignalDir,
  pruneStaleMcpLogDirs,
  MCP_LOGS_MAX_AGE_MS,
};
