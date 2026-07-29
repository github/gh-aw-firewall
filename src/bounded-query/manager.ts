import * as fs from 'fs';
import execa from 'execa';
import { logger } from '../logger';
import { getLocalDockerEnv } from '../host-env';
import { getSafeHostUid, getSafeHostGid } from '../host-identity';
import type { WrapperConfig } from '../types';
import {
  generateBoundedQueryRunId,
  resolveBoundedQueryPaths,
  type BoundedQueryPaths,
} from './paths';
import { assertQueryRuntimeAvailable, validateBoundedQueryConfig } from './preflight';
import { writeBoundedQuerySkill } from './skill';
import { releaseSeedPermissions, resolveStagingToken, stageBoundedQuerySeeds, type GitRunner } from './staging';
import { BOUNDED_QUERY_SEED_MAP_VERSION, type BoundedQuerySeedMap } from './types';

/**
 * Bounded-query lifecycle orchestration.
 *
 * `prepareBoundedQueries` runs entirely on the trusted AWF host **before** any
 * configuration is generated or any container is started, so that:
 *
 * - the primary agent never starts when staging fails;
 * - the staging credential is consumed and discarded before the broker, the
 *   agent, and any query exist;
 * - compose generation can rely on the on-disk layout already being present.
 *
 * `teardownBoundedQueries` removes orphaned query containers and restores write
 * permissions on the immutable seeds so AWF's generic work-directory cleanup
 * can delete them.
 */

/** Docker label applied to every query container, used for orphan cleanup. */
export const BOUNDED_QUERY_RUN_LABEL = 'awf.bounded-query.run';

/** Returns true when this run must stage seeds and start the broker. */
export function isBoundedQueriesEnabled(config: WrapperConfig): boolean {
  return config.boundedQueries?.enabled === true;
}

/** Creates a directory with an exact mode, independent of the process umask. */
function ensureModeDirectory(target: string, mode: number): void {
  fs.mkdirSync(target, { recursive: true, mode });
  fs.chmodSync(target, mode);
}

/**
 * Creates the bounded-query directory layout.
 *
 * The socket and skill directories are handed to the host user because the
 * agent process runs under the host UID/GID; everything else stays
 * root-owned (0700) inside the already-hardened work directory.
 *
 * The mask directory is created as an empty, read-only-to-others directory.
 * It is bind-mounted into the agent at the bounded-query root path, replacing
 * the agent's view of the entire bounded-query subtree (including seeds, work,
 * and audit) through the broad `/tmp` bind mount. Only the socket and skill
 * (mounted at separate container paths) remain agent-visible.
 */
function prepareDirectories(paths: BoundedQueryPaths): void {
  ensureModeDirectory(paths.root, 0o700);
  ensureModeDirectory(paths.seedsDir, 0o700);
  ensureModeDirectory(paths.workDir, 0o700);
  ensureModeDirectory(paths.auditDir, 0o700);
  ensureModeDirectory(paths.runDir, 0o770);
  ensureModeDirectory(paths.agentDir, 0o755);
  // Empty directory used as a masking mount in the agent container.
  // Mode 0o755 so Docker can bind-mount it without special privileges.
  ensureModeDirectory(paths.maskDir, 0o755);

  try {
    fs.chownSync(paths.runDir, parseInt(getSafeHostUid(), 10), parseInt(getSafeHostGid(), 10));
  } catch {
    // Non-root host (e.g. network-isolation mode): the broker chowns/chmods
    // the socket itself once it is bound.
  }
}

/** Writes the broker's repo → opaque seed map. */
function writeSeedMap(paths: BoundedQueryPaths, seedMap: BoundedQuerySeedMap): void {
  const content = JSON.stringify(seedMap, null, 2) + '\n';
  // O_EXCL | O_NOFOLLOW: atomically create; fail if a symlink or existing file
  // is already at this path (insecure-temp-file guard).
  const fd = fs.openSync(
    paths.seedMapPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeSync(fd, content);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

export interface PrepareBoundedQueriesDeps {
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
export async function prepareBoundedQueries(
  config: WrapperConfig,
  deps: PrepareBoundedQueriesDeps = {},
): Promise<void> {
  const boundedQueries = config.boundedQueries;
  if (!boundedQueries?.enabled) return;

  const env = deps.env ?? process.env;
  const errors = validateBoundedQueryConfig(config, env);
  if (errors.length > 0) {
    throw new Error(`Bounded-query configuration is invalid:\n  - ${errors.join('\n  - ')}`);
  }

  await assertQueryRuntimeAvailable(boundedQueries);

  const token = resolveStagingToken(env);
  if (!token) {
    // Already covered by validateBoundedQueryConfig; re-checked so the token is
    // never `undefined!`-asserted into the staging call.
    throw new Error('Bounded-query staging credential disappeared between validation and staging');
  }

  const paths = resolveBoundedQueryPaths(config.workDir);

  // Guard against symlink injection before writing any credential-bearing state.
  // The generic work-directory check in config-writer.ts runs later (during
  // writeConfigs), so we apply the same symlink rejection here explicitly.
  try {
    const lstat = fs.lstatSync(config.workDir);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Refusing to stage into a symlink work directory: ${config.workDir}`);
    }
  } catch (error: unknown) {
    // If lstatSync throws because the directory doesn't exist yet, that is
    // fine — prepareDirectories will create it.  Any other error propagates.
    if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  prepareDirectories(paths);

  const runId = generateBoundedQueryRunId();
  const staging = await stageBoundedQuerySeeds({
    repos: boundedQueries.privateRepos,
    paths,
    runId,
    token,
    gitRunner: deps.gitRunner,
  });

  writeSeedMap(paths, {
    version: BOUNDED_QUERY_SEED_MAP_VERSION,
    runId: staging.runId,
    seeds: staging.seeds.map((seed) => ({
      repo: seed.repoKey,
      seedId: seed.seedId,
      sensitivity: seed.sensitivity,
    })),
  });

  writeBoundedQuerySkill(paths, {
    repos: boundedQueries.privateRepos,
    timeoutSeconds: boundedQueries.timeout,
    maxInvocations: boundedQueries.maxInvocations,
  });

  logger.info(
    `Bounded queries: staged ${staging.seeds.length} immutable seed(s); staging credential discarded.`,
  );
}

/** Reads back the run id recorded during staging, if it is still available. */
function readRunId(paths: BoundedQueryPaths): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8')) as BoundedQuerySeedMap;
    return typeof parsed.runId === 'string' && parsed.runId.length > 0 ? parsed.runId : undefined;
  } catch {
    return undefined;
  }
}

/** Force-removes any query container still labelled with this run. */
async function removeOrphanQueryContainers(runId: string): Promise<void> {
  const filter = `label=${BOUNDED_QUERY_RUN_LABEL}=${runId}`;
  const listed = await execa('docker', ['ps', '-aq', '--filter', filter], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 30_000,
  });
  if (listed.exitCode !== 0) return;

  const ids = listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return;

  logger.debug(`Bounded queries: removing ${ids.length} orphaned query container(s)`);
  await execa('docker', ['rm', '-f', ...ids], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 60_000,
  });
}

/**
 * Tears down bounded-query state.
 *
 * Orphaned query containers are always removed: they are ephemeral, hold a
 * private copy of repository contents, and are never useful for debugging.
 *
 * Restoring seed permissions is skipped under `--keep-containers`, where the
 * caller explicitly asked to preserve the run's state for inspection. When it
 * does run, it must run before AWF's generic work-directory cleanup: seeds are
 * deliberately read-only, and `rm -rf` cannot unlink entries inside a
 * directory whose write bit was stripped.
 */
export async function teardownBoundedQueries(config: WrapperConfig): Promise<void> {
  if (!isBoundedQueriesEnabled(config)) return;

  const paths = resolveBoundedQueryPaths(config.workDir);
  if (!fs.existsSync(paths.root)) return;

  const runId = readRunId(paths);
  if (runId) {
    try {
      await removeOrphanQueryContainers(runId);
    } catch (error) {
      logger.warn('Bounded queries: failed to remove orphaned query containers', error);
    }
  }

  if (config.keepContainers) {
    logger.info(`Bounded-query seeds preserved (read-only) at: ${paths.seedsDir}`);
    return;
  }

  try {
    releaseSeedPermissions(paths.seedsDir);
  } catch (error) {
    logger.warn('Bounded queries: failed to restore seed permissions before cleanup', error);
  }
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const managerTestHelpers = {
  prepareDirectories,
  writeSeedMap,
  readRunId,
  removeOrphanQueryContainers,
};
