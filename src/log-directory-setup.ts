import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { getSafeHostUid, getSafeHostGid } from './host-env';
import { LogPaths } from './log-paths';
import { ensureDirectory } from './fs-utils';

export const MCP_LOGS_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function pruneStaleMcpLogDirs(mcpLogsDir: string): void {
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
 * Creates all log and session-state directories required before container
 * startup, setting ownership and permissions for the respective service users.
 */
export function prepareLogDirectories(logPaths: LogPaths): void {
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
