import type { WrapperConfig } from './types';

export function assertFilesystemWritePolicyCompatibility(config: WrapperConfig): void {
  if (
    config.filesystemAllowWrite !== undefined &&
    (config.containerRuntime === 'sbx' || config.containerRuntime === 'cloud-hypervisor')
  ) {
    throw new Error(
      `filesystem.allowWrite is not yet supported by the ${config.containerRuntime} runtime`,
    );
  }
}
