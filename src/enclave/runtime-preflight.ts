import type {
  EnclaveAgentExecutorConfig,
  EnclaveRuntime,
  EnclaveScriptExecutorConfig,
} from '../types/enclave-options';
import {
  defaultDockerAvailabilityQuery,
  defaultDockerRuntimeQuery,
  defaultSbxAvailabilityQuery,
  type DockerAvailabilityQuery,
  type DockerRuntimeQuery,
  type SbxAvailabilityQuery,
} from '../bounded-execution/runtime-probes';

const RUNSC_RUNTIME = 'runsc';

export type PrimaryRuntimeBackend = 'docker' | 'gvisor' | 'sbx' | 'firecracker';

export function resolvePrimaryRuntimeBackend(
  containerRuntime: string | undefined,
): PrimaryRuntimeBackend {
  if (containerRuntime === 'gvisor' || containerRuntime === RUNSC_RUNTIME) return 'gvisor';
  if (containerRuntime === 'sbx') return 'sbx';
  if (containerRuntime === 'firecracker') return 'firecracker';
  return 'docker';
}

export async function assertPrimaryRuntimeAvailable(
  containerRuntime: string | undefined,
  queryDockerRuntime: DockerRuntimeQuery = defaultDockerRuntimeQuery,
  queryDockerAvailable: DockerAvailabilityQuery = defaultDockerAvailabilityQuery,
  querySbxAvailable: SbxAvailabilityQuery = defaultSbxAvailabilityQuery,
): Promise<void> {
  if (containerRuntime === 'firecracker') {
    throw new Error(
      'Primary-agent runtime "firecracker" is a control-plane preview; ' +
      'enclave integration is not implemented and enclaves never fall back',
    );
  }
  if (containerRuntime === 'sbx') {
    if (!(await querySbxAvailable())) {
      throw new Error('Primary-agent runtime "sbx" is unavailable; enclaves never fall back');
    }
    return;
  }
  if (containerRuntime === 'gvisor' || containerRuntime === RUNSC_RUNTIME) {
    if (!(await queryDockerRuntime(RUNSC_RUNTIME))) {
      throw new Error(
        `Primary-agent runtime "${containerRuntime}" requires the "${RUNSC_RUNTIME}" OCI runtime; ` +
        'enclaves never fall back',
      );
    }
    return;
  }
  if (containerRuntime && containerRuntime !== 'docker') {
    if (!(await queryDockerRuntime(containerRuntime))) {
      throw new Error(
        `Primary-agent OCI runtime "${containerRuntime}" is unavailable; enclaves never fall back`,
      );
    }
    return;
  }
  if (!(await queryDockerAvailable())) {
    throw new Error('The Docker primary-agent runtime is unavailable; enclaves never fall back');
  }
}

async function assertExecutorRuntimeAvailable(
  runtime: EnclaveRuntime,
  label: string,
  queryDockerRuntime: DockerRuntimeQuery,
  queryDockerAvailable: DockerAvailabilityQuery,
): Promise<void> {
  if (runtime === 'gvisor') {
    if (!(await queryDockerRuntime(RUNSC_RUNTIME))) {
      throw new Error(
        `${label} runtime "gvisor" requires the "${RUNSC_RUNTIME}" OCI runtime; enclaves never fall back`,
      );
    }
    return;
  }
  if (runtime === 'docker') {
    if (!(await queryDockerAvailable())) {
      throw new Error(`${label} runtime "docker" requires a reachable Docker daemon; enclaves never fall back`);
    }
    return;
  }
  throw new Error(`${label} runtime "sbx" is not implemented and never falls back`);
}

export function assertScriptRuntimeAvailable(
  config: EnclaveScriptExecutorConfig,
  queryDockerRuntime: DockerRuntimeQuery = defaultDockerRuntimeQuery,
  queryDockerAvailable: DockerAvailabilityQuery = defaultDockerAvailabilityQuery,
): Promise<void> {
  return assertExecutorRuntimeAvailable(
    config.runtime,
    'Enclave script executor',
    queryDockerRuntime,
    queryDockerAvailable,
  );
}

export function assertAgentRuntimeAvailable(
  config: EnclaveAgentExecutorConfig,
  queryDockerRuntime: DockerRuntimeQuery = defaultDockerRuntimeQuery,
  queryDockerAvailable: DockerAvailabilityQuery = defaultDockerAvailabilityQuery,
): Promise<void> {
  return assertExecutorRuntimeAvailable(
    config.runtime,
    'Enclave agent executor',
    queryDockerRuntime,
    queryDockerAvailable,
  );
}
