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
const CANDIDATE_PREFIXES = ['/host', '/runner'];

/** Timeout for each docker run probe (ms) */
const PROBE_TIMEOUT_MS = 15000;

/** Lightweight image for the probe — busybox is smaller than alpine */
const PROBE_IMAGE = 'busybox:latest';

export interface ProbeResult {
  /** The detected prefix, or undefined if filesystem is shared or undetectable */
  prefix: string | undefined;
  /** Whether the probe detected a split filesystem */
  splitDetected: boolean;
}

/**
 * Probes whether the Docker daemon can see the runner's filesystem,
 * and if not, discovers the correct path prefix for bind-mount translation.
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

    // Step 1: Check if daemon can see the file directly (no prefix)
    const directVisible = await runProbe(probeDir, sentinelName);
    if (directVisible) {
      logger.debug('DinD probe: daemon can see runner filesystem directly (no prefix needed)');
      return { prefix: undefined, splitDetected: false };
    }

    // Split filesystem detected
    logger.debug('DinD probe: daemon cannot see runner filesystem — split topology detected');

    // Step 2: Try candidate prefixes
    for (const candidate of CANDIDATE_PREFIXES) {
      const prefixedDir = `${candidate}${probeDir}`;
      const prefixVisible = await runProbe(prefixedDir, sentinelName);
      if (prefixVisible) {
        logger.info(`DinD probe: auto-detected --docker-host-path-prefix ${candidate}`);
        return { prefix: candidate, splitDetected: true };
      }
    }

    // No candidate worked
    logger.debug('DinD probe: split filesystem detected but no candidate prefix worked');
    return { prefix: undefined, splitDetected: true };
  } catch (error) {
    logger.debug(`DinD probe: error during filesystem probe: ${error instanceof Error ? error.message : String(error)}`);
    return { prefix: undefined, splitDetected: false };
  } finally {
    // Clean up sentinel
    try {
      fs.unlinkSync(sentinelPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Runs a single probe: mounts the given directory and checks for the sentinel file.
 */
async function runProbe(mountSource: string, sentinelName: string): Promise<boolean> {
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
    return result.exitCode === 0;
  } catch {
    // Timeout or other error — treat as not visible
    return false;
  }
}
