import * as fs from 'fs';
import * as crypto from 'crypto';
import execa from 'execa';
import { logger } from '../logger';
import { getLocalDockerEnv } from '../host-env';
import { getSafeHostUid, getSafeHostGid } from '../host-identity';
import type { WrapperConfig } from '../types';
import {
  generateBoundedAgentRunId,
  resolveBoundedAgentPaths,
  type BoundedAgentPaths,
} from './paths';
import {
  assertEnclaveRuntimeAvailable,
  assertPrimaryRuntimeAvailable,
  validateBoundedAgentConfig,
} from './preflight';
import { writeBoundedAgentSkill } from './skill';
import { writeBoundedAgentWrapper } from './wrapper-artifact';
import { releaseSeedPermissions, resolveStagingToken, stageBoundedAgentSeeds, type GitRunner } from './staging';
import {
  PRIVATE_REPOSITORY_SEED_MAP_VERSION,
  serializePrivateRepositorySeedMap,
  type PrivateRepositorySeedMap,
} from '../bounded-execution/repository-staging';
import { assertBoundedAgentPrivateRootIsolated } from './mount-policy';
import { fixArtifactPermissionsForRootless } from '../artifact-permissions';
import { runtimeUsesComposeAgent } from '../container-runtime';
import { probeSbxUnixSocketMount } from '../sbx-manager';
import {
  resolveBoundedAgentPrimaryBackend,
  serializeBoundedAgentRuntimeTelemetry,
} from './runtime-matrix';

/**
 * Bounded-agent lifecycle orchestration.
 *
 * `prepareBoundedAgents` runs entirely on the trusted AWF host **before** any
 * configuration is generated or any container is started, so that:
 *
 * - the primary agent never starts when preflight or staging fails;
 * - the staging credential is consumed and discarded before the broker, the
 *   agent, and any enclave exist;
 * - compose generation can rely on the on-disk layout already being present.
 *
 * `teardownBoundedAgents` deterministically removes orphaned enclave
 * containers (matched by this run's Docker label) and the separate
 * broker-private host root.
 */

/** Docker label applied to every enclave container, used for orphan cleanup. */
export const BOUNDED_AGENT_RUN_LABEL = 'awf.bounded-agent.run';

/** Returns true when this run must stage seeds and start the bounded-agent broker. */
export function isBoundedAgentsEnabled(config: WrapperConfig): boolean {
  return config.boundedAgents?.enabled === true;
}

/** Creates a directory with an exact mode, independent of the process umask. */
function ensureModeDirectory(target: string, mode: number): void {
  fs.mkdirSync(target, { recursive: true, mode });
  fs.chmodSync(target, mode);
}

/**
 * Creates the bounded-agent directory layout.
 *
 * The private root is created without `recursive` so a pre-existing path,
 * including a symlink planted between preflight and creation, fails closed.
 */
function prepareDirectories(
  paths: BoundedAgentPaths,
  chown: typeof fs.chownSync = fs.chownSync,
): void {
  fs.mkdirSync(paths.root, { mode: 0o700 });
  fs.mkdirSync(paths.ingressRoot, { mode: 0o700 });
  ensureModeDirectory(paths.seedsDir, 0o700);
  ensureModeDirectory(paths.workDir, 0o700);
  ensureModeDirectory(paths.controlDir, 0o700);
  ensureModeDirectory(paths.auditDir, 0o700);
  ensureModeDirectory(paths.apiProxyLogsDir, 0o700);
  ensureModeDirectory(paths.runDir, 0o770);
  ensureModeDirectory(paths.agentDir, 0o755);

  // Under sudo these directories start root-owned. Hand the socket and private
  // proxy log directories to the non-root identity used by their containers.
  if (process.getuid?.() === 0) {
    const hostUid = parseInt(getSafeHostUid(), 10);
    const hostGid = parseInt(getSafeHostGid(), 10);
    chown(paths.runDir, hostUid, hostGid);
    chown(paths.apiProxyLogsDir, hostUid, hostGid);
  }
}

interface RemovePrivateStateDeps {
  removeTree?: (target: string) => void;
  repairPermissions?: typeof fixArtifactPermissionsForRootless;
}

function removePrivateState(
  config: WrapperConfig,
  paths: BoundedAgentPaths,
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
      logger.debug('Bounded agents: repairing rootless private-state permissions before cleanup');
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
        logger.warn('Bounded agents: failed to remove private state after permission repair', retryError);
      }
      return;
    }
    logger.warn('Bounded agents: failed to remove private state during cleanup', error);
  }
}

/** Writes the broker's repo → opaque seed map. */
function writeSeedMap(paths: BoundedAgentPaths, seedMap: PrivateRepositorySeedMap): void {
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

export interface PrepareBoundedAgentsDeps {
  /** Override the git runner (tests). */
  gitRunner?: GitRunner;
  /** Override the host environment the staging credential is read from. */
  env?: NodeJS.ProcessEnv;
  /** Override the sbx Unix-socket passthrough probe (tests). */
  probeSbxUnixSocket?: () => Promise<boolean>;
  /** Override enclave-runtime capability preflight (tests). */
  assertRuntimeAvailable?: typeof assertEnclaveRuntimeAvailable;
  /** Override primary-runtime capability preflight (tests). */
  assertPrimaryAvailable?: typeof assertPrimaryRuntimeAvailable;
}

interface SbxIngressCapabilities {
  version: 1;
  query: string;
  probe: string;
}

function writeSbxIngressCapabilities(paths: BoundedAgentPaths): void {
  const capabilities: SbxIngressCapabilities = {
    version: 1,
    query: crypto.randomBytes(32).toString('hex'),
    probe: crypto.randomBytes(32).toString('hex'),
  };
  const fd = fs.openSync(
    paths.capabilityPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeSync(fd, JSON.stringify(capabilities));
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Validates configuration, proves both the primary-agent runtime and the
 * enclave runtime are independently available, stages one immutable seed per
 * configured repository, and writes the broker/agent artifacts.
 *
 * Ordering is a security property: preflight runs *before* staging, so a run
 * that could never launch an enclave never clones a private repository, and
 * the staging credential is discarded before any container exists. Each
 * preflight axis is proven independently and neither ever falls back to a
 * weaker backend on failure; every terminal state is reported as narrow,
 * content-free runtime telemetry (backend names and capability state only —
 * never secrets, paths, prompts, repo names, or model payloads).
 *
 * Throws on any failure — the caller must abort the run.
 */
export async function prepareBoundedAgents(
  config: WrapperConfig,
  deps: PrepareBoundedAgentsDeps = {},
): Promise<void> {
  const boundedAgents = config.boundedAgents;
  if (!boundedAgents?.enabled) return;

  const env = deps.env ?? process.env;
  const errors = validateBoundedAgentConfig(config, env);
  if (errors.length > 0) {
    throw new Error(`Bounded-agent configuration is invalid:\n  - ${errors.join('\n  - ')}`);
  }

  const primaryBackend = resolveBoundedAgentPrimaryBackend(config.containerRuntime);
  const telemetryBase = {
    primaryBackend,
    boundedAgentBackend: boundedAgents.runtime,
    lifecycleClass: 'preflight' as const,
  };
  const assertRuntimeAvailable = deps.assertRuntimeAvailable ?? assertEnclaveRuntimeAvailable;
  const assertPrimaryAvailable = deps.assertPrimaryAvailable ?? assertPrimaryRuntimeAvailable;
  try {
    await assertPrimaryAvailable(config.containerRuntime);
  } catch (error) {
    logger.info(
      `Bounded-agent runtime telemetry: ${serializeBoundedAgentRuntimeTelemetry({
        ...telemetryBase,
        capabilityState: 'unavailable',
        category: 'primary-runtime-unavailable',
      })}`,
    );
    throw error;
  }
  try {
    await assertRuntimeAvailable(boundedAgents);
  } catch (error) {
    logger.info(
      `Bounded-agent runtime telemetry: ${serializeBoundedAgentRuntimeTelemetry({
        ...telemetryBase,
        capabilityState: boundedAgents.runtime === 'sbx' ? 'blocked' : 'unavailable',
        category: boundedAgents.runtime === 'sbx' ? 'enclave-security-block' : 'enclave-runtime-unavailable',
      })}`,
    );
    throw error;
  }
  if (runtimeUsesComposeAgent(config.containerRuntime)) {
    config.boundedAgentIngressTransport = 'unix';
    recordBoundedAgentRuntimeTelemetry(config, 'supported', 'ready');
  } else {
    const probe = deps.probeSbxUnixSocket ?? probeSbxUnixSocketMount;
    config.boundedAgentIngressTransport = (await probe()) ? 'unix' : 'sbx-http';
  }

  const paths = resolveBoundedAgentPaths(config.workDir);
  assertBoundedAgentPrivateRootIsolated(config, paths, env);

  const token = resolveStagingToken(env);
  if (!token) {
    // Already covered by validateBoundedAgentConfig; re-checked so the token is
    // never `undefined!`-asserted into the staging call.
    throw new Error('Bounded-agent staging credential disappeared between validation and staging');
  }

  // Guard against symlink injection before writing any credential-bearing state.
  try {
    const lstat = fs.lstatSync(config.workDir);
    if (lstat.isSymbolicLink()) {
      throw new Error(`Refusing to stage into a symlink work directory: ${config.workDir}`);
    }
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  prepareDirectories(paths);
  if (config.boundedAgentIngressTransport === 'sbx-http') {
    writeSbxIngressCapabilities(paths);
  }

  const runId = generateBoundedAgentRunId();
  const staging = await stageBoundedAgentSeeds({
    repos: boundedAgents.privateRepos,
    paths,
    runId,
    token,
    gitRunner: deps.gitRunner,
  });

  writeSeedMap(paths, {
    version: PRIVATE_REPOSITORY_SEED_MAP_VERSION,
    runId: staging.runId,
    seeds: staging.seeds.map((seed) => ({
      repo: seed.repoKey,
      seedId: seed.seedId,
      sensitivity: seed.sensitivity,
    })),
  });

  writeBoundedAgentSkill(paths, {
    repos: boundedAgents.privateRepos,
    timeoutSeconds: boundedAgents.timeout,
    maxInvocations: boundedAgents.maxInvocations,
    maxTaskBytes: boundedAgents.maxTaskBytes,
    profile: boundedAgents.profile,
    maxModelRequests: boundedAgents.maxModelRequests,
  });
  writeBoundedAgentWrapper(paths);

  logger.info(
    `Bounded agents: staged ${staging.seeds.length} immutable seed(s); staging credential discarded.`,
  );
}

/**
 * Records only the content-free runtime-matrix fields after ingress proof.
 *
 * Primary sbx callers invoke this after the actual primary sandbox completes
 * its Unix-socket or authenticated HTTP reachability exchange.
 */
export function recordBoundedAgentRuntimeTelemetry(
  config: WrapperConfig,
  capabilityState: 'supported' | 'unavailable' | 'blocked',
  category: string,
): void {
  if (!config.boundedAgents?.enabled) return;
  logger.info(
    `Bounded-agent runtime telemetry: ${serializeBoundedAgentRuntimeTelemetry({
      primaryBackend: resolveBoundedAgentPrimaryBackend(config.containerRuntime),
      boundedAgentBackend: config.boundedAgents.runtime,
      lifecycleClass: 'preflight',
      capabilityState,
      category,
    })}`,
  );
}

/** Reads back the run id recorded during staging, if it is still available. */
function readRunId(paths: BoundedAgentPaths): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8')) as PrivateRepositorySeedMap;
    return typeof parsed.runId === 'string' && parsed.runId.length > 0 ? parsed.runId : undefined;
  } catch {
    return undefined;
  }
}

/** Force-removes any enclave container still labelled with this run. */
async function removeOrphanEnclaveContainers(runId: string): Promise<void> {
  const filter = `label=${BOUNDED_AGENT_RUN_LABEL}=${runId}`;
  const listed = await execa('docker', ['ps', '-aq', '--filter', filter], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 30_000,
  });
  if (listed.exitCode !== 0) return;

  const ids = listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return;

  logger.debug(`Bounded agents: removing ${ids.length} orphaned enclave container(s)`);
  await execa('docker', ['rm', '-f', ...ids], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 60_000,
  });
}

/**
 * Tears down bounded-agent state.
 *
 * Orphaned enclave containers are always removed — including under
 * `--keep-containers` — because they are ephemeral, hold a private copy of
 * repository contents, and are never useful for debugging.
 *
 * Restoring seed permissions is skipped under `--keep-containers`. When it does
 * run, it must run before AWF's generic work-directory cleanup: seeds are
 * deliberately read-only, and `rm -rf` cannot unlink entries inside a directory
 * whose write bit was stripped.
 */
export async function teardownBoundedAgents(config: WrapperConfig): Promise<void> {
  if (!isBoundedAgentsEnabled(config)) return;

  const paths = resolveBoundedAgentPaths(config.workDir);
  if (!fs.existsSync(paths.root)) {
    if (!config.keepContainers) {
      fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
    }
    return;
  }

  const runId = readRunId(paths);
  if (runId) {
    try {
      await removeOrphanEnclaveContainers(runId);
    } catch (error) {
      logger.warn('Bounded agents: failed to remove orphaned enclave containers', error);
    }
  }

  if (config.keepContainers) {
    logger.info(`Bounded-agent private state preserved at: ${paths.root}`);
    logger.info(`Bounded-agent ingress preserved at: ${paths.ingressRoot}`);
    return;
  }

  try {
    releaseSeedPermissions(paths.seedsDir);
  } catch (error) {
    logger.warn('Bounded agents: failed to restore seed permissions before cleanup', error);
  }

  removePrivateState(config, paths);
}

/** @internal Exported for focused unit tests. */
// ts-prune-ignore-next
export const boundedAgentManagerTestHelpers = {
  prepareDirectories,
  writeSeedMap,
  readRunId,
  removeOrphanEnclaveContainers,
  removePrivateState,
  writeSbxIngressCapabilities,
};
