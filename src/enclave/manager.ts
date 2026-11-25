import * as fs from 'fs';
import execa from 'execa';
import { fixArtifactPermissionsForRootless } from '../artifact-permissions';
import type { PrivateRepositorySeedMap } from '../bounded-execution';
import { releaseSeedPermissions } from './staging';
import { getLocalDockerEnv } from '../host-env';
import { logger } from '../logger';
import { LOCAL_ENCLAVE_MCP_SERVER_IMAGE } from '../constants';
import type { WrapperConfig } from '../types';
import {
  assertAgentRuntimeAvailable,
  assertScriptRuntimeAvailable,
} from './runtime-preflight';
import { resolveEnclavePaths, type EnclavePaths } from './paths';
import {
  startCloudHypervisorEnclaveLifecycle,
  stopCloudHypervisorEnclaveLifecycle,
} from './cloud-hypervisor-lifecycle';
import {
  assertDockerEnclaveLifecycleReady,
  isDockerEnclaveSelected,
  startDockerEnclaveLifecycle,
  stopDockerEnclaveLifecycle,
} from './docker-lifecycle';
import { updateEnclaveStartupProgress } from './startup-progress';
import {
  isEnclavesEnabled,
  preflightEnclaveConfig,
  type PrepareEnclavesDeps,
} from './preflight-config';
import { preflightEnclaveHostIsolation, preflightEnclaveRuntimes } from './host-isolation-preflight';
import { prepareDirectories, stageEnclavePrivateState, type NeverLaunchedStaging } from './private-staging';

export {
  isEnclaveScriptEnabled,
  isEnclaveAgentEnabled,
  isEnclavesEnabled,
  isEnclaveDynamicPolicyDeclared,
  isEnclaveSeedStagingRequired,
  isEnclaveGithubEnabled,
  type PrepareEnclavesDeps,
} from './preflight-config';

export const ENCLAVE_RUN_LABEL = 'awf.enclave.run';
const neverLaunchedStaging = new Map<string, NeverLaunchedStaging>();

export async function prepareEnclaves(
  config: WrapperConfig,
  deps: PrepareEnclavesDeps = {},
): Promise<void> {
  if (!isEnclavesEnabled(config)) return;
  updateEnclaveStartupProgress(config, { stage: 'configuration' });
  const enclaves = config.enclaves!;
  const preparation = preflightEnclaveConfig(config, deps);
  const { env, storageProvider, cloudHypervisorSelected, dockerSelected } = preparation;
  await preflightEnclaveHostIsolation(config, preparation, deps);
  const runtimeChecks = await preflightEnclaveRuntimes(config, preparation, deps);
  const paths = await stageEnclavePrivateState(config, preparation, deps, neverLaunchedStaging);
  if (dockerSelected) {
    updateEnclaveStartupProgress(config, { stage: 'host-service' });
    await runtimeChecks.check('host-service', async () => {
      await startDockerEnclaveLifecycle(config, env, () => neverLaunchedStaging.delete(paths.root));
      await assertDockerEnclaveLifecycleReady(config);
    });
  }
  if (cloudHypervisorSelected) {
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
  const staging = neverLaunchedStaging.get(paths.root);
  await stopDockerEnclaveLifecycle(config, () => {
    const current = neverLaunchedStaging.get(paths.root);
    if (!current) return false;
    const runId = readRunId(paths);
    return !current.runId || current.runId === runId;
  });
  await stopCloudHypervisorEnclaveLifecycle(config);
  if (staging && neverLaunchedStaging.get(paths.root) === staging) {
    const stagedRunId = readRunId(paths);
    if (staging.runId && stagedRunId !== staging.runId) {
      throw new Error('Never-launched enclave staging identity changed; private state is preserved');
    }
    releaseSeedPermissions(paths.seedsDir);
    removePrivateState(config, paths);
    neverLaunchedStaging.delete(paths.root);
    return;
  }
  const runId = readRunId(paths);
  if (runId && !isDockerEnclaveSelected(config)) {
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
  neverLaunchedStaging,
};
