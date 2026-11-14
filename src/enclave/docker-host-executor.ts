import { createDockerHostContext, type DockerHostEnclaveExecutorOptions, type DockerHostEnclaveExecutorBackend } from './docker-host-context';
import { createDockerHostContainerOperations } from './docker-host-container';
import { createDockerHostExecution } from './docker-host-execute';
import { initializeDockerHostRecovery } from './docker-host-recovery';

export type {
  DockerHostRunnerConfig, DockerHostExecutorEntry, DockerHostAgentAuthority, DockerHostAuthoritySettlement,
  DockerHostEnclaveExecutorOptions, DockerHostEnclaveExecutorBackend,
} from './docker-host-context';

/**
 * Docker is only a workload adapter. Admission, settlement, leases and result
 * release remain exclusively in the shared host executor server.
 */
export function createDockerHostEnclaveExecutor(options: DockerHostEnclaveExecutorOptions): DockerHostEnclaveExecutorBackend {
  const context = createDockerHostContext(options);
  const containers = createDockerHostContainerOperations(context);
  const initialize = () => initializeDockerHostRecovery(context, containers);
  const execution = createDockerHostExecution(context, containers, initialize);
  return {
    async prepare() {
      if (context.closed) throw new Error('Docker enclave backend is closed');
      await (context.ready ||= initialize());
    },
    execute: execution.execute,
    async close() {
      context.closed = true;
      for (const handle of context.active) handle.controller.abort();
      const results = await Promise.all([...context.active].map((handle) => handle.done));
      if (results.some((result) => result.cleanupComplete === false)) throw new Error('Docker enclave cleanup requires recovery');
      // Failed listener publication may close an unopened backend belonging
      // to a duplicate start. It must not reconcile a live run it never owned.
      if (context.ready) await context.ready;
      if (context.cleanupIncomplete) throw new Error('Docker enclave resource or authority cleanup requires recovery');
      context.publicArtifacts.clear();
    },
  };
}

/** Resource recovery only; caller must subsequently reconcile mcpg authorities. */
export async function recoverDockerHostEnclaveExecutor(
  options: Omit<DockerHostEnclaveExecutorOptions, 'resolveAgentAuthority' | 'settleAgentAuthority'>,
): Promise<void> {
  const noAuthorityDuringRecovery = async (): Promise<never> => {
    throw new Error('Docker resource recovery cannot acquire or settle authorities');
  };
  const backend = createDockerHostEnclaveExecutor({
    ...options, resolveAgentAuthority: noAuthorityDuringRecovery, settleAgentAuthority: noAuthorityDuringRecovery,
  });
  try { await backend.prepare(); }
  finally { await backend.close(); }
}
