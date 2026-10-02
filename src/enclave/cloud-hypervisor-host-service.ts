import {
  createCloudHypervisorHostEnclaveExecutor,
  type CreateCloudHypervisorHostEnclaveExecutorOptions,
} from '../cloud-hypervisor/host-enclave-executor';
import {
  startHostExecutorServer,
  type HostExecutorServer,
} from './host-executor-server';

export interface CloudHypervisorEnclaveHostServiceOptions
  extends CreateCloudHypervisorHostEnclaveExecutorOptions {
  /** AWF-private directory shared only with the trusted enclave broker. */
  readonly runtimeDir: string;
}

/**
 * Internal integration boundary, not a user-facing runtime selector. Artifact
 * and host preflight must succeed before the authenticated listener is exposed.
 * Runtime selection remains gated on supported-host real-KVM validation.
 */
export async function startCloudHypervisorEnclaveHostService(
  options: CloudHypervisorEnclaveHostServiceOptions,
): Promise<HostExecutorServer> {
  const backend = await createCloudHypervisorHostEnclaveExecutor(options);
  try {
    return await startHostExecutorServer({
      runtimeDir: options.runtimeDir,
      runState: options.runState,
      backend,
    });
  } catch {
    await backend.close().catch(() => undefined);
    throw new Error('Cloud Hypervisor enclave host service could not start');
  }
}
