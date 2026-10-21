import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { logger } from '../logger';
import { getLocalDockerEnv } from '../docker-host';
import { openArtifactDirectory, resolveArtifactOwner } from '../resolved-config-artifact';
import { ROUTER_SERVICE_NAME } from '../services/router-service';

/** The file in the router log directory that receives the router's stdout and stderr. */
export const ROUTER_LOG_FILE = 'router.jsonl';

/**
 * Budget for finding, stopping and reading the router. The router's own 1 s stop
 * timeout, the same one `docker compose down -t 1` gives it, fits inside it.
 */
const CAPTURE_DEADLINE_MS = 5000;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const LOG_FILE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT |
  (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** `incomplete` means the file may lack records, `failed` that no file was written. */
export type RouterLogCaptureOutcome = 'saved' | 'absent' | 'incomplete' | 'failed';

type DockerResult = Pick<execa.ExecaReturnBase<string>, 'exitCode' | 'failed' | 'timedOut' | 'stderr'>;

function describeFailure(result: DockerResult): string {
  if (result.timedOut) return 'timed out';
  return typeof result.exitCode === 'number' ? `exit code ${result.exitCode}` : 'docker did not run';
}

function restrictToOwner(fd: number, mode: number, owner: { uid: number; gid: number }): void {
  const stat = fs.fstatSync(fd);
  if (stat.uid !== owner.uid || stat.gid !== owner.gid) fs.fchownSync(fd, owner.uid, owner.gid);
  fs.fchmodSync(fd, mode);
}

/**
 * Opens the router log file without following links, owned by the user who ran
 * AWF and readable only by them. The router image is configurable, so its logs
 * aren't assumed to be safe to publish more widely.
 */
function openRouterLogFile(routerLogsDir: string): number {
  const owner = resolveArtifactOwner();
  try {
    fs.mkdirSync(routerLogsDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const directoryFd = openArtifactDirectory(routerLogsDir);
  try {
    restrictToOwner(directoryFd, 0o700, owner);
    const fd = fs.openSync(`/proc/self/fd/${directoryFd}/${ROUTER_LOG_FILE}`, LOG_FILE_FLAGS, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Refusing to write router logs to ${ROUTER_LOG_FILE}: not a regular, unlinked file`);
      }
      fs.ftruncateSync(fd, 0);
      restrictToOwner(fd, 0o600, owner);
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  } finally {
    fs.closeSync(directoryFd);
  }
}

async function stopAndSave(workDir: string, routerLogsDir: string): Promise<RouterLogCaptureOutcome> {
  const deadline = Date.now() + CAPTURE_DEADLINE_MS;
  const env = getLocalDockerEnv();
  const limits = () => ({
    env,
    reject: false,
    timeout: Math.max(deadline - Date.now(), 1),
    forceKillAfterTimeout: 1000,
  });

  // Compose resolves the project the same way `docker compose down` does, so only
  // this run's router is found, never another container with the same name.
  const lookup = await execa('docker', ['compose', 'ps', '--all', '--quiet', ROUTER_SERVICE_NAME], {
    cwd: workDir,
    ...limits(),
  });
  if (lookup.failed) {
    logger.debug(`docker compose ps stderr: ${lookup.stderr || '(none)'}`);
    logger.warn(`Could not find this run's router container (${describeFailure(lookup)}); its logs were not saved`);
    return 'failed';
  }
  const ids = lookup.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (ids.length === 0) {
    logger.debug('This run has no router container; skipping router log capture');
    return 'absent';
  }
  if (ids.length !== 1 || !CONTAINER_ID.test(ids[0])) {
    logger.warn('Docker Compose did not report a single router container; its logs were not saved');
    return 'failed';
  }
  const containerId = ids[0];

  // The api-proxy keeps running, so it's still there for the router's final telemetry flush.
  let complete = true;
  const stop = await execa('docker', ['stop', '-t', '1', containerId], limits());
  if (stop.failed) {
    complete = false;
    logger.debug(`docker stop stderr: ${stop.stderr || '(none)'}`);
    logger.warn(`Could not stop the router before teardown (${describeFailure(stop)}); saving its logs anyway`);
  }
  if (Date.now() >= deadline) {
    logger.warn(`Router log capture ran out of time after ${CAPTURE_DEADLINE_MS} ms; its logs were not saved`);
    return 'failed';
  }

  const file = path.join(routerLogsDir, ROUTER_LOG_FILE);
  const fd = openRouterLogFile(path.resolve(routerLogsDir));
  try {
    // Stream straight to the file; `docker logs` works on a stopped container.
    const logs = await execa('docker', ['logs', containerId], {
      ...limits(),
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
    });
    if (logs.failed) {
      logger.warn(`Router log capture failed (${describeFailure(logs)}); ${file} may be incomplete`);
      return 'incomplete';
    }
  } finally {
    fs.closeSync(fd);
  }
  logger.debug(`Saved the router's logs to ${file}`);
  return complete ? 'saved' : 'incomplete';
}

/**
 * Stops this run's model router on its own and saves its complete stdout and
 * stderr to `<routerLogsDir>/router.jsonl`, before `docker compose down` removes
 * the container. Docker keeps the router's JSON log records only as long as the
 * container exists.
 *
 * All Docker calls share one 5 s deadline. Never throws: losing the router's
 * logs must not stop teardown or change its outcome.
 */
export async function stopRouterAndSaveLogs(
  workDir: string,
  routerLogsDir: string,
): Promise<RouterLogCaptureOutcome> {
  try {
    return await stopAndSave(workDir, routerLogsDir);
  } catch (error) {
    logger.warn('Could not save the router\'s logs:', error);
    return 'failed';
  }
}
