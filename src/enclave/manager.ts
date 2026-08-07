import * as fs from 'fs';
import execa from 'execa';
import { fixArtifactPermissionsForRootless } from '../artifact-permissions';
import {
  PRIVATE_REPOSITORY_SEED_MAP_VERSION,
  serializePrivateRepositorySeedMap,
  type PrivateRepositorySeedMap,
} from '../bounded-execution';
import { releaseSeedPermissions, resolveStagingToken, stageEnclaveSeeds, type GitRunner } from './staging';
import { getLocalDockerEnv } from '../host-env';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { logger } from '../logger';
import type { WrapperConfig } from '../types';
import type {
  EnclaveAgentExecutorConfig,
  EnclaveScriptExecutorConfig,
} from '../types/enclave-options';
import { assertPrivateRootIsolated } from './mount-policy';
import {
  assertAgentRuntimeAvailable,
  assertPrimaryRuntimeAvailable,
  assertScriptRuntimeAvailable,
} from './runtime-preflight';
import { validateEnclavesConfig } from './preflight';
import { generateEnclaveRunId, resolveEnclavePaths, type EnclavePaths } from './paths';
import {
  ENCLAVE_MCP_CAPABILITY_ENV,
  resolveEnclaveGatewayContract,
} from './gateway';

export const ENCLAVE_RUN_LABEL = 'awf.enclave.run';

export function isEnclaveScriptEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true && config.enclaves.executors.script.enabled === true;
}

export function isEnclaveAgentEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true && config.enclaves.executors.agent.enabled === true;
}

export function isEnclavesEnabled(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true;
}

function ensureDirectory(target: string, mode: number): void {
  fs.mkdirSync(target, { recursive: true, mode });
  fs.chmodSync(target, mode);
}

function prepareDirectories(
  paths: EnclavePaths,
  chown: typeof fs.chownSync = fs.chownSync,
): void {
  fs.mkdirSync(paths.root, { mode: 0o700 });
  fs.mkdirSync(paths.ingressRoot, { mode: 0o700 });
  ensureDirectory(paths.seedsDir, 0o700);
  ensureDirectory(paths.workDir, 0o700);
  ensureDirectory(paths.controlDir, 0o700);
  ensureDirectory(paths.auditDir, 0o700);
  ensureDirectory(paths.apiProxyLogsDir, 0o700);
  ensureDirectory(paths.runDir, 0o770);
  if (process.getuid?.() === 0) {
    const hostUid = parseInt(getSafeHostUid(), 10);
    const hostGid = parseInt(getSafeHostGid(), 10);
    chown(paths.runDir, hostUid, hostGid);
    chown(paths.apiProxyLogsDir, hostUid, hostGid);
  }
}

function writeExclusive(target: string, content: string, mode: number): void {
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode,
  );
  try {
    fs.writeSync(fd, content);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

export interface PrepareEnclavesDeps {
  gitRunner?: GitRunner;
  env?: NodeJS.ProcessEnv;
  assertScriptRuntimeAvailable?: (config: EnclaveScriptExecutorConfig) => Promise<void>;
  assertAgentRuntimeAvailable?: (config: EnclaveAgentExecutorConfig) => Promise<void>;
  assertPrimaryAvailable?: typeof assertPrimaryRuntimeAvailable;
}

export async function prepareEnclaves(
  config: WrapperConfig,
  deps: PrepareEnclavesDeps = {},
): Promise<void> {
  if (!isEnclavesEnabled(config)) return;
  const enclaves = config.enclaves!;
  const env = deps.env ?? process.env;
  const errors = validateEnclavesConfig(config);
  try {
    const gateway = resolveEnclaveGatewayContract(config, env);
    if (!config.networkIsolation) {
      errors.push('enclaves require networkIsolation so the externally launched gateway is attachable');
    }
    if (!config.topologyAttach?.includes(gateway.containerName)) {
      errors.push(
        `enclaves require topologyAttach to include the trusted gateway container "${gateway.containerName}"`,
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'enclave gateway handoff is invalid');
  }
  if (enclaves.executors.script.enabled && enclaves.executors.script.runtime === 'sbx') {
    errors.push('enclaves.executors.script.runtime "sbx" is not implemented and never falls back');
  }
  if (enclaves.executors.agent.enabled && enclaves.executors.agent.runtime === 'sbx') {
    errors.push(
      'enclaves.executors.agent.runtime "sbx" is not implemented: the installed sbx runtime cannot ' +
      'prove every mandatory enclave-isolation control, and enclaves never fall back to Docker or gVisor',
    );
  }
  const dockerHost = config.awfDockerHost ?? env.DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith('unix://')) {
    errors.push(
      'enclave execution requires a Unix-socket Docker host because the enclave MCP server has no network',
    );
  }
  const token = resolveStagingToken(env);
  if (!token) {
    errors.push('enclaves require a staging credential in GH_TOKEN or GITHUB_TOKEN on the AWF host');
  }
  if (errors.length > 0) {
    throw new Error(`Enclave configuration is invalid:\n  - ${errors.join('\n  - ')}`);
  }
  if (!token) {
    throw new Error('Enclave staging credential disappeared during preflight');
  }

  await (deps.assertPrimaryAvailable ?? assertPrimaryRuntimeAvailable)(config.containerRuntime);
  if (enclaves.executors.script.enabled) {
    const assertScriptRuntime = deps.assertScriptRuntimeAvailable ?? assertScriptRuntimeAvailable;
    await assertScriptRuntime(enclaves.executors.script);
  }
  if (enclaves.executors.agent.enabled) {
    const assertAgentRuntime = deps.assertAgentRuntimeAvailable ?? assertAgentRuntimeAvailable;
    await assertAgentRuntime(enclaves.executors.agent);
  }

  const paths = resolveEnclavePaths(config.workDir);
  assertPrivateRootIsolated(config, paths, env, process.cwd(), 'enclave');
  try {
    const workDirStat = fs.lstatSync(config.workDir);
    if (workDirStat.isSymbolicLink()) {
      throw new Error(`Refusing to stage into a symlink work directory: ${config.workDir}`);
    }
  } catch (error: unknown) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  prepareDirectories(paths);

  const runId = generateEnclaveRunId();
  const staging = await stageEnclaveSeeds({
    repos: enclaves.privateRepos,
    paths,
    runId,
    token,
    gitRunner: deps.gitRunner,
    label: 'Enclaves',
  });
  const seedMap: PrivateRepositorySeedMap = {
    version: PRIVATE_REPOSITORY_SEED_MAP_VERSION,
    runId: staging.runId,
    seeds: staging.seeds.map((seed) => ({
      repo: seed.repoKey,
      seedId: seed.seedId,
      sensitivity: seed.sensitivity,
    })),
  };
  writeExclusive(paths.seedMapPath, serializePrivateRepositorySeedMap(seedMap), 0o600);
  writeExclusive(paths.capabilityPath, `${env[ENCLAVE_MCP_CAPABILITY_ENV]}\n`, 0o600);
  logger.info(`Enclaves: staged ${staging.seeds.length} immutable seed(s); staging credential discarded.`);
}

function readRunId(paths: EnclavePaths): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8')) as PrivateRepositorySeedMap;
    return typeof parsed.runId === 'string' && parsed.runId.length > 0 ? parsed.runId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes every orphaned enclave container for this run.
 *
 * Script and agent enclaves share the `awf.enclave.run` label, so one pass
 * reconciles both executors without AWF having to know which one created a
 * container.
 */
async function removeOrphanEnclaveContainers(runId: string): Promise<void> {
  const listed = await execa('docker', ['ps', '-aq', '--filter', `label=${ENCLAVE_RUN_LABEL}=${runId}`], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 30_000,
  });
  if (listed.exitCode !== 0) {
    throw new Error('Failed to list orphaned enclave containers');
  }
  const ids = listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0) return;
  const removed = await execa('docker', ['rm', '-f', ...ids], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 60_000,
  });
  if (removed.exitCode !== 0) {
    throw new Error('Failed to remove orphaned enclave containers');
  }
}

function removePrivateState(config: WrapperConfig, paths: EnclavePaths): void {
  try {
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
      fixArtifactPermissionsForRootless(
        [paths.root, paths.ingressRoot],
        config.dockerHostPathPrefix,
        config.imageRegistry,
        config.imageTag,
        config.agentImage,
      );
      fs.rmSync(paths.root, { recursive: true, force: true });
      fs.rmSync(paths.ingressRoot, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

export async function teardownEnclaves(config: WrapperConfig): Promise<void> {
  if (!isEnclavesEnabled(config)) return;
  const paths = resolveEnclavePaths(config.workDir);
  const runId = readRunId(paths);
  if (runId) {
    await removeOrphanEnclaveContainers(runId);
  }
  if (config.keepContainers) {
    logger.info(`Enclave private state preserved at: ${paths.root}`);
    logger.info(`Enclave MCP control endpoint preserved at: ${paths.ingressRoot}`);
    return;
  }
  try {
    releaseSeedPermissions(paths.seedsDir);
  } catch (error) {
    logger.warn('Enclaves: failed to restore seed permissions before cleanup', error);
  }
  removePrivateState(config, paths);
}

export const enclaveManagerTestHelpers = {
  prepareDirectories,
  readRunId,
  removeOrphanEnclaveContainers,
};
