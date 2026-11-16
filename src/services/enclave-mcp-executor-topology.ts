import type { WrapperConfig } from '../types';
import type {
  EnclaveAgentExecutorConfig,
  EnclaveScriptExecutorConfig,
  EnclavesConfig,
} from '../types/enclave-options';

export function validateEnclaveMcpExecutors(config: WrapperConfig): EnclavesConfig {
  const enclaves = config.enclaves;
  const script = enclaves?.executors.script;
  const agent = enclaves?.executors.agent;
  if (!enclaves?.enabled || (!script?.enabled && !agent?.enabled)) {
    throw new Error('buildEnclaveMcpService: at least one enclave executor must be enabled');
  }
  if (script?.enabled && script.runtime === 'sbx') {
    throw new Error('buildEnclaveMcpService: sbx script enclave capability is not yet available');
  }
  if (agent?.enabled && agent.runtime === 'sbx') {
    throw new Error('buildEnclaveMcpService: sbx agent enclave capability is not yet available');
  }
  if (agent?.enabled && !config.enableApiProxy) {
    throw new Error(
      'buildEnclaveMcpService: the enclave agent executor requires the API proxy, which is the ' +
      "enclave's only permitted upstream egress",
    );
  }
  return enclaves;
}

export function resolveEnclaveMcpExecutorTopology(
  script: EnclaveScriptExecutorConfig | undefined,
  agent: EnclaveAgentExecutorConfig | undefined,
): { localExecutor: boolean; hostExecutor: boolean } {
  const cloudHypervisorExecutor = (script?.enabled && script.runtime === 'cloud-hypervisor')
    || (agent?.enabled && agent.runtime === 'cloud-hypervisor');
  const containerExecutor = (script?.enabled && script.runtime !== 'cloud-hypervisor')
    || (agent?.enabled && agent.runtime !== 'cloud-hypervisor');
  const localExecutor = (script?.enabled && script.runtime === 'gvisor')
    || (agent?.enabled && agent.runtime === 'gvisor');
  const hostExecutor = cloudHypervisorExecutor
    || (script?.enabled && script.runtime === 'docker')
    || (agent?.enabled && agent.runtime === 'docker');
  if (cloudHypervisorExecutor && containerExecutor) {
    throw new Error('Cloud Hypervisor enclaves cannot be mixed with container enclave runtimes');
  }
  if (hostExecutor && localExecutor) {
    throw new Error('Docker and gVisor enclaves cannot share a broker; one workload backend is required per run');
  }
  if (cloudHypervisorExecutor && ((script?.enabled && script.image !== undefined)
    || (agent?.enabled && (agent.image !== undefined || agent.dynamic !== undefined)))) {
    throw new Error('Cloud Hypervisor enclaves require static entries and release-attested artifacts');
  }
  return { localExecutor: localExecutor === true, hostExecutor: hostExecutor === true };
}
