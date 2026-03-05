import * as fs from 'fs';
import * as crypto from 'crypto';
import execa from 'execa';
import { logger } from './logger';

/**
 * Detect whether the Docker daemon is running in a Docker-in-Docker (DinD)
 * environment where file bind mounts don't work because the daemon cannot
 * see the client's filesystem.
 *
 * Detection logic:
 * 1. Fast path: If DOCKER_HOST starts with tcp://, the daemon is remote → true
 * 2. Probe path: Write a unique token to a temp file, bind-mount it into a
 *    busybox container, and check if the output matches. If not → true (DinD).
 * 3. On any probe error, assume native Docker → false (safe default).
 *
 * @returns true if Docker daemon cannot access the local filesystem
 */
export async function isDinDEnvironment(): Promise<boolean> {
  const dockerHost = process.env.DOCKER_HOST;

  // Fast path: tcp:// means the daemon is definitely remote
  if (dockerHost && dockerHost.startsWith('tcp://')) {
    logger.debug('DOCKER_HOST is tcp://, detected DinD environment');
    return true;
  }

  // Probe path: test if bind mounts work
  const token = crypto.randomUUID();
  const probeFile = `/tmp/awf-dind-probe-${token}`;

  try {
    fs.writeFileSync(probeFile, token, 'utf-8');

    const result = await execa('docker', [
      'run', '--rm',
      '-v', `${probeFile}:/probe:ro`,
      'busybox', 'cat', '/probe',
    ]);

    const matches = result.stdout.trim() === token;
    if (!matches) {
      logger.debug('DinD probe: output did not match token, detected DinD environment');
      return true;
    }

    logger.debug('DinD probe: output matched token, native Docker detected');
    return false;
  } catch (err) {
    logger.debug('DinD probe failed, assuming native Docker:', err);
    return false;
  } finally {
    try {
      fs.unlinkSync(probeFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
