import execa from 'execa';
import { logger } from './logger';
import { getLocalDockerEnv } from './docker-host';
import { SQUID_CONTAINER_NAME } from './constants';

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
 * Fixes squid log file permissions inside the running container before shutdown.
 *
 * Squid writes logs as its internal proxy user (UID 13). After `docker compose
 * down`, those files on the host are owned by UID 13, and the runner user
 * (e.g. UID 1001) cannot chmod them without sudo. This is especially
 * problematic on ARC/DinD topologies where the docker-based rootless repair in
 * `fixArtifactPermissionsForRootless()` also fails because path translation is
 * not applied to the bind-mount or the squid image is unavailable after compose
 * down with `--pull never`.
 *
 * Running `chmod -R a+rX` as root inside the still-running container fixes the
 * permissions on the bind-mounted log volume before it is unmounted, ensuring
 * that `awf logs summary` and artifact uploads can read the files.
 *
 * Tolerant: silently continues if the container is not running.
 */
export async function fixSquidLogPermissionsBeforeShutdown(): Promise<void> {
  try {
    const result = await execa(
      'docker',
      ['exec', '--user', 'root', SQUID_CONTAINER_NAME, 'chmod', '-R', 'a+rX', '/var/log/squid'],
      { env: getLocalDockerEnv(), reject: false },
    );
    if (result.exitCode !== 0) {
      logger.debug(
        `Pre-shutdown squid log chmod exited with code ${result.exitCode}: ${result.stderr || '(no stderr)'}`,
      );
    }
  } catch {
    // Container not running or docker not available — not an error.
    logger.debug('Pre-shutdown squid log chmod skipped (container not available)');
  }
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

  // Fix squid log permissions before compose down so log files are readable
  // after shutdown (e.g. for `awf logs summary` and artifact upload).
  await fixSquidLogPermissionsBeforeShutdown();

  try {
    await runComposeDown(workDir);
    logger.success('Containers stopped successfully');
  } catch (error) {
    logger.error('Failed to stop containers:', error);
    throw error;
  }
}
