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
import { LOCAL_ENCLAVE_MCP_SERVER_IMAGE } from '../constants';
import type { WrapperConfig } from '../types';
import type {
  EnclaveAgentExecutorConfig,
  EnclaveScriptExecutorConfig,
} from '../types/enclave-options';
import { isEnclaveAgentGithubToolsEnabled } from '../types/enclave-options';
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
import {
  ENCLAVE_GITHUB_MCP_AGENT_ID_ENV,
  resolveEnclaveGithubGatewayContract,
} from './github-gateway';
import {
  resolveEnclaveDynamicDelegationHandoff,
  stageEnclaveDynamicDelegationHandoff,
  takeEnclaveDynamicDelegationHandoff,
} from './dynamic-delegation-handoff';
import {
  assertCloudHypervisorEnclavePrerequisites,
  isCloudHypervisorEnclaveSelected,
  startCloudHypervisorEnclaveLifecycle,
  stopCloudHypervisorEnclaveLifecycle,
  type TrustedCloudHypervisorEnclaveStorageProvider,
} from './cloud-hypervisor-lifecycle';
import { ProductionTrustedCloudHypervisorEnclaveStorageProvider } from '../cloud-hypervisor/trusted-enclave-storage';
import { HOST_EXECUTOR_STORAGE_ROOT } from './host-executor-journal';
import * as path from 'path';
import { updateEnclaveStartupProgress } from './startup-progress';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';

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

/** Whether this run's agent entry declares a dynamic repository policy. */
export function isEnclaveDynamicPolicyDeclared(config: WrapperConfig): boolean {
  return isEnclaveAgentEnabled(config) && config.enclaves?.executors.agent.dynamic !== undefined;
}

/**
 * Whether this run stages immutable seeds at all.
 *
 * A dynamic-only entry reads live GitHub through a per-invocation delegated
 * identity, so it needs no staging credential, no clone, no seed catalog, and
 * no `/awf/seed` mount. Mixed runs (a static entry beside a separate dynamic
 * entry) still stage the static catalog.
 */
export function isEnclaveSeedStagingRequired(config: WrapperConfig): boolean {
  return isEnclavesEnabled(config) && (config.enclaves?.privateRepos.length ?? 0) > 0;
}

export function isEnclaveGithubEnabled(config: WrapperConfig): boolean {
  return (
    isEnclaveAgentEnabled(config)
    && isEnclaveAgentGithubToolsEnabled(config.enclaves?.executors.agent)
  );
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
  // The image's fixed non-root user must create the audit stream through this
  // bind mount. The parent private root remains 0700 on the host.
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
  /** Trusted host integration only. No CLI/config/env switch can supply this provider. */
  cloudHypervisorStorageProvider?: TrustedCloudHypervisorEnclaveStorageProvider;
}

export async function prepareEnclaves(
  config: WrapperConfig,
  deps: PrepareEnclavesDeps = {},
): Promise<void> {
  if (!isEnclavesEnabled(config)) return;
  updateEnclaveStartupProgress(config, { stage: 'configuration' });
  const enclaves = config.enclaves!;
  const env = deps.env ?? process.env;
  const storageProvider = deps.cloudHypervisorStorageProvider ??
    new ProductionTrustedCloudHypervisorEnclaveStorageProvider();
  // Take custody of the compiler's AWF-only delegation handoff before anything
  // else can inherit this environment, on every run — including static-only
  // runs, where the values must simply be discarded.
  const delegationHandoff = resolveEnclaveDynamicDelegationHandoff(
    takeEnclaveDynamicDelegationHandoff(env),
  );
  const dynamicDeclared = isEnclaveDynamicPolicyDeclared(config);
  const errors = validateEnclavesConfig(config, {
    delegationHandoff,
    requireDelegationHandoff: dynamicDeclared,
  });
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
  const seedStagingRequired = isEnclaveSeedStagingRequired(config);
  if (seedStagingRequired && !token) {
    errors.push('enclaves require a staging credential in GH_TOKEN or GITHUB_TOKEN on the AWF host');
  }
  const githubAgentId = env[ENCLAVE_GITHUB_MCP_AGENT_ID_ENV] ?? '';
  if (isEnclaveGithubEnabled(config)) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(githubAgentId)) {
      errors.push(
        `${ENCLAVE_GITHUB_MCP_AGENT_ID_ENV} must contain the compiler-issued enclave gateway identity`,
      );
    }
  }
  if (isEnclaveGithubEnabled(config) || dynamicDeclared) {
    try {
      resolveEnclaveGithubGatewayContract(config, env);
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : 'enclave GitHub gateway handoff is invalid',
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Enclave configuration is invalid:\n  - ${errors.join('\n  - ')}`);
  }
  if (seedStagingRequired && !token) {
    throw new Error('Enclave staging credential disappeared during preflight');
  }

  const hostExecutorSelected = isCloudHypervisorEnclaveSelected(config);
  updateEnclaveStartupProgress(config, { stage: 'host-preflight' });
  if (hostExecutorSelected) {
    const hostPaths = resolveEnclavePaths(config.workDir);
    const report = new HostPreflightReporter('host-isolation', (hostPreflight) =>
      updateEnclaveStartupProgress(config, { hostPreflight }));
    for (const [root, label, check] of [
      [hostPaths.hostExecutorJournalDir, 'recovery journal', 'journal-isolation'],
      [path.join(path.dirname(hostPaths.hostExecutorJournalDir), 'host-invocations'), 'invocation mount points', 'invocation-isolation'],
      [HOST_EXECUTOR_STORAGE_ROOT, 'allocation domains', 'allocation-isolation'],
    ] as const) {
      await report.check(check, () => assertPrivateRootIsolated(config, {
        root, ingressRoot: hostPaths.ingressRoot,
      }, env, process.cwd(), `Cloud Hypervisor enclave ${label}`));
    }
  }
  await assertCloudHypervisorEnclavePrerequisites(config, storageProvider);
  updateEnclaveStartupProgress(config, { stage: 'runtime-preflight' });
  const runtimeChecks = new HostPreflightReporter('enclave-runtime', (hostPreflight) =>
    updateEnclaveStartupProgress(config, { hostPreflight }));
  if (!enclaves.executors.script.enabled) runtimeChecks.notRequired('script-runtime');
  if (!enclaves.executors.agent.enabled) runtimeChecks.notRequired('agent-runtime');
  if (!hostExecutorSelected) runtimeChecks.notRequired('host-service');
  if (config.containerRuntime === 'cloud-hypervisor') {
    // The external runtime preflights the primary VM before runMainWorkflow;
    // Cloud Hypervisor is not a Docker OCI runtime.
    runtimeChecks.notRequired('primary-runtime');
  } else {
    await runtimeChecks.check('primary-runtime', () =>
      (deps.assertPrimaryAvailable ?? assertPrimaryRuntimeAvailable)(config.containerRuntime));
  }
  if (enclaves.executors.script.enabled && !hostExecutorSelected) {
    const assertScriptRuntime = deps.assertScriptRuntimeAvailable ?? assertScriptRuntimeAvailable;
    await runtimeChecks.check('script-runtime', () => assertScriptRuntime(enclaves.executors.script));
  }
  if (enclaves.executors.agent.enabled && !hostExecutorSelected) {
    const assertAgentRuntime = deps.assertAgentRuntimeAvailable ?? assertAgentRuntimeAvailable;
    await runtimeChecks.check('agent-runtime', () => assertAgentRuntime(enclaves.executors.agent));
  }

  const paths = resolveEnclavePaths(config.workDir);
  updateEnclaveStartupProgress(config, { stage: 'seed-staging' });
  const storageChecks = new HostPreflightReporter('enclave-storage', (hostPreflight) =>
    updateEnclaveStartupProgress(config, { hostPreflight }));
  if (!seedStagingRequired) storageChecks.notRequired('seed-catalog');
  if (!isEnclaveGithubEnabled(config)) storageChecks.notRequired('github-identity');
  if (!(dynamicDeclared && delegationHandoff.handoff)) storageChecks.notRequired('delegation-custody');
  await storageChecks.check('private-root-isolation', () =>
    assertPrivateRootIsolated(config, paths, env, process.cwd(), 'enclave'));
  await storageChecks.check('work-directory', () => {
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
  });
  await storageChecks.check('directory-layout', () => prepareDirectories(paths));

  const runId = generateEnclaveRunId();
  await storageChecks.check('run-identity', () => writeExclusive(paths.runIdPath, `${runId}\n`, 0o600));
  if (seedStagingRequired) {
    await storageChecks.check('seed-catalog', async () => {
      const staging = await stageEnclaveSeeds({
        repos: enclaves.privateRepos,
        paths,
        runId,
        token: token!,
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
      logger.info(`Enclaves: staged ${staging.seeds.length} immutable seed(s); staging credential discarded.`);
    });
  } else {
    // Dynamic-only: no clone, no seed catalog, not even an empty one. The
    // broker mounts neither /awf/seed nor a seed map, and never sees a job
    // token.
    logger.info('Enclaves: dynamic-only entry; no repository seed is cloned, staged, or mounted.');
  }
  await storageChecks.check('capability-staging', () =>
    writeExclusive(paths.capabilityPath, `${env[ENCLAVE_MCP_CAPABILITY_ENV]}\n`, 0o600));
  if (isEnclaveGithubEnabled(config)) {
    await storageChecks.check('github-identity', () => {
      writeExclusive(paths.githubAgentIdPath, `${githubAgentId}\n`, 0o600);
      if (env === process.env) delete process.env[ENCLAVE_GITHUB_MCP_AGENT_ID_ENV];
    });
  }
  if (dynamicDeclared && delegationHandoff.handoff) {
    const handoff = delegationHandoff.handoff;
    await storageChecks.check('delegation-custody', () => {
      // AWF-private custody: exclusive 0600 files inside the 0700 private root,
      // never bind-mounted into the broker, the executor, the model sidecar, the
      // general MCP route, or the delegated data plane.
      stageEnclaveDynamicDelegationHandoff(paths, handoff);
      ensureDirectory(paths.delegationChannelDir, 0o700);
      logger.info(
        'Enclaves: took private custody of the mcpg delegation-control handoff for dynamic '
        + 'repository admission.',
      );
    });
  }
  if (hostExecutorSelected) {
    updateEnclaveStartupProgress(config, { stage: 'host-service' });
    await runtimeChecks.check('host-service', () => startCloudHypervisorEnclaveLifecycle(config, storageProvider, env));
    if (enclaves.executors.script.enabled) {
      await runtimeChecks.check('script-runtime', () =>
        assertScriptRuntimeAvailable(enclaves.executors.script, undefined, undefined, config));
    }
    if (enclaves.executors.agent.enabled) {
      await runtimeChecks.check('agent-runtime', () =>
        assertAgentRuntimeAvailable(enclaves.executors.agent, undefined, undefined, config));
    }
  }
}

function readRunId(paths: EnclavePaths): string | undefined {
  try {
    const raw = fs.readFileSync(paths.runIdPath, 'ascii').trim();
    if (/^[0-9a-f]{16,64}$/.test(raw)) return raw;
  } catch {
    // Fall through to the seed map, which older runs wrote instead.
  }
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

interface RemovePrivateStateDependencies {
  remove?: (target: string) => void;
  repair?: typeof fixArtifactPermissionsForRootless;
}

function removePrivateState(
  config: WrapperConfig,
  paths: EnclavePaths,
  dependencies: RemovePrivateStateDependencies = {},
): void {
  const remove = dependencies.remove
    ?? ((target: string) => fs.rmSync(target, { recursive: true, force: true }));
  const repair = dependencies.repair ?? fixArtifactPermissionsForRootless;
  try {
    remove(paths.root);
    remove(paths.ingressRoot);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
      const repaired = repair(
        [paths.root, paths.ingressRoot],
        config.dockerHostPathPrefix,
        config.imageRegistry,
        config.imageTag,
        config.agentImage,
        config.buildLocal ? LOCAL_ENCLAVE_MCP_SERVER_IMAGE : undefined,
      );
      if (!repaired) {
        throw new Error(
          `Enclaves: failed to repair private state permissions; ` +
          `manual cleanup is required for ${paths.root} and ${paths.ingressRoot}`,
        );
      }
      remove(paths.root);
      remove(paths.ingressRoot);
      return;
    }
    throw error;
  }
}

export async function teardownEnclaves(config: WrapperConfig): Promise<void> {
  if (!isEnclavesEnabled(config)) return;
  const paths = resolveEnclavePaths(config.workDir);
  await stopCloudHypervisorEnclaveLifecycle(config);
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
  removePrivateState,
  removeOrphanEnclaveContainers,
};
