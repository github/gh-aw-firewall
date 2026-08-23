import { assertFilesystemWritePolicyCompatibility } from './filesystem-policy';
import type { WrapperConfig } from './types';

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: undefined,
    filesystemAllowWrite: ['/workspace'],
    ...overrides,
  } as WrapperConfig;
}

describe('assertFilesystemWritePolicyCompatibility', () => {
  it('rejects the unsupported sbx runtime', () => {
    expect(() => assertFilesystemWritePolicyCompatibility(config({ containerRuntime: 'sbx' })))
      .toThrow('filesystem.allowWrite is not yet supported by the sbx runtime');
  });

  it('accepts the Cloud Hypervisor runtime, which enforces the policy host-side', () => {
    expect(() => assertFilesystemWritePolicyCompatibility(config({
      containerRuntime: 'cloud-hypervisor',
    }))).not.toThrow();
    expect(() => assertFilesystemWritePolicyCompatibility(config({
      containerRuntime: 'cloud-hypervisor',
      filesystemAllowWrite: [],
    }))).not.toThrow();
  });

  it('accepts compose runtimes and an unset policy', () => {
    expect(() => assertFilesystemWritePolicyCompatibility(config())).not.toThrow();
    expect(() => assertFilesystemWritePolicyCompatibility(config({
      containerRuntime: 'sbx',
      filesystemAllowWrite: undefined,
    }))).not.toThrow();
  });

  it('rejects effective Docker-in-Docker access', () => {
    expect(() => assertFilesystemWritePolicyCompatibility(config({ enableDind: true })))
      .toThrow('filesystem.allowWrite cannot be combined with Docker-in-Docker access');
    expect(() => assertFilesystemWritePolicyCompatibility(config({
      containerRuntime: 'cloud-hypervisor',
      enableDind: true,
    }))).toThrow('filesystem.allowWrite cannot be combined with Docker-in-Docker access');
  });
});
