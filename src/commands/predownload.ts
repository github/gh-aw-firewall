import execa from 'execa';
import { logger } from '../logger';
import { buildRuntimeImageRef, parseImageTag } from '../image-tag';

export interface PredownloadOptions {
  imageRegistry: string;
  imageTag: string;
  agentImage: string;
  enableApiProxy: boolean;
  difcProxy?: boolean;
}

/**
 * Validates a custom Docker image reference.
 * Rejects values that could be interpreted as Docker CLI flags or contain whitespace.
 */
function validateImageReference(image: string): void {
  if (image.startsWith('-')) {
    throw new Error(`Invalid image reference "${image}": must not start with "-"`);
  }
  if (/\s/.test(image)) {
    throw new Error(`Invalid image reference "${image}": must not contain whitespace`);
  }
}

/**
 * Resolves the list of image references to pull based on the given options.
 */
export function resolveImages(options: PredownloadOptions): string[] {
  const { imageRegistry, imageTag, agentImage, enableApiProxy } = options;
  const parsedImageTag = parseImageTag(imageTag);
  const images: string[] = [];

  // Always pull squid
  images.push(buildRuntimeImageRef(imageRegistry, 'squid', parsedImageTag));

  // Pull agent image based on preset
  const isPreset = agentImage === 'default' || agentImage === 'act';
  if (isPreset) {
    const imageName = agentImage === 'act' ? 'agent-act' : 'agent';
    images.push(buildRuntimeImageRef(imageRegistry, imageName, parsedImageTag));
  } else {
    // Custom image - validate and pull as-is
    validateImageReference(agentImage);
    images.push(agentImage);
  }

  // Optionally pull api-proxy
  if (enableApiProxy) {
    images.push(buildRuntimeImageRef(imageRegistry, 'api-proxy', parsedImageTag));
  }

  // Optionally pull cli-proxy (mcpg is now started externally by the compiler)
  if (options.difcProxy) {
    images.push(buildRuntimeImageRef(imageRegistry, 'cli-proxy', parsedImageTag));
  }

  return images;
}

/**
 * Pre-download Docker images for offline use or faster startup.
 */
export async function predownloadCommand(options: PredownloadOptions): Promise<void> {
  const images = resolveImages(options);

  logger.info(`Pre-downloading ${images.length} image(s)...`);

  let failed = 0;
  for (const image of images) {
    logger.info(`Pulling ${image}...`);
    try {
      await execa('docker', ['pull', image], { stdio: 'inherit' });
      logger.info(`Successfully pulled ${image}`);
    } catch (error) {
      logger.error(`Failed to pull ${image}: ${error instanceof Error ? error.message : error}`);
      failed++;
    }
  }

  if (failed > 0) {
    const message = `${failed} of ${images.length} image(s) failed to pull`;
    logger.error(message);
    const error: Error & { exitCode?: number } = new Error(message);
    error.exitCode = 1;
    throw error;
  }

  logger.info(`All ${images.length} image(s) pre-downloaded successfully`);
  logger.info('You can now use --skip-pull to skip pulling images at runtime');
}
