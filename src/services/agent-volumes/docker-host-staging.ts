import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger';
import { isTmpRootedDockerHostPathPrefix, normalizeDockerHostPathPrefix } from '../host-path-prefix';
import { WrapperConfig } from '../../types';

const DOCKER_HOST_STAGE_DIR = 'awf-docker-host-stage';
const SAFE_BINARY_NAME_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

/**
 * Regular files AWF copied into the daemon staging root during this run.
 *
 * Staged sources live *under* `--docker-host-path-prefix`, so a topology pass
 * cannot attribute them back to a runner path and must otherwise treat them as
 * daemon-side. Recording them here preserves the one fact that would be lost:
 * the source is a regular file on this filesystem, so a bind of it needs a
 * *file* mountpoint rather than a directory.
 */
const stagedHostFiles = new Set<string>();

export function isStagedHostFile(candidate: string): boolean {
  return stagedHostFiles.has(candidate);
}

/** Test seam: staging is process-global, so suites must be able to reset it. */
export function clearStagedHostFiles(): void {
  stagedHostFiles.clear();
}

export function shouldUseDockerHostStaging(prefix: string | undefined): boolean {
  return isTmpRootedDockerHostPathPrefix(prefix);
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
    stagedHostFiles.add(targetPath);
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
