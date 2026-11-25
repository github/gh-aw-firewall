import * as fs from 'fs';
import {
  PRIVATE_REPOSITORY_SEED_MAP_VERSION,
  serializePrivateRepositorySeedMap,
  type PrivateRepositorySeedMap,
} from '../bounded-execution';
import { getSafeHostGid, getSafeHostUid } from '../host-identity';
import { logger } from '../logger';
import type { WrapperConfig } from '../types';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import { stageEnclaveSeeds } from './staging';
import { assertPrivateRootIsolated } from './mount-policy';
import { generateEnclaveRunId, resolveEnclavePaths, type EnclavePaths } from './paths';
import { ENCLAVE_MCP_CAPABILITY_ENV } from './gateway';
import { ENCLAVE_GITHUB_MCP_AGENT_ID_ENV } from './github-gateway';
import { stageEnclaveDynamicDelegationHandoff } from './dynamic-delegation-handoff';
import { updateEnclaveStartupProgress } from './startup-progress';
import {
  isEnclaveGithubEnabled,
  type EnclavePreparation,
  type PrepareEnclavesDeps,
} from './preflight-config';

export interface NeverLaunchedStaging {
  runId?: string;
}

function ensureDirectory(target: string, mode: number): void {
  fs.mkdirSync(target, { recursive: true, mode });
  fs.chmodSync(target, mode);
}

export function prepareDirectories(
  paths: EnclavePaths,
  chown: typeof fs.chownSync = fs.chownSync,
  onPrivateRootCreated: () => void = () => undefined,
): void {
  fs.mkdirSync(paths.root, { mode: 0o700 });
  onPrivateRootCreated();
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

export async function stageEnclavePrivateState(
  config: WrapperConfig,
  preparation: EnclavePreparation,
  deps: PrepareEnclavesDeps,
  neverLaunchedStaging: Map<string, NeverLaunchedStaging>,
): Promise<EnclavePaths> {
  const enclaves = config.enclaves!;
  const {
    env, seedStagingRequired, dynamicDeclared, delegationHandoff, dockerSelected,
    token, staticGithubCapability, githubAgentId,
  } = preparation;
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
  await storageChecks.check('directory-layout', () => prepareDirectories(
    paths, undefined, () => {
      if (dockerSelected) neverLaunchedStaging.set(paths.root, {});
    },
  ));

  const runId = generateEnclaveRunId();
  await storageChecks.check('run-identity', () => writeExclusive(paths.runIdPath, `${runId}\n`, 0o600));
  const staging = neverLaunchedStaging.get(paths.root);
  if (staging) staging.runId = runId;
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
      if (!staticGithubCapability) {
        writeExclusive(paths.githubAgentIdPath, `${githubAgentId}\n`, 0o600);
        if (env === process.env) delete process.env[ENCLAVE_GITHUB_MCP_AGENT_ID_ENV];
      }
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
  return paths;
}
