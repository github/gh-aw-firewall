import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { getSafeHostGid, getSafeHostUid } from './host-identity';
import { parseImageTag } from './image-tag';
import { agentImageRole, resolveRuntimeImageFor, type ImageManifestConfig } from './image-resolver';
import { logger } from './logger';
import { applyHostPathPrefixToVolumes } from './services/host-path-prefix';
import { getLocalDockerEnv } from './docker-host';

export function isBenignArtifactPermissionError(error: unknown): boolean {
  const details: string[] = [];
  if (typeof error === 'string') {
    details.push(error);
  } else if (error && typeof error === 'object') {
    const errorLike = error as {
      stderr?: unknown;
      stdout?: unknown;
      shortMessage?: unknown;
      message?: unknown;
      code?: unknown;
    };
    for (const value of [
      errorLike.stderr,
      errorLike.stdout,
      errorLike.shortMessage,
      errorLike.message,
      errorLike.code,
    ]) {
      if (typeof value === 'string') {
        details.push(value);
      }
    }
  }

  const combinedDetails = details.join('\n');
  return (
    /(?:^|\n)(?:chown|chmod):.*(?:operation not permitted|permission denied|\bEPERM\b|\bEACCES\b)/i.test(
      combinedDetails,
    ) || /(?:^|\n)\s*(?:EPERM|EACCES)\s*(?:\n|$)/i.test(combinedDetails)
  );
}

/**
 * Resolves a digest-pinned reference to the immutable local image ID.
 *
 * The repair container runs with `--pull never`; passing a digest reference
 * makes Docker contact the registry even then. Looking the digest up locally
 * keeps the run pinned to the compiler-authorized image without a pull.
 * Returns undefined when the authorized image is not present locally, so the
 * caller fails closed instead of running an unauthorized cached image.
 */
function resolveLocalImageId(imageRef: string): string | undefined {
  try {
    const result = execa.sync('docker', ['image', 'inspect', '--format', '{{.Id}}', imageRef], {
      env: getLocalDockerEnv(),
      reject: false,
    });
    if (result.exitCode !== 0) return undefined;
    const imageId = result.stdout?.trim();
    return imageId && /^sha256:[a-f0-9]{64}$/.test(imageId) ? imageId : undefined;
  } catch {
    return undefined;
  }
}

function resolvePermFixerImageRef(
  imageRegistry?: string,
  imageTag?: string,
  agentImage?: string,
  images?: ImageManifestConfig['images'],
): string | undefined {
  if (images) {
    // Compiler-authorized manifest: the repair container must run the same
    // pinned agent image as the run itself.
    const manifestRef = resolveRuntimeImageFor(
      { images, imageRegistry, imageTag, agentImage },
      agentImageRole(agentImage),
    );
    return resolveLocalImageId(manifestRef);
  }
  try {
    const registry = imageRegistry || 'ghcr.io/github/gh-aw-firewall';
    const parsedImageTag = parseImageTag(imageTag || 'latest');
    // Use tag-only ref (no digest) because this runs with --pull never.
    // Including the digest causes Docker to attempt registry verification
    // even with --pull never, which times out if credentials are unavailable.
    return `${registry}/${agentImageRole(agentImage)}:${parsedImageTag.tag}`;
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
  imageRefOverride?: string,
  images?: ImageManifestConfig['images'],
): boolean {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || currentUid === 0) {
    return true;
  }

  const existingDirs = dirs.filter(
    (dir): dir is string => typeof dir === 'string' && dir.length > 0 && fs.existsSync(dir),
  );
  if (existingDirs.length === 0) {
    return true;
  }

  const uid = getSafeHostUid();
  const gid = getSafeHostGid();
  const imageRef =
    imageRefOverride || resolvePermFixerImageRef(imageRegistry, imageTag, agentImage, images);
  if (!imageRef) {
    logger.debug(
      'Rootless artifact permission repair skipped: the compiler-authorized agent image is ' +
        'not available locally, and no unpinned fallback image may be used.',
    );
    return false;
  }
  let repairedAll = true;

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
          '--entrypoint',
          'sh',
          '-e',
          `TUID=${uid}`,
          '-e',
          `TGID=${gid}`,
          '-v',
          mount,
          imageRef,
          '-c',
          'chown -R "$TUID:$TGID" /fix 2>/dev/null; chmod -R a+rwX /fix',
        ],
        { env: getLocalDockerEnv(), reject: false },
      );

      if (result.exitCode !== 0) {
        const stderr = result.stderr?.trim();
        const stdout = result.stdout?.trim();
        const errorDetail = stderr || stdout;
        const exitDetail =
          typeof result.exitCode === 'number' ? `exit ${result.exitCode}` : 'exit unknown';
        // Ownership/permission repair is best-effort: the agent has already
        // finished and its artifacts are still readable by the owning user.
        // On rootless or restricted runners (e.g. ARC/DinD with a non-root
        // runner container) the repair container may be denied CHOWN/chmod,
        // producing "Operation not permitted" / "Permission denied". Those are
        // expected and non-fatal, so log them at debug to avoid alarming users
        // who otherwise see a scary WARN for a benign, non-blocking condition.
        const detail = `for ${dir} (${exitDetail})` + (errorDetail ? `: ${errorDetail}` : '');
        if (isBenignArtifactPermissionError(errorDetail)) {
          logger.debug(
            `Rootless artifact permission repair skipped ${detail}. ` +
              `This is expected on restricted runners and does not affect the run.`,
          );
        } else {
          logger.warn(`Rootless artifact permission repair failed ${detail}`);
        }
        repairedAll = false;
      }
    } catch (error) {
      logger.warn(`Rootless artifact permission repair failed for ${dir}:`, error);
      repairedAll = false;
    }
  }
  return repairedAll;
}
