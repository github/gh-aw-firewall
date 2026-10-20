import {
  createCloudHypervisorHostEnclaveExecutor,
  type CreateCloudHypervisorHostEnclaveExecutorOptions,
  type HostEnclaveExecutorDependencies,
} from '../cloud-hypervisor/host-enclave-executor';
import type { HostExecutorServer } from './host-executor-server';
import { startHostExecutorService } from './host-service';

export interface CloudHypervisorEnclaveHostServiceOptions
  extends CreateCloudHypervisorHostEnclaveExecutorOptions {
  /** AWF-private directory shared only with the trusted enclave broker. */
  readonly runtimeDir: string;
  /** Trusted storage implementation hooks, never sourced from configuration or the broker. */
  readonly backendDependencies?: Partial<HostEnclaveExecutorDependencies>;
}

/**
 * Internal integration boundary, not a user-facing runtime selector. Artifact
 * and host preflight must succeed before the authenticated listener is exposed.
 * Runtime selection remains gated on supported-host real-KVM validation.
 */
export async function startCloudHypervisorEnclaveHostService(
  options: CloudHypervisorEnclaveHostServiceOptions,
): Promise<HostExecutorServer> {
  return startHostExecutorService({
    runtimeDir: options.runtimeDir,
    runState: options.runState,
    createBackend: () => options.backendDependencies
      ? createCloudHypervisorHostEnclaveExecutor(options, options.backendDependencies)
      : createCloudHypervisorHostEnclaveExecutor(options),
    onListening: () => options.onPreflightStage?.('host-service'),
    startupFailureMessage: 'Cloud Hypervisor enclave host service could not start',
  });
}
