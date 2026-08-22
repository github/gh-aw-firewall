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
  it.each(['sbx', 'cloud-hypervisor'])('rejects the unsupported %s runtime', (containerRuntime) => {
    expect(() => assertFilesystemWritePolicyCompatibility(config({ containerRuntime })))
      .toThrow(`filesystem.allowWrite is not yet supported by the ${containerRuntime} runtime`);
  });

  it('accepts compose runtimes and an unset policy', () => {
    expect(() => assertFilesystemWritePolicyCompatibility(config())).not.toThrow();
    expect(() => assertFilesystemWritePolicyCompatibility(config({
      containerRuntime: 'sbx',
      filesystemAllowWrite: undefined,
    }))).not.toThrow();
  });
});
