import * as path from 'path';
import type { WrapperConfig } from '../types';
import { HostPreflightReporter } from '../cloud-hypervisor/host-preflight-progress';
import { assertPrivateRootIsolated } from './mount-policy';
import { ENCLAVE_DEBUG_ARTIFACT_ROOT } from './public-debug';
import {
  assertAgentRuntimeAvailable,
  assertPrimaryRuntimeAvailable,
  assertScriptRuntimeAvailable,
} from './runtime-preflight';
import { resolveEnclavePaths } from './paths';
import { assertCloudHypervisorEnclavePrerequisites } from './cloud-hypervisor-lifecycle';
import {
  assertDockerEnclaveHostPrerequisites,
  resolveDockerEnclavePaths,
} from './docker-lifecycle';
import { HOST_EXECUTOR_STORAGE_ROOT } from './host-executor-journal';
import { updateEnclaveStartupProgress } from './startup-progress';
import type { EnclavePreparation, PrepareEnclavesDeps } from './preflight-config';

export async function preflightEnclaveHostIsolation(
  config: WrapperConfig,
  preparation: EnclavePreparation,
  deps: PrepareEnclavesDeps,
): Promise<void> {
  const { env, storageProvider, cloudHypervisorSelected, dockerSelected } = preparation;
  const hostExecutorSelected = cloudHypervisorSelected || dockerSelected;
  if (dockerSelected) {
    (deps.assertDockerHostPrerequisites ?? assertDockerEnclaveHostPrerequisites)(config, env);
  }
  updateEnclaveStartupProgress(config, { stage: 'host-preflight' });
  if (hostExecutorSelected) {
    const hostPaths = dockerSelected ? resolveDockerEnclavePaths(config.workDir) : resolveEnclavePaths(config.workDir);
    const report = cloudHypervisorSelected
      ? new HostPreflightReporter('host-isolation', (hostPreflight) =>
        updateEnclaveStartupProgress(config, { hostPreflight }))
      : undefined;
    for (const [root, label, check] of [
      [hostPaths.hostExecutorJournalDir, 'recovery journal', 'journal-isolation'],
      [path.join(path.dirname(hostPaths.hostExecutorJournalDir), 'host-invocations'), 'invocation mount points', 'invocation-isolation'],
      [HOST_EXECUTOR_STORAGE_ROOT, 'allocation domains', 'allocation-isolation'],
      [ENCLAVE_DEBUG_ARTIFACT_ROOT, 'debug artifacts', 'debug-artifact-isolation'],
    ] as const) {
      if (!cloudHypervisorSelected && (check === 'allocation-isolation' || check === 'debug-artifact-isolation')) {
        continue;
      }
      const assertIsolated = () => assertPrivateRootIsolated(config, {
        root, ingressRoot: hostPaths.ingressRoot,
      }, env, process.cwd(), `${cloudHypervisorSelected ? 'Cloud Hypervisor' : 'Docker'} enclave ${label}`);
      if (report) await report.check(check, assertIsolated);
      else assertIsolated();
    }
  }
  await assertCloudHypervisorEnclavePrerequisites(config, storageProvider);
}

export async function preflightEnclaveRuntimes(
  config: WrapperConfig,
  preparation: EnclavePreparation,
  deps: PrepareEnclavesDeps,
): Promise<HostPreflightReporter> {
  const enclaves = config.enclaves!;
  const { cloudHypervisorSelected, dockerSelected } = preparation;
  const hostExecutorSelected = cloudHypervisorSelected || dockerSelected;
  updateEnclaveStartupProgress(config, { stage: 'runtime-preflight' });
  const runtimeChecks = new HostPreflightReporter('enclave-runtime', (hostPreflight) =>
    updateEnclaveStartupProgress(config, { hostPreflight }));
  if (!enclaves.executors.script.enabled) runtimeChecks.notRequired('script-runtime');
  if (!enclaves.executors.agent.enabled) runtimeChecks.notRequired('agent-runtime');
  if (!hostExecutorSelected) runtimeChecks.notRequired('host-service');
  if (config.containerRuntime === 'cloud-hypervisor') {
    await runtimeChecks.check('primary-runtime', () => {
      if (!deps.assertCloudHypervisorPrimaryPreflight) {
        throw new Error('Cloud Hypervisor primary runtime preflight evidence is unavailable');
      }
      return deps.assertCloudHypervisorPrimaryPreflight(config);
    });
  } else {
    await runtimeChecks.check('primary-runtime', () =>
      (deps.assertPrimaryAvailable ?? assertPrimaryRuntimeAvailable)(config.containerRuntime));
  }
  if (enclaves.executors.script.enabled && !cloudHypervisorSelected) {
    const assertScriptRuntime = deps.assertScriptRuntimeAvailable ?? assertScriptRuntimeAvailable;
    await runtimeChecks.check('script-runtime', () => assertScriptRuntime(enclaves.executors.script));
  }
  if (enclaves.executors.agent.enabled && !cloudHypervisorSelected) {
    const assertAgentRuntime = deps.assertAgentRuntimeAvailable ?? assertAgentRuntimeAvailable;
    await runtimeChecks.check('agent-runtime', () => assertAgentRuntime(enclaves.executors.agent));
  }
  return runtimeChecks;
}
