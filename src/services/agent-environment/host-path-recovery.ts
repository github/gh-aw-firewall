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
      process.env.PATH,
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
  currentPath: string,
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
          // Only inject this bin dir if none of its executables are already
          // resolvable on the current PATH. This prevents toolcache dirs from
          // shadowing system tools that are already available (e.g. a toolcache
          // Ruby shadowing the system Ruby with a different bundler version).
          if (!anyBinAlreadyOnPath(binDir, currentPath)) {
            binDirByTool.set(normalizedTool, binDir);
          }
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

/**
 * Returns true if any executable inside binDir already appears (by name)
 * somewhere on currentPath. Used to skip toolcache bin dirs whose tools are
 * already reachable, so we don't shadow system tools with different versions.
 */
function anyBinAlreadyOnPath(binDir: string, currentPath: string): boolean {
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  for (const name of safeReadDir(binDir)) {
    for (const pathEntry of pathEntries) {
      try {
        fs.accessSync(path.join(pathEntry, name), fs.constants.X_OK);
        return true;
      } catch {
        // not found in this path entry
      }
    }
  }
  return false;
}


