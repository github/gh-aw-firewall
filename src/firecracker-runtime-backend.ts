import type { WorkflowDependencies } from './cli-workflow';
import type { ExternalAgentRuntimeBackend } from './external-runtime-backend';
import { runFirecrackerPreflight } from './firecracker/preflight';
import type { WrapperConfig } from './types';

export const FIRECRACKER_INCOMPLETE_CAPABILITY_ERROR =
  'Firecracker runtime workload execution is unavailable in this preview: ' +
  'final runtime dispatch and infrastructure handoff are not integrated';

export interface FirecrackerRuntimeBackendDependencies {
  startInfrastructure: WorkflowDependencies['startContainers'];
  preflight: typeof runFirecrackerPreflight;
}

/**
 * Fail-closed backend boundary for the Firecracker control-plane preview.
 *
 * The manager primitives are intentionally not dispatched by the main workflow
 * until the final runtime-selection layer integrates infrastructure discovery,
 * sanitized environment assembly, and required probes. FirecrackerManager
 * separately refuses to launch without host-side network enforcement.
 */
export class FirecrackerRuntimeBackend implements ExternalAgentRuntimeBackend {
  readonly runtime = 'firecracker';

  constructor(
    private readonly config: WrapperConfig,
    private readonly dependencies: FirecrackerRuntimeBackendDependencies,
  ) {}

  async preflight(): Promise<void> {
    const firecracker = this.config.firecracker;
    if (!firecracker?.previewEnabled) {
      throw new Error(
        'Firecracker is an incomplete control-plane preview. ' +
        'Pass --firecracker-preview only for explicit control-plane testing.',
      );
    }
    await this.dependencies.preflight(firecracker);
  }

  readonly start: WorkflowDependencies['startContainers'] = async () => {
    await this.preflight();
    throw new Error(FIRECRACKER_INCOMPLETE_CAPABILITY_ERROR);
  };

  readonly exec: WorkflowDependencies['runAgentCommand'] = async () => {
    throw new Error(FIRECRACKER_INCOMPLETE_CAPABILITY_ERROR);
  };

  async collectDiagnostics(): Promise<void> {}

  async stop(): Promise<void> {}
}

export function createFirecrackerRuntimeBackend(
  config: WrapperConfig,
  startInfrastructure: WorkflowDependencies['startContainers'],
): FirecrackerRuntimeBackend {
  return new FirecrackerRuntimeBackend(config, {
    startInfrastructure,
    preflight: runFirecrackerPreflight,
  });
}
