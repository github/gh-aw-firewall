import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { getSafeHostGid, getSafeHostUid } from './host-identity';
import { buildRuntimeImageRef, parseImageTag } from './image-tag';
import { logger } from './logger';
import { applyHostPathPrefixToVolumes } from './services/host-path-prefix';
import { getLocalDockerEnv } from './docker-host';

function resolvePermFixerImageRef(imageRegistry?: string, imageTag?: string, agentImage?: string): string {
  try {
    const registry = imageRegistry || 'ghcr.io/github/gh-aw-firewall';
    const parsedImageTag = parseImageTag(imageTag || 'latest');
    const imageName = agentImage === 'act' ? 'agent-act' : 'agent';
    return buildRuntimeImageRef(registry, imageName, parsedImageTag);
  } catch {
    return 'ghcr.io/github/gh-aw-firewall/agent:latest';
  }
}

export function fixArtifactPermissionsForRootless(
  dirs: Array<string | undefined>,
  dockerHostPathPrefix: string | undefined,
  imageRegistry: string | undefined,
  imageTag: string | undefined,
  agentImage: string | undefined,
): void {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || currentUid === 0) {
    return;
  }

  const existingDirs = dirs.filter(
    (dir): dir is string => typeof dir === 'string' && dir.length > 0 && fs.existsSync(dir),
  );
  if (existingDirs.length === 0) {
    return;
  }

  const uid = getSafeHostUid();
  const gid = getSafeHostGid();
  const imageRef = resolvePermFixerImageRef(imageRegistry, imageTag, agentImage);

  for (const dir of existingDirs) {
    const mount = applyHostPathPrefixToVolumes([`${path.resolve(dir)}:/fix:rw`], dockerHostPathPrefix)[0];
    try {
      const result = execa.sync(
        'docker',
        [
          'run',
          '--rm',
          '--pull',
          'never',
          '--network',
          'none',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'CHOWN',
          '--cap-add',
          'DAC_OVERRIDE',
          '--cap-add',
          'FOWNER',
          '-e',
          `TUID=${uid}`,
          '-e',
          `TGID=${gid}`,
          '-v',
          mount,
          imageRef,
          'sh',
          '-c',
          'chown -R "$TUID:$TGID" /fix && chmod -R a+rX /fix',
        ],
        { env: getLocalDockerEnv(), reject: false },
      );

      if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
        logger.warn(`Rootless artifact permission repair failed for ${dir} (exit ${result.exitCode})`);
      }
    } catch (error) {
      logger.warn(`Rootless artifact permission repair failed for ${dir}:`, error);
    }
  }
}
