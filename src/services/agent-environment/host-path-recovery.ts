import {
  TOOLCHAIN_ENV_VARS,
  readGitHubEnvEntries,
  prependPathEntries,
} from '../../github-env';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';

const MAX_RECOVERED_TOOLCACHE_BINS = 12;

export function recoverHostPaths(environment: Record<string, string>): void {
  if (process.env.PATH) {
    const runnerToolCacheBinDirs = discoverRunnerToolCacheBinDirs(
      process.env.RUNNER_TOOL_CACHE,
    );
    environment.AWF_HOST_PATH = prependPathEntries(process.env.PATH, runnerToolCacheBinDirs);
    if (runnerToolCacheBinDirs.length > 0) {
      logger.debug(`Merged ${runnerToolCacheBinDirs.length} runner tool cache bin path(s) into AWF_HOST_PATH`);
    }
  }

  const runningUnderSudo =
    process.getuid?.() === 0 && (Boolean(process.env.SUDO_UID) || Boolean(process.env.SUDO_USER));
  const githubEnvEntries = runningUnderSudo ? readGitHubEnvEntries() : {};

  for (const varName of TOOLCHAIN_ENV_VARS) {
    const value = process.env[varName] || (runningUnderSudo ? githubEnvEntries[varName] : undefined);
    if (value) {
      environment[`AWF_${varName}`] = value;
      if (!process.env[varName] && runningUnderSudo && githubEnvEntries[varName]) {
        logger.debug(`Recovered ${varName} from $GITHUB_ENV (sudo likely stripped it from process.env)`);
      }
    }
  }
}

function discoverRunnerToolCacheBinDirs(
  runnerToolCache: string | undefined,
): string[] {
  if (!runnerToolCache) {
    return [];
  }

  try {
    if (!fs.statSync(runnerToolCache).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  // One bin dir per tool (newest version first via reverse sort, first arch alphabetically).
  const binDirByTool = new Map<string, string>();
  for (const toolName of safeReadDir(runnerToolCache)) {
    const toolDir = path.join(runnerToolCache, toolName);
    if (!isDirectory(toolDir)) continue;

    const normalizedTool = toolName.toLowerCase();
    if (binDirByTool.has(normalizedTool)) continue;

    outer: for (const versionName of safeReadDir(toolDir).sort().reverse()) {
      const versionDir = path.join(toolDir, versionName);
      if (!isDirectory(versionDir)) continue;

      for (const architectureName of safeReadDir(versionDir).sort()) {
        const binDir = path.join(versionDir, architectureName, 'bin');
        if (isDirectory(binDir)) {
          binDirByTool.set(normalizedTool, binDir);
          break outer;
        }
      }
    }
  }

  // Sort by tool name for deterministic ordering, then cap total entries.
  return [...binDirByTool.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, MAX_RECOVERED_TOOLCACHE_BINS)
    .map(([, dir]) => dir);
}

function safeReadDir(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}


