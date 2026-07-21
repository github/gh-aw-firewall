import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';
import { resolveRunnerToolCachePath } from '../../runner-tool-cache';
import { WrapperConfig } from '../../types';
import { HOME_TOOL_SUBDIRS } from './home-whitelist';

interface HomeMountsParams {
  config: WrapperConfig;
  effectiveHome: string;
  agentLogsPath: string;
  sessionStatePath: string;
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

  const copilotHomeDir = path.join(effectiveHome, '.copilot');
  if (fs.existsSync(copilotHomeDir)) {
    try {
      fs.accessSync(copilotHomeDir, fs.constants.R_OK | fs.constants.W_OK);
      mounts.push(`${copilotHomeDir}:/host${effectiveHome}/.copilot:rw`);
    } catch (error) {
      logger.warn(`Cannot access ~/.copilot directory at ${copilotHomeDir}; skipping host bind mount. Copilot CLI package extraction and persisted host MCP config may be unavailable. Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    logger.debug(`~/.copilot directory does not exist at ${copilotHomeDir}; skipping optional host bind mount.`);
  }

  mounts.push(`${sessionStatePath}:/host${effectiveHome}/.copilot/session-state:rw`);
  mounts.push(`${agentLogsPath}:/host${effectiveHome}/.copilot/logs:rw`);

  for (const subdir of HOME_TOOL_SUBDIRS) {
    if (subdir === '.copilot') continue; // handled specially above (existence check + session-state/logs sub-mounts)
    if (subdir === '.gemini' && !config.geminiApiKey && !config.googleApiKey) continue; // only mount when Gemini/Vertex credentials are present
    mounts.push(`${effectiveHome}/${subdir}:/host${effectiveHome}/${subdir}:rw`);
  }

  const runnerToolCacheDir = resolveRunnerToolCachePath(config, effectiveHome);
  if (runnerToolCacheDir) {
    mounts.push(`${runnerToolCacheDir}:/host${runnerToolCacheDir}:ro`);
  }

  return mounts;
}
