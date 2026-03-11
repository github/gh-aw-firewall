import execa from 'execa';
import { logger } from '../logger';

export interface PredownloadOptions {
  imageRegistry: string;
  imageTag: string;
  agentImage: string;
  enableApiProxy: boolean;
}

/**
 * Resolves the list of image references to pull based on the given options.
 */
export function resolveImages(options: PredownloadOptions): string[] {
  const { imageRegistry, imageTag, agentImage, enableApiProxy } = options;
  const images: string[] = [];

  // Always pull squid
  images.push(`${imageRegistry}/squid:${imageTag}`);

  // Pull agent image based on preset
  const isPreset = agentImage === 'default' || agentImage === 'act';
  if (isPreset) {
    const imageName = agentImage === 'act' ? 'agent-act' : 'agent';
    images.push(`${imageRegistry}/${imageName}:${imageTag}`);
  } else {
    // Custom image - pull as-is
    images.push(agentImage);
  }

  // Optionally pull api-proxy
  if (enableApiProxy) {
    images.push(`${imageRegistry}/api-proxy:${imageTag}`);
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
    logger.error(`${failed} of ${images.length} image(s) failed to pull`);
    process.exit(1);
  }

  logger.info(`All ${images.length} image(s) pre-downloaded successfully`);
  logger.info('You can now use --skip-pull to skip pulling images at runtime');
}
