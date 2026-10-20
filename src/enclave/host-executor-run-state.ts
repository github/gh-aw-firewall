import * as fs from 'fs';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import { PRIVATE_REPOSITORY_SEED_MAP_VERSION, type PrivateRepositorySeedMap } from '../bounded-execution';
import { normalizePrivateRepositoryKey } from '../bounded-execution/repository-staging';
import type { HostExecutorRunState } from './host-executor-server';
import { deriveEnclaveSeedId, readEnclaveRunId, type EnclavePaths } from './paths';
import { validateEnclavesStructure } from './preflight';
import { validateRunSandboxBackend } from './run-backend';

/** Derives static authority from the validated host catalog, never from invocation data. */
export function deriveHostExecutorRunState(
  config: WrapperConfig,
  paths: EnclavePaths,
  label = 'Host executor',
): HostExecutorRunState {
  if (!config.enclaves?.enabled) throw new Error(`Invalid trusted ${label} configuration: no executor`);
  const errors = [
    ...validateRunSandboxBackend(config.containerRuntime, config.enclaves),
    ...validateEnclavesStructure(config, { requireDelegationHandoff: false }),
  ];
  if (errors.length) {
    throw new Error(`Invalid trusted ${label} configuration: ${errors.join('; ')}`);
  }
  const runId = readEnclaveRunId(paths);
  if (!runId) throw new Error(`${label}s require a staged trusted run ID`);
  const seedMap = JSON.parse(fs.readFileSync(paths.seedMapPath, 'utf8')) as PrivateRepositorySeedMap;
  if (seedMap.version !== PRIVATE_REPOSITORY_SEED_MAP_VERSION
    || seedMap.runId !== runId || !Array.isArray(seedMap.seeds)) {
    throw new Error(`${label} seed map does not match the trusted run`);
  }
  const catalog = new Map(config.enclaves.privateRepos.map((repo) => [
    normalizePrivateRepositoryKey(repo.repo), repo,
  ]));
  const seeds = new Map<string, string>();
  for (const seed of seedMap.seeds) {
    const repo = catalog.get(seed.repo);
    if (!repo || seeds.has(seed.repo) || seed.sensitivity !== repo.sensitivity
      || seed.seedId !== deriveEnclaveSeedId(runId, seed.repo)) {
      throw new Error(`${label} seed map differs from the validated catalog`);
    }
    const stat = fs.lstatSync(path.join(paths.seedsDir, seed.seedId));
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${label} seeds must be staged real directories`);
    }
    seeds.set(seed.repo, seed.seedId);
  }
  if (seeds.size !== catalog.size) throw new Error(`${label} seed catalog is incomplete`);
  return {
    runId,
    seedsDir: paths.seedsDir,
    invocationsDir: path.join(path.dirname(paths.hostExecutorJournalDir), 'host-invocations', runId),
    journalDir: paths.hostExecutorJournalDir,
    entries: Object.entries(config.enclaves.executors)
      .filter(([, entry]) => entry.enabled)
      .map(([entryId, entry]) => ({
        entryId,
        executorKind: entryId as 'script' | 'agent',
        timeoutMs: entry.timeout * 1000,
        staticSeedIds: config.enclaves!.privateRepos.map((repo) => {
          const seed = seeds.get(normalizePrivateRepositoryKey(repo.repo));
          if (!seed) throw new Error(`${label} entry references an unstaged repository`);
          return seed;
        }),
        dynamicAgents: false,
      })),
  };
}
