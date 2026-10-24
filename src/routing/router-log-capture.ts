import * as fs from 'fs';
import * as path from 'path';
import type { Readable } from 'stream';
import execa from 'execa';
import { logger } from '../logger';
import { getLocalDockerEnv } from '../docker-host';
import { preservedArtifactDirectory, resolveLogPaths } from '../log-paths';
import { openArtifactDirectory, resolveArtifactOwner } from '../resolved-config-artifact';
import { ROUTER_SERVICE_NAME } from '../services/router-service';
import type { WrapperConfig } from '../types';
import { normalizeForOverlap, pathsOverlap } from './bootstrap';

/** The file in the router log directory that receives the router's stdout and stderr. */
export const ROUTER_LOG_FILE = 'router.jsonl';

/**
 * Budget for finding, stopping and reading the router. The router's own 1 s stop
 * timeout, the same one `docker compose down -t 1` gives it, fits inside it.
 */
const CAPTURE_DEADLINE_MS = 5000;
/**
 * The bundled router writes a few hundred bytes per request. A custom image that
 * logs far more must not fill the runner's disk, so no more than this is written.
 */
export const MAX_ROUTER_LOG_BYTES = 16 * 1024 * 1024;
/** How long to wait for buffered output after `docker logs` exits. */
const STREAM_DRAIN_MS = 1000;
const MIN_STREAM_DRAIN_MS = 50;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const LOG_FILE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
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
 * Creates and opens `<parent>/<name>` through a descriptor for its parent, so
 * that no component of the path is followed through a symlink and nothing is
 * created outside the intended directory.
 */
function openRouterLogsDirectory(routerLogsDir: string): number {
  const parentFd = openArtifactDirectory(path.dirname(routerLogsDir));
  try {
    const child = `/proc/self/fd/${parentFd}/${path.basename(routerLogsDir)}`;
    try {
      fs.mkdirSync(child, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return fs.openSync(child, DIRECTORY_FLAGS);
  } finally {
    fs.closeSync(parentFd);
  }
}

/**
 * Opens the router log file without following links, owned by the user who ran
 * AWF and readable only by them. The router image is configurable, so its logs
 * aren't assumed to be safe to publish more widely.
 */
function openRouterLogFile(routerLogsDir: string): number {
  const owner = resolveArtifactOwner();
  const directoryFd = openRouterLogsDirectory(routerLogsDir);
  try {
    restrictToOwner(directoryFd, 0o700, owner);
    const file = `/proc/self/fd/${directoryFd}/${ROUTER_LOG_FILE}`;
    try {
      const previous = fs.lstatSync(file);
      if (!previous.isFile() || previous.nlink !== 1) {
        throw new Error(`Refusing to replace router logs at ${ROUTER_LOG_FILE}: not a regular, unlinked file`);
      }
      // Existing readers must retain only the old records, never the new private output.
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const fd = fs.openSync(file, LOG_FILE_FLAGS, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Refusing to write router logs to ${ROUTER_LOG_FILE}: not a regular, unlinked file`);
      }
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

/**
 * Copies the output of `docker logs` into `fd`, at most MAX_ROUTER_LOG_BYTES in
 * total, and kills `docker logs` once there's more. The limit applies before any
 * byte reaches the disk. The bundled router writes only to stderr, so the
 * order between the two streams doesn't matter.
 */
async function copyLogs(
  child: execa.ExecaChildProcess,
  fd: number,
  deadline: number,
): Promise<{ result: DockerResult; oversized: boolean; drained: boolean; writeError?: unknown }> {
  let remaining = MAX_ROUTER_LOG_BYTES;
  let oversized = false;
  let writeError: unknown;
  let open = true;
  const write = (chunk: Buffer): void => {
    if (!open || oversized || writeError !== undefined) return;
    const length = Math.min(chunk.length, remaining);
    try {
      // writeSync may write less than asked, for example on a full disk, without throwing.
      for (let offset = 0; offset < length;) {
        const written = fs.writeSync(fd, chunk, offset, length - offset);
        if (written <= 0) throw new Error(`wrote ${offset} of ${length} bytes`);
        offset += written;
      }
    } catch (error) {
      writeError = error;
      child.kill('SIGKILL');
      return;
    }
    remaining -= length;
    if (length < chunk.length) {
      oversized = true;
      child.kill('SIGKILL');
    }
  };
  const streams = [child.stdout, child.stderr].filter((stream): stream is Readable => Boolean(stream));
  const drained = Promise.all(streams.map(stream => new Promise<boolean>(resolve => {
    stream.on('data', write);
    stream.on('error', () => resolve(false));
    stream.once('end', () => resolve(true));
    stream.once('close', () => resolve(stream.readableEnded));
  }))).then(results => results.every(Boolean));
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await child;
    // Output buffered when the process exited still arrives, but within the capture deadline.
    const drainMs = Math.min(STREAM_DRAIN_MS, Math.max(deadline - Date.now(), MIN_STREAM_DRAIN_MS));
    const finished = await Promise.race([
      drained, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), drainMs); }),
    ]);
    return { result, oversized, drained: finished, writeError };
  } finally {
    clearTimeout(timer);
    open = false;
    for (const stream of streams) {
      stream.removeListener('data', write);
      stream.destroy();
    }
  }
}

async function stopAndSave(workDir: string, routerLogsDir: string): Promise<RouterLogCaptureOutcome> {
  const deadline = Date.now() + CAPTURE_DEADLINE_MS;
  const env = getLocalDockerEnv();
  const limits = () => ({
    env,
    reject: false,
    timeout: Math.max(deadline - Date.now(), 1),
    // Kill a timed-out Docker CLI outright; execa would otherwise wait 5 s to escalate.
    killSignal: 'SIGKILL',
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
    // `docker logs` works on a stopped container. Its output goes through pipes, so
    // it never holds the file and can't write to it after the capture ends.
    const { result: logs, oversized, drained, writeError } = await copyLogs(execa('docker', ['logs', containerId], {
      ...limits(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
    }), fd, deadline);
    if (oversized) {
      logger.warn(`The router's logs exceeded ${MAX_ROUTER_LOG_BYTES} bytes; ${file} keeps only the start`);
      return 'incomplete';
    }
    if (writeError !== undefined) {
      logger.warn(`Could not write ${file}; it may be incomplete:`, writeError);
      return 'incomplete';
    }
    if (logs.failed) {
      logger.warn(`Router log capture failed (${describeFailure(logs)}); ${file} may be incomplete`);
      return 'incomplete';
    }
    if (!drained) {
      logger.warn(`Router log output did not finish; ${file} may be incomplete`);
      return 'incomplete';
    }
  } finally {
    fs.closeSync(fd);
  }
  logger.debug(`Saved the router's logs to ${file}`);
  return complete ? 'saved' : 'incomplete';
}

/**
 * Where to save this run's router logs: `resolveLogPaths(config).routerLogs` when
 * the compose file has a router service, otherwise undefined.
 *
 * Cleanup recursively makes the audit, session-state and diagnostics staging
 * directories readable by everyone (`preserveCleanupArtifacts` and the rootless
 * repair), so either the capture or preservation destination inside any of them,
 * or containing one, would lose its owner-only modes. In that case logs aren't
 * saved, with a warning.
 */
export function resolveRouterLogsDir(config: WrapperConfig): string | undefined {
  if (config.experimentalModelRouting !== true || !config.modelRouting || !config.modelRoutingBootstrap) {
    return undefined;
  }
  const routerLogsDir = resolveLogPaths(config).routerLogs;
  try {
    const targets = [
      routerLogsDir,
      ...(!config.proxyLogsDir ? [preservedArtifactDirectory(config.workDir, 'router-logs')] : []),
    ];
    const widened = [
      config.auditDir || path.join(config.workDir, 'audit'),
      ...(!config.auditDir ? [preservedArtifactDirectory(config.workDir, 'awf-audit')] : []),
      resolveLogPaths(config).sessionState,
      path.join(config.workDir, 'diagnostics'),
      ...(!config.auditDir ? [preservedArtifactDirectory(config.workDir, 'awf-diagnostics')] : []),
    ];
    // Lexically collapsing `..` before resolving a symlink can check the wrong tree.
    if ([config.workDir, config.proxyLogsDir, ...widened, ...targets]
      .some(root => root?.split(path.sep).includes('..'))) {
      throw new Error('Artifact paths containing parent components cannot be checked safely');
    }
    const normalizedTargets = targets.map(normalizeForOverlap);
    const overlapping = widened.find(root =>
      normalizedTargets.some(target => pathsOverlap(normalizeForOverlap(root), target)));
    if (overlapping) {
      logger.warn(`Not saving the router's logs: ${routerLogsDir} overlaps ${overlapping}, ` +
        'which AWF makes readable by everyone at cleanup');
      return undefined;
    }
  } catch (error) {
    logger.warn('Not saving the router\'s logs: could not check where they would go:', error);
    return undefined;
  }
  return routerLogsDir;
}

/**
 * Stops this run's model router on its own and saves its complete stdout and
 * stderr to `<routerLogsDir>/router.jsonl`, before `docker compose down` removes
 * the container. Docker keeps the router's JSON log records only as long as the
 * container exists.
 *
 * All Docker calls share one 5 s deadline, and at most 16 MiB is written. Never
 * throws: losing the router's logs must not stop teardown or change its outcome.
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
