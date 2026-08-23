import type { WrapperConfig } from './types';

export function assertFilesystemWritePolicyCompatibility(config: WrapperConfig): void {
  if (config.filesystemAllowWrite !== undefined && config.enableDind) {
    throw new Error('filesystem.allowWrite cannot be combined with Docker-in-Docker access');
  }

  // Cloud Hypervisor enforces the policy through host mount-tree staging (see
  // src/cloud-hypervisor/filesystem-write-enforcement.ts). sbx has no
  // equivalent enforcement path yet, so it still fails closed.
  if (config.filesystemAllowWrite !== undefined && config.containerRuntime === 'sbx') {
    throw new Error(
      `filesystem.allowWrite is not yet supported by the ${config.containerRuntime} runtime`,
    );
  }
}
