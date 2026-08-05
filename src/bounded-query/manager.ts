import * as fs from 'fs';
import * as crypto from 'crypto';
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
import {
  assertPrimaryRuntimeAvailable,
  assertQueryRuntimeAvailable,
  validateBoundedQueryConfig,
} from './preflight';
import { writeBoundedQuerySkill } from './skill';
import { writeBoundedQueryWrapper } from './wrapper-artifact';
import { releaseSeedPermissions, resolveStagingToken, stageBoundedQuerySeeds, type GitRunner } from './staging';
import {
  BOUNDED_QUERY_SEED_MAP_VERSION,
  serializePrivateRepositorySeedMap,
  type BoundedQuerySeedMap,
} from './types';
import { assertBoundedQueryPrivateRootIsolated } from './mount-policy';
import { fixArtifactPermissionsForRootless } from '../artifact-permissions';
import { runtimeUsesComposeAgent } from '../container-runtime';
import { probeSbxUnixSocketMount } from '../sbx-manager';
import {
  resolveBoundedQueryPrimaryBackend,
  serializeBoundedQueryRuntimeTelemetry,
} from './runtime-matrix';
import {
  type SbxIngressCapabilities,
  writeSbxIngressCapabilitiesFile,
} from '../bounded-execution/sbx-ingress-capabilities';

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
 * `teardownBoundedQueries` removes orphaned query containers and the separate
 * broker-private host root.
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
 * The private root is created without `recursive` so a pre-existing path,
 * including a symlink planted between preflight and creation, fails closed.
 */
function prepareDirectories(paths: BoundedQueryPaths): void {
  fs.mkdirSync(paths.root, { mode: 0o700 });
  fs.mkdirSync(paths.ingressRoot, { mode: 0o700 });
  ensureModeDirectory(paths.seedsDir, 0o700);
  ensureModeDirectory(paths.workDir, 0o700);
  ensureModeDirectory(paths.controlDir, 0o700);
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

interface RemovePrivateStateDeps {
  removeTree?: (target: string) => void;
  repairPermissions?: typeof fixArtifactPermissionsForRootless;
}

function removePrivateState(
  config: WrapperConfig,
  paths: BoundedQueryPaths,
  deps: RemovePrivateStateDeps = {},
): void {
  const removeTree = deps.removeTree ?? ((target: string) => {
    fs.rmSync(target, { recursive: true, force: true });
  });
  const repairPermissions = deps.repairPermissions ?? fixArtifactPermissionsForRootless;

  try {
    removeTree(paths.root);
    removeTree(paths.ingressRoot);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
      logger.debug('Bounded queries: repairing rootless private-state permissions before cleanup');
      repairPermissions(
        [paths.root, paths.ingressRoot],
        config.dockerHostPathPrefix,
        config.imageRegistry,
        config.imageTag,
        config.agentImage,
      );
      try {
        removeTree(paths.root);
        removeTree(paths.ingressRoot);
      } catch (retryError) {
        logger.warn('Bounded queries: failed to remove private state after permission repair', retryError);
      }
      return;
    }
    logger.warn('Bounded queries: failed to remove private state during cleanup', error);
  }
}

/** Writes the broker's repo → opaque seed map. */
function writeSeedMap(paths: BoundedQueryPaths, seedMap: BoundedQuerySeedMap): void {
  const content = serializePrivateRepositorySeedMap(seedMap);
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
  /** Override the sbx Unix-socket passthrough probe (tests). */
  probeSbxUnixSocket?: () => Promise<boolean>;
  /** Override query-runtime capability preflight (tests). */
  assertRuntimeAvailable?: typeof assertQueryRuntimeAvailable;
  /** Override primary-runtime capability preflight (tests). */
  assertPrimaryAvailable?: typeof assertPrimaryRuntimeAvailable;
}

function writeSbxIngressCapabilities(paths: BoundedQueryPaths): void {
  const capabilities: SbxIngressCapabilities = {
    version: 1,
    query: crypto.randomBytes(32).toString('hex'),
    probe: crypto.randomBytes(32).toString('hex'),
  };
  writeSbxIngressCapabilitiesFile(paths.capabilityPath, capabilities);
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

  const primaryBackend = resolveBoundedQueryPrimaryBackend(config.containerRuntime);
  const telemetryBase = {
    primaryBackend,
    queryBackend: boundedQueries.runtime,
    lifecycleClass: 'preflight' as const,
  };
  const assertRuntimeAvailable = deps.assertRuntimeAvailable ?? assertQueryRuntimeAvailable;
  const assertPrimaryAvailable = deps.assertPrimaryAvailable ?? assertPrimaryRuntimeAvailable;
  try {
    await assertPrimaryAvailable(config.containerRuntime);
  } catch (error) {
    logger.info(
      `Bounded-query runtime telemetry: ${serializeBoundedQueryRuntimeTelemetry({
        ...telemetryBase,
        capabilityState: 'unavailable',
        category: 'primary-runtime-unavailable',
      })}`,
    );
    throw error;
  }
  try {
    await assertRuntimeAvailable(boundedQueries);
  } catch (error) {
    logger.info(
      `Bounded-query runtime telemetry: ${serializeBoundedQueryRuntimeTelemetry({
        ...telemetryBase,
        capabilityState: boundedQueries.runtime === 'sbx' ? 'blocked' : 'unavailable',
        category: boundedQueries.runtime === 'sbx' ? 'query-security-block' : 'query-runtime-unavailable',
      })}`,
    );
    throw error;
  }
  logger.info(
    `Bounded-query runtime telemetry: ${serializeBoundedQueryRuntimeTelemetry({
      ...telemetryBase,
      capabilityState: 'supported',
      category: 'ready',
    })}`,
  );

  if (runtimeUsesComposeAgent(config.containerRuntime)) {
    config.boundedQueryIngressTransport = 'unix';
  } else {
    const probe = deps.probeSbxUnixSocket ?? probeSbxUnixSocketMount;
    config.boundedQueryIngressTransport = (await probe()) ? 'unix' : 'sbx-http';
  }

  const paths = resolveBoundedQueryPaths(config.workDir);
  assertBoundedQueryPrivateRootIsolated(config, paths, env);

  const token = resolveStagingToken(env);
  if (!token) {
    // Already covered by validateBoundedQueryConfig; re-checked so the token is
    // never `undefined!`-asserted into the staging call.
    throw new Error('Bounded-query staging credential disappeared between validation and staging');
  }

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
  if (config.boundedQueryIngressTransport === 'sbx-http') {
    writeSbxIngressCapabilities(paths);
  }

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
  writeBoundedQueryWrapper(paths);

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
  if (!fs.existsSync(paths.root)) {
    if (!config.keepContainers) {
      fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    }
    return;
  }

  const runId = readRunId(paths);
  if (runId) {
    try {
      await removeOrphanQueryContainers(runId);
    } catch (error) {
      logger.warn('Bounded queries: failed to remove orphaned query containers', error);
    }
  }

  if (config.keepContainers) {
    logger.info(`Bounded-query private state preserved at: ${paths.root}`);
    logger.info(`Bounded-query agent ingress preserved at: ${paths.ingressRoot}`);
    return;
  }

  try {
    releaseSeedPermissions(paths.seedsDir);
  } catch (error) {
    logger.warn('Bounded queries: failed to restore seed permissions before cleanup', error);
  }

  removePrivateState(config, paths);
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const managerTestHelpers = {
  prepareDirectories,
  writeSeedMap,
  readRunId,
  removeOrphanQueryContainers,
  removePrivateState,
  writeSbxIngressCapabilities,
};
