import type { WorkflowDependencies } from './cli-workflow';
import { runtimeUsesComposeAgent } from './container-runtime';
import type { ExternalAgentRuntimeBackend } from './external-runtime-backend';
import { createSbxRuntimeBackend } from './sbx-runtime-backend';
import { createFirecrackerRuntimeBackend } from './firecracker-runtime-backend';
import { createCloudHypervisorRuntimeBackend } from './cloud-hypervisor-runtime-backend';
import type { WrapperConfig } from './types';

interface ExternalRuntimeBackendFactoryContext {
  config: WrapperConfig;
  startInfrastructure: WorkflowDependencies['startContainers'];
}

type ExternalRuntimeBackendFactory = (
  context: ExternalRuntimeBackendFactoryContext,
) => ExternalAgentRuntimeBackend;

type ExternalRuntimeBackendRegistry = Readonly<
  Record<string, ExternalRuntimeBackendFactory>
>;

const EXTERNAL_RUNTIME_BACKENDS: ExternalRuntimeBackendRegistry = {
  sbx: ({ config, startInfrastructure }) =>
    createSbxRuntimeBackend(config, startInfrastructure),
  firecracker: ({ config, startInfrastructure }) =>
    createFirecrackerRuntimeBackend(config, startInfrastructure),
  'cloud-hypervisor': ({ config, startInfrastructure }) =>
    createCloudHypervisorRuntimeBackend(config, startInfrastructure),
};

/**
 * Resolves the selected external agent backend.
 *
 * Compose runtimes intentionally return undefined and continue through the
 * existing Docker/gVisor workflow without an additional abstraction layer.
 */
export function resolveExternalRuntimeBackend(
  config: WrapperConfig,
  startInfrastructure: WorkflowDependencies['startContainers'],
  registry: ExternalRuntimeBackendRegistry = EXTERNAL_RUNTIME_BACKENDS,
): ExternalAgentRuntimeBackend | undefined {
  if (runtimeUsesComposeAgent(config.containerRuntime)) {
    return undefined;
  }

  const runtime = config.containerRuntime;
  if (runtime === 'firecracker' && !config.firecracker?.previewEnabled) {
    throw new Error(
      'Firecracker workload execution requires explicit --firecracker-preview opt-in',
    );
  }
  if (runtime === 'cloud-hypervisor' && !config.cloudHypervisor?.previewEnabled) {
    throw new Error(
      'Cloud Hypervisor workload execution requires explicit --cloud-hypervisor-preview opt-in',
    );
  }
  const factory = runtime ? registry[runtime] : undefined;
  if (!factory) {
    throw new Error(`No external agent runtime backend is registered for "${runtime}"`);
  }

  return factory({ config, startInfrastructure });
}
