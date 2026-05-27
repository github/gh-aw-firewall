import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';
import { WrapperConfig } from '../../types';

const DOCKER_HOST_STAGE_DIR = 'awf-docker-host-stage';
const SAFE_BINARY_NAME_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

function normalizeDockerHostPathPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/';
}

export function shouldUseDockerHostStaging(prefix: string | undefined): boolean {
  if (!prefix) return false;
  const normalized = normalizeDockerHostPathPrefix(prefix);
  return normalized === '/tmp' || normalized.startsWith('/tmp/');
}

export function getDockerHostStageRoot(config: WrapperConfig): string {
  const normalizedPrefix = config.dockerHostPathPrefix
    ? normalizeDockerHostPathPrefix(config.dockerHostPathPrefix)
    : '';
  const preferredRoot = shouldUseDockerHostStaging(config.dockerHostPathPrefix)
    ? normalizedPrefix
    : config.workDir;
  const stageRoot = path.join(preferredRoot, DOCKER_HOST_STAGE_DIR);
  fs.mkdirSync(stageRoot, { recursive: true });
  return stageRoot;
}

export function stageHostFile(config: WrapperConfig, sourcePath: string, relativeTargetPath: string, mode = 0o644): string | undefined {
  try {
    if (!fs.statSync(sourcePath).isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  try {
    const stageRoot = getDockerHostStageRoot(config);
    const normalizedRelativeTargetPath = relativeTargetPath.replace(/^\/+/, '');
    const resolvedStageRoot = path.resolve(stageRoot);
    const targetPath = path.resolve(stageRoot, normalizedRelativeTargetPath);
    const relativeToStageRoot = path.relative(resolvedStageRoot, targetPath);
    if (!normalizedRelativeTargetPath || relativeToStageRoot.startsWith('..') || path.isAbsolute(relativeToStageRoot) || relativeToStageRoot === '') {
      logger.debug(`Rejected staged target path outside docker-host staging root: ${relativeTargetPath}`);
      return undefined;
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    fs.chmodSync(targetPath, mode);
    return targetPath;
  } catch (err) {
    logger.debug(`Could not stage ${sourcePath} for docker-host-path-prefix: ${err}`);
    return undefined;
  }
}

export function extractCommandBinaryName(agentCommand: string): string | undefined {
  const commandExecutable = agentCommand.trim().split(/\s+/, 1)[0] || '';
  if (!commandExecutable) {
    return undefined;
  }

  const commandExecutableBase = path.posix.basename(commandExecutable.replace(/\\/g, '/'));
  if (!SAFE_BINARY_NAME_REGEX.test(commandExecutableBase)) {
    return undefined;
  }
  return commandExecutableBase;
}
