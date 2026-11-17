import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';
import { resolveRunnerToolCachePath } from '../../runner-tool-cache';
import { WrapperConfig } from '../../types';
import { HOME_TOOL_PATHS } from './home-whitelist';
import { nfsHomeRelativePath, usesNfsHome } from '../../nfs-home';

interface HomeMountsParams {
  config: WrapperConfig;
  effectiveHome: string;
  agentLogsPath: string;
  sessionStatePath: string;
  pathExists?: (candidate: string) => boolean;
}

export function buildHomeMounts(params: HomeMountsParams): string[] {
  const { config, effectiveHome } = params;
  const mounts: string[] = [];

  const emptyHomeDir = `${config.workDir}-chroot-home`;
  mounts.push(`${emptyHomeDir}:/host${effectiveHome}:rw`);

  mounts.push(...buildToolDirectoryMounts(params));

  return mounts;
}

function buildToolDirectoryMounts(params: HomeMountsParams): string[] {
  const { config, effectiveHome, agentLogsPath, sessionStatePath } = params;
  const mounts: string[] = [];
  const nfsHome = usesNfsHome(config, effectiveHome);

  const copilotHomeDir = path.join(effectiveHome, '.copilot');
  if (!nfsHome && (params.pathExists ?? fs.existsSync)(copilotHomeDir)) {
    try {
      fs.accessSync(copilotHomeDir, fs.constants.R_OK | fs.constants.W_OK);
      mounts.push(`${copilotHomeDir}:/host${effectiveHome}/.copilot:rw`);
    } catch (error) {
      logger.warn(`Cannot access ~/.copilot directory at ${copilotHomeDir}; skipping host bind mount. Copilot CLI package extraction and persisted host MCP config may be unavailable. Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!nfsHome) {
    logger.debug(`~/.copilot directory does not exist at ${copilotHomeDir}; skipping optional host bind mount.`);
  }

  mounts.push(`${sessionStatePath}:/host${effectiveHome}/.copilot/session-state:rw`);
  mounts.push(`${agentLogsPath}:/host${effectiveHome}/.copilot/logs:rw`);

  for (const toolPath of HOME_TOOL_PATHS) {
    if (nfsHome) break; // The local chroot home already contains the sanitized snapshot.
    if (toolPath === '.copilot') continue; // handled specially above (existence check + session-state/logs sub-mounts)
    if (toolPath === '.gemini' && !config.geminiApiKey && !config.googleApiKey) continue; // only mount when Gemini/Vertex credentials are present
    mounts.push(`${effectiveHome}/${toolPath}:/host${effectiveHome}/${toolPath}:rw`);
  }

  const runnerToolCacheDir = resolveRunnerToolCachePath(config, effectiveHome);
  if (runnerToolCacheDir) {
    const relative = nfsHome ? nfsHomeRelativePath(effectiveHome, runnerToolCacheDir) : undefined;
    const source = relative !== undefined
      ? path.join(`${config.workDir}-chroot-home`, relative)
      : runnerToolCacheDir;
    mounts.push(`${source}:/host${runnerToolCacheDir}:ro`);
  }

  return mounts;
}
