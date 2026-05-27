/**
 * Probes whether the Docker daemon shares a filesystem with the runner.
 *
 * In ARC/DinD setups, the runner and Docker daemon may have separate
 * filesystems. When this is the case, bind-mount source paths resolved on
 * the runner won't exist inside containers. This probe detects that condition
 * and discovers the correct path prefix so AWF can translate mount paths.
 *
 * Strategy:
 *  1. Write a sentinel file to the probe directory.
 *  2. Run `docker run --rm -v <dir>:/probe:ro <image> test -f /probe/<sentinel>`.
 *  3. If the file IS visible → shared filesystem → no prefix needed.
 *  4. If the file is NOT visible → split filesystem → try candidate prefixes.
 *  5. For each candidate prefix, try mounting `<prefix><dir>:/probe:ro` and
 *     check if the sentinel is visible.
 *  6. Return the first working prefix, or undefined if none works.
 */

import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { getLocalDockerEnv } from './docker-host';
import { logger } from './logger';

/** Candidate prefixes to try when split filesystem is detected */
const CANDIDATE_PREFIXES = ['/host', '/runner', '/tmp/gh-aw'];

/** Timeout for each docker run probe (ms) */
const PROBE_TIMEOUT_MS = 10000;

/** Timeout for Docker connectivity check (ms) */
const DOCKER_PING_TIMEOUT_MS = 5000;

/** Lightweight image for the probe — busybox is smaller than alpine */
const PROBE_IMAGE = 'busybox:latest';

interface ProbeResult {
  /** The detected prefix, or undefined if filesystem is shared or undetectable */
  prefix: string | undefined;
  /** Whether the probe detected a split filesystem */
  splitDetected: boolean;
  /** Whether the probe was inconclusive (Docker unreachable, timeout, etc.) */
  inconclusive: boolean;
}

/**
 * Probes whether the Docker daemon can see the runner's filesystem,
 * and if not, discovers the correct path prefix for bind-mount translation.
 *
 * Returns inconclusive (without splitDetected) when Docker is unreachable
 * or the probe encounters infrastructure errors — as opposed to a confirmed
 * split where the daemon runs but can't see runner paths.
 *
 * @param probeDir - Directory to probe (should be the AWF workDir or a subdir)
 * @returns The discovered prefix, or undefined if same-fs or undetectable
 */
export async function probeSplitFilesystem(probeDir: string): Promise<ProbeResult> {
  const sentinelName = `.awf-fs-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sentinelPath = path.join(probeDir, sentinelName);

  try {
    // Ensure probe dir exists
    fs.mkdirSync(probeDir, { recursive: true });
    fs.writeFileSync(sentinelPath, 'awf-probe');

    // Step 0: Verify Docker daemon is reachable (fail-fast)
    const dockerReachable = await checkDockerReachable();
    if (!dockerReachable) {
      logger.debug('DinD probe: Docker daemon unreachable, skipping filesystem probe');
      return { prefix: undefined, splitDetected: false, inconclusive: true };
    }

    // Step 1: Check if daemon can see the file directly (no prefix)
    const directResult = await runProbe(probeDir, sentinelName);
    if (directResult === 'visible') {
      logger.debug('DinD probe: daemon can see runner filesystem directly (no prefix needed)');
      return { prefix: undefined, splitDetected: false, inconclusive: false };
    }
    if (directResult === 'error') {
      // Infrastructure error (not just file-not-found) — inconclusive
      logger.debug('DinD probe: infrastructure error during direct probe, result inconclusive');
      return { prefix: undefined, splitDetected: false, inconclusive: true };
    }

    // directResult === 'not-visible': Split filesystem confirmed
    logger.debug('DinD probe: daemon cannot see runner filesystem — split topology detected');

    // Step 2: Try candidate prefixes
    for (const candidate of CANDIDATE_PREFIXES) {
      const prefixedDir = `${candidate}${probeDir}`;
      const prefixResult = await runProbe(prefixedDir, sentinelName);
      if (prefixResult === 'visible') {
        return { prefix: candidate, splitDetected: true, inconclusive: false };
      }
    }

    // No candidate worked
    return { prefix: undefined, splitDetected: true, inconclusive: false };
  } catch (error) {
    logger.debug(`DinD probe: error during filesystem probe: ${error instanceof Error ? error.message : String(error)}`);
    return { prefix: undefined, splitDetected: false, inconclusive: true };
  } finally {
    // Clean up sentinel
    try {
      fs.unlinkSync(sentinelPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

/** Probe outcome distinguishing file-not-found from infrastructure errors */
type ProbeOutcome = 'visible' | 'not-visible' | 'error';

/**
 * Checks if the Docker daemon is reachable via `docker info`.
 * This is a fast connectivity check to avoid long timeouts on subsequent probes.
 */
async function checkDockerReachable(): Promise<boolean> {
  try {
    const result = await execa(
      'docker',
      ['info', '--format', '{{.ID}}'],
      {
        env: getLocalDockerEnv(),
        timeout: DOCKER_PING_TIMEOUT_MS,
        reject: false,
      },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Runs a single probe: mounts the given directory and checks for the sentinel file.
 *
 * Returns:
 *  - 'visible' if the sentinel file was found (exit code 0)
 *  - 'not-visible' if the container ran but file was absent (exit code 1)
 *  - 'error' if the container failed to start (exit code 125/126/127, timeout, etc.)
 */
async function runProbe(mountSource: string, sentinelName: string): Promise<ProbeOutcome> {
  try {
    const volumeMount = [mountSource, '/probe:ro'].join(':');
    const targetPath = ['/probe', sentinelName].join('/');
    const result = await execa(
      'docker',
      ['run', '--rm', '-v', volumeMount, PROBE_IMAGE, 'test', '-f', targetPath],
      {
        env: getLocalDockerEnv(),
        timeout: PROBE_TIMEOUT_MS,
        reject: false,
      },
    );

    if (result.exitCode === 0) {
      return 'visible';
    }
    // Exit codes 125, 126, 127 indicate Docker/container infrastructure errors
    // (e.g., image pull failure, mount error, command not found)
    if (result.exitCode !== undefined && result.exitCode >= 125) {
      return 'error';
    }
    // Exit code 1 from `test -f` means file not found — legitimate split-fs signal
    return 'not-visible';
  } catch {
    // Timeout or ENOENT (docker binary missing) — infrastructure error
    return 'error';
  }
}

