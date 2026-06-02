import execa from 'execa';
import { logger } from './logger';
import { getLocalDockerEnv } from './docker-host';

/**
 * Runs `docker compose down -v -t 1` with the standard AWF options.
 */
export async function runComposeDown(
  workDir: string,
  options: { reject?: boolean } = {},
): Promise<void> {
  await execa('docker', ['compose', 'down', '-v', '-t', '1'], {
    cwd: workDir,
    stdout: process.stderr,
    stderr: 'inherit',
    env: getLocalDockerEnv(),
    reject: options.reject ?? true,
  });
}

/**
 * Stops and removes Docker Compose services
 */
export async function stopContainers(workDir: string, keepContainers: boolean): Promise<void> {
  if (keepContainers) {
    logger.info('Keeping containers running (--keep-containers enabled)');
    return;
  }

  logger.info('Stopping containers...');

  try {
    await runComposeDown(workDir);
    logger.success('Containers stopped successfully');
  } catch (error) {
    logger.error('Failed to stop containers:', error);
    throw error;
  }
}
