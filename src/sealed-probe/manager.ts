import * as fs from 'fs';
import execa from 'execa';
import { logger } from '../logger';
import { getLocalDockerEnv } from '../host-env';
import { getSafeHostUid, getSafeHostGid } from '../host-identity';
import type { WrapperConfig } from '../types';
import {
  generateSealedProbeRunId,
  resolveSealedProbePaths,
  type SealedProbePaths,
} from './paths';
import { assertProbeRuntimeAvailable, validateSealedProbeConfig } from './preflight';
import { writeSealedProbeSkill } from './skill';
import { releaseSeedPermissions, resolveStagingToken, stageSealedProbeSeeds, type GitRunner } from './staging';
import { SEALED_PROBE_SEED_MAP_VERSION, type SealedProbeSeedMap } from './types';

/**
 * Sealed-probe lifecycle orchestration.
 *
 * `prepareSealedProbes` runs entirely on the trusted AWF host **before** any
 * configuration is generated or any container is started, so that:
 *
 * - the primary agent never starts when staging fails;
 * - the staging credential is consumed and discarded before the broker, the
 *   agent, and any probe exist;
 * - compose generation can rely on the on-disk layout already being present.
 *
 * `teardownSealedProbes` removes orphaned probe containers and restores write
 * permissions on the immutable seeds so AWF's generic work-directory cleanup
 * can delete them.
 */

/** Docker label applied to every probe container, used for orphan cleanup. */
export const SEALED_PROBE_RUN_LABEL = 'awf.sealed-probe.run';

/** Returns true when this run must stage seeds and start the broker. */
export function isSealedProbesEnabled(config: WrapperConfig): boolean {
  return config.sealedProbes?.enabled === true;
}

/** Creates a directory with an exact mode, independent of the process umask. */
function ensureModeDirectory(target: string, mode: number): void {
  fs.mkdirSync(target, { recursive: true, mode });
  fs.chmodSync(target, mode);
}

/**
 * Creates the sealed-probe directory layout.
 *
 * The socket and skill directories are handed to the host user because the
 * agent process runs under the host UID/GID; everything else stays
 * root-owned (0700) inside the already-hardened work directory.
 */
function prepareDirectories(paths: SealedProbePaths): void {
  ensureModeDirectory(paths.root, 0o700);
  ensureModeDirectory(paths.seedsDir, 0o700);
  ensureModeDirectory(paths.workDir, 0o700);
  ensureModeDirectory(paths.auditDir, 0o700);
  ensureModeDirectory(paths.runDir, 0o770);
  ensureModeDirectory(paths.agentDir, 0o755);

  try {
    fs.chownSync(paths.runDir, parseInt(getSafeHostUid(), 10), parseInt(getSafeHostGid(), 10));
  } catch {
    // Non-root host (e.g. network-isolation mode): the broker chowns/chmods
    // the socket itself once it is bound.
  }
}

/** Writes the broker's repo → opaque seed map. */
function writeSeedMap(paths: SealedProbePaths, seedMap: SealedProbeSeedMap): void {
  fs.writeFileSync(paths.seedMapPath, JSON.stringify(seedMap, null, 2) + '\n', { mode: 0o644 });
  fs.chmodSync(paths.seedMapPath, 0o644);
}

export interface PrepareSealedProbesDeps {
  /** Override the git runner (tests). */
  gitRunner?: GitRunner;
  /** Override the host environment the staging credential is read from. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Validates configuration, stages one immutable seed per configured
 * repository, and writes the broker/agent artifacts.
 *
 * Throws on any failure — the caller must abort the run.
 */
export async function prepareSealedProbes(
  config: WrapperConfig,
  deps: PrepareSealedProbesDeps = {},
): Promise<void> {
  const sealedProbes = config.sealedProbes;
  if (!sealedProbes?.enabled) return;

  const env = deps.env ?? process.env;
  const errors = validateSealedProbeConfig(config, env);
  if (errors.length > 0) {
    throw new Error(`Sealed-probe configuration is invalid:\n  - ${errors.join('\n  - ')}`);
  }

  await assertProbeRuntimeAvailable(sealedProbes);

  const token = resolveStagingToken(env);
  if (!token) {
    // Already covered by validateSealedProbeConfig; re-checked so the token is
    // never `undefined!`-asserted into the staging call.
    throw new Error('Sealed-probe staging credential disappeared between validation and staging');
  }

  const paths = resolveSealedProbePaths(config.workDir);
  prepareDirectories(paths);

  const runId = generateSealedProbeRunId();
  const staging = await stageSealedProbeSeeds({
    repos: sealedProbes.privateRepos,
    paths,
    runId,
    token,
    gitRunner: deps.gitRunner,
  });

  writeSeedMap(paths, {
    version: SEALED_PROBE_SEED_MAP_VERSION,
    runId: staging.runId,
    seeds: staging.seeds.map((seed) => ({ repo: seed.repoKey, seedId: seed.seedId })),
  });

  writeSealedProbeSkill(paths, {
    repos: sealedProbes.privateRepos,
    timeoutSeconds: sealedProbes.timeout,
    maxInvocations: sealedProbes.maxInvocations,
  });

  logger.info(
    `Sealed probes: staged ${staging.seeds.length} immutable seed(s); staging credential discarded.`,
  );
}

/** Reads back the run id recorded during staging, if it is still available. */
function readRunId(paths: SealedProbePaths): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8')) as SealedProbeSeedMap;
    return typeof parsed.runId === 'string' && parsed.runId.length > 0 ? parsed.runId : undefined;
  } catch {
    return undefined;
  }
}

/** Force-removes any probe container still labelled with this run. */
async function removeOrphanProbeContainers(runId: string): Promise<void> {
  const filter = `label=${SEALED_PROBE_RUN_LABEL}=${runId}`;
  const listed = await execa('docker', ['ps', '-aq', '--filter', filter], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 30_000,
  });
  if (listed.exitCode !== 0) return;

  const ids = listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return;

  logger.debug(`Sealed probes: removing ${ids.length} orphaned probe container(s)`);
  await execa('docker', ['rm', '-f', ...ids], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 60_000,
  });
}

/**
 * Tears down sealed-probe state.
 *
 * Orphaned probe containers are always removed: they are ephemeral, hold a
 * private copy of repository contents, and are never useful for debugging.
 *
 * Restoring seed permissions is skipped under `--keep-containers`, where the
 * caller explicitly asked to preserve the run's state for inspection. When it
 * does run, it must run before AWF's generic work-directory cleanup: seeds are
 * deliberately read-only, and `rm -rf` cannot unlink entries inside a
 * directory whose write bit was stripped.
 */
export async function teardownSealedProbes(config: WrapperConfig): Promise<void> {
  if (!isSealedProbesEnabled(config)) return;

  const paths = resolveSealedProbePaths(config.workDir);
  if (!fs.existsSync(paths.root)) return;

  const runId = readRunId(paths);
  if (runId) {
    try {
      await removeOrphanProbeContainers(runId);
    } catch (error) {
      logger.warn('Sealed probes: failed to remove orphaned probe containers', error);
    }
  }

  if (config.keepContainers) {
    logger.info(`Sealed-probe seeds preserved (read-only) at: ${paths.seedsDir}`);
    return;
  }

  try {
    releaseSeedPermissions(paths.seedsDir);
  } catch (error) {
    logger.warn('Sealed probes: failed to restore seed permissions before cleanup', error);
  }
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const managerTestHelpers = {
  prepareDirectories,
  writeSeedMap,
  readRunId,
  removeOrphanProbeContainers,
};
