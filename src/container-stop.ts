import execa from 'execa';
import { logger } from './logger';
import { getLocalDockerEnv } from './docker-host';
import { getSafeHostGid, getSafeHostUid } from './host-identity';
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
 * Fixes squid log file ownership and permissions inside the running container.
 *
 * Squid writes logs as its internal proxy user (UID 13). On the host those
 * files are then owned by UID 13, so the runner user (e.g. UID 1001) can
 * neither read them (`EACCES` when inspecting `access.log` for blocked-domain
 * diagnostics) nor chmod them during artifact preservation (`chmod -R a+rX ...
 * Operation not permitted`). This is especially problematic on ARC/DinD
 * topologies where the docker-based rootless repair in
 * `fixArtifactPermissionsForRootless()` also fails because path translation is
 * not applied to the bind-mount or the squid image is unavailable after compose
 * down with `--pull never`.
 *
 * Running `chown`/`chmod` as root inside the still-running container fixes both
 * ownership and permissions on the bind-mounted log volume, ensuring that log
 * inspection, `awf logs summary`, and artifact uploads can read the files.
 *
 * Tolerant: silently continues if the container is not running. Never throws,
 * so the caller's exit code is unaffected by diagnostic log handling.
 */
export async function fixSquidLogPermissions(): Promise<void> {
  const uid = getSafeHostUid();
  const gid = getSafeHostGid();
  try {
    const result = await execa(
      'docker',
      [
        'exec',
        '--user',
        'root',
        '-e',
        `TUID=${uid}`,
        '-e',
        `TGID=${gid}`,
        SQUID_CONTAINER_NAME,
        'sh',
        '-c',
        'chown -R "$TUID:$TGID" /var/log/squid 2>/dev/null; chmod -R a+rX /var/log/squid',
      ],
      { env: getLocalDockerEnv(), reject: false },
    );
    if (result.exitCode !== 0) {
      logger.debug(
        `Squid log permission repair exited with code ${result.exitCode}: ${result.stderr || '(no stderr)'}`,
      );
    }
  } catch {
    // Container not running or docker not available — not an error.
    logger.debug('Squid log permission repair skipped (container not available)');
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

  // Fix squid log ownership/permissions before compose down so log files are
  // readable after shutdown (e.g. for `awf logs summary` and artifact upload).
  await fixSquidLogPermissions();

  try {
    await runComposeDown(workDir);
    logger.success('Containers stopped successfully');
  } catch (error) {
    logger.error('Failed to stop containers:', error);
    throw error;
  }
}
