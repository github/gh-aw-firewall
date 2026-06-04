import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';

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

  mounts.push(`${effectiveHome}/.cache:/host${effectiveHome}/.cache:rw`);
  mounts.push(`${effectiveHome}/.config:/host${effectiveHome}/.config:rw`);
  mounts.push(`${effectiveHome}/.local:/host${effectiveHome}/.local:rw`);

  mounts.push(`${effectiveHome}/.anthropic:/host${effectiveHome}/.anthropic:rw`);
  mounts.push(`${effectiveHome}/.claude:/host${effectiveHome}/.claude:rw`);

  if (config.geminiApiKey) {
    mounts.push(`${effectiveHome}/.gemini:/host${effectiveHome}/.gemini:rw`);
  }

  mounts.push(`${effectiveHome}/.cargo:/host${effectiveHome}/.cargo:rw`);
  mounts.push(`${effectiveHome}/.rustup:/host${effectiveHome}/.rustup:rw`);
  mounts.push(`${effectiveHome}/.npm:/host${effectiveHome}/.npm:rw`);
  mounts.push(`${effectiveHome}/.nvm:/host${effectiveHome}/.nvm:rw`);

  const runnerToolCacheDir = resolveRunnerToolCachePath(config);
  if (runnerToolCacheDir) {
    mounts.push(`${runnerToolCacheDir}:/host${runnerToolCacheDir}:ro`);
  }

  return mounts;
}

function resolveRunnerToolCachePath(config: WrapperConfig): string | undefined {
  const candidates = [
    config.runnerToolCachePath,
    process.env.RUNNER_TOOL_CACHE,
    '/home/runner/work/_tool',
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Path does not exist or is not accessible — try next candidate
    }
  }

  return undefined;
}
