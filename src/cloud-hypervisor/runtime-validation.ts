import type { CloudHypervisorOptions, WrapperConfig } from '../types';

/**
 * Cloud Hypervisor is a foundation-only runtime in this release: its config
 * surface, preflight/artifact validation, and guest artifact pipeline exist
 * so a later layer can add a lifecycle backend, but no backend is registered
 * yet (see `src/container-runtime.ts` and
 * `src/external-runtime-backend-resolver.ts`).
 *
 * This guard produces a clear, actionable error instead of letting
 * `--container-runtime cloud-hypervisor` fall through to the generic
 * unknown-runtime passthrough (which would surface as an opaque Docker
 * runtime error).
 */
export function assertCloudHypervisorNotYetAvailable(config: WrapperConfig): void {
  if (config.containerRuntime === 'cloud-hypervisor') {
    throw new Error(
      'Cloud Hypervisor is not yet an available --container-runtime. ' +
      'Its configuration surface is foundation-only in this release: no lifecycle backend is registered.',
    );
  }
}

/**
 * Cloud Hypervisor options may only be supplied alongside their own
 * (currently non-selectable) runtime name, mirroring
 * `assertFirecrackerSelection`'s intent for config-shape consistency.
 */
export function assertCloudHypervisorSelection(config: WrapperConfig): void {
  if (config.cloudHypervisor && config.containerRuntime !== undefined && config.containerRuntime !== 'cloud-hypervisor') {
    throw new Error(
      'Cloud Hypervisor options require --container-runtime cloud-hypervisor (not yet an available runtime; foundation-only configuration).',
    );
  }
}

export function requireCloudHypervisorConfig(config: WrapperConfig): CloudHypervisorOptions {
  if (!config.cloudHypervisor) {
    throw new Error('Cloud Hypervisor backend resolved without Cloud Hypervisor runtime configuration');
  }
  return config.cloudHypervisor;
}
