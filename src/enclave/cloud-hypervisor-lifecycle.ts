import * as fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { PRIVATE_REPOSITORY_SEED_MAP_VERSION, type PrivateRepositorySeedMap } from '../bounded-execution';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';
import type { CloudHypervisorManagerDependencies } from '../cloud-hypervisor/manager-types';
import type {
  HostEnclaveExecutorDependencies,
  HostExecutorAgentPolicy,
} from '../cloud-hypervisor/host-enclave-executor';
import {
  startCloudHypervisorEnclaveHostService,
  type CloudHypervisorEnclaveHostServiceOptions,
} from './cloud-hypervisor-host-service';
import type { HostExecutorRunState, HostExecutorServer } from './host-executor-server';
import { deriveEnclaveSeedId, readEnclaveRunId, resolveEnclavePaths, type EnclavePaths } from './paths';
import { validateEnclavesConfig } from './preflight';

export const CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED =
  'Cloud Hypervisor enclaves require the trusted hard-bounded writable-storage provider (#9394); '
  + 'it is not installed. No listener or VM is started; enclaves never fall back.';

/**
 * Trusted host integration boundary for #9394, not a config/env feature flag.
 * The provider must enforce aggregate per-invocation capacity (script 1 GiB,
 * agent 512 MiB, from CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES) across ALL
 * writable exports/storage, including sparse files and concurrent writers,
 * artifact/rootfs snapshots, and runtime state. Enforcement precedes
 * host/artifact resource creation and remains until close succeeds.
 * A capacity check, sparse-file size, or invocation/guest tmpfs alone is insufficient.
 */
export interface TrustedCloudHypervisorEnclaveStorageProvider {
  assertAvailable(config: WrapperConfig): Promise<void>;
  prepareRun(options: CloudHypervisorEnclaveHostServiceOptions): Promise<{
    readonly backendDependencies?: Partial<HostEnclaveExecutorDependencies>;
    readonly managerDependencies?: CloudHypervisorManagerDependencies;
    close(): Promise<void>;
  }>;
}

export function isCloudHypervisorEnclaveSelected(config: WrapperConfig): boolean {
  return config.enclaves?.enabled === true
    && Object.values(config.enclaves.executors)
      .some((entry) => entry.enabled && entry.runtime === 'cloud-hypervisor');
}

export async function assertCloudHypervisorEnclavePrerequisites(
  config: WrapperConfig,
  storageProvider?: TrustedCloudHypervisorEnclaveStorageProvider,
): Promise<void> {
  if (!isCloudHypervisorEnclaveSelected(config)) return;
  if (!storageProvider) throw new Error(CLOUD_HYPERVISOR_ENCLAVE_STORAGE_REQUIRED);
  await storageProvider.assertAvailable(config);
}

export function deriveCloudHypervisorEnclaveRunState(
  config: WrapperConfig,
  paths: EnclavePaths,
): HostExecutorRunState {
  const errors = validateEnclavesConfig(config, { requireDelegationHandoff: false });
  if (errors.length || !isCloudHypervisorEnclaveSelected(config)) {
    throw new Error(`Invalid trusted Cloud Hypervisor enclave configuration: ${errors.join('; ')}`);
  }
  const runId = readEnclaveRunId(paths);
  if (!runId) throw new Error('Cloud Hypervisor enclaves require a staged trusted run ID');
  const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8')) as PrivateRepositorySeedMap;
  if (seedMap.version !== PRIVATE_REPOSITORY_SEED_MAP_VERSION
    || seedMap.runId !== runId || !Array.isArray(seedMap.seeds)) {
    throw new Error('Cloud Hypervisor enclave seed map does not match the trusted run');
  }
  const catalog = new Map(config.enclaves!.privateRepos.map((repo) => [
    normalizePrivateRepositoryKey(repo.repo), repo,
  ]));
  const seeds = new Map<string, string>();
  for (const seed of seedMap.seeds) {
    const repo = catalog.get(seed.repo);
    if (!repo || seeds.has(seed.repo) || seed.sensitivity !== repo.sensitivity
      || seed.seedId !== deriveEnclaveSeedId(runId, seed.repo)) {
      throw new Error('Cloud Hypervisor enclave seed map differs from the validated catalog');
    }
    const stat = fs.lstatSync(path.join(paths.seedsDir, seed.seedId));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Cloud Hypervisor enclave seeds must be staged real directories');
    }
    seeds.set(seed.repo, seed.seedId);
  }
  if (seeds.size !== catalog.size) throw new Error('Cloud Hypervisor enclave seed catalog is incomplete');
  return {
    runId,
    seedsDir: paths.seedsDir,
    invocationsDir: path.join(path.dirname(paths.hostExecutorJournalDir), 'host-invocations', runId),
    journalDir: paths.hostExecutorJournalDir,
    entries: Object.entries(config.enclaves!.executors)
      .filter(([, entry]) => entry.enabled)
      .map(([entryId, entry]) => ({
        entryId,
        executorKind: entryId as 'script' | 'agent',
        timeoutMs: entry.timeout * 1000,
        staticSeedIds: config.enclaves!.privateRepos.map((repo) => {
          const seed = seeds.get(normalizePrivateRepositoryKey(repo.repo));
          if (!seed) throw new Error('Cloud Hypervisor enclave entry references an unstaged repository');
          return seed;
        }),
        dynamicAgents: false,
      })),
  };
}

function deriveAgentPolicies(
  config: WrapperConfig,
): Readonly<Record<string, HostExecutorAgentPolicy>> {
  const agent = config.enclaves!.executors.agent;
  if (!agent.enabled) return {};
  return {
    agent: Object.freeze({
      model: agent.model,
      profile: agent.profile,
      maxOutputBytes: agent.maxOutputBytes,
      maxModelRequests: agent.maxModelRequests,
      maxModelTokens: agent.maxModelTokens,
    }),
  };
}

interface RunLifecycle {
  configuration: WrapperConfig;
  runId: string;
  server?: HostExecutorServer;
  storage?: Awaited<ReturnType<TrustedCloudHypervisorEnclaveStorageProvider['prepareRun']>>;
  failed?: boolean;
  closePromise?: Promise<void>;
  startPromise?: Promise<void>;
  draining?: boolean;
}
const runs = new Map<string, RunLifecycle>();
const completedRuns = new Map<string, string>();

export async function startCloudHypervisorEnclaveLifecycle(
  config: WrapperConfig,
  storageProvider: TrustedCloudHypervisorEnclaveStorageProvider,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = resolveEnclavePaths(config.workDir);
  if (runs.has(paths.root)) throw new Error('Cloud Hypervisor enclave host executor already exists for this run');
  if (!config.cloudHypervisor) throw new Error('Cloud Hypervisor enclave runtime configuration is missing');
  const options: CloudHypervisorEnclaveHostServiceOptions = {
    runtimeDir: paths.hostExecutorDir,
    runState: deriveCloudHypervisorEnclaveRunState(config, paths),
    config: config.cloudHypervisor,
    workDir: paths.workDir,
    agentPolicies: deriveAgentPolicies(config),
    environment,
  };
  const run: RunLifecycle = { configuration: config, runId: options.runState.runId };
  runs.set(paths.root, run);
  run.startPromise = (async () => {
    try {
      await assertCloudHypervisorEnclavePrerequisites(config, storageProvider);
      run.storage = await storageProvider.prepareRun(options);
      run.server = await startCloudHypervisorEnclaveHostService({
        ...options,
        backendDependencies: run.storage.backendDependencies,
        managerDependencies: run.storage.managerDependencies,
      });
      if (run.draining) run.server.closeAdmissions();
    } catch (error) {
      run.failed = true;
      throw error;
    }
  })();
  await run.startPromise;
}

export function closeCloudHypervisorEnclaveAdmissions(config: WrapperConfig): void {
  const run = runs.get(resolveEnclavePaths(config.workDir).root);
  if (!run) return;
  run.draining = true;
  run.server?.closeAdmissions();
}

export function assertCloudHypervisorEnclaveLifecycleReady(config: WrapperConfig): Promise<void> {
  const run = runs.get(resolveEnclavePaths(config.workDir).root);
  return run?.configuration === config && run.server && !run.failed && !run.draining && !run.closePromise
    ? Promise.resolve()
    : Promise.reject(new Error('Cloud Hypervisor enclave trusted full preflight has not completed'));
}

function assertRecoveryComplete(paths: EnclavePaths, runId: string): void {
  if (!fs.existsSync(paths.hostExecutorJournalDir)) return;
  const stat = fs.lstatSync(paths.hostExecutorJournalDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Unsafe Cloud Hypervisor enclave recovery directory; private state is preserved');
  }
  for (const file of fs.readdirSync(paths.hostExecutorJournalDir)) {
    if (file !== `${runId}.journal` && !file.startsWith(`${runId}-`)) continue;
    if (file !== `${runId}.journal` && !file.endsWith('.resources.json')) {
      throw new Error('Cloud Hypervisor enclave resource cleanup is pending; recovery journals are preserved');
    }
    const fd = fs.openSync(path.join(paths.hostExecutorJournalDir, file),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const journalStat = fs.fstatSync(fd);
      if (!journalStat.isFile() || journalStat.uid !== process.getuid?.()
        || (journalStat.mode & 0o777) !== 0o600 || journalStat.size > 32 * 1024 * 1024) {
        throw new Error('Cloud Hypervisor enclave recovery journal is unsafe; private state is preserved');
      }
      const content = fs.readFileSync(fd, 'utf8');
      const complete = file.endsWith('.resources.json')
        ? (() => {
          const record = JSON.parse(content) as { runId?: unknown; state?: unknown };
          return record.runId === runId && record.state === 'cleaned';
        })()
        : content.endsWith('{"state":"closed"}\n') && !content.includes('"state":"cleanup-pending"');
      if (!complete) {
        throw new Error('Cloud Hypervisor enclave cleanup is uncertain; recovery journals are preserved');
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

export async function stopCloudHypervisorEnclaveLifecycle(config: WrapperConfig): Promise<void> {
  const paths = resolveEnclavePaths(config.workDir);
  const run = runs.get(paths.root);
  if (!run && !config.enclaves?.enabled) return;
  if (!run) {
    // A restarted host must not delete resource recovery records it did not reap.
    const runId = readEnclaveRunId(paths);
    if (runId && completedRuns.get(paths.root) === runId) return;
    if (runId && fs.existsSync(paths.hostExecutorJournalDir)
      && fs.readdirSync(paths.hostExecutorJournalDir)
        .some((file) => file === `${runId}.journal` || file.startsWith(`${runId}-`))) {
      throw new Error('Cloud Hypervisor enclave recovery journals require trusted reconciliation before cleanup');
    }
    if (!runId && isCloudHypervisorEnclaveSelected(config) && fs.existsSync(paths.root)) {
      throw new Error('Cloud Hypervisor enclave run identity is missing; private recovery state is preserved');
    }
    return;
  }
  closeCloudHypervisorEnclaveAdmissions(config);
  run.closePromise ??= (async () => {
    await run.startPromise?.catch(() => undefined);
    await run.server?.close();
    assertRecoveryComplete(paths, run.runId);
    if (run.failed) throw new Error('Cloud Hypervisor enclave startup failed; private recovery state is preserved');
    await run.storage?.close();
    completedRuns.set(paths.root, run.runId);
    runs.delete(paths.root);
  })();
  await run.closePromise;
}
