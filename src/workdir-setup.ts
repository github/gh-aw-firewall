import * as path from 'path';
import { WrapperConfig } from './types';
import { LogPaths } from './log-paths';
import {
  ensureDirectory,
  assertRealDirectory,
  createMissingOwnedDirectorySegments,
} from './fs-utils';
import { prepareLogDirectories, pruneStaleMcpLogDirs, MCP_LOGS_MAX_AGE_MS } from './log-directory-setup';
import { prepareChrootHomeMountpoint, prepareChrootHomeMounts } from './chroot-home-setup';

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
