import * as fs from 'fs';
import * as path from 'path';
import { HOME_TOOL_PATHS } from './config/mount-policy';
import { createNfsHomeCopier, descriptorPath, isVanishedSource, isWithin, openDirectoryAt, openSourceDirectory } from './nfs-home-copy';
import { resolveRunnerToolCachePath } from './runner-tool-cache';
import { WrapperConfig } from './types';

export function nfsHomeRelativePath(home: string, candidate: string): string | undefined {
  const canonicalHome = fs.realpathSync(home);
  const canonicalCandidate = fs.realpathSync(candidate);
  return isWithin(canonicalHome, canonicalCandidate)
    ? path.relative(canonicalHome, canonicalCandidate)
    : undefined;
}

export function stageNfsHomeTools(
  config: WrapperConfig,
  home: string,
  homeFd: number,
  destinationFd: number,
  copier: ReturnType<typeof createNfsHomeCopier>,
): void {
  const toolCache = resolveRunnerToolCachePath(config, home);
  const relativeToolCache = toolCache ? nfsHomeRelativePath(home, toolCache) : undefined;
  const toolPaths = [...HOME_TOOL_PATHS];
  if (relativeToolCache) toolPaths.push(relativeToolCache);
  const uniqueToolPaths = [...new Set(toolPaths
    .filter((toolPath) => toolPath !== '.gemini' || config.geminiApiKey || config.googleApiKey)
    .map((toolPath) => path.normalize(toolPath)))]
    .sort((left, right) => left.split(path.sep).length - right.split(path.sep).length)
    .filter((toolPath, index, all) =>
      !all.slice(0, index).some((parent) => isWithin(parent, toolPath)));

  for (const toolPath of uniqueToolPaths) {
    let sourceFd: number;
    try {
      sourceFd = openSourceDirectory(homeFd, toolPath);
    } catch (error) {
      if (isVanishedSource(error)) continue;
      throw new Error(`NFS home tool state must be a real directory: ${path.join(home, toolPath)}`);
    }
    try {
      let targetParentFd = destinationFd;
      const parentDirectory = path.dirname(toolPath);
      const parentSegments = parentDirectory === '.' ? [] : parentDirectory.split(path.sep).filter(Boolean);
      const openedParentFds: number[] = [];
      try {
        for (const segment of parentSegments) {
          const segmentPath = descriptorPath(targetParentFd, segment);
          try {
            fs.mkdirSync(segmentPath, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
          const nextFd = openDirectoryAt(targetParentFd, segment);
          openedParentFds.push(nextFd);
          targetParentFd = nextFd;
        }
        const targetName = path.basename(toolPath);
        fs.mkdirSync(descriptorPath(targetParentFd, targetName), { mode: 0o700 });
        const targetFd = openDirectoryAt(targetParentFd, targetName);
        try {
          copier.copyDirectoryContents(sourceFd, targetFd, toolPath);
          copier.setOwnership(targetFd);
          fs.fchmodSync(targetFd, 0o700);
        } finally {
          fs.closeSync(targetFd);
        }
      } finally {
        for (const fd of openedParentFds.reverse()) fs.closeSync(fd);
      }
    } finally {
      fs.closeSync(sourceFd);
    }
  }
}
