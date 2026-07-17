import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { getSafeHostGid, getSafeHostUid } from './host-identity';
import { parseImageTag } from './image-tag';
import { logger } from './logger';
import { applyHostPathPrefixToVolumes } from './services/host-path-prefix';
import { getLocalDockerEnv } from './docker-host';

function resolvePermFixerImageRef(imageRegistry?: string, imageTag?: string, agentImage?: string): string {
  try {
    const registry = imageRegistry || 'ghcr.io/github/gh-aw-firewall';
    const parsedImageTag = parseImageTag(imageTag || 'latest');
    const imageName = agentImage === 'act' ? 'agent-act' : 'agent';
    // Use tag-only ref (no digest) because this runs with --pull never.
    // Including the digest causes Docker to attempt registry verification
    // even with --pull never, which times out if credentials are unavailable.
    return `${registry}/${imageName}:${parsedImageTag.tag}`;
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
          'chown -R "$TUID:$TGID" /fix 2>/dev/null; chmod -R a+rwX /fix',
        ],
        { env: getLocalDockerEnv(), reject: false },
      );

      if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
        const stderr = result.stderr?.trim();
        // Ownership/permission repair is best-effort: the agent has already
        // finished and its artifacts are still readable by the owning user.
        // On rootless or restricted runners (e.g. ARC/DinD with a non-root
        // runner container) the repair container may be denied CHOWN/chmod,
        // producing "Operation not permitted" / "Permission denied". Those are
        // expected and non-fatal, so log them at debug to avoid alarming users
        // who otherwise see a scary WARN for a benign, non-blocking condition.
        const isBenignPermissionError =
          !!stderr && /(?:^|\n)(?:chown|chmod):.*(?:operation not permitted|permission denied|EPERM|EACCES)/i.test(stderr);
        const detail = `for ${dir} (exit ${result.exitCode})` + (stderr ? `: ${stderr}` : '');
        if (isBenignPermissionError) {
          logger.debug(
            `Rootless artifact permission repair skipped ${detail}. ` +
              `This is expected on restricted runners and does not affect the run.`,
          );
        } else {
          logger.warn(`Rootless artifact permission repair failed ${detail}`);
        }
      }
    } catch (error) {
      logger.warn(`Rootless artifact permission repair failed for ${dir}:`, error);
    }
  }
}
